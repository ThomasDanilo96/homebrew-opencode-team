import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEX_REQUIRED, CODEX_SUCCESS, TERRA_FALLBACK, ensurePolicy, readPolicy } from "./codex-authority.js";
import { allowsDailyOrchestratorShell } from "./openai-guardrails.js";
import { isAllowlistedVerificationCommand, verificationCommandCategory } from "./execution-policy.js";
import { createHash } from "node:crypto";
import { extractTaskPacketMarker, objectiveBeforeMarker } from "./correlation-marker.js";
import { listWorkPackets, readWorkPacketByID } from "./work-packet.js";
import { readTask, transitionTask } from "./task-state.js";
import { updateWorkPacketByID } from "./work-packet.js";

const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "webfetch", "todowrite", "skill", "skill_mcp",
  "task", "docs", "documentation",
  "lsp_diagnostics", "lsp_symbols", "lsp_definition", "lsp_references", "lsp_hover", "lsp_workspace_symbols",
  "openai_remote_read",
  "session_list", "session_read", "session_search", "session_info",
  "background_output", "background_cancel", "look_at",
  "serena_initial_instructions", "serena_get_symbols_overview", "serena_find_symbol",
  "serena_find_declaration", "serena_find_implementations", "serena_find_referencing_symbols",
  "serena_get_diagnostics_for_file", "serena_search_for_pattern", "serena_list_memories",
  "serena_read_memory", "serena_get_current_config", "serena_list_mcp_resources",
  "serena_read_mcp_resource", "serena_activate_project",
]);

const UNBOUNDED_EXECUTION = new Set(["bash", "interactive_bash", "shell", "command"]);
const NATIVE_MUTATIONS = new Set([
  "apply_patch", "edit", "write", "delete", "rename", "file_create", "file_delete", "file_rename",
  "create_file", "remove_file", "move_file", "multi_edit", "write_file", "patch",
]);
const SERENA_MUTATION_PREFIXES = [
  "serena_replace_", "serena_insert_", "serena_rename_", "serena_delete_", "serena_write_",
  "serena_safe_delete_", "serena_edit_",
];
const FALLBACK_MUTATION_TOOLS = new Set([
  ...NATIVE_MUTATIONS, ...UNBOUNDED_EXECUTION,
  "serena_replace_content", "serena_replace_in_files", "serena_replace_symbol_body",
  "serena_insert_before_symbol", "serena_insert_after_symbol", "serena_rename_symbol",
  "serena_safe_delete_symbol", "serena_write_memory", "serena_edit_memory",
]);
export const CODEX_BOOTSTRAP_REASONS = Object.freeze({
  AGENT_SESSION: "AGENT_SESSION",
  SESSION_METADATA_PARENT: "SESSION_METADATA_PARENT",
  PROMPT: "PROMPT",
  CANDIDATE_COUNT: "CANDIDATE_COUNT",
  TASK_MISSING: "TASK_MISSING",
  TASK_IDENTITY: "TASK_IDENTITY",
  TASK_STATE: "TASK_STATE",
  CHILD_CONFLICT: "CHILD_CONFLICT",
  TRANSITION: "TRANSITION",
  PROVISIONAL_POLICY_CONFLICT: "PROVISIONAL_POLICY_CONFLICT",
  PACKET_BIND: "PACKET_BIND",
  POLICY_STATUS: "POLICY_STATUS",
  EXCEPTION: "EXCEPTION",
});
const GUARDED_AGENTS = new Set([
  "openai_orchestrator", "codex_executor", "openai_explore", "openai_librarian", "openai_ops", "reviewer", "reviewer_critical", "specialist",
]);

const stateRoot = () => process.env.OPENAI_TEAM_STATE_ROOT;
const logPath = () => join(stateRoot() || "/tmp", "logs", "authorship-guard.log");
const candidateWaitMs = () => Math.min(2000, Math.max(0, Number(process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS ?? 750) || 750));
const candidatePollMs = () => Math.min(25, Math.max(10, Number(process.env.OPENAI_CODEX_CANDIDATE_POLL_MS ?? 15) || 15));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arrayValue = (value) => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

