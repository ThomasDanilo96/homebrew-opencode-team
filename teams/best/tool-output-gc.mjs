#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const teamDataRoot = join(dataRoot, "opencode-team");
const root = resolve(process.env.BEST_TOOL_OUTPUT_DIR ?? join(teamDataRoot, "best", "data", "opencode", "tool-output"));
const db = resolve(process.env.BEST_OPENCODE_DB ?? join(teamDataRoot, "best", "data", "opencode", "opencode.db"));
const retentionMs = 24 * 60 * 60 * 1000;
const live = process.argv.includes("--tool-output-gc");
const diagnostics = process.argv.includes("--diagnostics");
const activeSessions = new Set(process.argv.flatMap((arg, index) => arg === "--active-session" ? [process.argv[index + 1]] : []).filter(Boolean));
const now = Date.now();
const resolvedRoot = realpathSync(root);
const openCache = new Map();

function query(sql) {
  const result = execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8" });
  return result.trim() ? JSON.parse(result) : [];
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function addReference(map, key, reference) {
  const list = map.get(key) ?? [];
  list.push(reference);
  map.set(key, list);
}

function isInsideRoot(file) {
  const resolvedFile = realpathSync(file);
  return resolvedFile.startsWith(`${resolvedRoot}/`);
}

function isOpen(file, fresh = false) {
  if (!fresh && openCache.has(file)) return openCache.get(file);
  const result = spawnSync("lsof", ["-t", "--", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const value = result.error || ![0, 1].includes(result.status) ? null : result.stdout.trim() !== "";
  if (!fresh) openCache.set(file, value);
  return value;
}

function canonicalReferenceMap() {
  const references = new Map();
  for (const ref of query(`
    SELECT
      json_extract(p.data, '$.state.metadata.outputPath') AS output_path,
      p.id AS part_id, p.message_id AS message_id, m.session_id AS session_id,
      s.title AS session_title, s.agent AS session_agent, s.parent_id AS parent_id,
      s.time_created AS session_created, s.time_archived AS session_archived,
      json_extract(p.data, '$.tool') AS tool
    FROM part p
    LEFT JOIN message m ON m.id = p.message_id
    LEFT JOIN session s ON s.id = m.session_id
    WHERE json_extract(p.data, '$.state.metadata.outputPath') IS NOT NULL
  `)) {
    const outputPath = resolve(ref.output_path);
    addReference(references, outputPath, { ...ref, surface: "canonical_part" });
  }
  return references;
}

function textReferenceCounts(table, names) {
  if (names.length === 0) return new Map();
  const expressions = names.map((name) => `sum(instr(data, ${sqlString(name)}) > 0) AS ${name}`);
  const row = query(`SELECT ${expressions.join(", ")} FROM ${table} WHERE instr(data, 'tool_') > 0`)[0];
  return new Map(names.map((name) => [name, Number(row[name] ?? 0)]));
}

function classify(record) {
  if (record.unknown) return "UNKNOWN";
  if (record.canonical.length > 0) {
    if (record.canonical.some((ref) => !ref.session_id)) return "UNKNOWN";
    return "CANONICAL_OWNER";
  }
  return "TRUE_ORPHAN";
}

function scanOwnership() {
  const canonical = canonicalReferenceMap();
  const records = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = resolve(root, entry.name);
    if (!/^tool_[A-Za-z0-9]+$/.test(entry.name) || !entry.isFile()) {
      records.push({ name: entry.name, bytes: 0, classification: "UNKNOWN", unknown: true });
      continue;
    }
    const stat = lstatSync(file);
    if (!isInsideRoot(file)) {
      records.push({ name: entry.name, file, bytes: stat.size, classification: "UNKNOWN", unknown: true });
      continue;
    }
    const refs = canonical.get(file) ?? [];
    const malformed = refs.some((ref) => !ref.session_id);
    const record = { name: entry.name, file, bytes: stat.size, mtimeMs: stat.mtimeMs, canonical: refs, unknown: malformed };
    record.classification = classify(record);
    records.push(record);
  }
  return records;
}

function addDiagnostics(records) {
  const names = records.filter((record) => record.classification === "TRUE_ORPHAN").map((record) => record.name);
  const partMentions = textReferenceCounts("part", names);
  const eventMentions = textReferenceCounts("event", names);
  for (const record of records) {
    record.textual_mentions = partMentions.get(record.name) ?? 0;
    record.historical_event_mentions = eventMentions.get(record.name) ?? 0;
  }
  return records;
}

function phantomReferenceCount() {
  return [...canonicalReferenceMap()].reduce((count, [file, refs]) => count + (existsSync(file) ? 0 : refs.length), 0);
}

function printReport(records) {
  const summary = new Map();
  for (const record of records) {
    const current = summary.get(record.classification) ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += record.bytes;
    summary.set(record.classification, current);
  }
  console.log(JSON.stringify({
    files_scanned: records.length,
    summary: Object.fromEntries(summary),
    canonical_owned: records.filter((record) => record.classification === "CANONICAL_OWNER").length,
    historical_event_mentions: diagnostics ? records.filter((record) => record.historical_event_mentions > 0).length : null,
    textual_mentions: diagnostics ? records.filter((record) => record.textual_mentions > 0).length : null,
    true_orphans: records.filter((record) => record.classification === "TRUE_ORPHAN").length,
    orphans: records.filter((record) => record.classification === "TRUE_ORPHAN").map((record) => ({
      name: record.name,
      bytes: record.bytes,
      ...(diagnostics ? { textual_mentions: record.textual_mentions, historical_event_mentions: record.historical_event_mentions } : {}),
      age_hours: Math.floor((now - record.mtimeMs) / 3600000),
      eligible: now - record.mtimeMs > retentionMs && isOpen(record.file) === false,
    })),
    eligible_orphans: records.filter((record) => record.classification === "TRUE_ORPHAN" && now - record.mtimeMs > retentionMs && isOpen(record.file) === false).length,
    unknown: records.filter((record) => record.classification === "UNKNOWN").length,
    phantom_reference_count: diagnostics ? phantomReferenceCount() : null,
    diagnostics,
    mode: live ? "live" : "dry-run",
  }, null, 2));
}

let records = scanOwnership();
if (diagnostics) records = addDiagnostics(records);
if (!live) {
  printReport(records);
  process.exit(0);
}
let deleted = 0;
let reclaimed = 0;
const deletedFiles = [];
for (const candidate of records.filter((record) => record.classification === "TRUE_ORPHAN").sort((a, b) => b.bytes - a.bytes)) {
  if (deleted >= 10 || now - candidate.mtimeMs <= retentionMs || isOpen(candidate.file) !== false) continue;
  try {
    const before = lstatSync(candidate.file);
    const current = scanOwnership().find((record) => record.name === candidate.name);
    if (!current || current.classification !== "TRUE_ORPHAN" || !isInsideRoot(candidate.file)) continue;
    if (isOpen(candidate.file, true) !== false) continue;
    const currentStat = lstatSync(candidate.file);
    if (currentStat.size !== before.size || currentStat.mtimeMs !== before.mtimeMs) continue;
    unlinkSync(candidate.file);
    deleted += 1;
    reclaimed += before.size;
    deletedFiles.push({
      name: candidate.name,
      bytes: before.size,
      age_hours: Math.floor((now - candidate.mtimeMs) / 3600000),
    });
  } catch {
    continue;
  }
}
console.log(JSON.stringify({ files_deleted: deleted, bytes_reclaimed: reclaimed, deleted_files: deletedFiles, mode: "live" }, null, 2));
