#!/usr/bin/env node

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const stateRoot = process.env.OPENAI_TEAM_STATE_ROOT;
if (!stateRoot) {
  console.error("OPENAI_TEAM_STATE_ROOT is required");
  process.exit(2);
}

const retentionDays = Number(process.env.OPENAI_WORK_PACKET_RETENTION_DAYS ?? 7);
const retentionMs = (Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : 7) * 86400000;
const now = Date.now();
const logsRoot = join(stateRoot, "logs");
const counts = {
  sessions_deleted: 0,
  work_packets_deleted: 0,
  recovery_items_deleted: 0,
  logs_pruned: 0,
  locks_skipped: 0,
  active_items_skipped: 0,
  unknown_kept: 0,
};

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files;
}

function fileIsOpen(path) {
  const result = spawnSync("lsof", ["-t", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.error || ![0, 1].includes(result.status) ? null : result.stdout.trim() !== "";
}

async function pruneLogs() {
  let removed = 0;
  for (const path of await listFiles(logsRoot)) {
    let file;
    try { file = await stat(path); } catch { continue; }
    if (now - file.mtimeMs <= retentionMs) continue;
    const open = fileIsOpen(path);
    if (open !== false) {
      counts.active_items_skipped += 1;
      continue;
    }
    try {
      await unlink(path);
      removed += 1;
    } catch {
      counts.unknown_kept += 1;
    }
  }
  return removed;
}

async function countProtectedState() {
  for (const relative of ["recovery-homes", "codex-recovery", "handoffs", "routes", "active", "locks"]) {
    counts.unknown_kept += (await listFiles(join(stateRoot, relative))).length;
  }
}

const { pruneWorkPackets } = await import("../../teams/openai/config/opencode/work-packet.js");
counts.work_packets_deleted = await pruneWorkPackets();
counts.logs_pruned = await pruneLogs();
await countProtectedState();
console.log(Object.entries(counts).map(([key, value]) => `${key}=${value}`).join("\n"));
