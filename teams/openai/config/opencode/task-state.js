import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ownerForProcess, canonicalAcquire, serializedReclaim } from "./lock-identity.js";

const root = () => join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "task-state");
const taskID = (value) => /^[a-f0-9]{64}$/i.test(String(value || "")) ? String(value) : createHash("sha256").update(String(value || "")).digest("hex");
const fileFor = (fingerprint) => join(root(), `${taskID(fingerprint)}.json`);
const lockFor = (fingerprint) => join(root(), `.${taskID(fingerprint)}.lock`);
const leaseMs = () => { const value = Number(process.env.OPENAI_TASK_LEASE_MS ?? 1_200_000); return Number.isInteger(value) && value >= 1000 && value <= 3_600_000 ? value : 1_200_000; };
const bounded = (value, fallback, min, max) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
const lockTimeoutMs = () => bounded(process.env.OPENAI_TASK_LOCK_TIMEOUT_MS, 5_000, 1, 30_000);
const lockStaleMs = () => bounded(process.env.OPENAI_TASK_LOCK_STALE_MS, 30_000, 1, 300_000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();
const redact = (value, max = 4096) => String(value ?? "").replace(/\s+/g, " ").replace(/(?:api[ _-]?key|password|token|secret)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`).replace(/(?:\/[^\s,;]+|~\/?[^\s,;]*|[A-Za-z]:\\[^\s,;]+)/g, "[PATH_REDACTED]").replace(/[^A-Za-z0-9 .,:_/@=+\-\[\]]/g, "").trim().slice(0, max);
export class TaskStateError extends Error { constructor(code, detail = {}) { super(JSON.stringify({ code, retryable: Boolean(detail.retryable), phase: detail.phase || "task_state", task_id: detail.task_id || null, provider_failure: Boolean(detail.provider_failure) })); this.name = "TaskStateError"; this.code = code; Object.assign(this, detail); } }
const fail = (code, detail) => { throw new TaskStateError(code, detail); };
const identityFields = ["task_fingerprint", "objective_sha256", "parent_session_id", "agent"];
const valid = (record) => {
  if (!record || record.schema_version !== 1 || !identityFields.every((key) => typeof record[key] === "string" && record[key]) || !["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION", "COMPLETED", "FAILED"].includes(record.state) || !Number.isInteger(record.attempt) || record.attempt < 1 || !Number.isInteger(record.version) || record.version < 1 || typeof record.lease_id !== "string") return false;
  return terminal(record) || (typeof record.lease_expires_at === "string" && Number.isFinite(Date.parse(record.lease_expires_at)) && Date.parse(record.lease_expires_at) > 0);
};
const readUnchecked = async (fingerprint) => { let raw; try { raw = await readFile(fileFor(fingerprint), "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } let record; try { record = JSON.parse(raw); } catch { fail("TASK_STATE_MALFORMED", { task_id: taskID(fingerprint) }); } if (!valid(record)) fail("TASK_STATE_MALFORMED", { task_id: taskID(fingerprint) }); return record; };
const atomicWrite = async (fingerprint, record) => { await mkdir(root(), { recursive: true, mode: 0o700 }); const temp = join(root(), `.${randomUUID()}.tmp`); await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, fileFor(fingerprint)); await chmod(fileFor(fingerprint), 0o600); };
const ownerInfo = async (lock) => { try { const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); return typeof owner?.token === "string" && Number.isInteger(owner.pid) && Number.isFinite(owner.acquired_at) && Number.isFinite(owner.heartbeat_at) ? owner : null; } catch { return null; } };
const releaseLock = async (lock, owner) => { const token = typeof owner === "string" ? owner : owner?.token; if (!token || (await ownerInfo(lock))?.token !== token) return; const fenced = `${lock}.release-${token}`; try { await rename(lock, fenced); } catch (error) { if (error?.code === "ENOENT") return; throw error; } if ((await ownerInfo(fenced))?.token === token) await rm(fenced, { recursive: true, force: true }); else { try { await rename(fenced, lock); } catch {} } };
const reclaimLock = async (lock, beforeRename) => serializedReclaim(lock, { orphanGraceMs: 1000, beforeRename });
const acquireLock = async (lock, owner) => { try { return await canonicalAcquire(lock, owner, Date.now() + 1); } catch (error) { if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) return false; throw error; } };
const withLock = async (fingerprint, action) => { await mkdir(root(), { recursive: true, mode: 0o700 }); const lock = lockFor(fingerprint), deadline = Date.now() + lockTimeoutMs(); let owner; while (Date.now() <= deadline) { const candidate = await ownerForProcess(randomUUID(), lockStaleMs(), { stale_after_ms: lockStaleMs() }); if (await acquireLock(lock, candidate)) { owner = candidate; break; } await reclaimLock(lock); await delay(10); } if (!owner) fail("TASK_LOCK_TIMEOUT", { task_id: taskID(fingerprint), retryable: true }); try { return await action(); } finally { await releaseLock(lock, owner); } };
const sameIdentity = (record, identity) => identityFields.every((key) => record[key] === identity[key]);
const terminal = (record) => record.state === "COMPLETED" || (record.state === "FAILED" && !record.retryable);
const legalTransitions = {
  CLAIMED: ["ADMITTED", "PENDING_REVIEW", "PENDING_VERIFICATION", "COMPLETED", "FAILED"], ADMITTED: ["BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION", "COMPLETED", "FAILED"], BOUND: ["RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION", "COMPLETED", "FAILED"],
  RUNNING: ["PENDING_REVIEW", "PENDING_VERIFICATION", "COMPLETED", "FAILED"], PENDING_REVIEW: ["PENDING_VERIFICATION", "COMPLETED", "FAILED"],
  PENDING_VERIFICATION: ["PENDING_REVIEW", "COMPLETED", "FAILED"], COMPLETED: ["FAILED"], FAILED: [],
};
const expired = (record) => Date.parse(record.lease_expires_at) <= Date.now();
const safeRecord = (record) => ({ ...record, result_summary: redact(record.result_summary) });
export const readTask = async (fingerprint) => safeRecord(await readUnchecked(fingerprint));
export const claimTask = async (identity) => {
  if (!identity || !identityFields.every((key) => typeof identity[key] === "string" && identity[key])) fail("TASK_IDENTITY_INVALID", { task_id: taskID(identity?.task_fingerprint) });
  const fingerprint = taskID(identity.task_fingerprint);
  return withLock(fingerprint, async () => {
    const current = await readUnchecked(fingerprint);
    if (current && !sameIdentity(current, identity)) fail("TASK_IDENTITY_MISMATCH", { task_id: fingerprint });
    if (current && terminal(current)) return { owner: false, disposition: "TERMINAL_REPLAY", record: safeRecord(current) };
    if (current && ["PENDING_REVIEW", "PENDING_VERIFICATION"].includes(current.state) && identity.implementation_retry_authorized !== true) {
      return { owner: false, disposition: "ACTIVE_DUPLICATE", record: safeRecord(current) };
    }
    if (current && !current.retryable && !expired(current)) return { owner: false, disposition: "ACTIVE_DUPLICATE", record: safeRecord(current) };
    const now = iso(), next = { ...(current || {}), schema_version: 1, task_fingerprint: fingerprint, objective_sha256: identity.objective_sha256, parent_session_id: redact(identity.parent_session_id, 128), agent: redact(identity.agent, 128), first_call_id: current?.first_call_id || taskID(identity.first_call_id || ""), packet_id: current?.packet_id || taskID(identity.packet_id || identity.first_call_id || ""), state: "CLAIMED", attempt: (current?.attempt || 0) + 1, version: (current?.version || 0) + 1, lease_id: randomUUID(), lease_expires_at: new Date(Date.now() + leaseMs()).toISOString(), child_session_id: null, retryable: false, error_code: null, result_summary: null, created_at: current?.created_at || now, updated_at: now };
    await atomicWrite(fingerprint, next); return { owner: true, disposition: current ? "RECLAIMED" : "CLAIMED", record: safeRecord(next) };
  });
};
export const transitionTask = async (fingerprint, { expectedVersion, expectedStates, leaseId, expectedAttempt, expectedLease, patch = {} } = {}) => withLock(fingerprint, async () => {
  const current = await readUnchecked(fingerprint); if (!current) fail("TASK_NOT_FOUND", { task_id: taskID(fingerprint) });
  if (current.version !== expectedVersion) fail("TASK_VERSION_REJECTED", { task_id: taskID(fingerprint), retryable: true });
  if (expectedAttempt != null && current.attempt !== expectedAttempt) fail("TASK_ATTEMPT_REJECTED", { task_id: taskID(fingerprint), retryable: true });
  if (expectedLease != null && current.lease_id !== expectedLease) fail("TASK_LEASE_REJECTED", { task_id: taskID(fingerprint), retryable: true });
  if (!Array.isArray(expectedStates) || !expectedStates.includes(current.state)) fail("TASK_STATE_REJECTED", { task_id: taskID(fingerprint) });
  if (current.lease_id !== leaseId) fail("TASK_LEASE_REJECTED", { task_id: taskID(fingerprint) });
  const allowed = new Set(["state", "child_session_id", "retryable", "error_code", "result_summary"]); const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key))), version: current.version + 1, updated_at: iso() };
  if (next.state !== current.state && !legalTransitions[current.state]?.includes(next.state)) fail("TASK_TRANSITION_REJECTED", { task_id: taskID(fingerprint) });
  next.result_summary = redact(next.result_summary); next.error_code = next.error_code ? redact(next.error_code, 80) : null; next.child_session_id = next.child_session_id ? redact(next.child_session_id, 128) : null;
  if (!terminal(next)) next.lease_expires_at = new Date(Date.now() + leaseMs()).toISOString();
  await atomicWrite(fingerprint, next); return safeRecord(next);
});
export const completeTask = (fingerprint, options = {}) => transitionTask(fingerprint, { ...options, expectedStates: options.expectedStates || ["CLAIMED", "ADMITTED", "BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION"], patch: { ...options.patch, state: "COMPLETED", retryable: false, result_summary: options.result_summary } });
// Kept intentionally narrow for lock-fencing regression tests; callers must not use it.
export const __taskStateTestHooks = { lockFor, releaseLock, reclaimLock, withLock };
