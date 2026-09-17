import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "./plugin-api.js";
import { bindExactChildReservation, childSessionIdFromAfter, reservationEligibleForSessionCreated, sessionCreatedCorrelationDecision } from "./reservation-correlation.js";
import { handoffMatchesInvocation, handoffPathFromStdout, removeConsumedArtifacts, safeHandoffID, safeInvocationID } from "./openai-handoff.js";
import { readRecovery, removeRecovery, removeRecoveryAndHome, removeRecoveryHome, recoveryHomeRoot, registerCodexHome, clearCodexHomePointer, RecoveryConflictError } from "./codex-recovery.js";
import { openCodexCircuit, readCodexCircuitGeneration } from "./codex-circuit.js";
import { resolveCodexModels } from "./codex-models.js";
import { createRemoteReadTool } from "./openai-remote-ops.js";
import { analyzeObjective, routeDelegatedAgent, selectAuthoritativeObjective, REPOSITORY_MUTATING_TOOLS } from "./openai-routing.js";
import { parseVerificationEvidence, postExecutionPolicy, verificationCommandCategory, isAllowlistedVerificationCommand } from "./execution-policy.js";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, runProcessAsync } from "./process-async.js";
import { addWorkPacketTokensByID, createWorkPacket, incrementWorkPacketByID, listWorkPackets, readWorkPacketByID, pruneWorkPackets, tokenEventHash, updateWorkPacket, updateWorkPacketByID, updateWorkPacketByIDIfCurrent } from "./work-packet.js";
import { TaskStateError, claimTask, completeTask, readTask, transitionTask } from "./task-state.js";
import { workspaceFingerprint } from "./read-cache.js";
import { ownerCanBeReclaimed, ownerForProcess } from "./lock-identity.js";
import { gateTerminalPacketPatch, lifecycleCleanupOptions } from "./gate-state.js";
import { GuardrailPolicyError, admitDelegation, admitToolCall, allowsDailyOrchestratorShell, backgroundDelegationAllowed, beginRequestCycle, canonicalDelegatedObjective, createGuardrailState, delegationScope, explicitlyConfirms, finishDelegation, isInternalContinuation, preserveChildGuardState, readStopLatch, recoverRootRequestState, settleVerificationGateState, updateStopLatch, verificationGateDecision, writeStopLatch } from "./openai-guardrails.js";
import { guardToolExecution } from "../../../../shared/tool-output-guard.js";
import { appendTaskPacketMarker, extractTaskPacketMarker, objectiveBeforeMarker } from "./correlation-marker.js";
import {
  CODEX_REQUIRED,
  CODEX_RUNNING,
  CODEX_SUCCESS,
  CODEX_UNKNOWN,
  CODEX_TASK_FAILED,
  CODEX_TIMEOUT,
  CODEX_ABORTED,
  MUTATING_TOOLS,
  TERRA_FALLBACK,
  PolicyConflictError,
  ensurePolicy,
  policyExists,
  readPolicy,
  removePolicy,
  transitionPolicy,
} from "./codex-authority.js";
const TEAM_ROOT = process.env.OPENAI_TEAM_ROOT ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LANE = join(TEAM_ROOT, "bin", "codex-lane.sh");
const ADMIT = join(TEAM_ROOT, "bin", "openai-admit.sh");
const RELEASE = join(TEAM_ROOT, "bin", "openai-release.sh");
const BIND = join(TEAM_ROOT, "bin", "openai-bind.sh");
const reservations = new Map();
export const retainParentCallReservation = (reservationMap, reservation, outcome, gatesPending) => {
  if (!(reservationMap instanceof Map) || outcome !== "success" || gatesPending !== true || !reservation?.task_call_id) return false;
  reservationMap.set(reservation.task_call_id, { ...reservation, token: null });
  return true;
};
const PREMIUM_AGENT_MODELS = { openai_orchestrator: "openai/gpt-5.6-sol", openai_explore: "openai/gpt-5.6-luna-fast", openai_librarian: "openai/gpt-5.6-luna", openai_ops: "openai/gpt-5.6-luna", tester: "openai/gpt-5.6-terra", reviewer: "openai/gpt-5.6-sol", reviewer_critical: "openai/gpt-6-astra", specialist: "openai/gpt-6-astra", codex_executor: "openai/gpt-5.6-luna-fast" };
const DAILY_AGENT_MODELS = { openai_orchestrator: "openai/gpt-5.6-luna", openai_explore: "openai/gpt-5.6-luna", openai_librarian: "openai/gpt-5.6-luna", openai_ops: "openai/gpt-5.6-luna", tester: "openai/gpt-5.6-luna", reviewer: "openai/gpt-5.6-terra", reviewer_critical: "openai/gpt-5.6-sol", specialist: "openai/gpt-5.6-terra", codex_executor: "openai/gpt-5.6-luna" };
export const DEFAULT_AGENT_MODELS = process.env.OPENAI_DAILY_PROFILE === "1" ? DAILY_AGENT_MODELS : PREMIUM_AGENT_MODELS;
export const latestUserObjective = (messages = []) => {
  const latest = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.info?.role === "user");
  const text = (latest?.parts || []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
  return text || null;
};
export const resolveInitialObjectiveFromClient = async (client, sessionID, seen = new Set(), cache = new Map()) => {
  if (!sessionID || seen.has(sessionID)) return null;
  if (cache.has(sessionID)) return cache.get(sessionID);
  const nextSeen = new Set(seen).add(sessionID);
  if (typeof client?.session?.get !== "function") return null;
  let session;
  try { session = (await client.session.get({ path: { id: sessionID } }))?.data; } catch { return null; }
  if (!session || typeof session !== "object") return null;
  const parentID = session.parentID || session.parent_id || session.parent?.id || null;
  if (parentID) {
    if (parentID === sessionID || nextSeen.has(parentID)) return null;
    const parent = await resolveInitialObjectiveFromClient(client, parentID, nextSeen, cache);
    if (!parent?.rootSessionID) return null;
    const result = { ...parent, parentSessionID: parent.rootSessionID };
    cache.set(sessionID, result);
    return result;
  }
  const readLatest = async (id) => {
    try {
      const response = await client?.session?.messages({ path: { id } });
      return latestUserObjective(response?.data);
    } catch { return null; }
  };
  const text = await readLatest(sessionID);
  const result = text ? { objective: text, parentSessionID: null, rootSessionID: sessionID } : null;
  cache.set(sessionID, result);
  return result;
};
const authMetadataError = (label, reason) => Object.assign(new Error(`${label}_AUTH_METADATA_REFUSED:${reason}`), { code: "AUTH_METADATA_REFUSED" });
const validatePrivateAuthFile = async (path, label) => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw authMetadataError(label, "symlink");
  if (!info.isFile()) throw authMetadataError(label, "not_regular");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw authMetadataError(label, "owner");
  if (info.nlink !== 1) throw authMetadataError(label, "link_count");
  if ((info.mode & 0o777) !== 0o600) throw authMetadataError(label, "mode");
  return info;
};
const bridgePrivateAuthFile = async ({ source, destination, root, label }) => {
  await validatePrivateAuthFile(source, `${label}_SOURCE`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const realParent = await realpath(dirname(destination));
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}/`)) throw authMetadataError(label, "destination_root");
  const temporary = join(dirname(destination), `.auth.${process.pid}.${randomUUID()}`);
  try {
    await copyFile(source, temporary, 0);
    await chmod(temporary, 0o600);
    await validatePrivateAuthFile(temporary, `${label}_TEMP`);
    await rename(temporary, destination);
    await validatePrivateAuthFile(destination, `${label}_DESTINATION`);
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
};
// Codex persists more than credentials in CODEX_HOME.  Every lane therefore
// gets a new, private home containing only the host authentication document.
// It is deliberately not inherited from the OpenCode process.
const freshCodexHome = async (recovery = null) => {
  const reusable = recovery?.codex_home;
  if (typeof reusable === "string") {
    try {
      const root = resolve(recoveryHomeRoot()), rootInfo = await lstat(root), home = resolve(reusable);
      const info = await lstat(home), realRoot = await realpath(root), realHome = await realpath(home);
      if (rootInfo.isDirectory() && (rootInfo.mode & 0o077) === 0 && info.isDirectory() && !info.isSymbolicLink() &&
        dirname(home) === root && dirname(realHome) === realRoot && realHome === join(realRoot, basename(home)) &&
        basename(home).startsWith("codex-home-") && (info.mode & 0o077) === 0 &&
        (typeof process.getuid !== "function" || info.uid === process.getuid()) && recovery.codex_home_identity === home) {
        await chmod(home, 0o700); return home;
      }
    } catch {}
  }
  await mkdir(recoveryHomeRoot(), { recursive: true, mode: 0o700 });
  await chmod(recoveryHomeRoot(), 0o700);
  const home = await mkdtemp(join(recoveryHomeRoot(), "codex-home-"));
  await registerCodexHome(home);
  try { await chmod(home, 0o700); } catch (error) { try { await rm(home, { recursive: true, force: true }); await clearCodexHomePointer(home); } catch {} throw error; }
  const auth = process.env.OPENAI_CODEX_AUTH_SOURCE || join(process.env.HOME || "", ".codex", "auth.json");
  try {
    await bridgePrivateAuthFile({ source: auth, destination: join(home, "auth.json"), root: home, label: "CODEX" });
  } catch (error) {
    // Test doubles do not need a local credential.  A real lane will report
    // its own non-fallback-eligible authentication failure if it cannot use it.
    if (process.env.OPENAI_CODEX_AUTH_SOURCE || error?.code !== "ENOENT") {
      try { await rm(home, { recursive: true, force: true }); await clearCodexHomePointer(home); } catch {}
      throw error;
    }
  }
  return home;
};
const advanceTask = async (reservation, state, patch = {}) => {
  if (!reservation?.task_fingerprint || !reservation?.task_lease_id || !Number.isInteger(reservation.task_state_version)) return null;
  const record = await transitionTask(reservation.task_fingerprint, { expectedVersion: reservation.task_state_version, expectedAttempt: reservation.attempt, expectedLease: reservation.task_lease_id, expectedStates: ["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION"], leaseId: reservation.task_lease_id, patch: { ...patch, state } });
  reservation.task_state_version = record.version;
  return record;
};
const manualRecoveryPacketPatch = ({ recovery = {}, packet = {}, metadata = {} } = {}) => {
  const testerRequired = packet?.tester_required === true;
  const critical = packet?.risk === "critical";
  const mutationCount = Number.isInteger(recovery?.mutation_count) && recovery.mutation_count >= 0
    ? recovery.mutation_count
    : Array.isArray(recovery?.command_journal) ? recovery.command_journal.length : 0;
  const reviewer = critical ? "reviewer_critical" : "reviewer";
  return {
    phase: "PENDING_VERIFICATION", outcome: "pending", verification_status: "pending_manual_recovery_review",
    mutation_count: mutationCount, journal_incomplete: recovery?.journal_incomplete === true,
    // Manual recovery is escalated to a reviewable risk lane.  This keeps the
    // existing reviewer authorization fence intact for noncritical work.
    risk: critical ? "critical" : "high", review_required: true, review_status: "pending",
    tester_required: testerRequired, tester_status: testerRequired ? (packet?.tester_status === "passed" ? "passed" : "pending") : "not_required",
    recovery_attempt: Number.isInteger(recovery?.attempt) ? recovery.attempt : null,
    next_agents: testerRequired ? [reviewer, "tester"] : [reviewer], policy_reasons: ["manual_recovery_review"],
    codex_run_id: typeof recovery?.codex_run_id === "string" ? recovery.codex_run_id : packet?.codex_run_id || "",
    codex_thread_id: typeof recovery?.thread_id === "string" ? recovery.thread_id : packet?.codex_thread_id || "",
    ...metadata,
  };
};
const masterParentBySession = new Map();
let telemetryErrorCallback = null;
const CUSTOM_MUTATION_TOOL = /(?:mutat|write|edit|patch|delete|remove|rename|create|move|exec|bash|shell|command)/;
const isMutationCapableTool = (toolName) => MUTATING_TOOLS.has(toolName) || CUSTOM_MUTATION_TOOL.test(toolName);
const FALLBACK_MUTATION_TOOLS = new Set([
  ...MUTATING_TOOLS, "bash", "interactive_bash", "shell", "command",
  "serena_replace_content", "serena_replace_in_files", "serena_replace_symbol_body",
  "serena_insert_before_symbol", "serena_insert_after_symbol", "serena_rename_symbol",
  "serena_safe_delete_symbol", "serena_write_memory", "serena_edit_memory",
]);
const latencyLogPath = () => join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "logs", "latency-metrics.jsonl");
const recordLatency = async (event) => {
  try {
    const path = latencyLogPath();
    await mkdir(join(path, ".."), { recursive: true });
    await appendFile(path, `${JSON.stringify({ schema_version: 1, timestamp: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  } catch (error) { try { telemetryErrorCallback?.(error, event); } catch {} }
};
const elapsed = (startedAt) => Math.max(0, Date.now() - startedAt);
const timestamp = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const messageTime = (info, key) => timestamp(info?.time?.[key] ?? info?.[key]);
const completedAssistant = (entry) => {
  const info = entry?.info || {};
  const completed = messageTime(info, "completed");
  return (String(info.role || "").toLowerCase() === "assistant" && completed != null) ? { entry, completed } : null;
};
export const taskInvocationMetrics = (entries = []) => {
  if (!Array.isArray(entries)) return null;
  let start = -1;
  entries.forEach((entry, index) => { if (String(entry?.info?.role || "").toLowerCase() === "user") start = index; });
  if (start < 0) return null;
  const userCreated = messageTime(entries[start]?.info, "created");
  const assistant = entries.slice(start + 1).map(completedAssistant).filter(Boolean).at(-1);
  if (!assistant) return null;
  const created = messageTime(assistant.entry.info, "created");
  const toolcalls = entries.slice(start + 1).reduce((count, entry) => count + (Array.isArray(entry?.parts) ? entry.parts.filter((part) => String(part?.type || "").toLowerCase() === "tool").length : 0), 0);
  const duration = (start) => start == null || assistant.completed < start ? null : assistant.completed - start;
  return { toolcalls, model_ms: duration(created), elapsed_ms: duration(userCreated) };
};
const metricDuration = (value) => { if (!Number.isFinite(value) || value < 0) return null; const seconds = Math.floor(value / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };
export const renderTaskInvocationMetrics = (metrics) => {
  if (!metrics || !Number.isFinite(metrics.toolcalls)) return null;
  const pieces = [`${metrics.toolcalls} ${metrics.toolcalls === 1 ? "toolcall" : "toolcalls"}`];
  const model = metricDuration(metrics.model_ms), elapsedValue = metricDuration(metrics.elapsed_ms);
  if (model) pieces.push(`model ${model}`);
  if (elapsedValue) pieces.push(`elapsed ${elapsedValue}`);
  return pieces.join(" · ");
};
export const enrichTaskInvocationOutput = (output, entries) => {
  const metrics = taskInvocationMetrics(entries), summary = renderTaskInvocationMetrics(metrics);
  if (!summary || !output || typeof output !== "object") return null;
  output.metadata = { ...(output.metadata || {}), "openai.task_invocation_metrics": metrics };
  const suffix = ` [current: ${summary}; native line: session cumulative]`;
  output.title = `${String(output.title || "task").replace(/\s*\[current: [^\]]*; native line: session cumulative\]/g, "")}${suffix}`;
  return metrics;
};
export const enrichTaskInvocationFromClient = async (output, client, childID) => {
  try {
    if (!childID || !client?.session?.messages) return null;
    let timeoutHandle;
    const timeout = new Promise((resolve) => { timeoutHandle = setTimeout(() => resolve(null), 500); });
    let response;
    try {
      response = await Promise.race([client.session.messages({ path: { id: childID } }), timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    return response == null ? null : enrichTaskInvocationOutput(output, unwrapData(response));
  } catch { return null; }
};
const tokenBudget = (agent, input) => {
  const key = agent === "openai_orchestrator" ? "OPENAI_TOKEN_WARN_ORCHESTRATOR_UNCACHED" : agent === "codex_executor" ? "OPENAI_TOKEN_WARN_WRAPPER_UNCACHED" : "OPENAI_TOKEN_WARN_AGENT_UNCACHED";
  const fallback = agent === "openai_orchestrator" ? 50000 : agent === "codex_executor" ? 5000 : 30000;
  const threshold = Number(process.env[key] ?? fallback);
  const safeThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : fallback;
  const uncached = Number.isFinite(input) && input >= 0 ? input : 0;
  return { threshold_tokens: safeThreshold, overage_tokens: Math.max(0, uncached - safeThreshold), cache_ratio_pct: 0 };
};
const CODEX_SUMMARY_MAX_CHARS = 8192;
const COMPACTION_CONTEXT_MAX_CHARS = 6000;
const codexResult = (fields = {}) => ({
  code: "CODEX_COMPLETED",
  retryable: false,
  phase: "codex_execution",
  task_id: null,
  provider_failure: false,
  codex_profile: null,
  ...fields,
});
const unwrapData = (value) => value?.data ?? value;
const oneLine = (value, limit = 300) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
const safeField = (value, limit = 120) => oneLine(value, limit).replace(/[^A-Za-z0-9 .,:_/@=+\-]/g, "");
const safeTodoContent = (value) => oneLine(value, 300)
  .replace(/(?:[A-Za-z]:)?\/[A-Za-z0-9._/-]+/g, "[path]")
  .replace(/\b[A-Z][A-Z0-9_]{2,}=[^\s]+/g, "[env]")
  .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]+/gi, "[redacted]");
const packetLine = (packet) => {
  const fields = [
    ["parent", packet.parent_session_id], ["child", packet.child_session_id], ["agent", packet.agent],
    ["class", packet.classification], ["phase", packet.phase], ["outcome", packet.outcome], ["codex", packet.codex_outcome], ["updated", packet.updated_at],
    ["budget", packet.budget_status], ["codex_budget", packet.codex_budget_status], ["opencode_budget", packet.opencode_budget_status],
  ].filter(([, value]) => value != null && value !== "").map(([key, value]) => `${key}=${safeField(value)}`);
  return `packet ${fields.join(" ")}`;
};
export const renderSemanticCompactionContext = (packets = [], todos = []) => {
  const lines = [
    "OpenAI semantic compaction: preserve the latest unresolved objective and acceptance criteria; decisions and constraints; modified files and symbols; exact focused tests and outcomes; exact unresolved errors or blockers; next action; and relevant work packet and delegated child IDs.",
    "Discard raw or repeated tool output, duplicate logs, superseded hypotheses, and completed retries.",
  ];
  if (packets.length) lines.push("Relevant work packets:", ...packets.map(packetLine));
  if (todos.length) lines.push("Incomplete todos:", ...todos.map((todo) => `todo ${safeTodoContent(todo.content ?? todo.text ?? todo.title)}`).filter((line) => line !== "todo "));
  return lines.join("\n").slice(0, COMPACTION_CONTEXT_MAX_CHARS);
};
const codexSummaryFromStdout = (stdout) => {
  let summary = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        summary = event.item.text.slice(-CODEX_SUMMARY_MAX_CHARS);
      }
    } catch {}
  }
  return summary;
};
const release = async (token) => {
  if (!token) return;
  const result = await runProcessAsync(RELEASE, [token], { env: process.env });
  if (result.status !== 0) {
    const error = new Error(`RESERVATION_RELEASE_FAILED:${result.status ?? "unknown"}`);
    error.code = "RESERVATION_RELEASE_FAILED";
    error.retryable = true;
    throw error;
  }
};

const masterParent = (sessionID) => {
  if (masterParentBySession.has(sessionID)) return masterParentBySession.get(sessionID);
  return sessionID;
};

export const findPendingMandatoryTesterGate = async (rootSessionID, deps = {}) => {
  const packets = await (deps.listWorkPackets || listWorkPackets)();
  const candidates = (Array.isArray(packets) ? packets : []).filter((packet) =>
    packet?.parent_session_id === rootSessionID && packet.tester_required === true &&
    ["pending", "required"].includes(packet.tester_status) && packet.codex_outcome === "success" &&
    packet.outcome === "pending" && String(packet.phase || "").toLowerCase() === "pending_verification");
  if (candidates.length === 0) return null;
  if (candidates.length > 1) throw new GuardrailPolicyError("AMBIGUOUS_MANDATORY_TESTER_GATE");
  const packet = candidates[0];
  const task = await (deps.readTask || readTask)(packet.task_fingerprint);
  if (!task || task.task_fingerprint !== packet.task_fingerprint || task.state !== "PENDING_VERIFICATION" ||
      task.attempt !== packet.attempt || (packet.task_lease_id != null && task.lease_id !== packet.task_lease_id) ||
      task.parent_session_id !== packet.parent_session_id) {
    throw new GuardrailPolicyError("MANDATORY_TESTER_GATE_STATE_INVALID");
  }
  return packet;
};

const mandatoryTesterDispatchFailures = new Set();
const observedMandatoryTesterContinuations = new Set();
export const observeMandatoryTesterContinuation = (rootID, packetID, deps = {}) => {
  const key = `${rootID}:${packetID}`;
  observedMandatoryTesterContinuations.add(key);
  if (typeof deps.readWorkPacketByID !== "function" || typeof deps.updateWorkPacketByIDIfCurrent !== "function") return true;
  return (async () => {
    const packet = await deps.readWorkPacketByID(packetID);
    if (packet?.parent_session_id !== rootID || packet.test_task_id !== packetID || packet.tester_required !== true) {
      observedMandatoryTesterContinuations.delete(key);
      return { matched: false, packet: packet || null };
    }
    const result = await deps.updateWorkPacketByIDIfCurrent(packetID, { parent_session_id: rootID, tester_dispatch_state: ["dispatching", "requested"] }, { tester_dispatch_state: "observed" });
    if (!result?.matched && result?.packet?.tester_dispatch_state !== "observed") observedMandatoryTesterContinuations.delete(key);
    return result;
  })();
};
export const mandatoryTesterDispatchTrigger = (eventType) => eventType === "session.idle";
export const driveMandatoryTesterContinuation = async (rootSessionID, deps = {}) => {
  const gate = await findPendingMandatoryTesterGate(rootSessionID, deps);
  if (!gate) return { status: "noop" };
  const packets = await (deps.listWorkPackets || listWorkPackets)();
  const terminal = new Set(["completed", "success", "failed", "error", "cancelled"]);
  const testerExists = (Array.isArray(packets) ? packets : []).some((packet) =>
    packet?.parent_session_id === rootSessionID && packet.agent === "tester" && packet.test_task_id === gate.packet_id &&
    !terminal.has(String(packet.outcome || "").toLowerCase())
  );
  if (testerExists) return { status: "existing", packet_id: gate.packet_id };
  const fail = async (code = "MANDATORY_TESTER_NOT_DISPATCHED") => {
    const key = `${rootSessionID}:${gate.packet_id}`;
    if (mandatoryTesterDispatchFailures.has(key)) return;
    mandatoryTesterDispatchFailures.add(key);
    observedMandatoryTesterContinuations.delete(key);
    if (typeof deps.fail === "function") await deps.fail(gate, code);
  };
  const observed = gate.tester_dispatch_state === "observed" || observedMandatoryTesterContinuations.has(`${rootSessionID}:${gate.packet_id}`);
  if (["dispatching", "requested"].includes(gate.tester_dispatch_state) && !observed) {
    return { status: "waiting", packet_id: gate.packet_id };
  }
  if (observed) {
    await fail();
    return { status: "failed", packet_id: gate.packet_id };
  }
  const cas = await (deps.updateWorkPacketByIDIfCurrent || updateWorkPacketByIDIfCurrent)(gate.packet_id, {
    tester_status: ["pending", "required"], phase: "pending_verification", outcome: "pending", codex_outcome: "success",
    tester_dispatch_state: [undefined, "pending"],
  }, { tester_dispatch_state: "dispatching" });
  if (!cas?.matched) return { status: "noop", packet_id: gate.packet_id };
  const text = `<!-- OMO_INTERNAL_INITIATOR --> MANDATORY_TESTER_GATE test_task_id=${gate.packet_id}\nCall the native task exactly once with subagent_type tester. Do not use Bash. Do not report final success.`;
  try {
    if (typeof deps.enqueue !== "function") throw new Error("MANDATORY_TESTER_ENQUEUE_UNAVAILABLE");
    const response = await deps.enqueue(rootSessionID, text);
    if (response?.error || response?.failure || response?.status === "error" || response?.status === "failed" || response?.status === "failure") throw new Error("MANDATORY_TESTER_ENQUEUE_FAILED");
    const requested = await (deps.updateWorkPacketByIDIfCurrent || updateWorkPacketByIDIfCurrent)(gate.packet_id, { tester_dispatch_state: "dispatching" }, { tester_dispatch_state: "requested" });
    if (!requested?.matched && requested?.packet?.tester_dispatch_state === "observed") return { status: "observed", packet_id: gate.packet_id };
    if (!requested?.matched) return { status: "waiting", packet_id: gate.packet_id };
    return { status: "requested", packet_id: gate.packet_id };
  } catch (error) {
    await (deps.updateWorkPacketByIDIfCurrent || updateWorkPacketByIDIfCurrent)(gate.packet_id, { tester_dispatch_state: "dispatching" }, { tester_dispatch_state: "pending", error_code: "MANDATORY_TESTER_ENQUEUE_FAILED" });
    await fail("MANDATORY_TESTER_ENQUEUE_FAILED");
    return { status: "failed", packet_id: gate.packet_id };
  }
};

export const enforcePendingMandatoryTesterGate = (packet, { tool, agent, prompt = "", active = false } = {}) => {
  if (!packet) return { allowed: true, prompt };
  if (tool !== "task" || agent !== "tester") return { allowed: false, reason: "MANDATORY_TESTER_GATE" };
  const requestedID = String(prompt).match(/\btest_task_id=([^\s]+)/i)?.[1]?.toLowerCase();
  if (requestedID && requestedID !== packet.packet_id) return { allowed: false, reason: "MANDATORY_TESTER_GATE" };
  if (active) return { allowed: false, reason: "TESTER_ALREADY_ACTIVE" };
  return { allowed: true, prompt: requestedID ? String(prompt) : `${prompt}\n\nMandatory verification tester: test_task_id=${packet.packet_id}` };
};

export const createMandatoryTesterRootDriver = ({ pluginInput = {}, updateWorkPacketByID: updatePacket = updateWorkPacketByID, reconcileGateTarget }) => async (rootID, options = {}) => {
  const result = await driveMandatoryTesterContinuation(rootID, {
    listWorkPackets: pluginInput.listWorkPackets || listWorkPackets,
    readTask: pluginInput.readTask || readTask,
    updateWorkPacketByIDIfCurrent: pluginInput.updateWorkPacketByIDIfCurrent || updateWorkPacketByIDIfCurrent,
    failRequested: options.failRequested,
    enqueue: async (destinationRoot, text) => {
      const session = pluginInput.client?.session;
      const prompt = session?.promptAsync;
      if (typeof prompt !== "function") throw new Error("MANDATORY_TESTER_ENQUEUE_UNAVAILABLE");
      return prompt.call(session, { path: { id: destinationRoot }, body: { parts: [{ type: "text", text }], agent: "openai_orchestrator" } });
    },
    fail: async (gate, code = "MANDATORY_TESTER_NOT_DISPATCHED") => {
      await updatePacket(gate.packet_id, { phase: "foreground_completion", outcome: "failed", tester_status: "failed", verification_status: "failed", error_code: code });
      await reconcileGateTarget({ ...gate, phase: "foreground_completion", outcome: "failed", tester_status: "failed", verification_status: "failed", error_code: code });
    },
  });
  if (result.status === "noop") {
    for (const key of observedMandatoryTesterContinuations) if (key.startsWith(`${rootID}:`)) observedMandatoryTesterContinuations.delete(key);
  }
  return result;
};

const objectiveHash = (objective) => createHash("sha256").update(objective).digest("hex");
const canonicalObjective = (objective) => String(objective || "").trim().replace(/\s+/g, " ");
const resultSummary = (output) => {
  const value = output?.output ?? output?.text ?? output?.result ?? output;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
};
export const parseReviewerVerdict = (value) => {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4);
  return lines[0] === "APPROVE" || lines[0] === "REJECT" ? { verdict: lines[0], reason: lines.slice(1).join(" ").slice(0, 300) } : null;
};
export const parseTesterResult = (output) => {
  if (output?.error) return { status: "failed", code: "TEST_FAILED" };
  const lines = resultSummary(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] === "TEST_FAIL") return { status: "failed", code: "TEST_FAILED" };
  if (lines[0] !== "TEST_PASS" || lines.length < 2) return { status: "invalid", code: "TEST_RESULT_INVALID" };
  if (lines.slice(1).some((line) => { try { JSON.parse(line); return false; } catch { return true; } })) return { status: "invalid", code: "TEST_RESULT_INVALID" };
  const evidence = parseVerificationEvidence(lines.slice(1).join("\n"));
  const summary = evidence.summary;
  if (!summary || summary.status === "failed" || summary.failed_count > 0 || evidence.some((entry) => entry.exit_code !== 0)) return { status: "failed", code: "TEST_FAILED", evidence };
  if (summary.status !== "passed" || !Number.isInteger(summary.recognized_count) || summary.recognized_count <= 0 || !Number.isInteger(summary.failed_count) || !Number.isInteger(summary.truncated_count) || summary.failed_count !== 0 || summary.truncated_count !== 0 || evidence.length === 0) return { status: "invalid", code: "TEST_RESULT_INVALID", evidence };
  return { status: "passed", evidence };
};
const parseSerializedArray = (value) => {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed : [];
};
export const testerEvidenceFromMessages = (messages, pending = {}) => {
  if (!Array.isArray(messages)) throw new Error("TEST_MESSAGES_UNAVAILABLE");
  const evidence = [];
  const nonemptyArray = (...values) => values.map(parseSerializedArray).find((value) => value.length > 0) || [];
  const recordedHashes = nonemptyArray(pending.expected_verification_hashes, pending.gate_target?.expected_verification_hashes);
  const commands = nonemptyArray(pending.verification_commands, pending.gate_target?.verification_commands);
  const serializedEvidence = nonemptyArray(pending.verification_evidence, pending.gate_target?.verification_evidence);
  const expectedHashes = new Set((recordedHashes.length ? recordedHashes : [...commands.filter((command) => typeof command === "string" && isAllowlistedVerificationCommand(command)).map((command) => createHash("sha256").update(command).digest("hex")), ...serializedEvidence.map((entry) => entry?.command_hash)])
    .filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)).map((hash) => hash.toLowerCase()));
  let invalid = !pending.child_session_id || timestamp(pending.started_at) == null || expectedHashes.size === 0;
  const childSessionID = pending.child_session_id;
  const startedAt = timestamp(pending.started_at);
  for (const message of messages) {
    const info = message?.info || {};
    const sessionID = info.sessionID || info.session_id || message?.sessionID || message?.session_id;
    const validMessage = sessionID === childSessionID && String(info.role || "").toLowerCase() === "assistant" && String(info.agent || message?.agent || "").toLowerCase() === "tester" && messageTime(info, "created") >= startedAt;
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (String(part?.type || "").toLowerCase() !== "tool" || String(part?.tool || part?.name || "").toLowerCase() !== "bash") continue;
      const state = part.state || {};
      const status = String(state.status || part.status || "").toLowerCase();
      const metadata = state.metadata || part.metadata || {};
      const input = state.input || part.input || part.args || {};
      const command = input.command ?? input.cmd;
      const exit = metadata.exit_code ?? metadata.exitCode ?? metadata.exit ?? state.exit_code ?? part.exit_code;
      if (!validMessage || status !== "completed" || typeof command !== "string" || !Number.isInteger(exit) || !isAllowlistedVerificationCommand(command)) { invalid = true; continue; }
       const commandHash = createHash("sha256").update(command).digest("hex");
        if (!expectedHashes.has(commandHash)) continue;
       evidence.push({ command_hash: commandHash, command_name: verificationCommandCategory(command), exit_code: exit });
    }
  }
   const matched = new Map();
   for (const entry of evidence) if (!matched.has(entry.command_hash)) matched.set(entry.command_hash, entry);
    const complete = [...expectedHashes].every((expected) => matched.has(expected));
    // A repeated expected command is failed if any execution failed; a first
    // successful receipt must not mask a later non-zero exit.
    const allPassed = complete && [...expectedHashes].every((expected) => evidence.filter((entry) => entry.command_hash === expected).every((entry) => entry.exit_code === 0));
   const summary = { recognized_count: evidence.length, passed_count: evidence.filter((entry) => entry.exit_code === 0).length, failed_count: evidence.filter((entry) => entry.exit_code !== 0).length, truncated_count: 0, status: invalid || evidence.length === 0 || !complete ? "missing" : allPassed ? "passed" : "failed" };
  Object.defineProperty(evidence, "summary", { value: summary, enumerable: false });
  return evidence;
};
const criteriaFrom = (objective) => String(objective || "").split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\s*(?:[-*]\s*)?(?:acceptance|criteria|expect|verify|test|check|run)\s*[:\-]?\s*(.+)$/i);
  return match ? [match[1].trim()] : [];
});
const eventMetadata = (packet, extra = {}) => ({ task_id: packet?.packet_id || (packet?.task_call_id ? objectiveHash(packet.task_call_id) : null), attempt: packet?.attempt ?? null, classification: packet?.classification || null, complexity: packet?.complexity || null, codex_profile: packet?.codex_profile || null, ...extra });
const objectiveLogPath = () => join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "logs", "authorship-guard.log");
const recordObjectiveEvent = async (event, sessionID, parentSessionID, callID, authorityState, action) => {
  const path = objectiveLogPath();
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${new Date().toISOString()} ${event} ${sessionID || "-"} ${parentSessionID || "-"} ${callID || "-"} ${authorityState || "NONE"} ${action}\n`, { mode: 0o600 });
};

export const OpenAITeamTools = async (pluginInput = {}) => {
  telemetryErrorCallback = typeof pluginInput.onTelemetryError === "function" ? pluginInput.onTelemetryError : null;
  const completedMessageIDs = new Set();
  const guardrails = new Map();
  const guardrailFor = async (sessionID) => {
    if (!sessionID) return null;
    if (!guardrails.has(sessionID)) guardrails.set(sessionID, { ...createGuardrailState(), ...(await readStopLatch(process.env.OPENAI_TEAM_STATE_ROOT, sessionID)) });
    return guardrails.get(sessionID);
  };
  // Events can arrive before the child-session binding event. Keep each
  // message as an individually identified packet so that a later flush uses
  // the same durable dedup fence as a directly-bound event.
  const bufferedOpenCodeTokens = new Map();
  const packetCallBySession = new Map();
  const finalizing = new Set();
  const reconciliations = new Map();
  const reconciliationTimers = new Map();
  const reconciliationFile = (key) => join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "reconciliations", `${createHash("sha256").update(String(key)).digest("hex")}.json`);
  const reconciliationLease = (key) => `${reconciliationFile(key)}.lease`;
  const leaseOwner = async (path) => { try { return JSON.parse(await readFile(join(path, "owner.json"), "utf8")); } catch { return null; } };
  const reconciliationWaitMs = () => { const value = Number(process.env.OPENAI_RECONCILIATION_LOCK_WAIT_MS ?? 5_000); return Number.isFinite(value) && value >= 1 ? Math.min(value, 300_000) : 5_000; };
   const reclaimMutex = async (key) => {
    const mutex = `${reconciliationLease(key)}.reclaim`, token = randomUUID(), owner = await ownerForProcess(token, 30_000);
    const deadline = Date.now() + reconciliationWaitMs();
    while (Date.now() < deadline) {
      const stage = `${mutex}.acquire-${token}-${randomUUID()}`;
      try {
        await mkdir(stage, { mode: 0o700 });
        await writeFile(join(stage, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        await rename(stage, mutex);
        return { mutex, owner };
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      }
      const current = await leaseOwner(mutex);
      let reclaim = Boolean(current) && (await ownerCanBeReclaimed(current, Date.now(), 1_000)).reclaim;
      if (!current) {
        try { reclaim = Date.now() - (await stat(mutex)).mtimeMs >= 1_000; } catch { reclaim = false; }
      }
       if (reclaim) {
         const snapshot = current ? JSON.parse(JSON.stringify(current)) : null;
         const fenced = `${mutex}.stale-${randomUUID()}`;
         try {
           await rename(mutex, fenced);
           const successorStage = `${mutex}.successor-${owner.token}-${randomUUID()}`;
           await mkdir(successorStage, { mode: 0o700 });
           await writeFile(join(successorStage, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
           await rename(successorStage, mutex);
           const successor = { mutex, owner };
           const moved = await leaseOwner(fenced);
           const successorOwner = await leaseOwner(mutex);
           if (successor && JSON.stringify(moved) === JSON.stringify(snapshot) && JSON.stringify(successorOwner) === JSON.stringify(owner) && (await ownerCanBeReclaimed(snapshot, Date.now(), 1_000)).reclaim) await rm(fenced, { recursive: true, force: true });
           else if (!await leaseOwner(mutex)) { try { await rename(fenced, mutex); } catch {} }
           if (successor) await releaseReclaimMutex(successor.path, successor.token);
         } catch { if (!await leaseOwner(mutex)) { try { await rename(fenced, mutex); } catch {} } }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    }
    try { telemetryErrorCallback?.(new Error("RECONCILIATION_LOCK_TIMEOUT"), { stage: "reconciliation", code: "RECONCILIATION_REQUIRED", retryable: true }); } catch {}
    return null;
  };
  const releaseReclaimMutex = async ({ mutex, owner }) => { if (!mutex || (await leaseOwner(mutex))?.token !== owner?.token) return; const fenced = `${mutex}.release-${owner.token}`; try { await rename(mutex, fenced); } catch { return; } if ((await leaseOwner(fenced))?.token === owner.token) await rm(fenced, { recursive: true, force: true }); else { try { await rename(fenced, mutex); } catch {} } };
   const serializedReclaimLease = async (key, captured) => {
    const lease = reconciliationLease(key), mutex = await reclaimMutex(key), token = randomUUID(), moved = `${lease}.stale-${token}`;
    if (!mutex) return false;
    try {
       const current = await leaseOwner(lease);
       if (JSON.stringify(current) !== JSON.stringify(captured)) return;
       if ((await ownerCanBeReclaimed(captured, Date.now(), 1_000)).reclaim !== true) return;
      try { await rename(lease, moved); } catch { return; }
       const movedOwner = await leaseOwner(moved);
       if (JSON.stringify(movedOwner) === JSON.stringify(captured) && (await ownerCanBeReclaimed(captured, Date.now(), 1_000)).reclaim) await rm(moved, { recursive: true, force: true });
      else if (!await leaseOwner(lease)) { try { await rename(moved, lease); } catch {} }
      else await rm(moved, { recursive: true, force: true });
    } finally { await releaseReclaimMutex(mutex); }
  };
  const acquireReconciliationLease = async (key) => {
     const lease = reconciliationLease(key), token = randomUUID(), owner = await ownerForProcess(token, 30_000);
    const deadline = Date.now() + 5_000, orphanGrace = 1_000;
    await mkdir(join(lease, ".."), { recursive: true, mode: 0o700 });
    while (Date.now() < deadline) {
      const stage = `${lease}.acquire-${token}-${randomUUID()}`;
      const gate = await reclaimMutex(key);
      if (!gate) continue;
      try {
        await mkdir(stage, { mode: 0o700 });
        await writeFile(join(stage, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        await rename(stage, lease);
        return owner;
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      } finally {
        await releaseReclaimMutex(gate);
      }
      const current = await leaseOwner(lease);
       let reclaim = Boolean(current) && (await ownerCanBeReclaimed(current, Date.now(), orphanGrace)).reclaim;
      if (!current) {
        try { reclaim = Date.now() - (await stat(lease)).mtimeMs >= orphanGrace; } catch { reclaim = false; }
      }
       if (reclaim) { await serializedReclaimLease(key, current); continue; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };
   const releaseReconciliationLease = async (key, owner) => { const lease = reconciliationLease(key); if ((await leaseOwner(lease))?.token !== owner?.token) return; const fenced = `${lease}.release-${owner.token}`; try { await rename(lease, fenced); } catch { return; } if ((await leaseOwner(fenced))?.token === owner.token) await rm(fenced, { recursive: true, force: true }); else { try { await rename(fenced, lease); } catch {} } };
  const loadReconciliation = async (key) => { try { return JSON.parse(await readFile(reconciliationFile(key), "utf8")); } catch { return null; } };
  const saveReconciliation = async (key, record) => { const target = reconciliationFile(key), temporary = `${target}.${randomUUID()}.tmp`; await mkdir(join(target, ".."), { recursive: true, mode: 0o700 }); await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 }); await rename(temporary, target); };
  const clearReconciliation = async (key) => { await rm(reconciliationFile(key), { force: true }); };
  const validReconciliation = (record) => record && typeof record === "object" && record.pending && typeof record.pending.task_call_id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(record.pending.task_call_id) && typeof record.pending.token === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(record.pending.token) && Array.isArray(record.pending_steps);
  let scheduleReconciliation = () => {};
  const sameLifecycleIdentity = (task, pending) => task && pending?.task_fingerprint === task.task_fingerprint && Number(pending.attempt) === Number(task.attempt) && pending.task_lease_id === task.lease_id;
  const policyRemovalExpected = (pending) => ({ expectedAttempt: pending?.attempt, expectedLease: pending?.task_lease_id, expectedRun: pending?.codex_run_id });
  const terminalPolicyStates = new Set([CODEX_SUCCESS, CODEX_TASK_FAILED, CODEX_TIMEOUT, CODEX_ABORTED, TERRA_FALLBACK]);
  const sealedNoMutationRecovery = (recovery, reservation, runID = null) => Boolean(
    recovery && reservation && recovery.fingerprint === reservation.task_fingerprint
      && Number(recovery.attempt) === Number(reservation.attempt)
      && recovery.task_lease_id === reservation.task_lease_id
      && (!runID || recovery.codex_run_id === runID)
      && recovery.termination_sealed === true
      && recovery.journal_scan_complete === true
      && recovery.journal_incomplete === false
      && Array.isArray(recovery.command_journal)
      && recovery.command_journal.length === 0
      && recovery.sealed_run_id === recovery.codex_run_id
      && recovery.sealed_lease_id === recovery.task_lease_id
  );
  const transitionCurrentPolicy = async (sessionID, status, metadata = {}) => {
    const current = await readPolicy(sessionID);
    if (!current) throw new PolicyConflictError({ task_id: sessionID, reason: "policy_absent" });
    try {
      return await transitionPolicy(sessionID, status, { ...metadata, expectedVersion: current.version });
    } catch (error) {
      if (!(error instanceof PolicyConflictError)) throw error;
      const latest = await readPolicy(sessionID);
      if (terminalPolicyStates.has(status) && latest?.status === status) return latest;
      throw error;
    }
  };
  const settleGatePolicy = async (packet, task) => {
    const sessionID = packet?.child_session_id;
    if (!sessionID || !task || packet.task_fingerprint !== task.task_fingerprint || Number(packet.attempt) !== Number(task.attempt) || !task.lease_id) return null;
    let policy = await readPolicy(sessionID);
    if (!policy || policy.agent !== "codex_executor" || policy.session_id !== sessionID
      || policy.task_fingerprint !== task.task_fingerprint || Number(policy.attempt) !== Number(task.attempt)
      || policy.task_lease_id !== task.lease_id
       || typeof packet.task_call_id !== "string" || !packet.task_call_id
       || typeof packet.packet_id !== "string" || !packet.packet_id
       || policy.task_call_id !== packet.task_call_id
       || policy.packet_id !== packet.packet_id) return null;
    const packetRunID = typeof packet.codex_run_id === "string" && packet.codex_run_id.length > 0 ? packet.codex_run_id : null;
    if (!packetRunID || (policy.codex_run_id != null && policy.codex_run_id !== packetRunID)) return null;
    if (policy.status !== CODEX_SUCCESS) {
      if (policy.status === CODEX_REQUIRED) policy = await transitionPolicy(sessionID, CODEX_RUNNING, { expectedVersion: policy.version });
      if (policy.status === CODEX_RUNNING || policy.status === CODEX_UNKNOWN) policy = await transitionPolicy(sessionID, CODEX_SUCCESS, { expectedVersion: policy.version });
    }
    const terminal = await readPolicy(sessionID);
    if (terminal?.status === CODEX_SUCCESS) {
      try { await removePolicy(sessionID, { expectedVersion: terminal.version, expectedStatus: CODEX_SUCCESS, expectedAttempt: task.attempt, expectedLease: task.lease_id, ...(terminal.codex_run_id == null ? {} : { expectedRun: terminal.codex_run_id }) }); } catch {}
    }
    return terminal;
  };
  const finalizeReservation = async (pending, { outcome = "completed", result_summary: summary = outcome, sessionID = null, terminal = true, packet = true, taskAction = terminal ? "complete" : null } = {}) => {
    const key = pending?.task_call_id;
    if (!key || finalizing.has(key)) return { code: "LIFECYCLE_ALREADY_FINALIZED", retryable: false, phase: "finalize", task_id: pending?.task_fingerprint || null, provider_failure: false };
    finalizing.add(key);
    const manualRecovery = pending.manual_recovery === true;
    const record = reconciliations.get(key) || await loadReconciliation(key) || { retry_count: 0, task_action: taskAction, finalize: { outcome, result_summary: summary, sessionID, terminal, packet, taskAction, manualRecovery }, pending_steps: manualRecovery ? ["policy_terminal", ...(packet ? ["packet"] : []), ...(taskAction ? ["task"] : []), "recovery", "recovery_home", ...(sessionID ? ["policy"] : [])] : ["release", ...(packet ? ["packet"] : []), ...(taskAction ? ["task"] : []), ...(sessionID && (taskAction || terminal) ? ["policy"] : []), ...(pending?.lane_homes?.length ? ["lane_homes"] : [])], pending: { ...pending, lane_homes: pending?.lane_homes || [] } };
    record.pending ||= { ...pending };
    if (!reconciliations.has(key)) {
      try { await saveReconciliation(key, record); } catch { finalizing.delete(key); return { code: "RECONCILIATION_PERSISTENCE_FAILED", retryable: true, phase: "finalize", task_id: record.pending?.task_fingerprint || null, provider_failure: false }; }
      reconciliations.set(key, record);
    }
    // Once a cleanup has been persisted, use that snapshot.  Lifecycle
    // callbacks can be duplicated with a partial or stale in-memory object.
    const cleanup = record.pending;
    const durable = cleanup?.task_fingerprint ? await readTask(cleanup.task_fingerprint) : null;
    if (durable && !sameLifecycleIdentity(durable, cleanup)) {
      // The callback may still release only its own admission token; it must
      // never alter a newer task, packet, or policy.
      try { await release(cleanup.token); } catch {}
      finalizing.delete(key);
      return { code: "STALE_LIFECYCLE_EVENT", retryable: false, phase: "finalize", task_id: cleanup.task_fingerprint, provider_failure: false };
    }
    try {
      if (record.pending_steps.includes("release")) { await release(cleanup.token); record.pending_steps = record.pending_steps.filter((step) => step !== "release"); await saveReconciliation(key, record); }
      if ((terminal || manualRecovery) && cleanup.master_parent_session_id) {
        const parentGuard = guardrails.get(cleanup.master_parent_session_id);
        if (parentGuard) guardrails.set(cleanup.master_parent_session_id, finishDelegation(parentGuard, ["tester", "reviewer", "reviewer_critical"].includes(cleanup.role), cleanup.delegation_scope));
      }
      if (record.pending_steps.includes("policy_terminal")) {
        const policy = cleanup.sessionID ? await readPolicy(cleanup.sessionID) : null;
        if (policy && policy.status !== CODEX_SUCCESS) await transitionPolicy(cleanup.sessionID, CODEX_SUCCESS, { expectedVersion: policy.version, error: "manual_recovery_approved" });
        record.pending_steps = record.pending_steps.filter((step) => step !== "policy_terminal"); await saveReconciliation(key, record);
      }
      if (record.pending_steps.includes("packet")) { const packetPatch = { phase: manualRecovery ? "foreground_completion" : "background_completion", outcome: manualRecovery ? "completed" : outcome, duration_ms: elapsed(cleanup.started_at) }; const packet = cleanup.packet_id ? await updateWorkPacketByID(cleanup.packet_id, packetPatch) : await updateWorkPacket(key, packetPatch); if (!packet) throw new Error("FINALIZE_PACKET_UPDATE_FAILED"); record.pending_steps = record.pending_steps.filter((step) => step !== "packet"); await saveReconciliation(key, record); }
      if (record.pending_steps.includes("task")) {
        const task = await readTask(cleanup.task_fingerprint);
        if (task && !["COMPLETED", "FAILED"].includes(task.state)) {
          if (record.task_action === "complete") await completeTask(cleanup.task_fingerprint, { expectedVersion: task.version, expectedAttempt: cleanup.attempt, expectedLease: cleanup.task_lease_id, leaseId: cleanup.task_lease_id, result_summary: summary });
          else if (record.task_action === "fail") await transitionTask(cleanup.task_fingerprint, { expectedVersion: task.version, expectedAttempt: cleanup.attempt, expectedLease: cleanup.task_lease_id, expectedStates: ["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION"], leaseId: cleanup.task_lease_id, patch: { state: "FAILED", retryable: false, error_code: summary, result_summary: summary } });
        }
        record.pending_steps = record.pending_steps.filter((step) => step !== "task"); await saveReconciliation(key, record);
      }
      if (record.pending_steps.includes("recovery")) {
        if (cleanup.recovery) await removeRecovery(cleanup.task_fingerprint, cleanup.recovery);
        record.pending_steps = record.pending_steps.filter((step) => step !== "recovery"); await saveReconciliation(key, record);
      }
      if (record.pending_steps.includes("recovery_home")) {
        if (cleanup.recovery) await removeRecoveryHome(cleanup.task_fingerprint, cleanup.recovery);
        record.pending_steps = record.pending_steps.filter((step) => step !== "recovery_home"); await saveReconciliation(key, record);
      }
      if (record.pending_steps.includes("lane_homes")) {
        const recovery = cleanup.task_fingerprint ? await readRecovery(cleanup.task_fingerprint) : null;
        const preserved = recovery?.codex_home_identity;
        for (const home of Array.isArray(cleanup.lane_homes) ? cleanup.lane_homes : []) {
          if (home && home !== preserved) { await rm(home, { recursive: true, force: true }); await clearCodexHomePointer(home); }
        }
        record.pending_steps = record.pending_steps.filter((step) => step !== "lane_homes"); await saveReconciliation(key, record);
      }
      if (record.pending_steps.includes("policy")) {
        const taskForPolicy = cleanup.task_fingerprint ? await readTask(cleanup.task_fingerprint) : null;
        const policyTerminal = taskForPolicy
          && sameLifecycleIdentity(taskForPolicy, cleanup)
          && (taskForPolicy.state === "COMPLETED" || (taskForPolicy.state === "FAILED" && !taskForPolicy.retryable));
        if (policyTerminal) {
          const terminalPolicy = await readPolicy(sessionID);
          if (manualRecovery) {
            if (terminalPolicy?.status === CODEX_SUCCESS) await removePolicy(sessionID, { ...policyRemovalExpected(cleanup), ...(terminalPolicy.codex_run_id == null ? { expectedRun: undefined } : {}) });
          } else await removePolicy(sessionID, policyRemovalExpected(cleanup));
        }
        // A replacement policy is never removed by an old callback; a
        // non-terminal task retains its policy for recovery and gates.
        record.pending_steps = record.pending_steps.filter((step) => step !== "policy");
        await saveReconciliation(key, record);
      }
    } catch {
      // Reconciliation is deliberately non-transactional: retain every
      // unfinished step durably so a duplicate lifecycle callback can retry it.
      try { await saveReconciliation(key, record); } catch {}
    } finally {
      // A failed persistence attempt must not turn this in-memory guard into a
      // permanent finalizing state.
      finalizing.delete(key);
    }
    if (record.pending_steps.length) {
      record.retry_count += 1;
      // Best effort is intentional here: a transient persistence fault must
      // still leave this process able to retry on the next duplicate event.
      try { await saveReconciliation(key, record); } catch {}
      reconciliations.set(key, record);
      scheduleReconciliation(key, record);
      return { code: "RECONCILIATION_REQUIRED", retryable: true, phase: "finalize", task_id: cleanup.task_fingerprint || null, provider_failure: false, pending_steps: record.pending_steps, retry_count: record.retry_count };
    }
    reconciliations.delete(key); await clearReconciliation(key); reservations.delete(key);
    if (sessionID) { reservations.delete(sessionID); packetCallBySession.delete(sessionID); bufferedOpenCodeTokens.delete(sessionID); }
    return { code: "LIFECYCLE_FINALIZED", retryable: false, phase: "finalize", task_id: cleanup.task_fingerprint || null, provider_failure: false };
  };
  const drainReconciliations = async () => {
    let files = [];
    const directory = join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "reconciliations");
    try { files = await readdir(directory); } catch { return; }
    await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => {
      const path = join(directory, name);
      let record;
      try { record = JSON.parse(await readFile(path, "utf8")); } catch (error) {
        try { await rename(path, `${path}.quarantine.${randomUUID()}`); } catch {}
        try { telemetryErrorCallback?.(error, { stage: "reconciliation", code: "RECONCILIATION_CORRUPT" }); } catch {}
        return;
      }
      if (!validReconciliation(record)) {
        try { await rename(path, `${path}.quarantine.${randomUUID()}`); } catch {}
        try { telemetryErrorCallback?.(new Error("RECONCILIATION_CORRUPT"), { stage: "reconciliation", code: "RECONCILIATION_CORRUPT" }); } catch {}
        return;
      }
      const key = record.pending.task_call_id;
      const owner = await acquireReconciliationLease(key);
      if (!owner) return;
      try {
        // Another consumer may have completed and removed the journal while
        // this contender waited for its fenced lease.
        const current = await loadReconciliation(key);
        if (current && validReconciliation(current)) {
          const result = await finalizeReservation(current.pending, current.finalize || { terminal: false, packet: false });
          if (result?.retryable) await finalizeReservation(current.pending, current.finalize || { terminal: false, packet: false });
        }
      } finally { await releaseReconciliationLease(key, owner); }
    }));
  };
  scheduleReconciliation = (key, record) => {
    if (reconciliationTimers.has(key)) return;
    const delay = Math.min(30000, Math.max(0, 25 * (2 ** Math.min(10, Number(record.retry_count) || 0))));
    const timer = setTimeout(() => { reconciliationTimers.delete(key); void drainReconciliations(); }, delay);
    timer.unref?.(); reconciliationTimers.set(key, timer);
  };
  // Startup is itself the autonomous consumer; no lifecycle callback is needed.
  await drainReconciliations();
  const lifecycleFinalization = async (pending, eventType, sessionID) => {
    const task = pending?.task_fingerprint ? await readTask(pending.task_fingerprint) : null;
    if (task && !sameLifecycleIdentity(task, pending)) return finalizeReservation(pending, { outcome: eventType.replace("session.", ""), result_summary: "STALE_LIFECYCLE_EVENT", sessionID, terminal: false, packet: false });
    const terminal = task && (task.state === "COMPLETED" || (task.state === "FAILED" && !task.retryable));
    let taskAction = null;
    if (!terminal && eventType === "session.error") {
      const recovery = await readRecovery(pending.task_fingerprint);
      const matching = recovery && task && recovery.attempt === task.attempt && Array.isArray(recovery.command_journal);
      if (matching && (recovery.journal_incomplete === true || recovery.command_journal.length > 0)) {
        const packet = (await listWorkPackets()).find((entry) => entry.task_call_id === pending.task_call_id);
        await updateWorkPacketByID(packet.packet_id, manualRecoveryPacketPatch({
          recovery,
          packet,
          metadata: { error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED" },
        }));
        await advanceTask(pending, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", result_summary: "pending_manual_recovery_review" });
        return finalizeReservation(pending, { outcome: "error", result_summary: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", sessionID, terminal: false, packet: false });
       } else if (matching && sealedNoMutationRecovery(recovery, pending)) {
         await advanceTask(pending, "FAILED", { retryable: true, error_code: "SESSION_ERROR_RECOVERY_READY", result_summary: "recovery_ready" });
       } else {
         const packet = (await listWorkPackets()).find((entry) => entry.task_call_id === pending.task_call_id);
         if (matching) {
            await updateWorkPacketByID(packet.packet_id, manualRecoveryPacketPatch({ recovery, packet, metadata: { error_code: "RECOVERY_TERMINATION_UNSEALED" } }));
           await advanceTask(pending, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_TERMINATION_UNSEALED", result_summary: "pending_manual_recovery_review" });
           return finalizeReservation(pending, { outcome: "error", result_summary: "RECOVERY_TERMINATION_UNSEALED", sessionID, terminal: false, packet: false });
         }
         taskAction = "fail";
       }
    } else if (!terminal && eventType === "session.deleted") taskAction = "fail";
    // Idle is cleanup only. Successful Codex completion is recorded by its
    // durable gate path, never inferred from a lifecycle callback.
    const summary = eventType === "session.error" ? "SESSION_ERROR" : eventType === "session.deleted" ? "SESSION_DELETED" : "SESSION_IDLE";
     return finalizeReservation(pending, lifecycleCleanupOptions(eventType, { outcome: eventType.replace("session.", ""), result_summary: summary, sessionID, terminal, taskAction }));
  };
  const reconcileGateTarget = async (packet) => {
    if (!packet?.task_fingerprint) return packet;
    const settle = async () => {
      const task = await readTask(packet.task_fingerprint);
      if (!task || ["COMPLETED", "FAILED"].includes(task.state)) return task;
      // A retry reuses the fingerprint with a higher attempt.  A late gate event
      // for an older packet must never settle that new attempt.
      if (Number(task.attempt) !== Number(packet.attempt)) return task;
      if (packet.review_status === "review_rejected") return transitionTask(packet.task_fingerprint, {
        expectedVersion: task.version, expectedStates: ["PENDING_REVIEW", "PENDING_VERIFICATION"], leaseId: task.lease_id,
        patch: { state: "FAILED", retryable: true, error_code: "REVIEW_REJECTED", result_summary: "review_rejected" },
      });
       if (packet.tester_status === "failed") {
         await updateWorkPacketByID(packet.packet_id, { phase: "foreground_completion", outcome: "failed", codex_outcome: "failed" });
         return transitionTask(packet.task_fingerprint, {
        expectedVersion: task.version, expectedStates: ["PENDING_REVIEW", "PENDING_VERIFICATION"], leaseId: task.lease_id,
        patch: { state: "FAILED", retryable: true, error_code: packet.error_code || "TEST_FAILED", result_summary: "tester_failed" },
         });
       }
       let terminalPolicy = null;
       let terminalPolicySessionID = null;
       if (["approved", "not_required"].includes(packet.review_status) && ["passed", "not_required"].includes(packet.tester_status)) {
        if (packet.verification_status === "pending_manual_recovery_review") {
          const recovery = await readRecovery(packet.task_fingerprint);
           const childSessionID = packet.child_session_id;
           terminalPolicySessionID = childSessionID;
          const identityMatches = recovery
            && recovery.fingerprint === packet.task_fingerprint
             && recovery.attempt === (Number.isInteger(Number(packet.recovery_attempt)) ? Number(packet.recovery_attempt) : task.attempt)
            && recovery.codex_run_id === packet.codex_run_id
            && recovery.thread_id === packet.codex_thread_id;
          const policy = identityMatches && childSessionID ? await readPolicy(childSessionID) : null;
          const policyMatches = policy
            && policy.agent === "codex_executor"
            && policy.task_fingerprint === task.task_fingerprint
            && policy.attempt === task.attempt
            && policy.task_lease_id === task.lease_id
            && (policy.codex_run_id == null || policy.codex_run_id === packet.codex_run_id)
            && [CODEX_RUNNING, CODEX_UNKNOWN, CODEX_SUCCESS].includes(policy.status);
          // Every durable identity is checked before either CAS deletion.  A
          // stale reviewer event leaves the task pending instead of settling a
          // replacement recovery or child policy.
           if (!identityMatches || !policyMatches) {
             if (!identityMatches && !recovery) {
               await updateWorkPacketByID(packet.packet_id, { phase: "foreground_completion", outcome: "failed", error_code: "RECOVERY_EVIDENCE_MISSING" });
               return transitionTask(packet.task_fingerprint, {
                 expectedVersion: task.version, expectedStates: ["PENDING_REVIEW", "PENDING_VERIFICATION"], leaseId: task.lease_id,
                 patch: { state: "FAILED", retryable: false, error_code: "RECOVERY_EVIDENCE_MISSING", result_summary: "manual_review_settled_without_recovery_evidence" },
               });
             }
             return task;
           }
           const reconciled = await finalizeReservation({
             ...packet, token: "manual-recovery", started_at: Date.now(),
             task_lease_id: task.lease_id, manual_recovery: true, recovery,
             sessionID: childSessionID,
           }, { outcome: "completed", result_summary: "gates_passed", sessionID: childSessionID, terminal: true, packet: true, taskAction: "complete" });
           if (reconciled.code === "RECONCILIATION_REQUIRED" || reconciled.code === "RECONCILIATION_PERSISTENCE_FAILED") return task;
           return await readTask(packet.task_fingerprint);
        }
          await updateWorkPacketByID(packet.packet_id, gateTerminalPacketPatch(packet, true));
          const completed = await completeTask(packet.task_fingerprint, { expectedVersion: task.version, leaseId: task.lease_id, result_summary: "gates_passed" });
          await settleGatePolicy(packet, completed);
         return completed;
      }
      return task;
    };
     try { await settle(); } catch (error) {
       if (packet.verification_status === "pending_manual_recovery_review" && !(await readRecovery(packet.task_fingerprint))) {
         const recoveredTask = await readTask(packet.task_fingerprint);
         if (recoveredTask && !["COMPLETED", "FAILED"].includes(recoveredTask.state)) {
           try { await updateWorkPacketByID(packet.packet_id, { phase: "foreground_completion", outcome: "completed" }); } catch {}
           try { await completeTask(packet.task_fingerprint, { expectedVersion: recoveredTask.version, leaseId: recoveredTask.lease_id, result_summary: "gates_passed" }); } catch {}
           if (packet.child_session_id) {
             try {
               const terminal = await readPolicy(packet.child_session_id);
               if (terminal?.status === CODEX_SUCCESS) await removePolicy(packet.child_session_id, { expectedVersion: terminal.version, expectedStatus: CODEX_SUCCESS, expectedAttempt: recoveredTask.attempt, expectedLease: recoveredTask.lease_id });
             } catch {}
           }
         }
       }
       if (!(error instanceof TaskStateError) || !["TASK_VERSION_REJECTED", "TASK_STATE_REJECTED"].includes(error.code)) throw error;
       await settle();
     }
    return packet;
  };
    const parseExpectedVerificationHashes = (packet) => {
      const commands = parseSerializedArray(packet?.verification_commands);
      const commandHashes = commands.filter((command) => typeof command === "string" && isAllowlistedVerificationCommand(command)).map((command) => createHash("sha256").update(command).digest("hex"));
      const recorded = parseSerializedArray(packet?.expected_verification_hashes).filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)).map((hash) => hash.toLowerCase());
      const evidence = parseSerializedArray(packet?.verification_evidence);
      const evidenceHashes = evidence.map((entry) => entry?.command_hash).filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)).map((hash) => hash.toLowerCase());
      return recorded.length ? recorded : [...new Set([...commandHashes, ...evidenceHashes])];
    };
  const gateTargetSnapshot = async (packet) => {
    const task = packet?.task_fingerprint ? await readTask(packet.task_fingerprint) : null;
    if (!packet || !task || Number(task.attempt) !== Number(packet.attempt) || !task.lease_id) return null;
     return { packet_id: packet.packet_id, parent_session_id: packet.parent_session_id, task_fingerprint: packet.task_fingerprint, attempt: task.attempt, task_lease_id: task.lease_id, expected_verification_hashes: parseExpectedVerificationHashes(packet) };
  };
  const validateGateTarget = async (pending, packetID) => {
    const snapshot = pending?.gate_target;
    const packet = (await listWorkPackets()).find((candidate) => candidate.packet_id === packetID);
    const task = snapshot?.task_fingerprint ? await readTask(snapshot.task_fingerprint) : null;
     const expectedHashes = parseExpectedVerificationHashes(packet);
     if (!snapshot || !packet || packet.packet_id !== snapshot.packet_id || packet.parent_session_id !== snapshot.parent_session_id || packet.task_fingerprint !== snapshot.task_fingerprint || Number(packet.attempt) !== Number(snapshot.attempt) || (packet.task_lease_id != null && packet.task_lease_id !== snapshot.task_lease_id) || JSON.stringify(expectedHashes) !== JSON.stringify(snapshot.expected_verification_hashes || []) || !task || task.parent_session_id !== snapshot.parent_session_id || Number(task.attempt) !== Number(snapshot.attempt) || task.lease_id !== snapshot.task_lease_id) return { code: "STALE_GATE_EVENT", packet: null };
     return { code: null, packet };
   };
   const settleTesterGate = async (pending, childID) => {
    if (!pending?.test_task_id || !childID || pending.child_session_id !== childID) return { pending: true };
    const response = await pluginInput.client?.session.messages({ path: { id: childID } });
    const messages = unwrapData(response);
    const completed = Array.isArray(messages) && messages.some((message) => {
      const info = message?.info || {};
      return (info.sessionID || info.session_id || message?.sessionID || message?.session_id) === childID
        && String(info.role || "").toLowerCase() === "assistant"
        && (messageTime(info, "completed") != null || info.finish != null);
    });
    if (!completed) return { pending: true };
    const validation = await validateGateTarget(pending, pending.test_task_id);
    if (validation.code) return validation;
    let evidence;
    try { evidence = testerEvidenceFromMessages(messages, { ...pending, ...pending.gate_target }); }
    catch { evidence = []; Object.defineProperty(evidence, "summary", { value: { recognized_count: 0, passed_count: 0, failed_count: 0, truncated_count: 0, status: "missing" }, enumerable: false }); }
    const passed = evidence.summary?.status === "passed";
     if (evidence.summary?.status === "missing" || evidence.length === 0) {
       await updateWorkPacketByIDIfCurrent(pending.test_task_id, { tester_status: ["pending", "required"] }, { tester_status: "failed", error_code: "TEST_RESULT_INVALID", verification_evidence: evidence });
        const target = (await listWorkPackets()).find((entry) => entry.packet_id === pending.test_task_id);
        await reconcileGateTarget(target);
        const terminalTask = await readTask(target?.task_fingerprint);
        const root = guardrails.get(pending.master_parent_session_id);
        if (root && terminalTask) guardrails.set(pending.master_parent_session_id, settleVerificationGateState(root, pending.test_task_id, terminalTask.state));
        return { passed: false, code: "TEST_RESULT_INVALID" };
     }
    const update = await updateWorkPacketByIDIfCurrent(pending.test_task_id, { tester_status: ["pending", "required"] }, { tester_status: passed ? "passed" : "failed", verification_evidence: evidence, ...(passed ? {} : { error_code: "TEST_RESULT_INVALID" }) });
     const target = update.packet || validation.packet;
     await reconcileGateTarget(target);
     const terminalTask = await readTask(target?.task_fingerprint);
     if (terminalTask && ["COMPLETED", "FAILED"].includes(terminalTask.state)) {
       const root = guardrails.get(pending.master_parent_session_id);
       if (root) guardrails.set(pending.master_parent_session_id, settleVerificationGateState(root, pending.test_task_id, terminalTask.state));
     }
     return { passed, code: passed ? null : "TEST_RESULT_INVALID" };
  };
  const rememberCompletedMessage = (id) => {
    if (!id || completedMessageIDs.has(id)) return false;
    completedMessageIDs.add(id);
    if (completedMessageIDs.size > 4096) completedMessageIDs.delete(completedMessageIDs.values().next().value);
    return true;
  };
  const taskCallForSession = async (sessionID) => {
    const pending = reservations.get(sessionID);
     if (pending?.packet_id) return pending.packet_id;
     if (packetCallBySession.has(sessionID)) return packetCallBySession.get(sessionID);
    const policy = await readPolicy(sessionID);
     return policy?.packet_id || null;
  };
  const flushBufferedOpenCodeTokens = async (sessionID) => {
    const events = bufferedOpenCodeTokens.get(sessionID);
    if (!events?.size) return;
    const packetCallID = await taskCallForSession(sessionID);
    if (!packetCallID) return;
    for (const [hash, tokens] of events) {
       if (await addWorkPacketTokensByID(packetCallID, "opencode", tokens, hash)) events.delete(hash);
    }
    if (!events.size) bufferedOpenCodeTokens.delete(sessionID);
  };
  const resolveSessionAgent = async (sessionID) => {
    try {
      const response = await pluginInput.client?.session.messages({ path: { id: sessionID } });
      const agents = (response?.data || []).map((message) => message.info?.agent).filter(Boolean);
      return [...new Set(agents)].length === 1 ? agents[0] : null;
    } catch {
      return null;
    }
  };

  const resolveInitialObjective = async (sessionID) => {
    const result = await resolveInitialObjectiveFromClient(pluginInput.client, sessionID, new Set(), new Map());
    if (result?.rootSessionID && result.rootSessionID !== sessionID) masterParentBySession.set(sessionID, result.rootSessionID);
    return result;
  };
  const recoverCodexReservation = async (sessionID) => {
    try {
      const messages = await pluginInput.client?.session?.messages({ path: { id: sessionID } });
      const prompt = latestUserObjective(unwrapData(messages));
      const marker = extractTaskPacketMarker(prompt);
      if (marker.present && !marker.valid) return null;
      const session = (await pluginInput.client?.session?.get({ path: { id: sessionID } }))?.data;
      const parentID = session?.parentID || session?.parent_id || session?.parent?.id || null;
      const rootID = parentID ? ((await resolveInitialObjective(sessionID))?.rootSessionID || masterParent(parentID)) : null;
      const packet = marker.present
        ? await (pluginInput.readWorkPacketByID || readWorkPacketByID)(marker.packetID)
        : (await (pluginInput.listWorkPackets || listWorkPackets)()).find((entry) => entry.child_session_id === sessionID && entry.agent === "codex_executor" && ["pending", "running"].includes(String(entry.outcome || "").toLowerCase()));
      if (!packet) return null;
      const task = await readTask(packet.task_fingerprint);
      const objective = marker.present ? objectiveBeforeMarker(prompt) : prompt;
      if (!task || !objective || objectiveHash(objective) !== packet.objective_sha256 || (marker.present && packet.parent_session_id !== rootID) || packet.agent !== "codex_executor" || !["admitted", "codex_running", "foreground_bound", "running"].includes(String(packet.phase || "").toLowerCase()) || !["pending", "running"].includes(String(packet.outcome || "").toLowerCase()) || task.task_fingerprint !== packet.task_fingerprint || task.child_session_id !== sessionID || task.packet_id !== packet.packet_id || task.agent !== "codex_executor" || task.parent_session_id !== packet.parent_session_id || task.lease_id !== packet.task_lease_id || task.attempt !== packet.attempt || !["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION"].includes(task.state)) return null;
      const recovered = { ...packet, authoritative_objective: objective, master_parent_session_id: packet.parent_session_id, task_call_id: packet.task_call_id || packet.packet_id, task_id: task.task_fingerprint, task_fingerprint: task.task_fingerprint, packet_id: packet.packet_id, task_state_version: task.version, task_lease_id: task.lease_id, attempt: task.attempt, role: "codex_executor", child_session_id: sessionID };
      reservations.set(sessionID, recovered);
      packetCallBySession.set(sessionID, recovered.packet_id);
      return recovered;
    } catch { return null; }
  };

 const driveMandatoryTesterForRoot = createMandatoryTesterRootDriver({ pluginInput, updateWorkPacketByID, reconcileGateTarget });

 const plugin = ({
  "experimental.session.compacting": async ({ sessionID }, output) => {
    let packets = [], todos = [];
    try {
      [packets, todos] = await Promise.all([
        Promise.resolve((pluginInput.listWorkPackets || listWorkPackets)()).catch(() => []),
        Promise.resolve(pluginInput.client?.session?.todo?.({ path: { id: sessionID } })).then(unwrapData).catch(() => []),
      ]);
    } catch {}
    const relevantPackets = (Array.isArray(packets) ? packets : [])
      .filter((packet) => packet?.parent_session_id === sessionID || packet?.child_session_id === sessionID)
      .map((packet, index) => {
        const timestamp = Date.parse(packet?.updated_at);
        return { packet, index, timestamp: Number.isFinite(timestamp) ? timestamp : null };
      })
      .sort((left, right) => {
        if (left.timestamp === null && right.timestamp === null) return left.index - right.index;
        if (left.timestamp === null) return 1;
        if (right.timestamp === null) return -1;
        return right.timestamp - left.timestamp || left.index - right.index;
      })
      .slice(0, 8)
      .map(({ packet }) => packet);
    const incompleteTodos = (Array.isArray(todos) ? todos : []).filter((todo) => !["completed", "cancelled"].includes(String(todo?.status || todo?.state || "").toLowerCase())).slice(0, 12);
    const context = renderSemanticCompactionContext(relevantPackets, incompleteTodos);
     await Promise.all(relevantPackets.map((packet) => incrementWorkPacketByID(packet.packet_id, {
      compaction_count: 1, compaction_input_chars: context.length, compaction_output_chars: context.length,
    })));
    output.context = Array.isArray(output.context) ? output.context : [];
    output.context.push(context.slice(0, COMPACTION_CONTEXT_MAX_CHARS));
    await recordLatency({ stage: "semantic_compaction", outcome: "context_injected", packet_count: relevantPackets.length, todo_count: incompleteTodos.length, session_id: sessionID, ...eventMetadata(relevantPackets[0]) });
  },
  tool: {
    openai_run_codex: tool({
      description: "Run coding work through the OpenAI team's mandatory single Codex lane.",
      args: {
        task: tool.schema.string().describe("The coding objective for Codex."),
        repository: tool.schema.string().optional().describe("Absolute repository path; defaults to the current workspace."),
        timeout_seconds: tool.schema.number().optional().describe("Maximum Codex runtime in seconds, capped at 900."),
      },
      async execute(args, context) {
        const guard = await guardrailFor(context.sessionID);
        if (guard) guardrails.set(context.sessionID, admitToolCall(guard));
        const allocatedHomes = new Set();
        const removeOwnedHome = async (home) => {
          if (!home) return;
          await rm(home, { recursive: true, force: true });
          await clearCodexHomePointer(home);
          allocatedHomes.delete(home);
        };
        if (context.agent !== "codex_executor") {
          throw new Error("openai_run_codex is restricted to the codex_executor native task.");
        }
        const task = String(args.task || "");
        if (/\breturn\s+fallback_required\b|\bsimulat(?:e|ing)\s+(?:a\s+)?provider\s+failure\b|\bauthoriz(?:e|ing)\s+(?:native\s+)?terra\s+(?:editing|fallback)\b|\bopen\s+the\s+circuit\s+breaker\b|\bmanufactur(?:e|ing)\s+(?:a\s+)?fallback\b/i.test(task)) {
          throw new Error("Codex task rejected: fallback state must come only from structured runtime/provider results; submit the actual coding objective.");
        }
         let reservation = reservations.get(context.sessionID);
         if (!reservation && context.agent === "codex_executor") reservation = await recoverCodexReservation(context.sessionID);
        const testObjective = await pluginInput.authoritativeObjectiveForSession?.(context.sessionID);
        const initialObjective = reservation ? null : await resolveInitialObjective(context.sessionID);
        const authoritativeObjective = reservation?.authoritative_objective || initialObjective?.objective || testObjective;
        let policy = await readPolicy(context.sessionID);
        if (!authoritativeObjective) {
          if (policy?.agent === "codex_executor" && policy.status !== CODEX_REQUIRED) {
            throw new Error("Codex authorship policy is missing or terminal; return control to the parent and do not retry Codex.");
          }
          await recordObjectiveEvent("codex_execution_rejected_no_objective", context.sessionID, null, context.callID, "NONE", "BLOCK");
          throw new Error("Codex authorship objective is not bound to this child session; refusing execution.");
        }
        if (!policy && (testObjective || initialObjective)) {
          policy = await ensurePolicy(context.sessionID, {
            agent: context.agent,
            worktree: context.worktree,
            master_parent_session_id: initialObjective?.parentSessionID || null,
            objective_sha256: objectiveHash(authoritativeObjective),
          });
        }
        if (!policy || policy.agent !== "codex_executor" || policy.status !== CODEX_REQUIRED) throw new Error("Codex authorship policy is missing or terminal; return control to the parent and do not retry Codex.");
        if (!reservation && initialObjective) {
          reservation = {
            authoritative_objective: authoritativeObjective,
            master_parent_session_id: initialObjective.parentSessionID,
          };
          reservations.set(context.sessionID, reservation);
          await recordObjectiveEvent("objective_bound", context.sessionID, initialObjective.parentSessionID, context.callID, policy.status, "BOUND");
        }
          const packetCallID = await taskCallForSession(context.sessionID);
          const packet = packetCallID ? await updateWorkPacketByID(packetCallID, { phase: "codex_running", codex_outcome: "running" }) : null;
          if (packetCallID && !packet) throw new Error("CODEX_PACKET_UPDATE_FAILED");
          if (packetCallID) await incrementWorkPacketByID(packetCallID, { wrapper_round_trips: 1 });
         await recordObjectiveEvent("codex_execution_admitted", context.sessionID, reservation?.master_parent_session_id, context.callID, policy.status, "ALLOW");
        await transitionCurrentPolicy(context.sessionID, CODEX_RUNNING);
        await advanceTask(reservation, "RUNNING");
        const repository = args.repository || context.directory || process.cwd();
        const reservationFingerprint = typeof reservation?.task_fingerprint === "string" ? reservation.task_fingerprint : "";
        const storedRecovery = reservation?.task_fingerprint && reservation?.attempt > 1 ? await readRecovery(reservation.task_fingerprint) : null;
        // The task-state lease owns a single continuation: only the next attempt
        // may resume the thread that was durably fenced by its predecessor.
         const recovery = storedRecovery && storedRecovery.fingerprint === reservation?.task_fingerprint && storedRecovery.attempt === reservation.attempt - 1 && storedRecovery.resume_count === 0 && Number.isInteger(storedRecovery.version) && storedRecovery.version > 0 && typeof storedRecovery.thread_id === "string" && storedRecovery.thread_id.length > 0 && storedRecovery.termination_sealed === true && storedRecovery.journal_scan_complete === true && storedRecovery.journal_incomplete === false && Array.isArray(storedRecovery.command_journal) && storedRecovery.command_journal.length === 0 && storedRecovery.sealed_run_id === storedRecovery.codex_run_id && storedRecovery.sealed_lease_id === storedRecovery.task_lease_id ? storedRecovery : null;
        const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds ?? process.env.OPENAI_CODEX_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS), 1), MAX_TIMEOUT_SECONDS);
        const progressState = { status: "running", kind: "codex_progress", event_count: 0, bytes: 0, last_progress_at: null };
        let lastProgressReport = 0;
         const report = async (metadata) => {
           if (typeof context.metadata === "function") await context.metadata({ metadata: eventMetadata(packet || reservation, metadata) });
        };
        const onProgress = (event) => {
          progressState.event_count += Math.max(1, event.lines || 0);
          progressState.bytes += event.bytes || 0;
          progressState.last_progress_at = new Date().toISOString();
          const now = Date.now();
          if (now - lastProgressReport >= 1000) {
            lastProgressReport = now;
            void report({ ...progressState });
          }
        };
        await report({ status: "running", kind: "codex_execution", timeout_seconds: timeoutSeconds });
        const codexStartedAt = Date.now();
        const modelPlan = resolveCodexModels(reservation?.codex_profile || process.env.OPENAI_CODEX_PROFILE, process.env);
        let executedModel = modelPlan.requested_model;
        let fallbackReason = null, fallbackCount = 0;
        const invocationAttempt = reservation?.attempt || 1;
        const invocationID = randomUUID();
        const modelTelemetry = () => ({
          requested_model: modelPlan.requested_model,
          executed_model: executedModel,
          fallback_model: modelPlan.fallback_model,
          fallback_reason: fallbackReason,
          fallback_count: fallbackCount,
          invocation_id: invocationID,
        });
        // Task failures cross a trust boundary.  Never reflect process output,
        // exception text, paths, prompts, or other lane diagnostics here.
        const taskFailure = (code, reason = "task_failure", handoffID = null) => ({
          code,
          reason: ["temporary_transport", "quota", "rate_limit", "capacity", "model_unavailable", "provider_failure", "task_failure", "process_error", "aborted", "handoff_invalid", "launch_failure"].includes(reason) ? reason : "task_failure",
          ...modelTelemetry(),
          handoff_id: typeof handoffID === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(handoffID) ? handoffID : null,
        });
        const activeHandoff = (value) => handoffMatchesInvocation(value, {
          profile: modelPlan.profile,
          requested_model: modelPlan.requested_model,
          executed_model: executedModel,
          fallback_model: modelPlan.fallback_model,
          fallback_count: fallbackCount,
          attempt: invocationAttempt,
          invocation_id: invocationID,
        });
        const pendingManualRecovery = (recovery, metadata = {}) => manualRecoveryPacketPatch({
          recovery,
          packet,
          metadata: { profile: modelPlan.profile, ...modelTelemetry(), ...metadata },
        });
         const recordCodexTerminal = async (outcome, result = {}) => {
          const durationMs = elapsed(codexStartedAt);
           const preservePending = result.preserve_pending === true;
           if (!preservePending && result.validated_handoff === true && reservation?.task_fingerprint && laneHome) {
             const current = await readRecovery(reservation.task_fingerprint);
             const expected = current ? { ...current, task_lease_id: reservation.task_lease_id, codex_home_identity: current.codex_home } : { version: 1, attempt: reservation.attempt, task_lease_id: reservation.task_lease_id, thread_id: terminalHandoff?.thread_id || "", codex_run_id: terminalHandoff?.codex_run_id || "", codex_home: laneHome, codex_home_identity: laneHome };
             try { if (current) await removeRecoveryAndHome(reservation.task_fingerprint, expected); else await removeRecoveryHome(reservation.task_fingerprint, expected); } catch {}
           }
           if (packetCallID && !preservePending) await updateWorkPacketByID(packetCallID, { phase: result.gates_pending ? "pending_verification" : "codex_terminal", outcome: result.gates_pending ? "pending" : outcome, codex_outcome: outcome, duration_ms: durationMs, profile: modelPlan?.profile || null, requested_model: modelPlan?.requested_model || null, executed_model: executedModel || null, fallback_model: modelPlan?.fallback_model || null, fallback_reason: fallbackReason, fallback_count: fallbackCount });
          if (reservation?.task_fingerprint && !preservePending) {
            if (outcome === "success" && !result.gates_pending) await completeTask(reservation.task_fingerprint, { expectedVersion: reservation.task_state_version, leaseId: reservation.task_lease_id, result_summary: outcome });
            else if (outcome !== "success") await advanceTask(reservation, "FAILED", { retryable: result.retryable === true, error_code: outcome, result_summary: outcome });
          }
           if (reservation?.token) {
            // Terminal Codex work has already advanced its task/packet state
            // above.  Reconcile only the release; policy terminal state is
            // intentionally retained for the parent-side authority guard.
             reservation.lane_homes = [...allocatedHomes];
             const finalized = await finalizeReservation(reservation, { outcome, result_summary: outcome, terminal: false, packet: false });
             if (finalized.code === "LIFECYCLE_FINALIZED") {
               reservations.delete(context.sessionID);
               packetCallBySession.delete(context.sessionID);
               bufferedOpenCodeTokens.delete(context.sessionID);
               retainParentCallReservation(reservations, reservation, outcome, result.gates_pending);
               }
            }
            const preservedHome = preservePending ? (await readRecovery(reservation?.task_fingerprint))?.codex_home : null;
            for (const home of [...allocatedHomes]) {
              if (home !== preservedHome) { try { await removeOwnedHome(home); } catch {} }
            }
           if (!preservePending && result.validated_handoff === true && handoffPath) {
             try { await removeConsumedArtifacts(handoffPath); } catch {}
           }
           return recordLatency({
          stage: "openai_run_codex_total", outcome, duration_ms: durationMs,
          agent: context.agent, model: executedModel || null, profile: modelPlan?.profile || null, requested_model: modelPlan?.requested_model || null, executed_model: executedModel || null, fallback_model: modelPlan?.fallback_model || null, fallback_reason: fallbackReason, fallback_count: fallbackCount,
           ...eventMetadata(packet || reservation), reasoning_effort: reservation?.reasoning_effort || null,
          exit_status: Number.isInteger(result.status) ? result.status : null,
          provider_failure: Boolean(result.provider_failure), event_count: progressState.event_count,
          session_id: context.sessionID, call_id: context.callID,
          });
        };
        // This is independent from the lane check: do not even start a custom
        // runner when the selected continuation has a side-effect journal.
        if (recovery && (recovery.journal_incomplete === true || recovery.command_journal.length > 0)) {
          const refusal = codexResult({ ...modelTelemetry(), code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", retryable: false, provider_failure: false, phase: "recovery", task_id: recovery.fingerprint, fingerprint: recovery.fingerprint, attempt: recovery.attempt, version: recovery.version, mutation_count: recovery.command_journal.length, journal_incomplete: recovery.journal_incomplete === true, status: "pending_manual_review", kind: "recovery_side_effect_review_required", progress: progressState });
           if (packetCallID) await updateWorkPacketByID(packetCallID, pendingManualRecovery(recovery, { codex_last_kind: "recovery_side_effect_review_required" }));
          await advanceTask(reservation, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", result_summary: "pending_manual_recovery_review" });
          await report(refusal);
          await recordCodexTerminal("recovery_side_effect_review_required", { preserve_pending: true });
          return JSON.stringify(refusal);
        }
        let laneStartGeneration = 0;
        let laneHome = null;
        let terminalHandoff = null;
        const runLane = async (model, extraEnv = {}) => {
          laneStartGeneration = await readCodexCircuitGeneration(model);
          const laneEnv = { ...process.env };
          delete laneEnv.OPENAI_CODEX_RESUME_THREAD_ID; delete laneEnv.OPENAI_CODEX_PARENT_RUN_ID; delete laneEnv.OPENAI_CODEX_RESUME_COUNT; delete laneEnv.OPENAI_CODEX_RECOVERY_EXPECTED_VERSION;
           const codexHome = await freshCodexHome(extraEnv.OPENAI_CODEX_RESUME_THREAD_ID ? recovery : null);
            laneHome = codexHome;
            allocatedHomes.add(codexHome);
            if (reservation) reservation.lane_homes = [...allocatedHomes];
           let laneResult;
           try {
             laneResult = await (pluginInput.runCodex || ((objective, options) => runProcessAsync(LANE, [objective], options)))(authoritativeObjective, {
              cwd: repository,
              env: {
                ...laneEnv, OPENAI_REPOSITORY_PATH: repository, CODEX_HOME: codexHome,
                OPENAI_TEAM_STATE_ROOT: process.env.OPENAI_TEAM_STATE_ROOT,
                OPENAI_PARENT_SESSION_ID: masterParent(context.sessionID),
                OPENAI_CODEX_REASONING_EFFORT: reservation?.reasoning_effort || process.env.OPENAI_CODEX_REASONING_EFFORT,
                OPENAI_CODEX_PROFILE: modelPlan.profile, OPENAI_CODEX_MODEL: model,
                OPENAI_CODEX_REQUESTED_MODEL: modelPlan.requested_model,
                // This is the selected next lane, not merely a profile hint.
                // Keep it explicit for the lane handoff and test doubles.
                OPENAI_CODEX_FALLBACK_MODEL: modelPlan.fallback_model || "",
                OPENAI_CODEX_FALLBACK_COUNT: "0", OPENAI_CODEX_FALLBACK_REASON: "",
                OPENAI_CODEX_INVOCATION_ID: invocationID,
                 OPENAI_CODEX_TASK_FINGERPRINT: reservation?.task_fingerprint || "", OPENAI_CODEX_ATTEMPT: String(reservation?.attempt || 1),
                 OPENAI_CODEX_TASK_LEASE_ID: reservation?.task_lease_id || "",
                 OPENAI_TEAM_RECOVERY_HOME_ROOT: recoveryHomeRoot(),
                ...extraEnv,
              }, signal: context.abort, timeoutMs: timeoutSeconds * 1000, onProgress,
             });
             return laneResult;
            } finally {}
        };
        let result;
        let circuitPersistenceFailed = false;
        const persistCircuit = async (model, options) => {
          try { return await openCodexCircuit(model, options); } catch { circuitPersistenceFailed = true; return null; }
        };
        try {
          result = await runLane(modelPlan.requested_model, recovery ? { OPENAI_CODEX_RESUME_THREAD_ID: recovery.thread_id, OPENAI_CODEX_PARENT_RUN_ID: recovery.codex_run_id || "", OPENAI_CODEX_RESUME_COUNT: String((recovery.resume_count || 0) + 1), OPENAI_CODEX_RECOVERY_EXPECTED_VERSION: String(recovery.version) } : {});
        } catch (error) {
          result = { kind: "spawn_error", status: null, error: String(error), stdout: "", stderr: "" };
        }
        if (result.kind === "timeout" || result.kind === "spawn_error") {
          const reason = String(result.reason || result.error || result.kind);
          const localLaunchFailure = result.kind === "spawn_error" && result.provider_failure !== true;
          const persisted = reservation?.task_fingerprint ? await readRecovery(reservation.task_fingerprint) : null;
          if (persisted && (persisted.journal_incomplete === true || persisted.command_journal.length > 0)) {
            const terminal = codexResult({ ...modelTelemetry(), status: "pending_manual_review", kind: "recovery_side_effect_review_required", code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", retryable: false, provider_failure: false, phase: "recovery", task_id: persisted.fingerprint, mutation_count: persisted.command_journal.length, journal_incomplete: persisted.journal_incomplete === true, progress: progressState });
             if (packetCallID) await updateWorkPacketByID(packetCallID, pendingManualRecovery(persisted, { codex_last_kind: "recovery_side_effect_review_required" }));
            await advanceTask(reservation, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", result_summary: "pending_manual_recovery_review" });
            await report(terminal); await recordCodexTerminal("recovery_side_effect_review_required", { ...terminal, preserve_pending: true }); return JSON.stringify(terminal);
          }
           // A transport failure is not itself enough to retry: it must be
          // temporary, and a durable empty journal must prove no mutation.
          const temporaryTransport = result.kind === "timeout" || (result.provider_failure === true
            && result.fallback_eligible === true
            && result.fallback_reason === "temporary_transport");
            const terminatedRunID = result.codex_run_id || result.run_id || null;
            const matchingEmptyRecovery = Boolean(reservationFingerprint && terminatedRunID && persisted?.fingerprint === reservationFingerprint && persisted.attempt === (reservation?.attempt || 1) && persisted.task_lease_id === reservation.task_lease_id && persisted.codex_run_id === terminatedRunID && persisted.resume_count === 0 && persisted.termination_sealed === true && persisted.journal_scan_complete === true && persisted.journal_incomplete === false && Array.isArray(persisted.command_journal) && persisted.command_journal.length === 0 && persisted.sealed_run_id === terminatedRunID && persisted.sealed_lease_id === reservation.task_lease_id);
             if (matchingEmptyRecovery) await removeRecoveryAndHome(reservationFingerprint, persisted);
            if (matchingEmptyRecovery && laneHome) { try { await removeOwnedHome(laneHome); } catch {} }
           if (result.kind === "timeout" && !matchingEmptyRecovery) {
               const terminal = codexResult({ ...modelTelemetry(), status: "pending_manual_review", kind: "recovery_side_effect_review_required", code: reservationFingerprint ? "CODEX_RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED" : "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", retryable: false, provider_failure: false, phase: "recovery", task_id: reservationFingerprint, codex_run_id: persisted?.codex_run_id || result.codex_run_id || result.run_id || null, codex_thread_id: persisted?.thread_id || null, mutation_count: persisted?.command_journal?.length || 0, journal_incomplete: persisted?.journal_incomplete === true, progress: progressState });
              if (packetCallID) await updateWorkPacketByID(packetCallID, pendingManualRecovery(persisted || {}, { codex_last_kind: "recovery_side_effect_review_required" }));
             await advanceTask(reservation, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", result_summary: "pending_manual_recovery_review" });
              await transitionCurrentPolicy(context.sessionID, CODEX_UNKNOWN, { error: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED" });
             await report(terminal); await recordCodexTerminal("recovery_side_effect_review_required", { ...terminal, preserve_pending: true }); return JSON.stringify(terminal);
           }
          // A timeout occurred after the lane was started.  Only an exact,
          // durable empty journal can prove it did not mutate the workspace.
          const recoveryProvesNoMutation = result.kind === "timeout"
            ? matchingEmptyRecovery
             : false;
           if (fallbackCount === 0 && modelPlan.fallback_model && temporaryTransport && recoveryProvesNoMutation && !circuitPersistenceFailed) {
             if (result.kind === "timeout") await persistCircuit(modelPlan.requested_model, { reason: "temporary_transport", invocation_id: invocationID, profile: modelPlan.profile, requested_model: modelPlan.requested_model, fallback_count: fallbackCount, start_generation: laneStartGeneration });
            // Remove only an exact, empty record from the failed lane.  A
            // record from another attempt is never evidence for this retry.
            fallbackReason = "temporary_transport"; fallbackCount = 1; executedModel = modelPlan.fallback_model;
            try { result = await runLane(executedModel, { OPENAI_CODEX_FALLBACK_COUNT: "1", OPENAI_CODEX_FALLBACK_REASON: fallbackReason }); }
            catch (error) { result = { kind: "spawn_error", status: null, error: String(error), stdout: "", stderr: "" }; }
          }
          if (fallbackCount === 1 && (result.kind === "timeout" || result.kind === "spawn_error")) {
             if (result.kind === "timeout") await persistCircuit(executedModel, { reason: "temporary_transport", invocation_id: invocationID, profile: modelPlan.profile, requested_model: modelPlan.requested_model, fallback_count: fallbackCount, start_generation: laneStartGeneration });
            await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: String(result.error || result.kind) });
            const fallbackLocalLaunchFailure = result.kind === "spawn_error" && result.provider_failure !== true;
            const providerFailure = !fallbackLocalLaunchFailure;
            const terminal = taskFailure(providerFailure ? "CODEX_PROVIDER_FAILURE" : "CODEX_LAUNCH_FAILURE", providerFailure ? fallbackReason : "launch_failure");
            await report(terminal); await recordCodexTerminal(terminal.kind, { ...result, provider_failure: providerFailure }); return JSON.stringify(terminal);
          }
          // A successful fallback produces a normal lane result.  Let it
          // continue through handoff validation below; only the remaining
          // launch/timeout outcomes are terminal at this boundary.
          if (result.kind === "timeout" || result.kind === "spawn_error") {
            const finalLocalLaunchFailure = result.kind === "spawn_error" && result.provider_failure !== true;
            await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: result.error || reason });
             const terminal = taskFailure(finalLocalLaunchFailure ? "CODEX_LAUNCH_FAILURE" : "CODEX_PROVIDER_FAILURE", finalLocalLaunchFailure ? "launch_failure" : result.kind === "timeout" ? "temporary_transport" : reason);
            await report(terminal);
            await recordCodexTerminal(terminal.kind, { ...result, provider_failure: !finalLocalLaunchFailure });
            return JSON.stringify(terminal);
          }
        }
        if (result.kind === "aborted") {
          const reason = String(result.reason || result.error || result.kind);
          await transitionCurrentPolicy(context.sessionID, CODEX_ABORTED, { error: result.error || reason });
          const terminal = taskFailure("CODEX_ABORTED", "aborted");
          await report(terminal);
          await recordCodexTerminal("aborted", result);
          return JSON.stringify(terminal);
        }
        let output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        const recoveryRefusal = output.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((value) => value?.code === "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED");
        if (recoveryRefusal) {
           if (packetCallID) await updateWorkPacketByID(packetCallID, pendingManualRecovery(recoveryRefusal, { codex_last_kind: "recovery_side_effect_review_required" }));
          await advanceTask(reservation, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", result_summary: "pending_manual_recovery_review" });
          const terminal = codexResult({ ...modelTelemetry(), ...recoveryRefusal, status: "pending_manual_review", kind: "recovery_side_effect_review_required", task_id: recoveryRefusal.task_id || reservation?.task_fingerprint || null, progress: progressState });
          await report(terminal);
          await recordCodexTerminal("recovery_side_effect_review_required", { preserve_pending: true });
          return JSON.stringify(terminal);
        }
        if (result.error) {
          const error = String(result.error.message || result.error);
          const reason = String(result.reason || error || "process_error");
          await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error });
          const terminal = taskFailure("CODEX_TASK_FAILED", "process_error");
          await report(terminal);
          await recordCodexTerminal("process_error", { ...result, provider_failure: false });
          return JSON.stringify(terminal);
        }
        let handoffPath = handoffPathFromStdout(output);
        let handoff = null;
        if (handoffPath) {
          try { handoff = JSON.parse(readFileSync(handoffPath, "utf8")); } catch {}
        }
          const parsedHandoff = handoff;
         if (!activeHandoff(handoff)) handoff = null;
            terminalHandoff = handoff;
          const eligibleProviderHandoff = parsedHandoff && result.status === 79 && parsedHandoff.exit_status !== 0
            && parsedHandoff.provider_failure === 1 && parsedHandoff.fallback_eligible === true
             && parsedHandoff.mutation_count === 0 && parsedHandoff.journal_incomplete === false && (!parsedHandoff.thread_id || (parsedHandoff.termination_sealed === true && parsedHandoff.journal_scan_complete === true && parsedHandoff.sealed_run_id === parsedHandoff.codex_run_id))
            && new Set(["temporary_transport", "quota", "rate_limit", "capacity", "model_unavailable", "circuit_open"]).has(parsedHandoff.fallback_reason);
          if (parsedHandoff && Number(parsedHandoff.exit_status) !== Number(result.status) && !eligibleProviderHandoff) {
           await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: "HANDOFF_INVALID" });
           const terminal = taskFailure("HANDOFF_INVALID", "handoff_invalid", parsedHandoff.codex_run_id);
           await report(terminal); await recordCodexTerminal("HANDOFF_INVALID", result); return JSON.stringify(terminal);
         }
         if (handoff) result.validated_handoff = true;
        // A retry is safe only when the first lane positively classified an
        // availability failure and durable evidence proves it made no mutation.
        // This path intentionally has no resume variables and is capped at one.
        const safeFallbackReasons = new Set(["temporary_transport", "quota", "rate_limit", "capacity", "model_unavailable", "circuit_open"]);
          const safeFallbackFailure = (value) => value?.schema_version === 3 && Boolean(value?.provider_failure === true || value?.provider_failure === 1) && value?.fallback_eligible === true && safeFallbackReasons.has(value?.fallback_reason) && value.mutation_count === 0 && value.journal_incomplete === false && (!value.thread_id || (value.termination_sealed === true && value.journal_scan_complete === true && value.sealed_run_id === value.codex_run_id));
        const circuitOpenFailure = (value) => Boolean(value?.provider_failure === true || value?.provider_failure === 1)
          && value?.schema_version === 3 && safeInvocationID(value?.invocation_id) && value.invocation_id === invocationID
          && value?.fallback_eligible === true && value?.code === "CODEX_MODEL_CIRCUIT_OPEN"
          && value?.model === executedModel && value?.executed_model === executedModel && value?.profile === modelPlan.profile
          && value?.requested_model === modelPlan.requested_model && (value?.fallback_model || null) === (modelPlan.fallback_model || null)
          && value?.fallback_count === fallbackCount && safeFallbackReasons.has(value?.fallback_reason);
         const parseStructuredLine = (line) => {
           try { return JSON.parse(line); } catch {
             try { return JSON.parse(line.replace(/\\n\s*$/, "")); } catch { return null; }
           }
         };
         const structuredProviderFailure = () => result.status === 0 ? null : output.split(/\r?\n/).map(parseStructuredLine).map((value) => {
           if (!value || value.provider_failure === true || value.provider_failure === 1) return value;
           const text = JSON.stringify(value);
           const fallback_reason = /quota|credit|limit/i.test(text) ? "quota" : /rate|429/i.test(text) ? "rate_limit" : /capacity/i.test(text) ? "capacity" : /unavailable|model/i.test(text) ? "model_unavailable" : /timeout|transport|network|connection/i.test(text) ? "temporary_transport" : null;
           return fallback_reason ? { ...value, schema_version: 3, provider_failure: true, fallback_eligible: true, fallback_reason, mutation_count: 0, journal_incomplete: false } : null;
         }).find(Boolean) || null;
        const structuredCircuitOpen = () => { const value = structuredProviderFailure(); return circuitOpenFailure(value) ? value : null; };
         if ((safeFallbackFailure(handoff) || circuitOpenFailure(handoff) || structuredCircuitOpen()) && modelPlan.fallback_model && fallbackCount === 0) {
          const currentRecovery = reservation?.task_fingerprint ? await readRecovery(reservation.task_fingerprint) : null;
           if (currentRecovery && (currentRecovery.journal_incomplete === true || currentRecovery.termination_sealed !== true || currentRecovery.journal_scan_complete !== true || !Array.isArray(currentRecovery.command_journal) || currentRecovery.command_journal.length > 0)) {
           const failure = handoff || structuredCircuitOpen() || {};
            const terminal = codexResult({ code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", status: "pending_manual_review", kind: "recovery_side_effect_review_required", retryable: false, provider_failure: false, fallback_reason: failure.fallback_reason || failure.reason || "provider_failure", requested_model: modelPlan.requested_model, executed_model: executedModel, fallback_model: modelPlan.fallback_model, fallback_count: 0 });
             if (packetCallID) await updateWorkPacketByID(packetCallID, pendingManualRecovery(currentRecovery, { fallback_reason: terminal.fallback_reason }));
            await advanceTask(reservation, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_SIDE_EFFECT_REVIEW_REQUIRED", result_summary: "pending_manual_recovery_review" });
            await report(terminal); await recordCodexTerminal("recovery_side_effect_review_required", { ...terminal, preserve_pending: true }); return JSON.stringify(terminal);
          }
          // A recovered, empty journal is evidence for a fresh lane, but it
          // belongs to the failed primary and must be removed by identity CAS
          // before the fallback starts.
             if (reservationFingerprint && currentRecovery && currentRecovery.fingerprint === reservationFingerprint && currentRecovery.attempt === (reservation?.attempt || 1) && currentRecovery.task_lease_id === reservation.task_lease_id && currentRecovery.resume_count === 0 && currentRecovery.termination_sealed === true && currentRecovery.journal_scan_complete === true && currentRecovery.journal_incomplete === false && Array.isArray(currentRecovery.command_journal) && currentRecovery.command_journal.length === 0 && currentRecovery.sealed_run_id === currentRecovery.codex_run_id && currentRecovery.sealed_lease_id === reservation.task_lease_id) { await removeRecoveryAndHome(reservationFingerprint, currentRecovery); if (laneHome) { try { await removeOwnedHome(laneHome); } catch {} } }
          const failure = handoff || structuredCircuitOpen() || {};
          fallbackReason = failure.fallback_reason || failure.reason || "provider_failure";
         if (packetCallID && handoff?.schema_version === 3) await addWorkPacketTokensByID(packetCallID, "codex", handoff.token_usage || {}, tokenEventHash("codex", handoff.codex_run_id, handoff.codex_run_id));
          fallbackCount = 1; executedModel = modelPlan.fallback_model;
          try {
            result = await runLane(executedModel, { OPENAI_CODEX_FALLBACK_COUNT: "1", OPENAI_CODEX_FALLBACK_REASON: fallbackReason });
          } catch (error) {
            result = { kind: "spawn_error", status: null, error: String(error), stdout: "", stderr: "" };
          }
          // The retry is the second and final lane invocation.  It can still
          // fail before producing a handoff, but must never enter another
          // fallback path or ask the parent to schedule one.
          if (result.kind === "timeout" || result.kind === "spawn_error") {
               if (result.kind === "timeout") await persistCircuit(executedModel, { reason: "temporary_transport", invocation_id: invocationID, profile: modelPlan.profile, requested_model: modelPlan.requested_model, fallback_count: fallbackCount, start_generation: laneStartGeneration });
            await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: String(result.error || result.kind) });
            const localLaunchFailure = result.kind === "spawn_error" && result.provider_failure !== true;
            const terminal = taskFailure(localLaunchFailure ? "CODEX_LAUNCH_FAILURE" : "CODEX_PROVIDER_FAILURE", localLaunchFailure ? "launch_failure" : fallbackReason);
            await report(terminal); await recordCodexTerminal(terminal.kind, { ...result, provider_failure: !localLaunchFailure }); return JSON.stringify(terminal);
          }
          if (result.kind === "aborted") {
            const reason = String(result.reason || result.error || result.kind);
            await transitionCurrentPolicy(context.sessionID, CODEX_ABORTED, { error: result.error || reason });
            const terminal = taskFailure("CODEX_ABORTED", "aborted");
            await report(terminal); await recordCodexTerminal("aborted", result); return JSON.stringify(terminal);
          }
          const retryOutput = [result.stdout, result.stderr].filter(Boolean).join("\n"); output = retryOutput;
          const retryPath = handoffPathFromStdout(retryOutput);
          handoffPath = retryPath;
          handoff = null;
          if (retryPath) { try { handoff = JSON.parse(readFileSync(retryPath, "utf8")); } catch {} }
           if (!activeHandoff(handoff)) handoff = null;
           terminalHandoff = handoff;
           if (handoff && Number(handoff.exit_status) === Number(result.status)) result.validated_handoff = true;
        }
        if (packetCallID && handoff?.codex_run_id) {
           await updateWorkPacketByID(packetCallID, { codex_run_id: handoff.codex_run_id, codex_thread_id: handoff.thread_id || "", codex_resume_count: handoff.resume_count || 0, codex_last_kind: handoff.reason || "", parent_codex_run_id: handoff.parent_codex_run_id || "" });
           await addWorkPacketTokensByID(packetCallID, "codex", handoff.token_usage || {}, tokenEventHash("codex", handoff.codex_run_id, handoff.codex_run_id));
        }
        // `handoff` is absent for a circuit-open result, so retain the
        // machine-readable provider classification parsed from output.
          const finalFailure = handoff || structuredProviderFailure();
          if (result.status === 0 && (handoff === null || result.validated_handoff !== true)) {
          await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: "HANDOFF_INVALID" });
          const terminal = taskFailure("HANDOFF_INVALID", "handoff_invalid");
           await report(terminal); await recordCodexTerminal("HANDOFF_INVALID", result); return JSON.stringify(terminal);
         }
         if (result.status === 0 && handoff && (handoff.exit_status !== 0 || handoff.provider_failure !== 0 || handoff.fallback_eligible !== false || handoff.reason !== "success")) {
           await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: "HANDOFF_INVALID" });
           const terminal = taskFailure("HANDOFF_INVALID", "handoff_invalid", handoff.codex_run_id);
           await report(terminal); await recordCodexTerminal("HANDOFF_INVALID", result); return JSON.stringify(terminal);
          }
          if (result.status === 0) {
           const verificationEvidence = parseVerificationEvidence(result.stdout);
          const executionPolicy = postExecutionPolicy({
            classification: reservation?.classification || packet?.classification,
            complexity: reservation?.complexity || packet?.complexity,
            risk: reservation?.risk || packet?.risk,
            review_required: reservation?.review_required || packet?.review_required,
            verification_evidence: verificationEvidence,
            codex_outcome: "success",
          });
          const reviewPending = executionPolicy.next_agents.some((agent) => agent === "reviewer" || agent === "reviewer_critical");
          const testerRequired = executionPolicy.next_agents.includes("tester");
          const gatesPending = reviewPending || testerRequired;
          // The record observed before execution is only a resume hint.  A
          // successful handoff may have created or advanced recovery state, so
          // compare against the current durable identity before declaring it
          // stale and clearing it.
          const currentRecovery = reservation?.task_fingerprint ? await readRecovery(reservation.task_fingerprint) : null;
           const recoveryMatchesHandoff = !currentRecovery || (
             currentRecovery.attempt === handoff.attempt
             && (currentRecovery.task_lease_id === reservation.task_lease_id || currentRecovery.task_lease_id === `legacy-${reservation.task_fingerprint}`)
             && currentRecovery.thread_id === handoff.thread_id
             && currentRecovery.codex_run_id === handoff.codex_run_id
             && currentRecovery.codex_home_identity === currentRecovery.codex_home
           );
          let recoveryCleared = recoveryMatchesHandoff;
          if (currentRecovery && recoveryMatchesHandoff) {
             try {
              await removeRecoveryAndHome(reservation.task_fingerprint, { ...currentRecovery, codex_home_identity: currentRecovery.codex_home });
            } catch (error) {
              if (error instanceof RecoveryConflictError || error?.code === "RECOVERY_CONFLICT") recoveryCleared = false;
              else throw error;
            }
            if (!reservation?.token) {
              for (const home of allocatedHomes) { try { await removeOwnedHome(home); } catch {} }
            }
          }
          if (!recoveryCleared) {
             if (packetCallID) await updateWorkPacketByID(packetCallID, pendingManualRecovery(currentRecovery, {
              codex_last_kind: "recovery_identity_conflict",
            }));
            await transitionCurrentPolicy(context.sessionID, CODEX_UNKNOWN, { error: "RECOVERY_IDENTITY_CONFLICT" });
            await advanceTask(reservation, "PENDING_VERIFICATION", { retryable: false, error_code: "RECOVERY_IDENTITY_CONFLICT", result_summary: "pending_manual_recovery_review" });
            const terminal = codexResult({ ...modelTelemetry(), status: "pending_manual_review", kind: "recovery_identity_conflict", code: "RECOVERY_IDENTITY_CONFLICT", retryable: false, provider_failure: false, phase: "recovery", task_id: reservation?.task_fingerprint || null, progress: progressState });
            await report(terminal);
            await recordCodexTerminal("recovery_identity_conflict", { preserve_pending: true });
            return JSON.stringify(terminal);
          }
           if (packetCallID) await updateWorkPacketByID(packetCallID, {
            verification_evidence: verificationEvidence, next_agents: executionPolicy.next_agents, policy_reasons: executionPolicy.reasons,
            review_status: reviewPending ? "pending" : "not_required", tester_required: testerRequired, tester_status: testerRequired ? "pending" : "not_required", verification_status: executionPolicy.verification_status,
            verification_recognized_count: verificationEvidence.summary?.recognized_count || 0, verification_passed_count: verificationEvidence.summary?.passed_count || 0, verification_failed_count: verificationEvidence.summary?.failed_count || 0, verification_truncated_count: verificationEvidence.summary?.truncated_count || 0,
             phase: gatesPending ? (testerRequired ? "pending_verification" : "pending_review") : "codex_terminal", outcome: gatesPending ? "pending" : "success", codex_outcome: "success",
          });
          await transitionCurrentPolicy(context.sessionID, CODEX_SUCCESS);
           if (gatesPending) await advanceTask(reservation, testerRequired ? "PENDING_VERIFICATION" : "PENDING_REVIEW", { result_summary: "pending_gates" });
           if (testerRequired && packetCallID && reservation?.master_parent_session_id) {
             const rootID = reservation.master_parent_session_id;
             const root = guardrails.get(rootID);
             if (root) guardrails.set(rootID, { ...root, pendingVerificationPacketID: packetCallID, pendingTesterActive: false });
           }
           const terminal = codexResult({ status: "success", kind: "success", code: "CODEX_SUCCESS", task_id: reservation?.task_fingerprint || null, packet_id: packet?.packet_id || null, attempt: reservation?.attempt || 1, complexity: reservation?.complexity || packet?.complexity || null, codex_profile: reservation?.codex_profile || packet?.codex_profile || null, requested_model: modelPlan.requested_model, executed_model: executedModel, fallback_model: modelPlan.fallback_model, fallback_reason: fallbackReason, fallback_count: fallbackCount, risk: reservation?.risk || packet?.risk || null, review_required: Boolean(reservation?.review_required || packet?.review_required), review_status: reviewPending ? "pending" : "not_required", tester_required: testerRequired, tester_status: testerRequired ? "pending" : "not_required", verification_status: executionPolicy.verification_status, next_agents: executionPolicy.next_agents, reasons: executionPolicy.reasons, codex_run_id: handoff?.codex_run_id || null, handoff_id: safeHandoffID(handoff, handoffPath), summary: safeTodoContent(codexSummaryFromStdout(result.stdout)), progress: progressState });
          await report({ status: terminal.status, kind: terminal.kind });
           await recordCodexTerminal("success", { ...result, gates_pending: gatesPending, validated_handoff: true });
          return JSON.stringify(terminal);
        }
         if (safeFallbackFailure(finalFailure) && fallbackCount === 1) {
          await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: finalFailure?.fallback_reason || finalFailure?.reason || "provider_failure" });
          const terminal = taskFailure("CODEX_PROVIDER_FAILURE", finalFailure?.fallback_reason || finalFailure?.reason || "provider_failure", handoff?.codex_run_id);
          await report(terminal); await recordCodexTerminal("provider_failure", { ...result, provider_failure: true }); return JSON.stringify(terminal);
        }
        if (safeFallbackFailure(finalFailure)) {
          await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: finalFailure?.fallback_reason || finalFailure?.reason || "provider_failure" });
          const terminal = taskFailure("CODEX_PROVIDER_FAILURE", finalFailure?.fallback_reason || finalFailure?.reason || "provider_failure", handoff?.codex_run_id);
          await report(terminal);
          await recordCodexTerminal("provider_failure", { ...result, provider_failure: true });
          return JSON.stringify(terminal);
        }
        if (finalFailure?.provider_failure === true || finalFailure?.provider_failure === 1) {
          await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED, { error: finalFailure.reason || "provider_failure" });
          const terminal = taskFailure("CODEX_PROVIDER_FAILURE", finalFailure.reason || finalFailure.fallback_reason || "provider_failure", handoff?.codex_run_id);
          await report(terminal); await recordCodexTerminal("provider_failure", { ...result, provider_failure: true });
          return JSON.stringify(terminal);
        }
        await transitionCurrentPolicy(context.sessionID, CODEX_TASK_FAILED);
        const terminal = taskFailure("CODEX_TASK_FAILED", handoff?.reason || "task_failure", handoff?.codex_run_id);
        await report(terminal);
        await recordCodexTerminal("task_failure", result);
        return JSON.stringify(terminal);
      },
    }),
    openai_remote_read: createRemoteReadTool(pluginInput.runRemoteRead),
  },
  "tool.execute.before": async (input, output) => {
    guardToolExecution({ team: "openai", input, output });
    const toolName = String(input.tool || "").toLowerCase();
     let guard = await guardrailFor(input.sessionID);
     if (toolName === "task" && guard && !guard.authoritativeObjective) {
       const initialObjective = await resolveInitialObjective(input.sessionID);
       if (initialObjective?.objective && initialObjective.rootSessionID === input.sessionID && initialObjective.parentSessionID == null) {
         guard = recoverRootRequestState(guard, initialObjective.objective, Date.now(), process.env);
       } else if (initialObjective?.objective && initialObjective.rootSessionID) {
         masterParentBySession.set(input.sessionID, initialObjective.rootSessionID);
         const rootGuard = await guardrailFor(initialObjective.rootSessionID);
         guard = preserveChildGuardState(guard, rootGuard, initialObjective.objective);
       }
       guardrails.set(input.sessionID, guard);
     }
      if (toolName === "task" && guard && !guard.activeDelegation && guard.delegations > 0 && !guard.verificationTerminal) {
     guard = beginRequestCycle(guard, String(output.args?.prompt || output.args?.description || ""), Date.now(), process.env, { preserveVerificationTerminal: true, preserveCodexFailureTerminal: true, preserveVerificationGate: true });
        guardrails.set(input.sessionID, guard);
     }
      const sessionAgent = input.agent || await resolveSessionAgent(input.sessionID);
      const rootParentForGate = masterParent(input.sessionID);
      const rootGuardForGate = guardrails.get(rootParentForGate) || (rootParentForGate === input.sessionID ? guard : null);
      const durableGate = process.env.OPENAI_DAILY_PROFILE === "1" && sessionAgent === "openai_orchestrator"
        ? await findPendingMandatoryTesterGate(rootParentForGate, { listWorkPackets: pluginInput.listWorkPackets, readTask: pluginInput.readTask })
        : null;
      const gateStateForDecision = process.env.OPENAI_DAILY_PROFILE === "1" && sessionAgent === "openai_orchestrator" && !durableGate
        ? (rootGuardForGate ? { ...rootGuardForGate, pendingVerificationPacketID: null, pendingTesterActive: false } : rootGuardForGate)
        : rootGuardForGate;
      if (durableGate) {
        const requestedAgent = toolName === "task" ? String(output.args?.subagent_type || output.args?.agent || "") : sessionAgent;
        const testerActive = [...reservations.values()].some((entry) => entry.master_parent_session_id === rootParentForGate && entry.role === "tester" && entry.test_task_id === durableGate.packet_id && entry.token)
          || (rootGuardForGate?.pendingTesterActive === true && rootGuardForGate?.pendingVerificationPacketID === durableGate.packet_id);
        const enforced = enforcePendingMandatoryTesterGate(durableGate, {
          tool: toolName, agent: requestedAgent,
          prompt: output.args?.prompt || output.args?.description || "", active: testerActive,
        });
        if (!enforced.allowed) throw new GuardrailPolicyError(enforced.reason);
        output.args = output.args || {};
        output.args.prompt = enforced.prompt;
      }
      const gateDecision = verificationGateDecision(gateStateForDecision, toolName, toolName === "task" ? String(output.args?.subagent_type || output.args?.agent || "") : sessionAgent, output.args?.prompt || output.args?.description || "", [...reservations.values()].some((entry) => entry.master_parent_session_id === rootParentForGate && entry.role === "tester" && entry.test_task_id === gateStateForDecision?.pendingVerificationPacketID && entry.token));
     if (!gateDecision.allowed) throw new GuardrailPolicyError(gateDecision.reason);
    if (guard && toolName !== "openai_run_codex") guardrails.set(input.sessionID, admitToolCall(guard, toolName));
    if (toolName === "bash" && sessionAgent === "tester") {
      const command = output.args?.command ?? output.args?.cmd;
      const target = typeof input.sessionID === "string"
        ? (await listWorkPackets()).find((packet) => packet.child_session_id === input.sessionID
          && packet.agent === "tester" && ["pending", "required"].includes(packet.tester_status))
        : null;
      const expected = new Set([
        ...parseSerializedArray(target?.verification_commands),
        ...parseSerializedArray(target?.verification_evidence).map((entry) => entry?.command_hash),
        ...parseSerializedArray(target?.expected_verification_hashes),
      ].filter((value) => typeof value === "string" && (isAllowlistedVerificationCommand(value) || /^[a-f0-9]{64}$/i.test(value)))
        .map((value) => /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : createHash("sha256").update(value).digest("hex")));
      const commandHash = typeof command === "string" ? createHash("sha256").update(command).digest("hex") : "";
      if (target != null && typeof command === "string" && isAllowlistedVerificationCommand(command) && expected.has(commandHash)) return;
      throw new Error("Tester Bash is restricted to allowlisted verification commands.");
    }
    if (toolName !== "task" && toolName !== "openai_run_codex" && input.sessionID) {
      const callID = await taskCallForSession(input.sessionID);
     if (callID) await incrementWorkPacketByID(callID, { tool_call_count: 1 });
    }
    if (isMutationCapableTool(toolName)) {
       const shellCommand = output.args?.command ?? output.args?.cmd ?? input.args?.command ?? input.args?.cmd;
       if (sessionAgent === "openai_orchestrator" && allowsDailyOrchestratorShell(toolName, shellCommand, guard?.authoritativeObjective)) return;
       if (sessionAgent === "openai_orchestrator" && REPOSITORY_MUTATING_TOOLS.has(toolName)) {
        throw new Error("openai_orchestrator repository mutation is denied; delegate implementation to codex_executor");
      }
      if (sessionAgent !== "codex_executor") {
        throw new Error("OpenAI authorship guard: mutation-capable tools are restricted to codex_executor with fallback authority.");
      }
      if (!input.agent && !(await policyExists(input.sessionID))) {
        const bootstrapped = await ensurePolicy(input.sessionID, { agent: "codex_executor", reason: "exact session agent lookup" });
        if (!bootstrapped) throw new Error("Codex authorship policy bootstrap failed; native repository mutation denied.");
      }
      const policy = await readPolicy(input.sessionID);
      if (!policy || policy.agent !== "codex_executor") throw new Error("Invalid Codex authorship policy; native repository mutation denied.");
       if (policy.status !== TERRA_FALLBACK || !FALLBACK_MUTATION_TOOLS.has(toolName)) throw new Error("Native repository mutation is denied until openai_run_codex returns fallback_required.");
      return;
    }
    if (toolName === "call_omo_agent") throw new Error("call_omo_agent is disabled for the OpenAI team; use native task delegation.");
    if (toolName === "skill") {
      const agent = input.agent || await resolveSessionAgent(input.sessionID);
      const requestedSkill = String(output.args?.name || output.args?.skill || output.args?.skill_name || "").trim();
      if (requestedSkill === "codex-native") {
        throw new Error("The OPENAI codex_executor must use openai_run_codex. The codex-native skill/direct Codex CLI path is disabled for this team. Call openai_run_codex once using the authoritative objective.");
      }
      return;
    }
     if (toolName !== "task") return;
     const args = output.args || {};
      let testTaskID;
     if (args.run_in_background === true && !backgroundDelegationAllowed()) throw new GuardrailPolicyError("BACKGROUND_DENIED");
      const currentTaskObjective = String(args.prompt || args.description || "").trim();
      const suppliedMarker = extractTaskPacketMarker(currentTaskObjective);
      if (suppliedMarker.present) throw new Error("TASK_PACKET_MARKER_INJECTED");
     const requestedAgent = String(output.args?.subagent_type || output.args?.agent || "");
     const fallbackParentObjective = guard?.authoritativeObjective ? "" : (await resolveInitialObjective(masterParent(input.sessionID)))?.objective || "";
     const authoritativeParentObjective = selectAuthoritativeObjective(guard?.authoritativeObjective, fallbackParentObjective);
     const analysis = analyzeObjective(currentTaskObjective);
     if (!authoritativeParentObjective) throw new GuardrailPolicyError("OBJECTIVE_UNBOUND");
     const route = routeDelegatedAgent(authoritativeParentObjective, currentTaskObjective, requestedAgent);
    const remoteReadOnly = route.classification === "REMOTE_READ_ONLY" ||
      (/\bopenai_remote_read\b/i.test(currentTaskObjective) && route.classification !== "REMOTE_MUTATION");
    if (route.classification === "MUTATING") {
      delete output.args.category;
      delete output.args.load_skills;
      output.args.subagent_type = "codex_executor";
     } else if (route.classification === "REMOTE_MUTATION") {
       const genuineObjective = (await resolveInitialObjective(masterParent(input.sessionID)))?.objective || "";
       if (!explicitlyConfirms(genuineObjective, "vps_ssh")) throw new GuardrailPolicyError("REMOTE_CONFIRMATION", { category: "vps_ssh" });
       throw new Error("OPENAI ROUTING POLICY: remote mutation requires an approved remote mutation tool.");
    } else if (remoteReadOnly || route.classification === "READ_ONLY") {
      if (requestedAgent === "codex_executor") {
        throw new Error("OPENAI ROUTING POLICY: read-only objectives cannot use codex_executor; delegate to an approved read-only OpenAI agent.");
      }
      delete output.args.category;
      delete output.args.load_skills;
      output.args.subagent_type = remoteReadOnly ? "openai_ops" : requestedAgent === "tester" ? "tester" : ["reviewer", "reviewer_critical"].includes(requestedAgent) ? (/\breview_task_id=[a-f0-9]{64}\b/i.test(currentTaskObjective) ? requestedAgent : "specialist") : route.agent;
    } else if (requestedAgent === "codex_executor") {
      output.args.subagent_type = "specialist";
    } else if (args.category) {
      throw new Error("Native task category dispatch is ambiguous or unsupported for the OpenAI team; specify an approved OpenAI subagent_type.");
    }
    let agent = String(output.args?.subagent_type || output.args?.agent || "");
      const allowedTaskAgents = new Set(["codex_executor", "openai_librarian", "openai_explore", "openai_ops", "tester", "reviewer", "reviewer_critical", "specialist"]);
      if (!allowedTaskAgents.has(agent)) throw new Error(`Native task agent '${agent || "(missing)"}' is not allowed for the OpenAI team.`);
       const rootParent = masterParent(input.sessionID);
       const rootGuard = guardrails.get(rootParent) || guard;
       if (agent === "codex_executor" && rootGuard?.codexFailureTerminal) {
         const error = new Error("CODEX_RETRY_DENIED"); error.code = "CODEX_RETRY_DENIED"; error.retryable = false; throw error;
       }
      let reviewTaskID = ["reviewer", "reviewer_critical"].includes(agent) ? (currentTaskObjective.match(/\breview_task_id=([a-f0-9]{64})\b/i) || [])[1]?.toLowerCase() : null;
      let reviewTarget = null;
      let gateTarget = null;
      if (["reviewer", "reviewer_critical"].includes(agent)) {
        if (!reviewTaskID) throw new Error("REVIEW_TASK_ID_REQUIRED");
        reviewTarget = (await listWorkPackets()).find((packet) => packet.packet_id === reviewTaskID);
        const requiredRisk = agent === "reviewer_critical" ? "critical" : "high";
        if (!reviewTarget || reviewTarget.parent_session_id !== rootParent || reviewTarget.review_required !== true || reviewTarget.risk !== requiredRisk || reviewTarget.review_status !== "pending") throw new Error("REVIEW_TARGET_DENIED");
        gateTarget = await gateTargetSnapshot(reviewTarget);
        if (!gateTarget) throw new Error("REVIEW_TARGET_DENIED");
      }
      const delegatedObjective = canonicalDelegatedObjective(authoritativeParentObjective, currentTaskObjective, { targetBound: Boolean(reviewTarget) });
      if (!delegatedObjective) throw new GuardrailPolicyError("OBJECTIVE_UNBOUND");
      output.args.prompt = delegatedObjective;
      if (guard) {
       if (guard.activeDelegation) {
         const parent = masterParent(input.sessionID);
         const active = [...reservations.values()].find((entry) => entry.master_parent_session_id === parent && entry.token);
         try {
           await readFile(join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "active", `${active?.token}.json`), "utf8");
         } catch {
            const released = finishDelegation(guard, false, active?.delegation_scope || null);
           guardrails.set(input.sessionID, { ...released, objective: currentTaskObjective, delegations: 0, weightedUnits: 0 });
         }
         }
         const currentGuard = guardrails.get(input.sessionID) || guard;
         if (!currentGuard.activeDelegation && currentGuard.delegations > 0 && !currentGuard.verificationTerminal) {
           const rootAuthority = currentGuard.authoritativeObjective || authoritativeParentObjective;
            guardrails.set(input.sessionID, { ...beginRequestCycle(currentGuard, currentTaskObjective, Date.now(), process.env, { preserveVerificationTerminal: true, preserveVerificationGate: true }), authoritativeObjective: rootAuthority });
         }
        const requestGuard = guardrails.get(input.sessionID) || currentGuard;
         const parentObjective = selectAuthoritativeObjective(requestGuard.authoritativeObjective, authoritativeParentObjective);
         requestGuard.objective = parentObjective;
        const reviewDelegation = ["reviewer", "reviewer_critical"].includes(agent);
          const admittedGuard = admitDelegation({ ...requestGuard, objective: parentObjective }, delegatedObjective, {
           review: reviewDelegation,
            explicitlyRequestedReview: /\b(?:review|audit)\b/i.test(parentObjective || "") || Boolean(reviewTarget),
         });
         const gateRoot = rootParent === input.sessionID ? rootGuard : guardrails.get(rootParent);
         const admittedWithGate = agent === "tester" && gateRoot?.pendingVerificationPacketID === testTaskID
           ? { ...admittedGuard, pendingTesterActive: true } : admittedGuard;
         guardrails.set(input.sessionID, admittedWithGate);
         if (agent === "tester" && gateRoot?.pendingVerificationPacketID === testTaskID && rootParent !== input.sessionID) {
           guardrails.set(rootParent, { ...gateRoot, pendingTesterActive: true });
         }
     }
    const resolvedModel = String(output.args?.model || "");
    if (resolvedModel && !resolvedModel.startsWith("openai/")) {
      throw new Error(`OPENAI-ONLY POLICY: rejected non-OpenAI model '${resolvedModel}' in task dispatch.`);
    }
    const configuredModel = DEFAULT_AGENT_MODELS[agent];
    if (resolvedModel && configuredModel && resolvedModel !== configuredModel) {
      throw new Error(`OPENAI MODEL MATRIX: model override '${resolvedModel}' is not permitted for ${agent}; required '${configuredModel}'.`);
    }
    const weights = { openai_explore: 1, openai_librarian: 1, openai_ops: 1, tester: 2, reviewer: 3, reviewer_critical: 3, specialist: 3, codex_executor: 2 };
    const weight = weights[agent] || 1;
     const discoveryGroupID = analysis.discovery_agents.length ? objectiveHash(`${rootParent}\n${objectiveHash(currentTaskObjective)}`) : null;
      testTaskID = agent === "tester" ? (currentTaskObjective.match(/\btest_task_id=([a-f0-9]{64})\b/i) || [])[1]?.toLowerCase() : null;
     if (agent === "tester") {
      const packets = await listWorkPackets();
      const pendingGates = packets.filter((packet) => packet.parent_session_id === rootParent && ["pending", "required"].includes(packet.tester_status));
      const gateIntent = /\b(?:gate|gated|verification[_ -]?gate|release[_ -]?gate)\b/i.test(currentTaskObjective);
      // A tester may freely perform an isolated read-only check only when it
      // cannot accidentally leave an existing mandatory gate unbound.
      if ((["high", "critical"].includes(analysis.risk) || gateIntent || pendingGates.length) && !testTaskID) throw new Error("TEST_TARGET_REQUIRED");
      if (testTaskID) {
        const target = packets.find((packet) => packet.packet_id === testTaskID);
        if (!target || target.parent_session_id !== rootParent || !["pending", "required"].includes(target.tester_status)) throw new Error("TEST_TARGET_DENIED");
        const targetHashes = parseSerializedArray(target.expected_verification_hashes).filter((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash));
        const testerCommands = criteriaFrom(currentTaskObjective).filter(isAllowlistedVerificationCommand);
        if (targetHashes.length === 0 && testerCommands.length === 0) {
          const error = new Error("TEST_COMMAND_REQUIRED"); error.code = "TEST_COMMAND_REQUIRED"; throw error;
        }
        if (targetHashes.length === 0) {
          const promoted = testerCommands.map((command) => createHash("sha256").update(command).digest("hex"));
          const promotion = await updateWorkPacketByIDIfCurrent(testTaskID,
            { parent_session_id: rootParent, task_fingerprint: target.task_fingerprint, tester_status: ["pending", "required"] },
            { verification_commands: testerCommands, acceptance_criteria: testerCommands, expected_verification_hashes: promoted });
          if (!promotion.matched) throw new Error("TEST_TARGET_DENIED");
        }
        const refreshedTarget = (await listWorkPackets()).find((packet) => packet.packet_id === testTaskID);
        gateTarget = await gateTargetSnapshot(refreshedTarget);
        if (!gateTarget) throw new Error("TEST_TARGET_DENIED");
      }
    }
    const selectedModel = configuredModel || DEFAULT_AGENT_MODELS[agent] || "openai/default";
    const localReadOnly = route.classification === "READ_ONLY" && !remoteReadOnly;
    const workspace = localReadOnly
      ? await workspaceFingerprint({ repository: input.directory || input.worktree || process.cwd(), agent, model: selectedModel, policyVersion: "read-cache-v1" }, { runProcess: pluginInput.runProcess })
      : { cacheable: false, fingerprint: null, reason: remoteReadOnly ? "remote_read_only" : "not_local_read_only" };
    const cacheableRead = localReadOnly && workspace.cacheable;
     const fingerprint = objectiveHash(`${canonicalObjective(delegatedObjective)}\n${rootParent}\n${agent}${cacheableRead ? `\n${workspace.fingerprint}` : agent === "codex_executor" ? "\nresumable-codex-v1" : `\nnonce:${createHash("sha256").update(`${input.callID}:${Date.now()}:${Math.random()}`).digest("hex")}`}`);
     const claim = await claimTask({ task_fingerprint: fingerprint, objective_sha256: objectiveHash(delegatedObjective), parent_session_id: rootParent, agent, first_call_id: input.callID, packet_id: input.callID });
     if (!claim.owner) {
      if (claim.disposition === "ACTIVE_DUPLICATE") throw new TaskStateError("TASK_DUPLICATE_ACTIVE", { task_id: fingerprint, attempt: claim.record.attempt, phase: "task_admission" });
      if (cacheableRead && claim.record.state === "COMPLETED") throw new TaskStateError("TASK_CACHE_HIT", { task_id: fingerprint, phase: "task_admission", status: claim.record.state, result_summary: claim.record.result_summary });
      throw new TaskStateError("TASK_TERMINAL_REPLAY", { task_id: fingerprint, phase: "task_admission", status: claim.record.state, result_summary: claim.record.result_summary });
    }
     if (agent === "codex_executor") output.args.prompt = appendTaskPacketMarker(delegatedObjective, claim.record.packet_id);
     const admissionStartedAt = Date.now();
    const ownerStart = process.env.OPENAI_OWNER_START_IDENTITY || (() => { try { return execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim().replace(/\r/g, "").replace(/\s+/g, " ").replaceAll(":", "_").toLowerCase(); } catch { return ""; } })();
    const ownerArgs = ["--wait", "--parent", rootParent, "--call", input.callID, "--owner-pid", String(process.pid)];
    if (ownerStart) ownerArgs.push("--owner-start", ownerStart);
    ownerArgs.push(agent || "worker", String(weight));
    const admission = await runProcessAsync(ADMIT, ownerArgs, {
       env: { ...process.env, OPENAI_OWNER_PID: String(process.pid), OPENAI_OWNER_START_IDENTITY: ownerStart },
    });
       const verificationCommands = agent === "tester" && gateTarget ? [] : criteriaFrom(currentTaskObjective);
      const expectedVerificationHashes = agent === "tester" && gateTarget ? gateTarget.expected_verification_hashes : verificationCommands.filter(isAllowlistedVerificationCommand).map((command) => createHash("sha256").update(command).digest("hex"));
       const packetMetadata = { task_id: fingerprint, task_fingerprint: fingerprint, task_lease_id: claim.record.lease_id, packet_id: claim.record.packet_id, workspace_fingerprint: workspace.fingerprint, cache_status: cacheableRead ? "miss" : "bypass", complexity: analysis.complexity, codex_profile: analysis.codex_profile, reasoning_effort: analysis.reasoning_effort, risk: analysis.risk, review_required: analysis.review_required, discovery_group_id: discoveryGroupID, discovery_required_lanes: analysis.discovery_agents, attempt: claim.record.attempt, retry_count: claim.record.attempt - 1, tool_call_count: 0, wrapper_round_trips: 0, acceptance_criteria: verificationCommands, verification_commands: verificationCommands, expected_verification_hashes: expectedVerificationHashes, tester_status: agent === "tester" ? "pending" : undefined, test_task_id: agent === "tester" ? (testTaskID || claim.record.packet_id) : testTaskID || undefined };
     await recordLatency({ stage: "task_admission", outcome: admission.status === 0 ? "admitted" : "deferred", duration_ms: elapsed(admissionStartedAt), admission_wait_ms: elapsed(admissionStartedAt), agent, call_id: input.callID, ...eventMetadata({ ...packetMetadata, classification: route.classification, task_call_id: input.callID }) });
     if (admission.status !== 0) {
       if (agent === "tester" && rootGuardForGate?.pendingVerificationPacketID === testTaskID) guardrails.set(rootParent, { ...rootGuardForGate, pendingTesterActive: false });
      await transitionTask(fingerprint, { expectedVersion: claim.record.version, expectedStates: ["CLAIMED"], leaseId: claim.record.lease_id, patch: { state: "FAILED", retryable: true, error_code: "ADMISSION_DEFERRED" } });
       throw new Error("OpenAI global worker budget is full; task admission deferred.");
    }
    const admissionToken = admission.stdout.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(admissionToken)) {
      // Only roll back a parseable reservation that belongs to this call.  A
      // noisy stdout line must never be able to release another worker's slot.
      const recoverableToken = String(admission.stdout || "").match(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/)?.[0];
      if (recoverableToken) {
        try {
          const active = JSON.parse(await readFile(join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "active", `${recoverableToken}.json`), "utf8"));
          if (active?.token === recoverableToken && active?.task_call_id === input.callID) await release(recoverableToken);
        } catch {}
      }
      await transitionTask(fingerprint, { expectedVersion: claim.record.version, expectedStates: ["CLAIMED"], leaseId: claim.record.lease_id, patch: { state: "FAILED", retryable: true, error_code: "ADMISSION_TOKEN_INVALID" } });
       if (agent === "tester" && rootGuardForGate?.pendingVerificationPacketID === testTaskID) guardrails.set(rootParent, { ...rootGuardForGate, pendingTesterActive: false });
       const error = new Error("ADMISSION_TOKEN_INVALID"); error.code = "ADMISSION_TOKEN_INVALID"; throw error;
    }
    try {
      const activePath = join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "active", `${admissionToken}.json`);
      const active = JSON.parse(await readFile(activePath, "utf8"));
      await writeFile(activePath, `${JSON.stringify({ ...active, codex_profile: analysis.codex_profile, classification: route.classification, complexity: analysis.complexity, risk: analysis.risk })}\n`, { mode: 0o600 });
    } catch (error) {
      await release(admissionToken);
      await transitionTask(fingerprint, { expectedVersion: claim.record.version, expectedStates: ["CLAIMED"], leaseId: claim.record.lease_id, patch: { state: "FAILED", retryable: true, error_code: "ADMISSION_METADATA_FAILED" } });
       if (agent === "tester" && rootGuardForGate?.pendingVerificationPacketID === testTaskID) guardrails.set(rootParent, { ...rootGuardForGate, pendingTesterActive: false });
       throw error;
    }
    reservations.set(input.callID, {
      token: admissionToken,
      master_parent_session_id: rootParent,
      task_call_id: input.callID,
      role: agent || "worker",
      weight,
      background: Boolean(output.args?.run_in_background),
      started_at: Date.now(),
      authoritative_objective: agent === "codex_executor" ? delegatedObjective : "",
       review_task_id: reviewTaskID, test_task_id: testTaskID, gate_target: gateTarget,
       objective_sha256: objectiveHash(delegatedObjective),
        classification: route.classification, cacheable_read: cacheableRead, ...packetMetadata, test_task_id: testTaskID,
         task_id: fingerprint, task_state_version: claim.record.version, task_lease_id: claim.record.lease_id, task_fingerprint: fingerprint, packet_id: claim.record.packet_id, delegation_scope: delegationScope(delegatedObjective),
    });
    try {
      await createWorkPacket(input.callID, {
        objective_sha256: objectiveHash(delegatedObjective), parent_session_id: rootParent,
        agent, task_fingerprint: fingerprint, attempt: claim.record.attempt, task_lease_id: claim.record.lease_id, classification: route.classification, phase: "admitted", outcome: "pending",
         admission_wait_ms: elapsed(admissionStartedAt),
         ...packetMetadata, review_task_id: reviewTaskID, test_task_id: testTaskID, gate_target: gateTarget ? (reviewTaskID || testTaskID) : null,
      });
      const admitted = await transitionTask(fingerprint, { expectedVersion: claim.record.version, expectedStates: ["CLAIMED"], leaseId: claim.record.lease_id, patch: { state: "ADMITTED" } });
      const stored = reservations.get(input.callID);
      if (stored) reservations.set(input.callID, { ...stored, task_state_version: admitted.version });
      await pruneWorkPackets();
    } catch (error) {
      await finalizeReservation(reservations.get(input.callID), { outcome: "error", result_summary: "ADMISSION_SETUP_FAILED", terminal: false, taskAction: "fail" });
      throw error;
    }
  },
  "tool.execute.after": async (input, output) => {
    if (String(input.tool || "").toLowerCase() !== "task") return;
    const pending = reservations.get(input.callID) || [...reservations.values()].find((entry) => entry.task_call_id === input.callID);
    if (!pending) return;
    const parentGuard = guardrails.get(input.sessionID);
      if (parentGuard) guardrails.set(input.sessionID, finishDelegation(parentGuard, ["tester", "reviewer", "reviewer_critical"].includes(pending.role), pending.delegation_scope));
    try {
     const foregroundChildID = !pending.background ? childSessionIdFromAfter(output?.metadata) : null;
      if (!pending.background) await bindExactChildReservation(pending, foregroundChildID, { readTask, advanceTask, updateWorkPacket, updateWorkPacketByID });
     if (!pending.background && pending.role === "codex_executor") {
       const childPacket = (await listWorkPackets()).find((entry) => entry.packet_id === pending.packet_id && entry.child_session_id === foregroundChildID);
       const childTask = await readTask(pending.task_fingerprint);
       const childPolicy = foregroundChildID ? await readPolicy(foregroundChildID) : null;
       const childIdentity = childPolicy?.schema_version === 1 && childPolicy.session_id === foregroundChildID && childPolicy.agent === "codex_executor" && childPolicy.status === CODEX_SUCCESS && childPolicy.task_fingerprint === pending.task_fingerprint && childPolicy.packet_id === pending.packet_id && childPolicy.task_lease_id === pending.task_lease_id && childPolicy.attempt === pending.attempt && childPolicy.task_call_id === (childPacket?.task_call_id || pending.task_call_id);
        if (!childIdentity) {
          const rootID = masterParent(input.sessionID);
          const rootState = guardrails.get(rootID);
          guardrails.set(rootID, { ...(rootState || guardrails.get(input.sessionID) || createGuardrailState()), codexFailureTerminal: true });
          throw Object.assign(new Error(JSON.stringify({ code: "CODEX_CHILD_NOT_SUCCESSFUL", retryable: false, phase: "codex_child_policy", task_id: pending.task_fingerprint, session_id: foregroundChildID, status: childPolicy?.status || null })), { code: "CODEX_CHILD_NOT_SUCCESSFUL" });
        }
        if (childTask?.state === "PENDING_VERIFICATION") {
          await finalizeReservation(pending, { outcome: "pending", result_summary: "pending_gates", sessionID: foregroundChildID, terminal: false, packet: false, taskAction: null });
          return undefined;
        }
        if (childTask?.state === "PENDING_REVIEW") {
          await finalizeReservation(pending, { outcome: "pending", result_summary: "pending_gates", sessionID: foregroundChildID, terminal: false, packet: false, taskAction: null });
          return undefined;
        }
     }
     let gateEvent = null;
    let gateError = null;
    if (["reviewer", "reviewer_critical"].includes(pending.role) && pending.review_task_id) {
      const validation = await validateGateTarget(pending, pending.review_task_id);
      if (validation.code) gateEvent = validation;
      else {
      const parsed = parseReviewerVerdict(resultSummary(output));
      const update = !parsed
        ? await updateWorkPacketByIDIfCurrent(pending.review_task_id, { review_status: "pending" }, { error_code: "REVIEW_RESULT_INVALID", phase: "pending_review" })
        : await updateWorkPacketByIDIfCurrent(pending.review_task_id, { review_status: "pending" }, {
          review_status: parsed.verdict === "APPROVE" ? "approved" : "review_rejected",
          phase: parsed.verdict === "APPROVE" ? "pending_verification" : "review_rejected",
          outcome: "pending",
        });
      // The comparison and write share the packet lock: only one conflicting
      // terminal callback can transition a pending/invalid reviewer result.
      const target = update.packet || validation.packet;
      if (!parsed && update.matched) gateError = new Error("REVIEW_RESULT_INVALID");
      await reconcileGateTarget(target);
      }
    }
    if (pending.role === "tester" && pending.test_task_id && !pending.background) {
      const validation = await validateGateTarget(pending, pending.test_task_id);
      if (validation.code) gateEvent = validation;
      else {
       let evidence;
       try {
          const childID = childSessionIdFromAfter(output?.metadata);
          if (!pending.child_session_id || childID !== pending.child_session_id) throw new Error("TEST_CHILD_SESSION_MISMATCH");
          const response = await pluginInput.client?.session.messages({ path: { id: pending.child_session_id } });
           evidence = testerEvidenceFromMessages(unwrapData(response), { ...pending, ...pending.gate_target });
       } catch {
         evidence = [];
         Object.defineProperty(evidence, "summary", { value: { recognized_count: 0, passed_count: 0, failed_count: 0, truncated_count: 0, status: "missing" }, enumerable: false });
       }
       const parsed = { status: evidence.summary?.status === "passed" ? "passed" : "failed", code: evidence.summary?.status === "passed" ? undefined : "TEST_RESULT_INVALID", evidence };
      const update = await updateWorkPacketByIDIfCurrent(pending.test_task_id, { tester_status: ["pending", "required"] }, { tester_status: parsed.status === "passed" ? "passed" : "failed", ...(parsed.evidence ? { verification_evidence: parsed.evidence } : {}), ...(parsed.code ? { error_code: parsed.code } : {}) });
      const target = update.packet || validation.packet;
      await reconcileGateTarget(target);
      if (update.matched && parsed.status !== "passed") gateError = new Error(parsed.code);
      }
    }
    if (gateEvent) {
      await finalizeReservation(pending, { outcome: "completed", result_summary: gateEvent.code, sessionID: pending.child_session_id || null, terminal: false });
      return gateEvent;
    }
    if (gateError) throw gateError;
    if (!pending.background) {
        // UI telemetry is best-effort only: a missing/failed SDK client must never
        // affect foreground task completion.
        await enrichTaskInvocationFromClient(output, pluginInput.client, foregroundChildID);
        const finalized = await finalizeReservation(pending, { outcome: "completed", result_summary: resultSummary(output), sessionID: foregroundChildID || null });
        if (finalized.code !== "LIFECYCLE_FINALIZED") throw new Error(finalized.code || "FOREGROUND_FINALIZATION_INCOMPLETE");
         await recordLatency({ stage: "task_foreground_total", outcome: "completed", duration_ms: elapsed(pending.started_at), agent: pending.role, call_id: input.callID, ...eventMetadata(pending) });
        const completedPacket = await updateWorkPacket(pending.task_call_id, { phase: "foreground_completion", outcome: "completed", duration_ms: elapsed(pending.started_at), cache_status: pending.cacheable_read ? "stored" : pending.cache_status, ...(pending.role === "tester" && !pending.test_task_id ? { tester_status: "passed" } : {}) });
        if (!completedPacket) throw new Error("FOREGROUND_PACKET_UPDATE_FAILED");
        if (pending.child_session_id) {
          packetCallBySession.delete(pending.child_session_id); bufferedOpenCodeTokens.delete(pending.child_session_id);
        }
        return gateEvent || undefined;
    }
    const childID = childSessionIdFromAfter(output.metadata);
    if (!childID) {
      await finalizeReservation(pending, { outcome: "error", result_summary: "BINDING_MISSING_CHILD", terminal: false });
       await recordLatency({ stage: "task_background_binding", outcome: "missing_child", duration_ms: elapsed(pending.started_at), handoff_ms: elapsed(pending.started_at), agent: pending.role, call_id: input.callID, ...eventMetadata(pending) });
      await updateWorkPacket(pending.task_call_id, { phase: "background_binding", outcome: "error", duration_ms: elapsed(pending.started_at) });
      await advanceTask(pending, "FAILED", { retryable: true, error_code: "BINDING_MISSING_CHILD" });
      throw new Error("Native background task returned no exact child session ID; reservation released fail-closed.");
    }
    const bindingStartedAt = Date.now();
    if (pending.child_session_id && pending.child_session_id !== childID) throw new Error("BACKGROUND_CHILD_SESSION_ID_CONFLICT");
    const bound = await runProcessAsync(BIND, [pending.token, childID], { env: process.env });
     await recordLatency({ stage: "task_background_binding", outcome: bound.status === 0 ? "bound" : "binding_failed", duration_ms: elapsed(bindingStartedAt), handoff_ms: elapsed(bindingStartedAt), agent: pending.role, call_id: input.callID, session_id: childID, ...eventMetadata(pending) });
     if (bound.status !== 0) {
      await finalizeReservation(pending, { outcome: "error", result_summary: "BINDING_FAILED", terminal: false });
      await updateWorkPacket(pending.task_call_id, { phase: "background_binding", outcome: "error", duration_ms: elapsed(pending.started_at) });
      await advanceTask(pending, "FAILED", { retryable: true, error_code: "BINDING_FAILED" });
       throw new Error("Could not bind reservation to the exact native child session.");
     }
      await bindExactChildReservation(pending, childID, { readTask, advanceTask, updateWorkPacket, updateWorkPacketByID, packetPatch: { phase: "background_bound", outcome: "running" } });
     if (pending.role === "codex_executor") {
      const boundPacket = (await listWorkPackets()).find((packet) => packet.packet_id === pending.packet_id || packet.task_call_id === pending.packet_id);
      await ensurePolicy(childID, { agent: "codex_executor", master_parent_session_id: pending.master_parent_session_id, task_call_id: boundPacket?.packet_id || pending.packet_id, task_id: pending.task_id, task_fingerprint: pending.task_fingerprint, attempt: pending.attempt, task_lease_id: pending.task_lease_id, packet_id: boundPacket?.packet_id || pending.packet_id });
      }
       packetCallBySession.set(childID, pending.packet_id);
     reservations.set(childID, { ...pending, child_session_id: childID });
    await flushBufferedOpenCodeTokens(childID);
    reservations.delete(input.callID);
    } catch (error) {
      if (reservations.has(input.callID) || (pending.child_session_id && reservations.has(pending.child_session_id))) {
        await finalizeReservation(pending, { outcome: "error", result_summary: error?.code || "TASK_AFTER_ERROR", sessionID: pending.child_session_id || pending.provisional_child_session_id || null, terminal: false, taskAction: "fail" });
      }
      throw error;
    }
  },
  event: async ({ event }) => {
    if (event.type === "session.created") {
      const child = event.properties.info;
      const parent = child.parentID;
      if (parent) masterParentBySession.set(child.id, masterParent(parent));
      if (parent) {
        const parentGuard = await guardrailFor(masterParent(parent));
        if (parentGuard) { guardrails.set(child.id, { ...parentGuard, activeDelegations: 1, activeDelegation: true }); await writeStopLatch(process.env.OPENAI_TEAM_STATE_ROOT, child.id, parentGuard); }
      }
      if (parent && ["codex_executor", "reviewer", "reviewer_critical", "tester"].includes(child.agent)) {
        const rootParent = masterParent(parent);
        const candidates = [...reservations.entries()].filter(([, pending]) =>
          pending.role === child.agent &&
          reservationEligibleForSessionCreated(pending) &&
          pending.master_parent_session_id === rootParent,
        );
        const explicitCallID = [child.reservation_id, child.reservationID, child.task_call_id, child.callID, child.call_id].find((value) => typeof value === "string" && value) || null;
        const decision = sessionCreatedCorrelationDecision({
          background: candidates.some(([, pending]) => pending.background),
          explicitCallID,
          candidateCallIDs: candidates.map(([, pending]) => pending.task_call_id),
        });
        if (decision === "rejected") throw new Error("SESSION_CREATED_CORRELATION_REJECTED");
        if (["durable", "provisional"].includes(decision)) {
          const [[callID, pending]] = explicitCallID
            ? candidates.filter(([, candidate]) => candidate.task_call_id === explicitCallID)
            : candidates;
          const bindingStartedAt = Date.now();
          const bound = decision === "durable" ? await runProcessAsync(BIND, [pending.token, child.id], { env: process.env }) : { status: 0 };
            await recordLatency({ stage: "task_background_binding", outcome: decision === "provisional" ? "provisional" : (bound.status === 0 ? "bound" : "binding_failed"), duration_ms: elapsed(bindingStartedAt), handoff_ms: elapsed(bindingStartedAt), agent: pending.role, call_id: pending.task_call_id, session_id: child.id, ...eventMetadata(pending) });
           if (bound.status === 0) {
             if (decision === "provisional") pending.provisional_child_session_id = child.id;
             if (decision === "durable") {
      await bindExactChildReservation(pending, child.id, { readTask, advanceTask, updateWorkPacket, updateWorkPacketByID, packetPatch: { phase: "background_bound", outcome: "running" } });
              }
              if (pending.role === "codex_executor" && decision === "durable") await ensurePolicy(child.id, {
              agent: "codex_executor",
              master_parent_session_id: pending.master_parent_session_id,
               task_call_id: pending.packet_id,
              task_id: pending.task_id,
              objective_sha256: pending.objective_sha256,
              task_fingerprint: pending.task_fingerprint,
              attempt: pending.attempt,
              task_lease_id: pending.task_lease_id,
              packet_id: pending.packet_id,
            });
      packetCallBySession.set(child.id, pending.packet_id);
              if (decision === "durable") {
                reservations.set(child.id, { ...pending, child_session_id: child.id });
                reservations.delete(callID);
              }
             await flushBufferedOpenCodeTokens(child.id);
             await recordObjectiveEvent("objective_bound", child.id, pending.master_parent_session_id, pending.task_call_id, CODEX_REQUIRED, "BOUND");
          }
        }
      }
    }
    if (event.type === "session.idle" || event.type === "session.deleted" || event.type === "session.error") {
      const sessionID = event.properties.sessionID || event.properties.info?.id;
      const pending = reservations.get(sessionID);
      if (pending) {
        if (pending.role === "tester" && pending.test_task_id && pending.child_session_id === sessionID) {
           const gateResult = await settleTesterGate(pending, sessionID);
           if (gateResult?.pending) return;
           if (gateResult?.code && gateResult.code !== "STALE_GATE_EVENT") {
            try { await advanceTask(pending, "FAILED", { retryable: true, error_code: gateResult.code, result_summary: "tester_failed" }); } catch {}
          }
        }
        if (!pending.codex_terminal) {
        const finalized = await lifecycleFinalization(pending, event.type, sessionID);
        if (finalized.code !== "LIFECYCLE_ALREADY_FINALIZED") {
         await recordLatency({ stage: "task_background_completion", outcome: event.type.replace("session.", ""), duration_ms: elapsed(pending.started_at), agent: pending.role, call_id: pending.task_call_id, session_id: sessionID, ...eventMetadata(pending) });
        }
        }
      }
        // Policy survives non-terminal lifecycle events: it is the durable
        // authority binding for recovery, quality gates, and duplicate calls.
      if (!pending) { packetCallBySession.delete(sessionID); bufferedOpenCodeTokens.delete(sessionID); }
      if (mandatoryTesterDispatchTrigger(event.type) && sessionID && masterParent(sessionID) === sessionID) {
        await driveMandatoryTesterForRoot(sessionID, { failRequested: true });
      }
    }
      if (event.type === "message.updated") {
        const info = event.properties?.info;
        if (String(info?.role || "").toLowerCase() === "user") {
          const text = (event.properties?.parts || event.properties?.message?.parts || []).filter((part) => part?.type === "text").map((part) => part.text).join(" ");
          const sessionID = event.properties?.sessionID || info.sessionID;
          const testTaskID = String(text).match(/MANDATORY_TESTER_GATE[\s\S]*?test_task_id=([^\s]+)/)?.[1];
           if (sessionID && testTaskID && /^\s*<!-- OMO_INTERNAL_INITIATOR -->[\s\S]*\bMANDATORY_TESTER_GATE\b[\s\S]*\btest_task_id=[^\s]+/.test(text)) {
             const rootID = masterParent(sessionID);
             await observeMandatoryTesterContinuation(rootID, testTaskID, { readWorkPacketByID, updateWorkPacketByIDIfCurrent });
           }
           if (sessionID && !isInternalContinuation(text)) {
             const state = await guardrailFor(sessionID);
             const mappedRoot = masterParentBySession.get(sessionID);
             const resolved = await resolveInitialObjective(sessionID);
             const rootSessionID = mappedRoot || resolved?.rootSessionID;
             const childSession = Boolean(rootSessionID && rootSessionID !== sessionID);
             if (childSession && resolved?.rootSessionID) masterParentBySession.set(sessionID, resolved.rootSessionID);
             const positivelyIdentifiedRoot = resolved?.rootSessionID === sessionID && resolved.parentSessionID == null;
             if (childSession) {
               const rootState = rootSessionID ? guardrails.get(rootSessionID) : null;
               const next = preserveChildGuardState(state, rootState, resolved?.objective);
               guardrails.set(sessionID, next);
               await writeStopLatch(process.env.OPENAI_TEAM_STATE_ROOT, sessionID, next);
               return;
             }
             if (!positivelyIdentifiedRoot) {
               guardrails.set(sessionID, state);
               return;
             }
              const cycled = beginRequestCycle(state, text, Date.now(), process.env, { preserveVerificationTerminal: !positivelyIdentifiedRoot, preserveVerificationGate: !positivelyIdentifiedRoot });
             const next = positivelyIdentifiedRoot ? updateStopLatch(cycled, text, true) : {
               ...cycled,
               stopped: state.stopped,
               verificationTerminal: state.verificationTerminal,
               authoritativeObjective: state.authoritativeObjective || null,
             };
             guardrails.set(sessionID, next);
             await writeStopLatch(process.env.OPENAI_TEAM_STATE_ROOT, sessionID, next);
           }
        }
        if (info?.role === "assistant" && info.finish != null && info.tokens && rememberCompletedMessage(info.id)) {
        const tokens = info.tokens;
        const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
        const input = number(tokens.input), output = number(tokens.output), reasoning = number(tokens.reasoning);
        const cacheRead = number(tokens.cache?.read), cacheWrite = number(tokens.cache?.write);
         const sessionID = event.properties?.sessionID || info.sessionID;
         const packetCallID = typeof sessionID === "string" ? await taskCallForSession(sessionID) : null;
         const packet = packetCallID ? (await listWorkPackets()).find((candidate) => candidate.task_call_id === packetCallID || candidate.packet_id === packetCallID) : null;
         const metric = {
          stage: "opencode_llm", outcome: String(info.finish), agent: typeof info.agent === "string" ? info.agent : null,
          provider_id: typeof info.providerID === "string" ? info.providerID : null, model: typeof info.modelID === "string" ? info.modelID : null,
          input_tokens: input, cached_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_tokens: reasoning,
           total_tokens: input + cacheRead + cacheWrite + output + reasoning, ...eventMetadata(packet),
        };
        const budget = tokenBudget(metric.agent, input);
        budget.cache_ratio_pct = input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : 0;
        metric.threshold_tokens = budget.threshold_tokens;
        metric.overage_tokens = budget.overage_tokens;
        metric.cache_ratio_pct = budget.cache_ratio_pct;
        metric.budget_status = input > budget.threshold_tokens ? "exceeded" : "within";
         if (typeof info.cost === "number" && Number.isFinite(info.cost)) metric.cost = info.cost;
         if (Number.isFinite(info.time?.created) && Number.isFinite(info.time?.completed)) metric.duration_ms = Math.max(0, info.time.completed - info.time.created);
         await recordLatency(metric);
          const eventHash = tokenEventHash("opencode", sessionID, info.id);
          const eventTokens = {
            input_tokens: input, cached_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite,
            output_tokens: output, reasoning_tokens: reasoning, total_tokens: metric.total_tokens,
          };
     if (typeof sessionID === "string" && packetCallID) await addWorkPacketTokensByID(packetCallID, "opencode", eventTokens, eventHash);
          else if (typeof sessionID === "string") {
            const events = bufferedOpenCodeTokens.get(sessionID) || new Map();
            events.set(eventHash, eventTokens);
            bufferedOpenCodeTokens.set(sessionID, events);
          }
       }
    }
  },
  });
  plugin.drainReconciliations = drainReconciliations;
  plugin.disposeReconciliations = () => { for (const timer of reconciliationTimers.values()) clearTimeout(timer); reconciliationTimers.clear(); };
  return plugin;
};

export default { id: "openai-team-tools", server: OpenAITeamTools };