const isSerenaMutation = (toolName) => SERENA_MUTATION_PREFIXES.some((prefix) => toolName.startsWith(prefix));
const isCustomMutation = (toolName) => /(?:mutat|write|edit|patch|delete|remove|rename|create|move|exec|bash|shell|command)/.test(toolName);
const isDangerous = (toolName) => UNBOUNDED_EXECUTION.has(toolName) || NATIVE_MUTATIONS.has(toolName) || isSerenaMutation(toolName) || isCustomMutation(toolName);
const isKnownTool = (toolName) => READ_ONLY_TOOLS.has(toolName) || toolName === "openai_run_codex" || UNBOUNDED_EXECUTION.has(toolName) || NATIVE_MUTATIONS.has(toolName) || isSerenaMutation(toolName);

const resolveAgent = async (pluginInput, input) => {
  if (input.agent) return input.agent;
  try {
    const response = await pluginInput.client?.session.messages({ path: { id: input.sessionID } });
    const agents = (response?.data || []).map((message) => message.info?.agent).filter(Boolean);
    return [...new Set(agents)].length === 1 ? agents[0] : null;
  } catch {
    return null;
  }
};

const childParent = (session) => session?.parentID || session?.parent_id || session?.parent?.id || null;
const childPrompt = (messages) => {
  const latest = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.info?.role === "user");
  const text = (latest?.parts || []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
  return text || null;
};
const genuineObjective = async (pluginInput, input) => {
  const supplied = pluginInput.authoritativeObjective;
  if (typeof supplied === "function") return await supplied(input.sessionID);
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  try {
    let id = input.sessionID;
    for (let depth = 0; id && depth < 32; depth += 1) {
      const session = (await pluginInput.client?.session?.get({ path: { id } }))?.data;
      const parent = childParent(session);
      if (!parent) {
        const messages = (await pluginInput.client?.session?.messages({ path: { id } }))?.data;
        return childPrompt(messages);
      }
      if (parent === id) return null;
      id = parent;
    }
  } catch { return null; }
  return null;
};
export const bootstrapCodexPolicy = async (pluginInput, sessionID, agent) => {
  const blocked = (reason) => ({ policy: null, reason });
  if (agent !== "codex_executor" || !sessionID) return blocked(CODEX_BOOTSTRAP_REASONS.AGENT_SESSION);
  try {
    const session = (await pluginInput.client?.session?.get({ path: { id: sessionID } }))?.data;
    if (!session) return blocked(CODEX_BOOTSTRAP_REASONS.SESSION_METADATA_PARENT);
    const parentID = childParent(session);
    if (!parentID || parentID === sessionID) return blocked(CODEX_BOOTSTRAP_REASONS.SESSION_METADATA_PARENT);
    const messages = (await pluginInput.client?.session?.messages({ path: { id: sessionID } }))?.data;
    const prompt = childPrompt(messages);
    if (!prompt) return blocked(CODEX_BOOTSTRAP_REASONS.PROMPT);
    const marker = extractTaskPacketMarker(prompt);
    if (marker.present && !marker.valid) return blocked(CODEX_BOOTSTRAP_REASONS.CANDIDATE_COUNT);
    const objective = marker.present ? objectiveBeforeMarker(prompt) : prompt;
    const objective_sha256 = createHash("sha256").update(objective).digest("hex");
    const listPackets = pluginInput.listWorkPackets || listWorkPackets;
    const parentIDs = new Set([parentID]);
    let cursor = parentID;
    let rootID = parentID;
    for (let i = 0; i < 32; i++) {
      const parent = (await pluginInput.client?.session?.get({ path: { id: cursor } }))?.data;
      const next = childParent(parent);
      if (!next || parentIDs.has(next)) { rootID = cursor; break; }
      cursor = next;
    }
    parentIDs.add(rootID);
    const eligibleCandidates = (packets) => (Array.isArray(packets) ? packets : []).filter((packet) =>
        packet?.agent === "codex_executor" && parentIDs.has(packet.parent_session_id) &&
        packet.objective_sha256 === objective_sha256 &&
        ["admitted", "codex_running", "foreground_bound", "running"].includes(String(packet.phase || "").toLowerCase()) &&
        ["pending", "running"].includes(String(packet.outcome || "").toLowerCase()) &&
        (packet.child_session_id == null || packet.child_session_id === sessionID));
    let packet;
    if (marker.present) {
      packet = await (pluginInput.readWorkPacketByID || readWorkPacketByID)(marker.packetID);
      if (!packet || packet.objective_sha256 !== objective_sha256 || packet.parent_session_id !== rootID || packet.agent !== "codex_executor" || !["admitted", "codex_running", "foreground_bound", "running"].includes(String(packet.phase || "").toLowerCase()) || !["pending", "running"].includes(String(packet.outcome || "").toLowerCase()) || (packet.child_session_id && packet.child_session_id !== sessionID)) return blocked(CODEX_BOOTSTRAP_REASONS.CANDIDATE_COUNT);
    } else {
      let candidates = eligibleCandidates(await listPackets());
      const deadline = Date.now() + candidateWaitMs();
      while (candidates.length === 0 && Date.now() < deadline) {
        await delay(Math.min(candidatePollMs(), deadline - Date.now()));
        candidates = eligibleCandidates(await listPackets());
      }
      if (candidates.length !== 1) return blocked(CODEX_BOOTSTRAP_REASONS.CANDIDATE_COUNT);
      packet = candidates[0];
    }
    const task = await (pluginInput.readTask || readTask)(packet.task_fingerprint);
    const lease = packet.task_lease_id || packet.lease_id;
    if (!task) return blocked(CODEX_BOOTSTRAP_REASONS.TASK_MISSING);
    if (task.agent !== "codex_executor" || task.parent_session_id !== packet.parent_session_id ||
      task.packet_id !== packet.packet_id || task.attempt !== packet.attempt || task.lease_id !== lease) {
      return blocked(CODEX_BOOTSTRAP_REASONS.TASK_IDENTITY);
    }
    if (task.task_fingerprint !== packet.task_fingerprint || !["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION"].includes(task.state)) {
      return blocked(CODEX_BOOTSTRAP_REASONS.TASK_STATE);
    }
    if (task.child_session_id && task.child_session_id !== sessionID) return blocked(CODEX_BOOTSTRAP_REASONS.CHILD_CONFLICT);
    if (["CLAIMED", "ADMITTED"].includes(task.state)) {
      let bound;
      try {
        bound = await (pluginInput.transitionTask || transitionTask)(task.task_fingerprint, { expectedVersion: task.version, expectedStates: [task.state], leaseId: task.lease_id, expectedAttempt: task.attempt, expectedLease: task.lease_id, patch: { state: "BOUND", child_session_id: sessionID } });
      } catch { return blocked(CODEX_BOOTSTRAP_REASONS.TRANSITION); }
      if (bound.child_session_id !== sessionID) return blocked(CODEX_BOOTSTRAP_REASONS.CHILD_CONFLICT);
    } else if (!task.child_session_id || task.child_session_id !== sessionID) return blocked(CODEX_BOOTSTRAP_REASONS.CHILD_CONFLICT);
    const expectedPolicy = {
      agent: task.agent, master_parent_session_id: packet.parent_session_id,
      task_fingerprint: task.task_fingerprint, packet_id: task.packet_id,
      task_call_id: packet.task_call_id || packet.packet_id, attempt: task.attempt,
      task_lease_id: task.lease_id, objective_sha256,
    };
    const existingPolicy = await readPolicy(sessionID);
    if (existingPolicy && Object.entries(expectedPolicy).some(([key, value]) => existingPolicy[key] != null && existingPolicy[key] !== value)) return blocked(CODEX_BOOTSTRAP_REASONS.PROVISIONAL_POLICY_CONFLICT);
    const boundPacket = await (pluginInput.updateWorkPacketByID || updateWorkPacketByID)(packet.packet_id, { child_session_id: sessionID, phase: "foreground_bound", outcome: "running" });
    if (!boundPacket?.child_session_id || boundPacket.child_session_id !== sessionID) return blocked(CODEX_BOOTSTRAP_REASONS.PACKET_BIND);
    const policy = await ensurePolicy(sessionID, {
      schema_version: 1, ...expectedPolicy,
    });
    return policy?.schema_version === 1 && policy.session_id === sessionID && policy.agent === "codex_executor" && policy.status === CODEX_REQUIRED
      ? { policy, reason: null } : blocked(CODEX_BOOTSTRAP_REASONS.POLICY_STATUS);
  } catch { return blocked(CODEX_BOOTSTRAP_REASONS.EXCEPTION); }
};

