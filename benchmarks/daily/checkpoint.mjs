import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
export const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function atomicWriteFile(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch {
    // Directory fsync is best-effort on platforms/filesystems that expose it.
  }
}
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function buildFingerprints({ manifest, selection, commit }) {
  return {
    suite: fingerprint({ suite_version: manifest.suite_version, package_version: manifest.package_version, tasks: manifest.tasks }),
    selection: fingerprint(selection),
    commit: commit ?? null,
  };
}

export function checkpointPaths(root) {
  return {
    state: join(root, "generation-state.json"),
    results: join(root, "results.jsonl"),
    paired: join(root, "paired-results.jsonl"),
  };
}

export function loadCheckpoint(root) {
  const paths = checkpointPaths(root);
  return {
    state: readJson(paths.state),
    results: readJsonl(paths.results),
    paired: readJsonl(paths.paired),
  };
}

export function writeCheckpoint(root, state, results) {
  const paths = checkpointPaths(root);
  const sorted = [...results].sort((a, b) => a.sequence - b.sequence);
  atomicWriteFile(paths.state, json({ ...state, completed_sequences: sorted.map((row) => row.sequence), updated_at: new Date().toISOString() }));
  atomicWriteFile(paths.results, jsonl(sorted));
  const byTask = new Map();
  for (const row of sorted) {
    const current = byTask.get(row.task_id) ?? { task_id: row.task_id, generation: row.generation, results: [] };
    current.results.push(row);
    byTask.set(row.task_id, current);
  }
  const paired = [...byTask.values()].filter((row) => row.results.length === 2).map((row) => ({
    schema_version: 1,
    generation: row.generation,
    task_id: row.task_id,
    results: row.results.sort((a, b) => a.sequence - b.sequence),
  }));
  atomicWriteFile(paths.paired, jsonl(paired));
}

export function ensureCheckpointCompatible(root, expected, { resume = false } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = existsSync(checkpointPaths(root).state) ? readJson(checkpointPaths(root).state) : null;
  if (!existing) return null;
  if (!resume) throw new Error("generation_root_already_has_state_use_--resume");
  for (const name of ["suite", "selection", "commit"]) {
    if (existing.fingerprints?.[name] !== expected.fingerprints?.[name]) throw new Error(`checkpoint_fingerprint_mismatch:${name}`);
  }
  if (existing.generation !== expected.generation) throw new Error("checkpoint_generation_mismatch");
  return existing;
}
