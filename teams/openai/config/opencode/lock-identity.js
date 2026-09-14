import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
let localStartIdentity;
let localStartIdentityPromise;
const pidIdentityCache = new Map();
const PID_CACHE_MS = 250;
export const processStartIdentity = async (pid) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (value === process.pid) {
    if (!localStartIdentityPromise) localStartIdentityPromise = (async () => {
      try { const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(value)], { timeout: 1000 }); return String(stdout || "").trim().replace(/\s+/g, " ") || null; } catch { return null; }
    })();
    localStartIdentity = await localStartIdentityPromise;
    return localStartIdentity;
  }
  const cached = pidIdentityCache.get(value);
  if (cached && cached.expires > Date.now()) return cached.value;
  try { const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(value)], { timeout: 1000 }); const identity = String(stdout || "").trim().replace(/\s+/g, " ") || null; pidIdentityCache.set(value, { value: identity, expires: Date.now() + PID_CACHE_MS }); return identity; } catch { return null; }
};
export const ownerForProcess = async (token, lease_ms, extra = {}) => ({ token, pid: process.pid, process_start_identity: await processStartIdentity(process.pid), acquired_at: Date.now(), heartbeat_at: Date.now(), lease_ms, ...extra });
export const ownerCanBeReclaimed = async (owner, now = Date.now(), orphanGraceMs = 1000) => {
  if (!owner || !Number.isInteger(Number(owner.pid))) return { reclaim: false };
  try { process.kill(Number(owner.pid), 0); } catch { return { reclaim: true, reason: "dead_pid" }; }
  const current = await processStartIdentity(owner.pid);
  if (current && owner.process_start_identity) return { reclaim: current !== owner.process_start_identity, reason: current === owner.process_start_identity ? "matching_process_identity" : "process_identity_mismatch" };
  const leaseUntil = Number(owner.heartbeat_at) + Number(owner.lease_ms);
  return { reclaim: Number.isFinite(leaseUntil) && now >= leaseUntil + orphanGraceMs, reason: "identity_unavailable" };
};

const ownerFile = (lock) => join(lock, "owner.json");
const readOwner = async (lock) => { try { return JSON.parse(await readFile(ownerFile(lock), "utf8")); } catch { return null; } };
const reclaimPath = (lock) => join(dirname(dirname(lock)), ".guards", `${basename(dirname(lock))}.${basename(lock)}.guard`);
const sameOwner = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const removeOwnedReclaim = async (path, token) => {
  try { const current = await readOwner(path); if (current?.token !== token) return; const fenced = `${path}.release-${token}`; await rename(path, fenced); if ((await readOwner(fenced))?.token === token) await rm(fenced, { recursive: true, force: true }); else { try { await rename(fenced, path); } catch {} } } catch (error) { if (error?.code !== "ENOENT") throw error; }
};
export const acquireReclaimMutex = async (lock, owner, waitUntil) => {
  const mutex = reclaimPath(lock);
  await mkdir(dirname(mutex), { recursive: true, mode: 0o700 });
  while (Date.now() <= waitUntil) {
    try {
      // The guard itself is the mutex.  Do not publish contender siblings:
      // mkdir is the single atomic admission operation.
      await mkdir(mutex, { mode: 0o700 });
      await writeFile(ownerFile(mutex), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return { path: mutex, token: owner.token };
    }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return null;
};
export const releaseReclaimMutex = async (mutex, token) => removeOwnedReclaim(mutex, token);
export const canonicalAcquire = async (lock, owner, waitUntil) => {
  // Publication is a contender too: serialize the two observations and the
  // rename under the same reclaim mutex used by stale recovery.
  const mutex = await acquireReclaimMutex(lock, owner, waitUntil);
  if (!mutex) return false;
  const stage = `${lock}.acquire-${owner.token}`;
  try { await mkdir(stage, { mode: 0o700 }); await writeFile(ownerFile(stage), `${JSON.stringify(owner)}\n`, { mode: 0o600 }); if (await stat(lock).then(() => true, () => false)) return false; await rename(stage, lock); return true; }
  finally { await rm(stage, { recursive: true, force: true }); await releaseReclaimMutex(mutex.path, mutex.token); }
};
export const serializedReclaim = async (lock, stale, waitUntil = Date.now() + 1000) => {
  // Capture one immutable owner snapshot at the stale/liveness observation.
  // The exact snapshot, not merely its token, fences the later mutation.
  const observed = await readOwner(lock);
  const snapshot = observed ? JSON.parse(JSON.stringify(observed)) : null;
  if (snapshot && !(await ownerCanBeReclaimed(snapshot, Date.now(), stale.orphanGraceMs ?? 1000)).reclaim) return false;
  const mutexOwner = await ownerForProcess(randomUUID(), 30000), mutex = await acquireReclaimMutex(lock, mutexOwner, waitUntil); if (!mutex) return false;
  try { const current = await readOwner(lock); if (!sameOwner(current, snapshot)) return false; if (current && !(await ownerCanBeReclaimed(snapshot, Date.now(), stale.orphanGraceMs ?? 1000)).reclaim) return false; if (!current) { try { if (Date.now() - (await stat(lock)).mtimeMs < (stale.orphanGraceMs ?? 1000)) return false; } catch (error) { return error?.code === "ENOENT"; } }
    if (stale.beforeRename) await stale.beforeRename(lock, snapshot?.token || null);
    const reread = await readOwner(lock); if (!sameOwner(reread, snapshot)) return false;
    const fenced = `${lock}.stale-${randomUUID()}`; try { await rename(lock, fenced); } catch (error) { return error?.code === "ENOENT"; }
    const moved = await readOwner(fenced); if (sameOwner(moved, snapshot) || (!snapshot && !moved)) { await rm(fenced, { recursive: true, force: true }); return true; } try { await rename(fenced, lock); } catch {} return false;
  } finally { await releaseReclaimMutex(mutex.path, mutex.token); }
};