const validateExistingCodexPolicy = async (pluginInput, sessionID, policy) => {
  if (!policy || policy.schema_version !== 1 || policy.session_id !== sessionID || policy.agent !== "codex_executor" || policy.status !== CODEX_REQUIRED) return false;
  try {
    const session = (await pluginInput.client?.session?.get({ path: { id: sessionID } }))?.data;
    const parentID = childParent(session);
    const messages = (await pluginInput.client?.session?.messages({ path: { id: sessionID } }))?.data;
    const prompt = childPrompt(messages);
    if (!parentID || !prompt) return false;
    const marker = extractTaskPacketMarker(prompt);
    if (marker.present && !marker.valid) return false;
    const objective = marker.present ? objectiveBeforeMarker(prompt) : prompt;
    const hash = createHash("sha256").update(objective).digest("hex");
    const packet = marker.present
      ? await (pluginInput.readWorkPacketByID || readWorkPacketByID)(marker.packetID)
      : (await (pluginInput.listWorkPackets || listWorkPackets)()).find((entry) => entry.packet_id === policy.packet_id && entry.child_session_id === sessionID && entry.agent === "codex_executor" && entry.objective_sha256 === hash && ["pending", "running"].includes(String(entry.outcome || "").toLowerCase()) && (entry.parent_session_id === parentID || entry.parent_session_id === policy.master_parent_session_id));
    if (marker.present && (!packet || packet.packet_id !== policy.packet_id || packet.parent_session_id !== (policy.master_parent_session_id || parentID))) return false;
    const task = packet ? await readTask(packet.task_fingerprint) : null;
    return Boolean(packet && task && ["admitted", "codex_running", "foreground_bound", "running"].includes(String(packet.phase || "").toLowerCase()) && packet.task_lease_id === task.lease_id && packet.attempt === task.attempt && packet.task_call_id === policy.task_call_id && task.agent === "codex_executor" && task.parent_session_id === packet.parent_session_id && task.packet_id === packet.packet_id && task.attempt === policy.attempt && task.lease_id === policy.task_lease_id && task.child_session_id === sessionID && ["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION"].includes(task.state) && policy.task_fingerprint === task.task_fingerprint && policy.objective_sha256 === hash);
  } catch { return false; }
};

