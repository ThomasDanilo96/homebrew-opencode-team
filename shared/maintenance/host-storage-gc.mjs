#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cloneName = "com.google.Chrome.code_sign_clone";
const retentionMs = Math.min(Math.max(Number(process.env.OPENCODE_CHROME_CLONE_RETENTION_HOURS || 24), 1), 24 * 30) * 60 * 60 * 1000;
const maxEntries = Math.min(Math.max(Number(process.env.OPENCODE_HOST_STORAGE_GC_MAX_ENTRIES || 100000), 1), 500000);
const apply = process.argv.includes("--apply");
const now = Date.now();

const rootsFromEnvironment = () => String(process.env.OPENCODE_TEAM_CHROME_CLONE_ROOTS || "").split(",").map((path) => path.trim()).filter(Boolean).map((path) => resolve(path));
const cloneRoots = () => {
  const roots = new Set();
  const tempParent = resolve(dirname(tmpdir()));
  const parentRoots = [...rootsFromEnvironment(), tempParent, resolve(tmpdir()), join(tempParent, "X")];
  for (const parent of parentRoots) {
    if (parent.split("/").at(-1) === cloneName) { roots.add(parent); continue; }
    let entries = [];
    try { entries = readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && entry.name === cloneName) roots.add(join(parent, entry.name));
  }
  return [...roots];
};

const cloneUnits = (root) => {
  try {
    const children = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(root, entry.name));
    return children.length ? children : [root];
  } catch { return [root]; }
};

const safeRoot = (path) => {
  if (path.split("/").at(-1) !== cloneName) return false;
  for (const parent of [resolve(dirname(tmpdir())), resolve(tmpdir()), ...rootsFromEnvironment().map(dirname)]) {
    try {
      if (resolve(realpathSync(path)).startsWith(`${resolve(realpathSync(parent))}/`)) return true;
    } catch {}
  }
  return false;
};

const activity = (path) => {
  try {
    const output = execFileSync(process.env.OPENCODE_TEAM_LSOF || "/usr/sbin/lsof", ["-nP", "+D", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.trim() ? "active" : "clear";
  } catch (error) {
    if (error.status === 1) return "clear";
    return "uncertain";
  }
};

const owner = (path) => {
  try { return typeof process.getuid === "function" && lstatSync(path).uid === process.getuid() ? "user" : "uncertain"; } catch { return "uncertain"; }
};

const measure = (path) => {
  let bytes = 0;
  let allocatedBytes = 0;
  let entries = 0;
  const walk = (current) => {
    if (entries >= maxEntries) return;
    let info;
    try { info = lstatSync(current); } catch { return; }
    entries += 1;
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      bytes += info.size;
      allocatedBytes += Number(info.blocks || 0) * 512;
    }
    if (!info.isDirectory()) return;
    let children = [];
    try { children = readdirSync(current); } catch { return; }
    for (const child of children) walk(join(current, child));
  };
  walk(path);
  return { bytes, allocated_bytes: allocatedBytes, entries, truncated: entries >= maxEntries };
};

const dockerSafeGC = () => {
  const result = { daemon: "unavailable", safe_gc: "not-run", builder_prune: "not-run", dangling_image_prune: "not-run", volumes_auto_delete: false, direct_disk_delete: false };
  try {
    execFileSync("docker", ["system", "df", "--format", "{{json .}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    result.daemon = "available";
  } catch { return result; }
  if (!apply) {
    result.safe_gc = "ready";
    return result;
  }
  try {
    execFileSync("docker", ["builder", "prune", "--force", "--filter", "until=168h"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    result.builder_prune = "pass";
  } catch { result.builder_prune = "failed"; }
  try {
    execFileSync("docker", ["image", "prune", "--force", "--filter", "until=168h"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    result.dangling_image_prune = "pass";
  } catch { result.dangling_image_prune = "failed"; }
  result.safe_gc = result.builder_prune === "pass" && result.dangling_image_prune === "pass" ? "pass" : "partial";
  return result;
};

const metrics = {
  CHROME_CODE_SIGN_CLONE_COUNT: 0,
  CHROME_CODE_SIGN_CLONE_BYTES: 0,
  CHROME_CODE_SIGN_CLONE_ACTIVE: 0,
  CHROME_CODE_SIGN_CLONE_RECLAIMABLE_BYTES: 0,
  CHROME_CODE_SIGN_CLONE_REMOVED_BYTES: 0,
  roots: [],
  docker: { policy: "report-only", direct_delete: "forbidden", volumes_auto_delete: false },
};

metrics.docker = dockerSafeGC();
metrics.DOCKER_SAFE_GC = metrics.docker.safe_gc === "pass" || metrics.docker.safe_gc === "ready" ? "PASS" : metrics.docker.daemon === "unavailable" ? "UNAVAILABLE" : "BLOCKED";
metrics.DOCKER_RAW_DIRECT_DELETE = "NO";
metrics.DOCKER_VOLUME_AUTO_DELETE = "NO";

for (const root of cloneRoots()) for (const path of cloneUnits(root)) {
  if (!existsSync(path) || !safeRoot(root)) continue;
  let info;
  try { info = lstatSync(path); } catch { continue; }
  if (!info.isDirectory() || info.isSymbolicLink()) continue;
  const size = measure(path);
  const resourceOwner = owner(path);
  const state = activity(path);
  const old = now - info.mtimeMs >= retentionMs;
  const reclaimable = resourceOwner === "user" && state === "clear" && old && !size.truncated;
  metrics.CHROME_CODE_SIGN_CLONE_COUNT += 1;
  metrics.CHROME_CODE_SIGN_CLONE_BYTES += size.bytes;
  metrics.CHROME_CODE_SIGN_CLONE_ACTIVE += state === "active" ? 1 : 0;
  metrics.CHROME_CODE_SIGN_CLONE_RECLAIMABLE_BYTES += reclaimable ? size.bytes : 0;
  let removedBytes = 0;
  if (apply && reclaimable) {
    try { rmSync(path, { recursive: true, force: true }); removedBytes = size.bytes; } catch {}
  }
  metrics.CHROME_CODE_SIGN_CLONE_REMOVED_BYTES += removedBytes;
  metrics.roots.push({ path, root, ...size, owner: resourceOwner, activity: state, old, reclaimable, removed_bytes: removedBytes });
}

process.stdout.write(`${JSON.stringify(metrics)}\n`);
