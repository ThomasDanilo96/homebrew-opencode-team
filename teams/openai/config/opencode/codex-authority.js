import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ownerForProcess, canonicalAcquire, serializedReclaim } from "./lock-identity.js";

export const CODEX_REQUIRED = "CODEX_REQUIRED";
export const CODEX_RUNNING = "CODEX_RUNNING";
export const CODEX_SUCCESS = "CODEX_SUCCESS";
export const CODEX_TASK_FAILED = "CODEX_TASK_FAILED";
export const CODEX_UNKNOWN = "CODEX_UNKNOWN";
export const CODEX_TIMEOUT = "CODEX_TIMEOUT";
export const CODEX_ABORTED = "CODEX_ABORTED";
export const TERRA_FALLBACK = "TERRA_FALLBACK";
export const MUTATING_TOOLS = new Set(["apply_patch", "edit", "write", "delete", "rename", "file_create", "file_delete", "file_rename", "create_file", "remove_file", "move_file", "multi_edit", "write_file", "patch", "bash", "interactive_bash", "shell", "command"]);
export class PolicyConflictError extends Error { constructor(detail = {}) { super(JSON.stringify({ code: "POLICY_CONFLICT", retryable: true, phase: "policy", task_id: detail.task_id || null, provider_failure: false })); this.name = "PolicyConflictError"; this.code = "POLICY_CONFLICT"; Object.assign(this, detail); } }
const root = () => process.env.OPENAI_TEAM_STATE_ROOT;
const directory = () => join(root(), "codex-child-policy");
const pathFor = (sessionID) => join(directory(), `${sessionID}.json`);
const lockFor = (sessionID) => join(directory(), `.${sessionID}.lock`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const readPolicy = async (sessionID) => { try { return JSON.parse(await readFile(pathFor(sessionID), "utf8")); } catch { return null; } };
export const policyExists = async (sessionID) => { try { await access(pathFor(sessionID)); return true; } catch { return false; } };
const atomicWrite = async (sessionID, value) => { await mkdir(directory(), { recursive: true, mode: 0o700 }); const temporary = join(directory(), `.${sessionID}.${randomUUID()}.tmp`); await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, pathFor(sessionID)); };
const ownerInfo = async (lock) => { try { return JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const releaseLock = async (lock, owner, beforeRename) => { try { const captured = (await ownerInfo(lock))?.token; if (captured !== owner.token) return; if (beforeRename) await beforeRename(lock, captured); const fenced = `${lock}.release-${captured}`; await rename(lock, fenced); if ((await ownerInfo(fenced))?.token === captured) await rm(fenced, { recursive: true, force: true }); else if (!(await access(lock).then(() => true, () => false))) { try { await rename(fenced, lock); } catch {} } } catch (error) { if (error?.code !== "ENOENT") throw error; } };
const withLock = async (sessionID, action) => { await mkdir(directory(), { recursive: true, mode: 0o700 }); const lock = lockFor(sessionID), owner = await ownerForProcess(randomUUID(), Math.min(Math.max(Number(process.env.OPENAI_AUTHORITY_LOCK_LEASE_MS) || 30_000, 1), 300_000)), until = Date.now() + Math.min(Math.max(Number(process.env.OPENAI_AUTHORITY_LOCK_WAIT_MS) || 5_000, 1), 30_000); while (Date.now() < until) { try { if (await canonicalAcquire(lock, owner, until)) { try { return await action(); } finally { await releaseLock(lock, owner); } } } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error; } await serializedReclaim(lock, { orphanGraceMs: 1000 }, Date.now()); await pause(1); } throw new PolicyConflictError({ task_id: sessionID, reason: "lock_timeout" }); };
const validTransition = (from, to) => from === CODEX_REQUIRED && to === CODEX_RUNNING || [CODEX_RUNNING, CODEX_UNKNOWN].includes(from) && [CODEX_SUCCESS, CODEX_TASK_FAILED, CODEX_UNKNOWN, CODEX_TIMEOUT, CODEX_ABORTED, TERRA_FALLBACK].includes(to);
const PROTECTED_IDENTITY = new Set(["status", "version", "schema_version", "session_id", "agent", "task_fingerprint", "task_lease_id", "task_call_id", "packet_id", "master_parent_session_id", "attempt", "codex_run_id", "thread_id", "codex_thread_id", "parent_codex_run_id"]);
const MUTABLE_DIAGNOSTICS = new Set(["error", "reason", "provider_failure", "retryable", "updated_at", "timestamp", "last_error", "provider_metadata", "error_metadata"]);
const creationMetadata = (metadata = {}) => Object.fromEntries(Object.entries(metadata).filter(([key]) => !["status", "version", "session_id", "schema_version", "expectedVersion"].includes(key)));
const transitionMetadata = (metadata = {}) => Object.fromEntries(Object.entries(metadata).filter(([key]) => MUTABLE_DIAGNOSTICS.has(key) && !PROTECTED_IDENTITY.has(key)));
const callerMetadata = creationMetadata;
export const ensurePolicy = async (sessionID, metadata = {}) => { if (!root() || !sessionID) return null; return withLock(sessionID, async () => { const current = await readPolicy(sessionID); if (current) return current; const policy = { ...callerMetadata(metadata), schema_version: 1, version: 1, session_id: sessionID, status: CODEX_REQUIRED, created_at: Date.now() }; await atomicWrite(sessionID, policy); return policy; }); };
export const transitionPolicy = async (sessionID, status, metadata = {}) => withLock(sessionID, async () => { const current = await readPolicy(sessionID); if (!current) return null; const expectedVersion = metadata.expectedVersion; if (!Number.isInteger(expectedVersion) || !validTransition(current.status, status) || current.version !== expectedVersion) throw new PolicyConflictError({ task_id: sessionID, expected_status: CODEX_REQUIRED, actual_status: current.status, expected_version: expectedVersion, actual_version: current.version }); const next = { ...current, ...transitionMetadata(metadata), status, version: (Number.isInteger(current.version) ? current.version : 0) + 1, session_id: sessionID, schema_version: 1, updated_at: Date.now() }; await atomicWrite(sessionID, next); return next; });
export const removePolicy = async (sessionID, expected = {}) => {
  if (!root() || !sessionID) return { code: "POLICY_ABSENT" };
  return withLock(sessionID, async () => {
    const current = await readPolicy(sessionID);
    if (!current) return { code: "POLICY_ABSENT" };
    const fields = [["expectedVersion", "version"], ["expectedStatus", "status"], ["expectedRun", "codex_run_id"], ["expectedAttempt", "attempt"], ["expectedLease", "task_lease_id"]];
    if (fields.some(([expectedKey, actualKey]) => expected[expectedKey] != null && current[actualKey] !== expected[expectedKey])) return { code: "POLICY_CONFLICT", policy: current };
    await rm(pathFor(sessionID), { force: true });
    return { code: "POLICY_REMOVED" };
  });
};

export const __codexAuthorityTestHooks = { lockFor, releaseLock };
