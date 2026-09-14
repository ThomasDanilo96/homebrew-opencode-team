import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { ownerForProcess, canonicalAcquire, serializedReclaim } from "./lock-identity.js";
const root = () => join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "codex-recovery");
export const recoveryHomeRoot = () => join(process.env.OPENAI_TEAM_RECOVERY_HOME_ROOT || join(process.env.OPENAI_TEAM_STATE_ROOT || "/tmp", "recovery-homes"));
const valid = (v) => /^[a-f0-9]{64,128}$/i.test(String(v || ""));
const file = (f) => join(root(), `${f}.json`), lockFor = (f) => join(root(), `.${f}.lock`);
const homePointer = (home) => join(root(), `home-${createHash("sha256").update(String(home)).digest("hex")}.json`);
export const registerCodexHome = async (home) => {
  const target = homePointer(home), temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(root(), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify({ schema_version: 1, codex_home: home, codex_home_identity: home })}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return target;
};
export const clearCodexHomePointer = async (home) => { await rm(homePointer(home), { force: true }); };
const bounded = (v, fallback, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; };
const waitMs = () => bounded(process.env.OPENAI_RECOVERY_LOCK_WAIT_MS, 5000, 1, 30000), leaseMs = () => bounded(process.env.OPENAI_RECOVERY_LOCK_LEASE_MS, 30000, 1, 300000);
const pause = (n) => new Promise((resolve) => setTimeout(resolve, n));
let removeHome = (home) => rm(home, { recursive: true, force: true });
export class RecoveryConflictError extends Error { constructor(detail = {}) { super("RECOVERY_CONFLICT"); this.name = "RecoveryConflictError"; this.code = "RECOVERY_CONFLICT"; Object.assign(this, detail); } }
const validHome = (value) => typeof value === "string" && value === resolve(value) && basename(value).startsWith("codex-home-") && dirname(value) === resolve(recoveryHomeRoot());
const clean = (fingerprint, value = {}) => {
  const hasHome = value.codex_home != null, hasIdentity = value.codex_home_identity != null;
  if (hasHome !== hasIdentity) throw new RecoveryConflictError({ reason: "recovery_home_identity_malformed" });
  if (hasHome && (!validHome(value.codex_home) || value.codex_home_identity !== value.codex_home)) throw new RecoveryConflictError({ reason: "recovery_home_identity_malformed" });
  return { schema_version: 1, fingerprint, version: Number.isInteger(value.version) && value.version >= 1 ? value.version : 0, attempt: Number.isInteger(value.attempt) && value.attempt >= 1 ? value.attempt : 1, task_lease_id: value.task_lease_id ? String(value.task_lease_id) : `legacy-${fingerprint}`, thread_id: String(value.thread_id || ""), codex_run_id: value.codex_run_id ? String(value.codex_run_id) : null, parent_codex_run_id: value.parent_codex_run_id ? String(value.parent_codex_run_id) : null, codex_home: hasHome ? value.codex_home : null, codex_home_identity: hasHome ? value.codex_home_identity : null, resume_count: Number.isInteger(value.resume_count) && value.resume_count >= 0 ? value.resume_count : 0, state: String(value.state || "unknown"), journal_incomplete: value.journal_incomplete === true, journal_scan_complete: value.journal_scan_complete === true, termination_sealed: value.termination_sealed === true, sealed_run_id: value.sealed_run_id ? String(value.sealed_run_id) : null, sealed_lease_id: value.sealed_lease_id ? String(value.sealed_lease_id) : null, command_journal: Array.isArray(value.command_journal) ? [...new Set(value.command_journal.filter((e) => /^[a-f0-9]{64}$/i.test(String(e))).map((e) => String(e).toLowerCase()))].slice(-256) : [] };
};
const ownerInfo = async (lock) => { try { return JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); } catch { return null; } };
const release = async (lock, owner) => { if ((await ownerInfo(lock))?.token !== owner.token) return; const fenced = `${lock}.release-${owner.token}`; try { await rename(lock, fenced); } catch (e) { if (e?.code === "ENOENT") return; throw e; } if ((await ownerInfo(fenced))?.token === owner.token) await rm(fenced, { recursive: true, force: true }); else { try { await rename(fenced, lock); } catch {} } };
const reclaim = async (lock) => serializedReclaim(lock, { orphanGraceMs: 1000 });
const acquire = async (lock, owner) => { try { return await canonicalAcquire(lock, owner, Date.now() + 1); } catch (e) { if (["EEXIST", "ENOTEMPTY"].includes(e?.code)) return false; throw e; } };
const withLock = async (fingerprint, action) => { await mkdir(root(), { recursive: true, mode: 0o700 }); const lock = lockFor(fingerprint), until = Date.now() + waitMs(); let owner; while (Date.now() <= until) { const candidate = await ownerForProcess(randomUUID(), leaseMs()); if (await acquire(lock, candidate)) { owner = candidate; break; } await reclaim(lock); await pause(5); } if (!owner) throw new RecoveryConflictError({ reason: "lock_timeout", retryable: true }); try { return await action(); } finally { await release(lock, owner); } };
export const readRecovery = async (fingerprint) => { if (!valid(fingerprint)) return null; try { const record = clean(fingerprint, JSON.parse(await readFile(file(fingerprint), "utf8"))); return record.thread_id ? record : null; } catch { return null; } };
const write = async (fingerprint, record) => { const temp = join(root(), `.${randomUUID()}.tmp`); await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, file(fingerprint)); await chmod(file(fingerprint), 0o600); };
export const saveRecovery = async (fingerprint, value) => { if (!valid(fingerprint)) throw new Error("Invalid recovery fingerprint"); return withLock(fingerprint, async () => { const record = clean(fingerprint, value); if (!record.thread_id) throw new Error("Recovery thread_id is required"); const current = await readRecovery(fingerprint), expected = value.expectedVersion; if (expected != null && Number(current?.version || 0) !== expected) throw new RecoveryConflictError({ expectedVersion: expected, actualVersion: Number(current?.version || 0) }); if (current && (record.attempt < current.attempt || record.resume_count < current.resume_count || (record.attempt === current.attempt && record.resume_count === current.resume_count && (current.codex_run_id !== record.codex_run_id || current.thread_id !== record.thread_id)))) throw new RecoveryConflictError(); record.resume_count = Math.max(record.resume_count, current?.resume_count || 0); record.command_journal = [...new Set([...(current?.command_journal || []), ...record.command_journal])].slice(-256); record.journal_incomplete ||= current?.journal_incomplete === true; if (current && current.attempt === record.attempt && current.resume_count === record.resume_count && current.thread_id === record.thread_id && current.codex_run_id === record.codex_run_id && current.state === record.state && current.journal_incomplete === record.journal_incomplete && JSON.stringify(current.command_journal) === JSON.stringify(record.command_journal)) return current; record.version = Number(current?.version || 0) + 1; await write(fingerprint, record); return record; }); };
export const recordCompletedCommand = async (fingerprint, hash, { expectedVersion } = {}) => { if (!valid(fingerprint) || !/^[a-f0-9]{64}$/i.test(String(hash || ""))) throw new Error("Invalid recovery command hash"); return withLock(fingerprint, async () => { const current = await readRecovery(fingerprint); if (!current) throw new RecoveryConflictError({ reason: "missing_recovery" }); if (expectedVersion != null && current.version !== expectedVersion) throw new RecoveryConflictError({ expectedVersion, actualVersion: current.version }); const command = String(hash).toLowerCase(); if (current.command_journal.includes(command)) return false; await write(fingerprint, { ...current, version: current.version + 1, command_journal: [...current.command_journal, command].slice(-256) }); return true; }); };
export const removeRecovery = async (fingerprint, expected) => { if (!valid(fingerprint)) return false; if (!expected || !Number.isInteger(expected.version) || !Number.isInteger(expected.attempt) || !String(expected.task_lease_id || "") || !String(expected.thread_id || "") || !String(expected.codex_run_id || "") || (expected.codex_home != null) !== (expected.codex_home_identity != null) || (expected.codex_home != null && expected.codex_home_identity !== expected.codex_home)) throw new RecoveryConflictError({ reason: "recovery_identity_required" }); return withLock(fingerprint, async () => { const current = await readRecovery(fingerprint); if (!current) return false; if (current.version !== expected.version || current.fingerprint !== fingerprint || current.attempt !== expected.attempt || current.task_lease_id !== expected.task_lease_id || current.thread_id !== expected.thread_id || current.codex_run_id !== expected.codex_run_id || current.codex_home_identity !== expected.codex_home_identity) throw new RecoveryConflictError({ expectedVersion: expected.version, actualVersion: current.version }); await rm(file(fingerprint), { force: true }); return true; }); };