const record = async (event, input, agent, authorityState, action) => {
  const path = logPath();
  await mkdir(dirname(path), { recursive: true });
  const line = [new Date().toISOString(), event, input.sessionID || "-", agent || "unknown", input.tool || "-", authorityState || "NONE", action].join(" ");
  await appendFile(path, `${line}\n`, { mode: 0o600 });
};

export const OpenAIAuthorshipGuard = async (pluginInput = {}) => ({
  "tool.execute.before": async (input, output = {}) => {
    const toolName = String(input.tool || "").toLowerCase();
    if (toolName === "openai_run_codex") {
      // This must be independently verifiable: input.agent is caller supplied
      // and cannot authorize native execution on its own.
      const agent = await resolveAgent(pluginInput, { ...input, agent: undefined });
      let policy = agent === "codex_executor" && typeof input.sessionID === "string" && input.sessionID ? await readPolicy(input.sessionID) : null;
      let bootstrapReason = null;
      if (!policy || !(await validateExistingCodexPolicy(pluginInput, input.sessionID, policy))) {
        const bootstrap = await bootstrapCodexPolicy(pluginInput, input.sessionID, agent);
        policy = bootstrap.policy;
        bootstrapReason = bootstrap.reason;
      }
      const canonicalPolicy = policy?.schema_version === 1 && policy.session_id === input.sessionID && policy.agent === "codex_executor" && policy.status === CODEX_REQUIRED && (await validateExistingCodexPolicy(pluginInput, input.sessionID, policy));
      if (!canonicalPolicy) {
        if (bootstrapReason) await record("codex_bootstrap_failed", input, agent, "NONE", `BLOCK:${bootstrapReason}`);
        await record("codex_tool_blocked", input, agent, policy?.status || "NONE", "BLOCK");
        throw new Error("OPENAI AUTHORSHIP POLICY: openai_run_codex requires verified codex_executor session attribution and canonical CODEX_REQUIRED policy.");
      }
      await record("codex_tool_allowed", input, agent, CODEX_REQUIRED, "ALLOW");
      return;
    }
    if (READ_ONLY_TOOLS.has(toolName)) return;

    const agent = await resolveAgent(pluginInput, input);
    if (agent === "tester" && toolName === "bash") {
      const command = output.args?.command ?? output.args?.cmd ?? input.args?.command ?? input.args?.cmd ?? "";
      const reservation = typeof input.sessionID === "string"
        ? (await listWorkPackets()).find((packet) => packet.child_session_id === input.sessionID
          && packet.agent === "tester" && ["pending", "required"].includes(packet.tester_status))
        : null;
      const targetID = typeof reservation?.test_task_id === "string" && /^[a-f0-9]{64}$/i.test(reservation.test_task_id) ? reservation.test_task_id.toLowerCase() : null;
      const target = targetID ? (await listWorkPackets()).find((packet) => packet.packet_id === targetID) : null;
      const expected = new Set([
        ...arrayValue(target?.verification_commands),
        ...arrayValue(target?.verification_evidence).map((entry) => entry?.command_hash),
        ...arrayValue(target?.expected_verification_hashes),
      ].filter((value) => typeof value === "string" && isAllowlistedVerificationCommand(value)
        ? true : typeof value === "string" && /^[a-f0-9]{64}$/i.test(value))
        .map((value) => /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : createHash("sha256").update(value).digest("hex")));
      const commandHash = typeof command === "string" ? createHash("sha256").update(command).digest("hex") : "";
      if (reservation != null && targetID != null && target != null && typeof command === "string" && isAllowlistedVerificationCommand(command)
        && expected.has(commandHash)) {
        await record("tester_verification_bash_allowed", input, agent, "NONE", `ALLOW:${verificationCommandCategory(command)}`);
        return;
      }
      await record("tester_verification_bash_blocked", input, agent, "NONE", "BLOCK");
      throw new Error("OPENAI AUTHORSHIP POLICY: Tester bash is restricted to allowlisted verification commands.");
    }
    // The custom-name heuristic remains a second line of defense and is never
    // used to expand the read-only allowlist.
    const mutationLookingTool = isCustomMutation(toolName);
    const unknownTool = !isKnownTool(toolName);
    // Attribution is itself an authority boundary.  A mutation-capable tool
    // must never become available merely because session metadata is absent,
    // null, ambiguous, or names an unrecognised agent.
    if (!GUARDED_AGENTS.has(agent) && agent !== "tester") {
      await record("unattributed_mutation_blocked", input, agent, "NONE", "BLOCK");
      throw new Error(`OPENAI AUTHORSHIP POLICY: ${unknownTool ? "UNKNOWN_TOOL_DENIED: " : ""}Mutation-capable tools require verified codex_executor attribution and structured TERRA_FALLBACK authority.`);
    }

    const policy = agent === "codex_executor" ? await readPolicy(input.sessionID) : null;
    const authorityState = policy?.status || "NONE";
    if (agent === "codex_executor" && authorityState === TERRA_FALLBACK && FALLBACK_MUTATION_TOOLS.has(toolName)) {
      await record("terra_fallback_mutation_allowed", input, agent, authorityState, "ALLOW");
      return;
    }

    if (agent === "tester") {
      await record("tester_mutation_blocked", input, agent, authorityState, "BLOCK");
      throw new Error("OPENAI AUTHORSHIP POLICY: Tester is read-only and may not invoke mutation-capable or unbounded execution tools.");
    }

    const command = output.args?.command ?? output.args?.cmd ?? input.args?.command ?? input.args?.cmd;
    if (agent === "openai_orchestrator" && allowsDailyOrchestratorShell(toolName, command, await genuineObjective(pluginInput, input))) {
      await record("daily_orchestrator_shell_allowed", input, agent, "NONE", "ALLOW");
      return;
    }

    if (unknownTool || (agent === "codex_executor" && authorityState === TERRA_FALLBACK && !FALLBACK_MUTATION_TOOLS.has(toolName))) {
      await record("unknown_tool_denied", input, agent, authorityState, "BLOCK");
      throw new Error("OPENAI AUTHORSHIP POLICY: UNKNOWN_TOOL_DENIED");
    }

    const event = UNBOUNDED_EXECUTION.has(toolName) ? "unbounded_execution_blocked" : mutationLookingTool ? "mutation_blocked" : "unknown_tool_denied";
    await record(event, input, agent, authorityState, "BLOCK");
    if (agent === "openai_orchestrator") {
      throw new Error("OPENAI AUTHORSHIP POLICY: Repository mutations must be delegated through the native codex_executor task. The orchestrator is read/orchestration only.");
    }
    throw new Error("OPENAI AUTHORSHIP POLICY: Native repository mutation is denied until structured TERRA_FALLBACK authority exists.");
  },
});

export default { id: "openai-authorship-guard", server: OpenAIAuthorshipGuard };
