import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ownerForProcess, canonicalAcquire, serializedReclaim } from "./lock-identity.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const numericCooldown = () => {
  const value = Number(process.env.OPENAI_CODEX_COOLDOWN_SECONDS);
  return Number.isInteger(value) && value >= 0 ? value : 300;
};
const stateFor = (model) => {
  const root = process.env.OPENAI_TEAM_STATE_ROOT || "/tmp";
  const key = createHash("sha256").update(model).digest("hex");
  return { directory: join(root, "codex"), locks: join(root, "locks"), state: join(root, "codex", `circuit-${key}.json`), lock: join(root, "locks", `circuit-${key}.lock`) };
};
export const readCodexCircuitGeneration = async (model) => {
  try {
    const state = JSON.parse(await readFile(stateFor(model).state, "utf8"));
    return Number.isInteger(state.generation) && state.generation >= 0 ? state.generation : 0;
  } catch { return 0; }
};
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const lockOwner = async (path) => { try { const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); return typeof owner.token === "string" && Number.isInteger(owner.pid) && Number.isFinite(owner.acquired_at) ? owner : null; } catch { return null; } };
const lockWaitMs = () => Math.min(Math.max(Number(process.env.OPENAI_CODEX_LOCK_WAIT_MS) || 5000, 1), 30000);
const lockOrphanGraceMs = () => Math.max(Number(process.env.OPENAI_LOCK_ORPHAN_GRACE_MS) || 1000, 0);

// This is deliberately compatible with codex-lane.sh's circuit file and lock
// name, so an outer runner timeout cannot race a lane classification.
export const openCodexCircuit = async (model, { reason = "temporary_transport", cooldown_seconds = numericCooldown(), invocation_id = null, profile = null, requested_model = model, fallback_count = 0, start_generation = null } = {}) => {
  const paths = stateFor(model);
  await mkdir(paths.locks, { recursive: true, mode: 0o700 });
  await chmod(paths.locks, 0o700);
  const token = randomUUID();
  const deadline = Date.now() + lockWaitMs();
  while (Date.now() < deadline) {
    try {
      const owner = await ownerForProcess(token, Math.min(Math.max(Number(process.env.OPENAI_LOCK_LEASE_MS) || 30000, 1), 300000));
      if (!await canonicalAcquire(paths.lock, owner, deadline)) {
        await serializedReclaim(paths.lock, { orphanGraceMs: lockOrphanGraceMs() }, deadline);
        await pause(10); continue;
      }
      try {
        await mkdir(paths.directory, { recursive: true, mode: 0o700 });
        await chmod(paths.directory, 0o700);
        let previous = {};
        try { previous = JSON.parse(await readFile(paths.state, "utf8")); } catch {}
          const generation = Math.max(0, Number(previous.generation) || 0);
          if (Number.isInteger(start_generation) && generation !== start_generation) return previous;
          if (reason === "temporary_transport" && !Number.isInteger(start_generation)) return previous;
          const next = (previous.state === "HALF_OPEN" && previous.probe_owner && previous.probe_owner !== invocation_id)
            ? previous
            : { state: "OPEN", model, requested_model, profile, invocation_id, fallback_count, failures: Math.max(0, Number(previous.failures) || 0) + 1, generation: generation + 1, opened_at: Math.floor(Date.now() / 1000), cooldown_seconds, last_reason: reason, probe_owner: null, probe_lease_until: null };
        const temporary = `${paths.state}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, paths.state);
        return next;
      } finally {
        if ((await lockOwner(paths.lock))?.token === token) {
          const released = `${paths.lock}.release-${token}`;
          try {
            await rename(paths.lock, released);
            if ((await lockOwner(released))?.token === token) await rm(released, { recursive: true, force: true });
            else { try { await rename(released, paths.lock); } catch {} }
          } catch {}
        }
      }
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await pause(10);
    }
    await serializedReclaim(paths.lock, { orphanGraceMs: lockOrphanGraceMs() }, deadline);
  }
  throw new Error("CODEX_CIRCUIT_LOCK_TIMEOUT");
};