const validateHome = async (home) => {
  if (!validHome(home)) throw new RecoveryConflictError({ reason: "recovery_home_outside_private_root" });
  const privateRoot = resolve(recoveryHomeRoot());
  const rootInfo = await lstat(privateRoot);
  if (!rootInfo.isDirectory()) throw new RecoveryConflictError({ reason: "recovery_home_root_invalid" });
  if ((rootInfo.mode & 0o077) !== 0) throw new RecoveryConflictError({ reason: "recovery_home_root_private" });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(home) !== privateRoot) throw new RecoveryConflictError({ reason: "recovery_home_invalid" });
  if ((info.mode & 0o077) !== 0) throw new RecoveryConflictError({ reason: "recovery_home_private" });
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new RecoveryConflictError({ reason: "recovery_home_owner" });
  const realRoot = await realpath(privateRoot);
  const realHome = await realpath(home);
  if (dirname(realHome) !== realRoot || realHome !== join(realRoot, basename(home))) throw new RecoveryConflictError({ reason: "recovery_home_symlink" });
};

export const removeRecoveryAndHome = async (fingerprint, expected) => {
  if (!valid(fingerprint)) return false;
  return withLock(fingerprint, async () => {
    const current = await readRecovery(fingerprint);
    if (!current || (current.codex_home != null) !== (current.codex_home_identity != null) || (expected.codex_home != null) !== (expected.codex_home_identity != null) || current.version !== expected.version || current.fingerprint !== fingerprint || current.attempt !== expected.attempt || current.task_lease_id !== expected.task_lease_id || current.thread_id !== expected.thread_id || current.codex_run_id !== expected.codex_run_id || current.codex_home !== expected.codex_home || current.codex_home_identity !== expected.codex_home_identity) throw new RecoveryConflictError({ reason: "recovery_identity_conflict" });
    if (current.codex_home) await validateHome(current.codex_home);
     if (current.codex_home) {
       await validateHome(current.codex_home);
        await removeHome(current.codex_home);
        await clearCodexHomePointer(current.codex_home);
        await rm(file(fingerprint), { force: true });
       return true;
     }
     await rm(file(fingerprint), { force: true });
     return true;
  });
};

export const removeRecoveryHome = async (fingerprint, expected) => {
  if (!valid(fingerprint) || !expected?.codex_home) return false;
  return withLock(fingerprint, async () => {
    const current = await readRecovery(fingerprint);
    if (current && (current.version !== expected.version || current.fingerprint !== fingerprint || current.attempt !== expected.attempt || current.task_lease_id !== expected.task_lease_id || current.thread_id !== expected.thread_id || current.codex_run_id !== expected.codex_run_id || current.codex_home !== expected.codex_home || current.codex_home_identity !== (expected.codex_home_identity || expected.codex_home))) throw new RecoveryConflictError({ reason: "replacement_recovery_present" });
      await validateHome(expected.codex_home);
      await removeHome(expected.codex_home);
      await clearCodexHomePointer(expected.codex_home);
      await rm(file(fingerprint), { force: true });
    return true;
  });
};

export const __codexRecoveryTestHooks = { setRemoveHome: (fn) => { removeHome = fn; }, reset: () => { removeHome = (home) => rm(home, { recursive: true, force: true }); } };
