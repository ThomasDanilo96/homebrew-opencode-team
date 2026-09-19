#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const command = process.argv[2];
const packageRoot = resolve(process.env.PACKAGE_ROOT || join(dirname(new URL(import.meta.url).pathname), "..", ".."));
const configRoot = resolve(process.env.CONFIG_ROOT || join(homedir(), ".config", "opencode-team"));
const dataRoot = resolve(process.env.DATA_ROOT || join(homedir(), ".local", "share", "opencode-team"));
const stateRoot = resolve(process.env.STATE_ROOT || join(homedir(), ".local", "state", "opencode-team"));
const cacheRoot = resolve(process.env.CACHE_ROOT || join(homedir(), ".cache", "opencode-team"));
const runtimeRoot = resolve(process.env.RUNTIME_ROOT || join(cacheRoot, "runtime"));
const dependencyRoot = resolve(process.env.DEPENDENCY_ROOT || join(dataRoot, "dependencies"));
const teams = ["best", "go", "openai", "daily"];
const roles = ["launcher", "server", "bridge", "attach", "watchdog", "reaper"];
const legacyFamily = /^(?:opencode-team-|opencode-daily-|openai-daily-|daily-(?:real|postcommit)-|opencode-daily-cert\.|\.opencode-team-daily-|omo-(?:hook-repro|ignore|inspect-npm|pack-name)(?:[-.].*)?$|openai-admit-concurrency-|opencode-(?:auth|best|cutover|maintenance|model|server)-)/i;

const readText = (path) => {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
};

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const print = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

