import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ownerForProcess, canonicalAcquire, serializedReclaim } from "./lock-identity.js";

const root = () => join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "work-packets");
const idFor = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const pathFor = (callID) => join(root(), `${idFor(callID)}.json`);
const packetPathFor = (id) => join(root(), `${/^[a-f0-9]{64}$/i.test(String(id || "")) ? String(id) : idFor(id)}.json`);
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const strings = new Set(["packet_id", "task_call_id", "task_lease_id", "objective_sha256", "parent_session_id", "child_session_id", "agent", "classification", "phase", "outcome", "codex_outcome", "codex_run_id", "codex_thread_id", "codex_last_kind", "parent_codex_run_id", "profile", "requested_model", "executed_model", "fallback_model", "fallback_reason", "created_at", "updated_at", "completed_at", "codex_budget_status", "opencode_budget_status", "discovery_group_id"]);
const safeStrings = new Set(["task_fingerprint", "benchmark_run_id", "benchmark_task_id", "variant", "complexity", "reasoning_effort", "risk", "codex_profile", "review_status", "tester_status", "verification_status", "error_code", "error_phase", "cache_status", "workspace_fingerprint", "test_task_id", "review_task_id", "gate_target"]);
const listStrings = new Set(["acceptance_criteria", "verification_commands", "expected_verification_hashes", "verification_evidence", "discovery_required_lanes", "next_agents", "policy_reasons"]);
const numbers = new Set(["schema_version", "duration_ms", "admission_wait_ms", "codex_input_tokens", "codex_cached_input_tokens", "codex_cache_write_input_tokens", "codex_output_tokens", "codex_reasoning_tokens", "codex_total_tokens", "codex_threshold_tokens", "codex_overage_tokens", "opencode_input_tokens", "opencode_cached_input_tokens", "opencode_cache_write_input_tokens", "opencode_output_tokens", "opencode_reasoning_tokens", "opencode_total_tokens", "opencode_threshold_tokens", "opencode_overage_tokens", "attempt", "recovery_attempt", "retry_count", "codex_resume_count", "fallback_count", "mutation_count", "tool_call_count", "compaction_count", "compaction_input_chars", "compaction_output_chars", "correctness_score", "cost", "first_event_ms", "wrapper_round_trips", "verification_recognized_count", "verification_passed_count", "verification_failed_count", "verification_truncated_count"]);
const booleans = new Set(["review_required", "tester_required", "retryable", "provider_failure", "journal_incomplete"]);
const cumulativeNumbers = new Set(["attempt", "retry_count", "mutation_count", "tool_call_count", "compaction_count", "compaction_input_chars", "compaction_output_chars", "cost", "wrapper_round_trips"]);
const redact = (value) => String(value)
  .replace(/\s+/g, " ")
  .replace(/(?:api[ _-]?key|password|token|secret)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`)
  .replace(/(?:\/[^\s,;]+|~\/?[^\s,;]*|\$(?:HOME|USERPROFILE)[^\s,;]*|%USERPROFILE%[^\s,;]*|[A-Za-z]:\\[^\s,;]+)/g, "[PATH_REDACTED]")
  .trim();
export const sanitizeStringList = (value) => {
  let entries = value;
  if (typeof entries === "string") {
    try { entries = JSON.parse(entries); } catch { entries = []; }
  }
  if (!Array.isArray(entries)) entries = [];
  return JSON.stringify(entries.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const cleaned = redact(entry);
    return cleaned && cleaned.length <= 300 ? [cleaned] : [];
  }).slice(0, 8));
};
export const sanitizeVerificationEvidence = (value) => {
  let entries = value;
  if (typeof entries === "string") { try { entries = JSON.parse(entries); } catch { entries = []; } }
  if (!Array.isArray(entries)) entries = [];
  return JSON.stringify(entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !/^[a-f0-9]{64}$/i.test(String(entry.command_hash || "")) || !Number.isInteger(entry.exit_code)) return [];
    const item = { command_hash: entry.command_hash.toLowerCase(), command_name: String(entry.command_name || "verification").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "verification", exit_code: entry.exit_code };
    if (Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0) item.duration_ms = entry.duration_ms;
    if (entry.independent_tester === true) item.independent_tester = true;
    return [item];
  }).slice(0, 8));
};
export const tokenEventHash = (source, sessionID, messageID) => createHash("sha256").update(`${String(source)}\0${String(sessionID)}\0${String(messageID)}`).digest("hex");
const tokenEventHashes = (value) => {
  try {
    const entries = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(entries) ? entries.filter((entry) => /^[a-f0-9]{64}$/i.test(String(entry))).map((entry) => String(entry).toLowerCase()) : [];
  } catch { return []; }
};
const thresholdFor = (source, agent) => {
  const name = source === "codex" ? "OPENAI_TOKEN_WARN_CODEX_UNCACHED" : agent === "openai_orchestrator" ? "OPENAI_TOKEN_WARN_ORCHESTRATOR_UNCACHED" : agent === "codex_executor" ? "OPENAI_TOKEN_WARN_WRAPPER_UNCACHED" : "OPENAI_TOKEN_WARN_AGENT_UNCACHED";
  const value = Number(process.env[name] ?? (source === "codex" ? 30000 : agent === "openai_orchestrator" ? 50000 : agent === "codex_executor" ? 5000 : 30000));
  return Number.isFinite(value) && value >= 0 ? value : 0;
};
const boundedMilliseconds = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const lockStaleMs = () => boundedMilliseconds(process.env.OPENAI_WORK_PACKET_LOCK_STALE_MS, 30_000, 1, 300_000);
const lockOrphanGraceMs = () => boundedMilliseconds(process.env.OPENAI_WORK_PACKET_LOCK_ORPHAN_GRACE_MS, 1_000, 0, 30_000);
const lockWaitMs = () => boundedMilliseconds(process.env.OPENAI_WORK_PACKET_LOCK_WAIT_MS, 5_000, 1, 30_000);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const clean = (value = {}) => Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
  if (strings.has(key) && (typeof entry === "string" || typeof entry === "number")) return [[key, String(entry)]];
  if (safeStrings.has(key) && (typeof entry === "string" || typeof entry === "number")) {
    const cleaned = redact(entry);
    const fingerprint = key === "task_fingerprint" || key === "workspace_fingerprint";
    return cleaned && (cleaned.length <= 256 || (fingerprint && /^[a-f0-9]{64,128}$/i.test(cleaned))) ? [[key, cleaned]] : [];
  }
  if (key === "verification_evidence") return [[key, sanitizeVerificationEvidence(entry)]];
  if (key === "processed_token_event_hashes") return [[key, JSON.stringify(tokenEventHashes(entry))]];
  if (listStrings.has(key)) return [[key, sanitizeStringList(entry)]];
  if (numbers.has(key) && finite(entry) !== undefined && (!cumulativeNumbers.has(key) || entry >= 0)) return [[key, entry]];
  if (booleans.has(key) && typeof entry === "boolean") return [[key, entry]];
  return [];
}));
const lockFor = (callID) => join(root(), `.${idFor(callID)}.lock`);
const readOwner = async (lock) => { try { return JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); } catch { return null; } };
// Fencing is deliberately directory-rename based: a releaser must still own the
// exact token it acquired, and a contender never deletes a lock in place.
const releaseLock = async (lock, owner) => {
  const current = await readOwner(lock);
  if (current?.token !== owner.token) return;
  const fenced = `${lock}.release-${owner.token}`;
  try { await rename(lock, fenced); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const moved = await readOwner(fenced);
  if (moved?.token === owner.token) await rm(fenced, { recursive: true, force: true });
  else { try { await rename(fenced, lock); } catch {} }
};
const reclaimLock = async (lock) => serializedReclaim(lock, { orphanGraceMs: lockStaleMs() });
const acquireLock = async (lock, owner) => {
  try { return await canonicalAcquire(lock, owner, Date.now() + 1); }
  catch (error) { if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) return false; throw error; }
};
const withLock = async (callID, action, packetID = false) => {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const lock = packetID ? join(root(), `.${callID}.lock`) : lockFor(callID);
  const deadline = Date.now() + lockWaitMs();
  let owner = null;
  while (Date.now() <= deadline) {
    try {
      owner = await ownerForProcess(randomUUID(), lockStaleMs());
      if (await acquireLock(lock, owner)) break;
      owner = null;
      await reclaimLock(lock);
      await delay(10);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        await stat(lock);
        await reclaimLock(lock);
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await delay(10);
    }
  }
  if (!owner) throw new Error("WORK_PACKET_LOCK_TIMEOUT: Timed out waiting for work packet lock");
  try { return await action(); } finally { await releaseLock(lock, owner); }
};
const atomicWrite = async (file, packet) => {
  const temp = join(root(), `.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(clean(packet))}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await chmod(file, 0o600);
};
export const createWorkPacket = async (callID, fields = {}) => withLock(callID, async () => {
  const file = pathFor(callID);
  try { return clean(JSON.parse(await readFile(file, "utf8"))); } catch {}
  const now = new Date().toISOString();
  const packetID = idFor(callID);
  const packet = clean({ ...fields, schema_version: 2, packet_id: packetID, task_call_id: packetID, created_at: now, updated_at: now, phase: "admitted", outcome: "pending" });
  await atomicWrite(file, packet);
  return packet;
});
export const updateWorkPacket = async (callID, fields = {}) => withLock(callID, async () => {
  const file = pathFor(callID);
  let current;
  try { current = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (fields.child_session_id && current.child_session_id && current.child_session_id !== fields.child_session_id) return null;
  const now = new Date().toISOString();
  const next = clean({ ...current, ...clean(fields), updated_at: now });
  if ((next.phase === "foreground_completion" || next.phase === "background_completion" || (next.phase === "codex_terminal" && next.outcome && next.outcome !== "pending")) && !next.completed_at) next.completed_at = now;
  await atomicWrite(file, next);
  return next;
});
// Packet IDs are already canonical file IDs.  Callers must authorize parent/role
// relationships before invoking this; this function only prevents re-hashing them.
export const updateWorkPacketByID = async (packetID, fields = {}) => {
  const id = String(packetID || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  return withLock(id, async () => {
    const file = packetPathFor(id);
    let current;
    try { current = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
    if (String(current.packet_id || "").toLowerCase() !== id) return null;
    if (fields.child_session_id && current.child_session_id && current.child_session_id !== fields.child_session_id) return null;
    const now = new Date().toISOString();
    const next = clean({ ...current, ...clean(fields), updated_at: now });
    if ((next.phase === "foreground_completion" || next.phase === "background_completion" || (next.phase === "codex_terminal" && next.outcome && next.outcome !== "pending")) && !next.completed_at) next.completed_at = now;
    await atomicWrite(file, next);
    return next;
  }, true);
};
export const readWorkPacketByID = async (packetID) => {
  const id = String(packetID || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  return withLock(id, async () => {
    try {
      const packet = JSON.parse(await readFile(packetPathFor(id), "utf8"));
      return String(packet.packet_id || "").toLowerCase() === id ? clean(packet) : null;
    } catch { return null; }
  }, true);
};
// Compare and update while holding the packet's canonical lock.  Expected
// values may be arrays when a caller deliberately accepts a small set of
// non-terminal states.  A mismatch is observable and never writes the packet.
export const updateWorkPacketByIDIfCurrent = async (packetID, expected = {}, fields = {}) => {
  const id = String(packetID || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return { packet: null, matched: false };
  return withLock(id, async () => {
    const file = packetPathFor(id);
    let current;
    try { current = JSON.parse(await readFile(file, "utf8")); } catch { return { packet: null, matched: false }; }
    if (String(current.packet_id || "").toLowerCase() !== id) return { packet: null, matched: false };
    if (fields.child_session_id && current.child_session_id && current.child_session_id !== fields.child_session_id) return { packet: clean(current), matched: false };
    const matched = Object.entries(expected).every(([key, value]) => Array.isArray(value)
      ? value.includes(current[key])
      : current[key] === value);
    if (!matched) return { packet: clean(current), matched: false };
    const now = new Date().toISOString();
    const next = clean({ ...current, ...clean(fields), updated_at: now });
    if ((next.phase === "foreground_completion" || next.phase === "background_completion" || (next.phase === "codex_terminal" && next.outcome && next.outcome !== "pending")) && !next.completed_at) next.completed_at = now;
    await atomicWrite(file, next);
    return { packet: next, matched: true };
  }, true);
};
export const addWorkPacketTokens = async (callID, source, tokens = {}, eventHash = null) => withLock(callID, async () => {
  const file = pathFor(callID);
  let current;
  try { current = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  const prefix = source === "codex" ? "codex" : source === "opencode" ? "opencode" : null;
  if (!prefix) return clean(current);
  const hash = /^[a-f0-9]{64}$/i.test(String(eventHash || "")) ? String(eventHash).toLowerCase() : null;
  const processed = tokenEventHashes(current.processed_token_event_hashes);
  if (hash && processed.includes(hash)) return clean(current);
  const next = { ...current, updated_at: new Date().toISOString() };
  for (const [name, value] of Object.entries(tokens)) {
    const key = `${prefix}_${name}`;
    if (numbers.has(key) && finite(value) !== undefined) next[key] = (finite(current[key]) || 0) + value;
  }
  const threshold = thresholdFor(prefix, next.agent);
  const input = finite(next[`${prefix}_input_tokens`]) || 0;
  next[`${prefix}_threshold_tokens`] = threshold;
  next[`${prefix}_overage_tokens`] = Math.max(0, input - threshold);
  next[`${prefix}_budget_status`] = input > threshold ? "exceeded" : "within";
  if (hash) next.processed_token_event_hashes = JSON.stringify([...processed, hash]);
  await atomicWrite(file, next);
  return clean(next);
});
export const addWorkPacketTokensByID = async (packetID, source, tokens = {}, eventHash = null) => {
  const id = String(packetID || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  return withLock(id, async () => {
    const file = packetPathFor(id); let current;
    try { current = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
    if (String(current.packet_id || "").toLowerCase() !== id) return null;
    const prefix = source === "codex" ? "codex" : source === "opencode" ? "opencode" : null;
    if (!prefix) return clean(current);
    const hash = /^[a-f0-9]{64}$/i.test(String(eventHash || "")) ? String(eventHash).toLowerCase() : null;
    const processed = tokenEventHashes(current.processed_token_event_hashes);
    if (hash && processed.includes(hash)) return clean(current);
    const next = { ...current, updated_at: new Date().toISOString() };
    for (const [name, value] of Object.entries(tokens)) { const key = `${prefix}_${name}`; if (numbers.has(key) && finite(value) !== undefined) next[key] = (finite(current[key]) || 0) + value; }
    const threshold = thresholdFor(prefix, next.agent), input = finite(next[`${prefix}_input_tokens`]) || 0;
    next[`${prefix}_threshold_tokens`] = threshold; next[`${prefix}_overage_tokens`] = Math.max(0, input - threshold); next[`${prefix}_budget_status`] = input > threshold ? "exceeded" : "within";
    if (hash) next.processed_token_event_hashes = JSON.stringify([...processed, hash]); await atomicWrite(file, next); return clean(next);
  }, true);
};
export const incrementWorkPacket = async (callID, counters = {}) => withLock(callID, async () => {
  const file = packetPathFor(callID);
  let current;
  try { current = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  const next = { ...current, updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(counters)) {
    if (cumulativeNumbers.has(key) && finite(value) !== undefined && value >= 0) next[key] = (finite(current[key]) || 0) + value;
  }
  await atomicWrite(file, next);
  return clean(next);
});
export const incrementWorkPacketByID = async (packetID, counters = {}) => {
  const id = String(packetID || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  return withLock(id, async () => {
    const file = packetPathFor(id); let current;
    try { current = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
    if (String(current.packet_id || "").toLowerCase() !== id) return null;
    const next = { ...current, updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(counters)) if (cumulativeNumbers.has(key) && finite(value) !== undefined && value >= 0) next[key] = (finite(current[key]) || 0) + value;
    await atomicWrite(file, next); return clean(next);
  }, true);
};
export const pruneWorkPackets = async () => {
  const days = Number(process.env.OPENAI_WORK_PACKET_RETENTION_DAYS ?? 7);
  const retentionMs = (Number.isFinite(days) && days >= 0 ? days : 7) * 86400000;
  let names = [];
  try { names = await readdir(root()); } catch { return 0; }
  let removed = 0;
  await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
    const packetID = name.slice(0, -5);
    try {
      const deleted = await withLock(packetID, async () => {
        const file = join(root(), name);
        let packet;
        try { packet = JSON.parse(await readFile(file, "utf8")); } catch { return false; }
        const terminal = ["codex_terminal", "foreground_completion", "background_completion"].includes(packet.phase)
          && ["completed", "success", "failed", "error"].includes(packet.outcome)
          && packet.completed_at
          && !["pending", "required"].includes(packet.tester_status);
        const completed = Date.parse(packet.completed_at);
        if (terminal && Number.isFinite(completed) && Date.now() - completed > retentionMs) {
          await rm(file, { force: true });
          return true;
        }
        return false;
      }, true);
      if (deleted) removed++;
    } catch {}
  }));
  return removed;
};
export const listWorkPackets = async () => {
  let names = [];
  try { names = await readdir(root()); } catch { return []; }
  const packets = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
    try { const file = join(root(), name); const packet = JSON.parse(await readFile(file, "utf8")); await stat(file); return clean(packet); } catch { return null; }
  }));
  return packets.filter(Boolean).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
};
