#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = process.env.DATA_ROOT;
if (!dataRoot) throw new Error("DATA_ROOT is required");
const teams = ["best", "go", "openai", "daily"];
const maxAgeMs = Math.min(Math.max(Number(process.env.OPENCODE_PLAYWRIGHT_GC_RETENTION_HOURS || 6), 1), 24 * 30) * 60 * 60 * 1000;
const maxEntries = Math.min(Math.max(Number(process.env.OPENCODE_PLAYWRIGHT_GC_MAX_ENTRIES || 1000), 1), 10000);
const now = Date.now();
const metrics = { bytes_before: 0, bytes_removed: 0, bytes_after: 0, entries_removed: 0, entries_preserved_active: 0, entries_preserved_uncertain: 0, upstream_profiles: { bytes_before: 0, bytes_removed: 0, entries_removed: 0, preserved_active: 0, preserved_uncertain: 0, roots: [] }, roots: [] };

const activeUse = (root) => {
  if (process.env.OPENCODE_PLAYWRIGHT_GC_TEST_IGNORE_ACTIVITY === "1") return false;
  try {
    const processes = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const target = resolve(root);
    if (processes.split(/\r?\n/).some((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match || Number(match[1]) === process.pid || !/@playwright\/mcp|playwright-mcp/.test(match[2])) return false;
      const profile = match[2].match(/(?:--user-data-dir=|--user-data-dir\s+)([^\s]+)/)?.[1];
      return profile ? resolve(profile.replace(/^['"]|['"]$/g, "")) === target : false;
    })) return true;
  } catch (error) {
    return null;
  }
  try {
    const open = execFileSync("/usr/sbin/lsof", ["-nP", "+D", root], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return open.trim().length > 0;
  } catch (error) {
    if (error.status === 1) return false;
    return null;
  }
};

const walk = (path, state) => {
  if (state.seen >= maxEntries) { state.uncertain += 1; return; }
  let info;
  try { info = lstatSync(path); } catch { state.uncertain += 1; return; }
  state.seen += 1;
  if (info.isSymbolicLink()) { state.before += info.size; state.uncertain += 1; return; }
  if (info.isDirectory()) {
    let entries;
    try { entries = readdirSync(path); } catch { state.uncertain += 1; return; }
    for (const entry of entries) walk(join(path, entry), state);
    return;
  }
  if (!info.isFile()) return;
  state.before += info.size;
  if (state.active !== false || now - info.mtimeMs < maxAgeMs) { state.preserved += 1; return; }
  try { rmSync(path, { force: true }); state.removed += 1; state.removedBytes += info.size; }
  catch { state.uncertain += 1; }
};

for (const team of teams) {
  const root = join(dataRoot, team, "playwright", "output");
  const state = { before: 0, removed: 0, removedBytes: 0, preserved: 0, uncertain: 0, seen: 0, active: activeUse(root) };
  if (!existsSync(root)) state.active = false;
  if (state.active === null) state.uncertain += 1;
  if (state.active !== true) walk(root, state);
  else state.uncertain += 1;
  metrics.bytes_before += state.before;
  metrics.bytes_removed += state.removedBytes;
  metrics.entries_removed += state.removed;
  metrics.entries_preserved_active += state.active === true ? state.seen : 0;
  metrics.entries_preserved_uncertain += state.uncertain;
  metrics.roots.push({ team, root, active: state.active, bytes_before: state.before, bytes_removed: state.removedBytes, entries_removed: state.removed, entries_preserved: state.preserved, entries_preserved_uncertain: state.uncertain });
}
const profileRoot = join(homedir(), "Library", "Caches", "ms-playwright-mcp");
if (existsSync(profileRoot)) {
  let entries = [];
  try { entries = readdirSync(profileRoot, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith("mcp-chrome-"))) {
    const root = join(profileRoot, entry.name);
    const state = { before: 0, removed: 0, removedBytes: 0, preserved: 0, uncertain: 0, seen: 0, active: activeUse(root) };
    if (state.active === null) state.uncertain += 1;
    if (state.active !== true) walk(root, state); else state.uncertain += 1;
    metrics.upstream_profiles.bytes_before += state.before;
    metrics.upstream_profiles.bytes_removed += state.removedBytes;
    metrics.upstream_profiles.entries_removed += state.removed;
    metrics.upstream_profiles.preserved_active += state.active === true ? state.seen : 0;
    metrics.upstream_profiles.preserved_uncertain += state.uncertain;
    metrics.upstream_profiles.roots.push({ root, active: state.active, bytes_before: state.before, bytes_removed: state.removedBytes, entries_removed: state.removed, entries_preserved_uncertain: state.uncertain });
  }
}
metrics.bytes_after = metrics.bytes_before - metrics.bytes_removed;
process.stdout.write(`${JSON.stringify(metrics)}\n`);