const inside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${String.fromCharCode(47)}`));
};

const realInside = (child, parent) => {
  try {
    const realChild = realpathSync(child);
    const realParent = realpathSync(parent);
    return inside(realChild, realParent);
  } catch {
    return false;
  }
};

const processStartEpoch = (pid) => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};

const pidAlive = (pid) => {
  const result = spawnSync("kill", ["-0", String(pid)], { stdio: "ignore" });
  return result.status === 0;
};

const readIdentity = (runDir, role) => {
  const values = {};
  for (const line of readText(join(runDir, `${role}.identity`)).split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return Object.keys(values).length ? values : null;
};

const identityState = (runDir, role, runID) => {
  const identity = readIdentity(runDir, role);
  if (!identity) return "missing";
  if (identity.role !== role || identity.run_id !== runID || !/^\d+$/.test(identity.pid || "") || !/^\d+$/.test(identity.start_epoch || "")) return "mismatch";
  if (!pidAlive(identity.pid)) return "dead";
  const start = processStartEpoch(identity.pid);
  if (start === null || Math.abs(start - Number(identity.start_epoch)) > 5) return "mismatch";
  return "alive";
};

const lsof = (args) => spawnSync(process.env.OPENCODE_TEAM_LSOF || "/usr/sbin/lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const pathHasOpenFiles = (path) => {
  if (!existsSync(path)) return { state: "clear", count: 0 };
  const result = lsof(["+D", path]);
  if (result.error || ![0, 1].includes(result.status ?? 1)) return { state: "error", count: 0 };
  const count = Math.max(0, (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).length - 1);
  return count > 0 ? { state: "open", count } : { state: "clear", count: 0 };
};

const openReferences = (path) => {
  if (!existsSync(path)) return { state: "missing", refs: [] };
  const result = lsof(["-Fpn", "+D", path]);
  if (result.error || ![0, 1].includes(result.status ?? 1)) return { state: "error", refs: [] };
  const refs = [...(result.stdout || "").matchAll(/\np(\d+)\n/g)].map((match) => Number(match[1]));
  return { state: refs.length ? "open" : "clear", refs: [...new Set(refs)] };
};

const descendantsForPids = (pids) => {
  if (pids.length === 0) return [];
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const children = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid) || [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found = new Set();
  const pending = [...pids.map(Number).filter(Number.isFinite)];
  while (pending.length) {
    const pid = pending.pop();
    for (const child of children.get(pid) || []) {
      if (found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return [...found];
};

const locksPresent = (manifest) => {
  const profile = basename(dirname(dirname(manifest.__run_dir || "")));
  const teamRoot = profile || String(manifest.team || "");
  const roots = [
    join(dataRoot, teamRoot, "data", "state", "session-locks"),
    join(dataRoot, teamRoot, "data", "opencode-team", "state", "session-locks"),
    join(dataRoot, teamRoot, "state", "session-locks"),
    join(stateRoot, profile || teamRoot, "session-locks"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      if (readdirSync(root).some((name) => lstatSync(join(root, name)).isDirectory())) return true;
    } catch {
      return true;
    }
  }
  return false;
};

const validateManifest = (manifest, runDir) => {
  if (!manifest || manifest.schema_version !== 1) return "malformed";
  if (!/^[0-9a-f]{8}$/i.test(String(manifest.run_id || ""))) return "malformed";
  if (basename(runDir) !== String(manifest.run_id)) return "malformed";
  if (!teams.includes(String(manifest.team || "").replace(/^opencode-|-team.*$/g, "")) && !String(manifest.team || "").includes("openai") && !String(manifest.team || "").includes("best")) return "malformed";
  if (String(manifest.runtime_root || "") && !inside(runDir, manifest.runtime_root)) return "escape";
  if (!inside(runDir, runtimeRoot)) return "escape";
  try {
    const info = lstatSync(runDir);
    if (!info.isDirectory() || info.isSymbolicLink()) return "escape";
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "owner";
  } catch {
    return "malformed";
  }
  if (!realInside(runDir, runtimeRoot)) return "escape";
  return "ok";
};

const evaluateRun = (runDir) => {
  const manifest = readJson(join(runDir, "manifest.json"));
  const schema = validateManifest(manifest, runDir);
  if (schema !== "ok") return { run: relative(runtimeRoot, runDir), decision: "uncertain", reason: schema };
  manifest.__run_dir = runDir;
  const runID = String(manifest.run_id);
  const identity = Object.fromEntries(roles.map((role) => [role, identityState(runDir, role, runID)]));
  if (Object.values(identity).includes("alive")) return { run: relative(runtimeRoot, runDir), path: runDir, decision: "keep", reason: "live_process", state: manifest.state, identity };
  if (Object.values(identity).includes("mismatch")) return { run: relative(runtimeRoot, runDir), path: runDir, decision: "uncertain", reason: "process_identity_mismatch", state: manifest.state, identity };
  for (const role of ["launcher", "server", "bridge", "reaper"]) {
    if (identity[role] === "missing") return { run: relative(runtimeRoot, runDir), path: runDir, decision: "uncertain", reason: `missing_${role}_identity`, state: manifest.state, identity };
  }
  const livePids = roles.map((role) => readIdentity(runDir, role)?.pid).filter((pid) => pid && pidAlive(pid));
  const descendants = descendantsForPids(livePids);
  if (descendants === null) return { run: relative(runtimeRoot, runDir), path: runDir, decision: "uncertain", reason: "descendant_check_error", state: manifest.state, identity };
  if (descendants.length > 0) return { run: relative(runtimeRoot, runDir), path: runDir, decision: "keep", reason: "live_descendant", state: manifest.state, identity };
  if (locksPresent(manifest)) return { run: relative(runtimeRoot, runDir), path: runDir, decision: "keep", reason: "session_lock", state: manifest.state, identity };
  const open = pathHasOpenFiles(runDir);
  if (open.state === "error") return { run: relative(runtimeRoot, runDir), path: runDir, decision: "uncertain", reason: "lsof_error", state: manifest.state, identity };
  if (open.state === "open") return { run: relative(runtimeRoot, runDir), path: runDir, decision: "keep", reason: "open_file", open_files: open.count, state: manifest.state, identity };
  if (manifest.state !== "RECLAIMABLE") return { run: relative(runtimeRoot, runDir), path: runDir, decision: "keep", reason: "not_reclaimable", state: manifest.state, identity };
  return { run: relative(runtimeRoot, runDir), path: runDir, decision: "delete", reason: "proven_inactive", state: manifest.state, identity };
};

const readinessForRun = (runDir) => {
  const manifest = readJson(join(runDir, "manifest.json"));
  const schema = validateManifest(manifest, runDir);
  if (schema !== "ok") return { run: relative(runtimeRoot, runDir), ready: false, reason: schema };
  const runID = String(manifest.run_id);
  const identity = Object.fromEntries(["launcher", "server"].map((role) => [role, identityState(runDir, role, runID)]));
  const ready = manifest.state === "ACTIVE" && Boolean(String(manifest.parent_session_id || "").trim()) && Object.values(identity).every((state) => state === "alive");
  return {
    run: relative(runtimeRoot, runDir),
    ready,
    reason: ready ? "active_server" : "incomplete_initialization",
    state: manifest.state,
    parent_session_id: String(manifest.parent_session_id || ""),
    identity,
  };
};

const runDirs = () => {
  const found = [];
  const directRuns = join(runtimeRoot, "runs");
  if (existsSync(directRuns)) {
    for (const entry of readdirSync(directRuns, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(directRuns, entry.name));
    }
  }
  for (const team of teams) {
    const runs = join(runtimeRoot, team, "runs");
    if (!existsSync(runs)) continue;
    for (const entry of readdirSync(runs, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(runs, entry.name));
    }
  }
  return found.sort();
};

const sizeOf = (root, limit = 50_000) => {
  let bytes = 0;
  let entries = 0;
  const walk = (path) => {
    if (entries >= limit || !existsSync(path)) return;
    let info;
    try { info = lstatSync(path); } catch { return; }
    entries += 1;
    if (info.isSymbolicLink()) return;
    if (info.isFile()) { bytes += info.size; return; }
    if (!info.isDirectory()) return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
  };
  walk(root);
  return { bytes, entries, truncated: entries >= limit };
};

const sumSizes = (roots, limit = 50_000) => roots.reduce((total, root) => total + sizeOf(root, limit).bytes, 0);

const fileBytes = (path) => {
  try { return statSync(path).size; } catch { return 0; }
};

const storageAccounting = () => {
  const runSizes = runDirs().map((run) => ({ run, bytes: sizeOf(run, 20_000).bytes }));
  const disposableBytes = runSizes.reduce((total, item) => total + item.bytes, 0);
  const categories = {
    "run-state": sizeOf(runtimeRoot),
    "profile-cache": sumSizes(teams.map((team) => join(cacheRoot, team))),
    "profile-opencode-data": sumSizes(teams.map((team) => join(dataRoot, team, "data"))),
    "tool-output": { bytes: 0, entries: 0, truncated: false },
    logs: sizeOf(join(stateRoot, "maintenance", "logs")),
    "db-wal": { bytes: 0, entries: 0, truncated: false, files: {} },
    "shared-team-dependencies": sizeOf(dependencyRoot),
  };
  for (const team of teams) {
    const tool = sizeOf(join(dataRoot, team, "data", "opencode", "tool-output"));
    categories["tool-output"].bytes += tool.bytes;
    categories["tool-output"].entries += tool.entries;
    categories["tool-output"].truncated ||= tool.truncated;
    for (const [label, files] of Object.entries({
      [`${team}:opencode`]: ["opencode.db", "opencode.db-wal"],
      [`${team}:codegraph`]: ["codegraph.db", "codegraph.db-wal"],
    })) {
      for (const name of files) {
        const path = join(dataRoot, team, "data", "opencode", name);
        const bytes = fileBytes(path);
        categories["db-wal"].bytes += bytes;
        categories["db-wal"].entries += bytes ? 1 : 0;
        categories["db-wal"].files[`${label}:${name}`] = { bytes, owner: inside(path, dataRoot) ? "package" : "external", mutable: false };
      }
    }
  }
  const current = Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, value.bytes]));
  const practicalPeak = {
    "current-bytes": Object.values(current).reduce((sum, value) => sum + value, 0),
    "peak-checkpoint-bytes": Object.values(current).reduce((sum, value) => sum + value, 0) + Number(process.env.OPENCODE_TEAM_PEAK_HEADROOM_BYTES || 0),
  };
  const codegraphRoot = resolve(process.env.OPENCODE_TEAM_CODEGRAPH_ROOT || join(homedir(), ".omo", "codegraph"));
  const backupRoot = resolve(process.env.OPENCODE_TEAM_BACKUP_ROOT || join(homedir(), ".config", "opencode", "backups"));
  const quotas = {
    per_run_bytes: Number(process.env.OPENCODE_TEAM_QUOTA_PER_RUN_BYTES || 2_000_000_000),
    per_team_bytes: Number(process.env.OPENCODE_TEAM_QUOTA_PER_TEAM_BYTES || 20_000_000_000),
    aggregate_disposable_bytes: Number(process.env.OPENCODE_TEAM_QUOTA_AGGREGATE_BYTES || 50_000_000_000),
    minimum_free_disk_bytes: Number(process.env.OPENCODE_TEAM_MIN_FREE_DISK_BYTES || 5_000_000_000),
  };
  let free = Number(process.env.OPENCODE_TEAM_TEST_FREE_BYTES || 0);
  if (!free) {
    const df = spawnSync("df", ["-Pk", cacheRoot], { encoding: "utf8" });
    const fields = (df.stdout || "").trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) || [];
    free = Number(fields[3] || 0) * 1024;
  }
  const warnings = [];
  if (free && free < quotas.minimum_free_disk_bytes) warnings.push({ code: "LOW_FREE_DISK", free_bytes: free, threshold_bytes: quotas.minimum_free_disk_bytes });
  if (disposableBytes > quotas.aggregate_disposable_bytes) warnings.push({ code: "DISPOSABLE_QUOTA", bytes: disposableBytes, threshold_bytes: quotas.aggregate_disposable_bytes });
  for (const item of runSizes) if (item.bytes > quotas.per_run_bytes) warnings.push({ code: "RUN_QUOTA", run: relative(runtimeRoot, item.run), bytes: item.bytes, threshold_bytes: quotas.per_run_bytes });
  for (const team of teams) {
    const bytes = runSizes.filter((item) => relative(runtimeRoot, item.run).startsWith(`${team}/`)).reduce((total, item) => total + item.bytes, 0);
    if (bytes > quotas.per_team_bytes) warnings.push({ code: "TEAM_QUOTA", team, bytes, threshold_bytes: quotas.per_team_bytes });
  }
  for (const threshold of [1, 5, 10, 20]) {
    const thresholdBytes = threshold * 1_000_000_000;
    if (disposableBytes >= thresholdBytes) warnings.push({ code: `DISPOSABLE_GROWTH_${threshold}GB`, bytes: disposableBytes, threshold_bytes: thresholdBytes });
  }
  return {
    categories,
    current,
    practical_peak: practicalPeak,
    disposable_bytes: disposableBytes,
    quotas,
    warnings,
    OPENAI_DB_WAL_FINDING: "package-controlled OpenCode DB/WAL is reported separately; live DBs are not checkpointed by runtime accounting",
    CODEGRAPH_GROWTH_FINDING: { path: codegraphRoot, bytes: sizeOf(codegraphRoot, 20_000).bytes, ownership: "report-only-unverified" },
    BACKUPS_FINDING: { path: backupRoot, bytes: sizeOf(backupRoot, 20_000).bytes, ownership: "upstream-report-only" },
  };
};

const quotaCheck = () => {
  const accounting = storageAccounting();
  const hard = accounting.warnings.filter((warning) => ["LOW_FREE_DISK", "DISPOSABLE_QUOTA", "RUN_QUOTA", "TEAM_QUOTA"].includes(warning.code));
  print({ ok: hard.length === 0, warnings: accounting.warnings, hard_warnings: hard, accounting });
  if (hard.length) process.exitCode = 1;
};

const rotateCandidates = () => [
  join(stateRoot, "maintenance", "logs"),
  ...teams.flatMap((team) => [
    join(dataRoot, team, "state", "team", "logs"),
    join(dataRoot, team, "data", "opencode", "log"),
    join(dataRoot, team, "logs"),
  ]),
  ...runDirs(),
];

const rotateLogs = (apply) => {
  const maxBytes = Number(process.env.OPENCODE_TEAM_LOG_MAX_BYTES || 1_000_000);
  const maxFiles = Number(process.env.OPENCODE_TEAM_LOG_ROTATIONS || 3);
  let rotated = 0;
  for (const root of rotateCandidates()) {
    if (!existsSync(root)) continue;
    const visit = (path) => {
      let entries = [];
      try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && /\.(?:log|err|out|jsonl)$/.test(entry.name)) {
          const info = statSync(child);
          if (info.size <= maxBytes) continue;
          rotated += 1;
          if (!apply) continue;
          for (let i = maxFiles - 1; i >= 1; i -= 1) {
            const from = `${child}.${i}`;
            const to = `${child}.${i + 1}`;
            if (existsSync(from)) {
              if (i + 1 > maxFiles) rmSync(from, { force: true });
              else {
                rmSync(to, { force: true });
                renameSync(from, to);
              }
            }
          }
          rmSync(`${child}.1`, { force: true });
          renameSync(child, `${child}.1`);
          writeFileSync(child, "", { mode: 0o600 });
        }
      }
    };
    visit(root);
  }
  return { rotated, mode: apply ? "apply" : "dry-run" };
};

const legacyFamilyPath = (path) => {
  const name = basename(path);
  if (legacyFamily.test(name)) return true;
  return name === ".omo" && legacyFamily.test(basename(dirname(path)));
};

const legacyTempRoots = () => {
  const roots = ["/private/tmp"];
  const visit = (root, depth) => {
    if (depth < 0 || !existsSync(root)) return;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && entry.name === "T") roots.push(path);
      else if (entry.isDirectory() && depth > 0) visit(path, depth - 1);
    }
  };
  visit("/var/folders", 3);
  return roots;
};

const legacyDiscoveredPaths = () => {
  const paths = readdirSync(homedir(), { withFileTypes: true })
    .filter((entry) => legacyFamilyPath(entry.name) || entry.name === ".opencode-team-staging")
    .map((entry) => join(homedir(), entry.name));
  for (const root of legacyTempRoots()) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    paths.push(...entries.filter((entry) => legacyFamilyPath(entry.name)).map((entry) => join(root, entry.name)));
  }
  return paths;
};

const classifyLegacy = () => {
  const requested = process.argv.slice(3);
  const paths = requested.length ? requested : legacyDiscoveredPaths();
  return paths.map((item) => {
    const path = resolve(item.replace(/^~(?=$|\/)/, homedir()));
    const open = openReferences(path);
    let info = null;
    try { const stat = lstatSync(path); info = { size_bytes: stat.isFile() ? stat.size : sizeOf(path, 10_000).bytes, mtime_ms: Math.floor(stat.mtimeMs), symlink: stat.isSymbolicLink() }; } catch {}
    const packageOwned = inside(path, dataRoot) || inside(path, cacheRoot) || inside(path, stateRoot);
    const knownLegacy = packageOwned || legacyFamilyPath(path) || path === join(homedir(), ".opencode-team-staging");
    const classification = open.state === "open" ? "legacy-active" : open.state === "error" || info?.symlink || !info || !knownLegacy ? "legacy-uncertain" : packageOwned ? "package-owned" : "legacy-reclaimable-read-only";
    return { path, exists: !!info, ...info, open_state: open.state, open_count: open.refs.length, open_refs: open.refs, live_process_refs: open.refs, classification };
  });
};

const excludeTimeMachine = (apply, check = false) => {
  const roots = [runtimeRoot, dependencyRoot].filter((root) => existsSync(root) || apply || check);
  const results = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      results.push({ root, root_excluded: false, child_covered: false, mode: apply ? "apply" : check ? "check" : "dry-run", status: 1, error: "missing_root" });
      continue;
    }
    const args = ["addexclusion", root];
    const result = apply ? spawnSync("tmutil", args, { encoding: "utf8" }) : { status: 0, stdout: "", stderr: "" };
    let childCovered = !apply && !check;
    let rootExcluded = !apply && !check;
    if ((apply && result.status === 0) || check) {
      const probe = join(root, ".opencode-team-time-machine-probe");
      let createdProbe = false;
      try {
        if (!existsSync(probe)) {
          writeFileSync(probe, "probe\n", { mode: 0o600 });
          createdProbe = true;
        }
        const rootCheck = spawnSync("tmutil", ["isexcluded", root], { encoding: "utf8" });
        const childCheck = spawnSync("tmutil", ["isexcluded", probe], { encoding: "utf8" });
        rootExcluded = rootCheck.status === 0 && /excluded/i.test(rootCheck.stdout || "");
        childCovered = childCheck.status === 0 && /excluded/i.test(childCheck.stdout || "");
      } finally {
        if (createdProbe) rmSync(probe, { force: true });
      }
    }
    results.push({ root, root_excluded: rootExcluded, child_covered: childCovered, mode: apply ? "apply" : check ? "check" : "dry-run", status: result.status ?? 0, ...(result.stderr?.trim() ? { error: result.stderr.trim() } : {}) });
  }
  return results;
};

const timeMachinePassed = (results) => results.length === 2 && results.every((result) => result.status === 0 && result.root_excluded && result.child_covered);

if (command === "gc") {
  const apply = process.argv.includes("--apply");
  const decisions = runDirs().map(evaluateRun);
  let deleted = 0;
  if (apply) {
    for (const decision of decisions.filter((item) => item.decision === "delete")) {
      const current = evaluateRun(decision.path);
      if (current.decision !== "delete" || !realInside(decision.path, runtimeRoot)) {
        print(`GC ${current.decision.toUpperCase()} ${decision.run} reason=revalidation_${current.reason}`);
        continue;
      }
      rmSync(decision.path, { recursive: true, force: true });
      deleted += 1;
    }
  }
  for (const decision of decisions) print(`GC ${decision.decision.toUpperCase()} ${decision.run} reason=${decision.reason}`);
  print(`GC SUMMARY mode=${apply ? "apply" : "dry-run"} candidates=${decisions.length} deleted=${deleted}`);
} else if (command === "status") {
  const decisions = runDirs().map(evaluateRun);
  print({ runs: decisions, storage: storageAccounting() });
} else if (command === "readiness") {
  print({ ready: runDirs().some((runDir) => readinessForRun(runDir).ready), runs: runDirs().map(readinessForRun) });
} else if (command === "accounting") {
  print(storageAccounting());
} else if (command === "quota") {
  quotaCheck();
} else if (command === "rotate") {
  print(rotateLogs(process.argv.includes("--apply")));
} else if (command === "time-machine-exclude") {
  const apply = process.argv.includes("--apply");
  const results = excludeTimeMachine(apply);
  print(results);
  if (apply && !timeMachinePassed(results)) process.exitCode = 1;
} else if (command === "time-machine-status") {
  const results = excludeTimeMachine(false, true);
  print(results);
  if (!timeMachinePassed(results)) process.exitCode = 1;
} else if (command === "legacy-classify") {
  print(classifyLegacy());
} else {
  console.error("Usage: runtime-lifecycle.mjs <gc|status|accounting|rotate|time-machine-exclude|legacy-classify>");
  process.exit(2);
}
