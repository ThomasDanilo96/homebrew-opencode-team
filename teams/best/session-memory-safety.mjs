import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run-dir");
  return { runDir: runIndex >= 0 ? args[runIndex + 1] : null };
};

const execFileAsync = promisify(execFile);

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));

const processMemory = async (runDir) => {
  const pid = Number((await readFile(join(runDir, "server.pid"), "utf8")).trim());
  const [{ stdout: rss }, { stdout: physical }, { stdout: vmStat }] = await Promise.all([
    execFileAsync("ps", ["-p", String(pid), "-o", "rss="]),
    execFileAsync("sysctl", ["-n", "hw.memsize"]),
    execFileAsync("vm_stat", []),
  ]);
  const rssBytes = Number(rss.trim()) * 1024;
  const physicalBytes = Number(physical.trim());
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1] || 4096);
  const pages = (name) => Number(vmStat.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] || 0);
  const availableBytes = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * pageSize;
  return { pid, rss_bytes: rssBytes, physical_bytes: physicalBytes, available_bytes: availableBytes, fraction: physicalBytes > 0 ? rssBytes / physicalBytes : 0 };
};

const metricsFor = (dbPath, sessionID) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT
        (SELECT count(*) FROM message WHERE session_id = ?) AS messages,
        (SELECT count(*) FROM part WHERE session_id = ?) AS parts,
        (SELECT coalesce(sum(length(data)), 0) FROM message WHERE session_id = ?) AS message_bytes,
        (SELECT coalesce(sum(length(data)), 0) FROM part WHERE session_id = ?) AS part_bytes,
        (SELECT coalesce(max(length(data)), 0) FROM part WHERE session_id = ?) AS largest_part
    `).get(sessionID, sessionID, sessionID, sessionID, sessionID);
    const marker = db.prepare(`
      SELECT id, time_created, json_extract(data, '$.auto') AS auto
      FROM part
      WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction'
      ORDER BY time_created DESC, id DESC
      LIMIT 1
    `).get(sessionID);
    return { ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])), compaction_marker: marker ? { id: marker.id, time_created: Number(marker.time_created), auto: marker.auto === null ? null : Boolean(marker.auto) } : null };
  } finally {
    db.close();
  }
};

const modelFor = async (dbPath, port, sessionID) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 20").all(sessionID);
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data);
        if (data.providerID && data.modelID) return { providerID: data.providerID, modelID: data.modelID };
      } catch {
        // The API fallback below handles legacy or non-JSON message rows.
      }
    }
  } finally {
    db.close();
  }
  const recent = await (await fetch(`http://127.0.0.1:${port}/session/${sessionID}/message?limit=20`)).json();
  return [...recent].reverse().map((message) => message.info || {}).find((info) => info.providerID && info.modelID) || null;
};

const candidateRuns = async (runtimeRoot, requested) => {
  if (requested) return [requested];
  const runs = [];
  for (const team of ["best"]) {
    const root = join(runtimeRoot, team, "runs");
    if (!existsSync(root)) continue;
    for (const name of await readdir(root)) runs.push(join(root, name));
  }
  return runs;
};

const compactRun = async (runDir, config) => {
  const manifest = await readJSON(join(runDir, "manifest.json"));
  const sessionID = String(manifest.parent_session_id || "");
  const port = String((await readFile(join(runDir, "port"), "utf8")).trim());
  if (!sessionID || !port) return { run: manifest.run_id, result: "SKIP_NO_SESSION" };
  const statuses = await (await fetch(`http://127.0.0.1:${port}/session/status`)).json();
  if (Object.keys(statuses).length > 0) return { run: manifest.run_id, session_id: sessionID, result: "SKIP_BUSY" };
  const metrics = metricsFor(config.dbPath, sessionID);
  const memory = await processMemory(runDir);
  const pressurePath = join(runDir, "memory-pressure.json");
  const blockMemory = memory.rss_bytes >= config.blockRssBytes || (memory.available_bytes > 0 && memory.available_bytes <= config.blockAvailableBytes);
  const warnMemory = memory.rss_bytes >= config.warnRssBytes || (memory.available_bytes > 0 && memory.available_bytes <= config.warnAvailableBytes);
  if (blockMemory) {
    await atomicWrite(pressurePath, { session_id: sessionID, run_id: manifest.run_id, result: "BLOCK_FANOUT", rss_bytes: memory.rss_bytes, available_bytes: memory.available_bytes, physical_bytes: memory.physical_bytes, checked_at: new Date().toISOString() });
  } else if (warnMemory) {
    await atomicWrite(pressurePath, { session_id: sessionID, run_id: manifest.run_id, result: "WARN", rss_bytes: memory.rss_bytes, available_bytes: memory.available_bytes, physical_bytes: memory.physical_bytes, checked_at: new Date().toISOString() });
  } else {
    await rm(pressurePath, { force: true });
  }
  const metadataPath = join(config.metadataRoot, `${sessionID}.json`);
  const prior = existsSync(metadataPath) ? await readJSON(metadataPath) : null;
  const checkpoint = prior?.compaction_status === "COMPLETED" || prior?.result === "COMPLETED" || prior?.result === "RECYCLE_REQUIRED" ? prior.checkpoint : null;
  const baseline = checkpoint?.session_id === sessionID ? { messages: checkpoint.messages_at_compaction, parts: checkpoint.parts_at_compaction, message_bytes: checkpoint.message_bytes_at_compaction, part_bytes: checkpoint.part_bytes_at_compaction } : { messages: 0, parts: 0, message_bytes: 0, part_bytes: 0 };
  const delta = { messages: Math.max(0, metrics.messages - baseline.messages), parts: Math.max(0, metrics.parts - baseline.parts), message_bytes: Math.max(0, metrics.message_bytes - baseline.message_bytes), part_bytes: Math.max(0, metrics.part_bytes - baseline.part_bytes) };
  const risky = checkpoint
    ? delta.messages >= config.maxMessagesSinceCompaction || delta.parts >= config.maxPartsSinceCompaction || delta.part_bytes >= config.maxPartBytesSinceCompaction
    : metrics.messages >= config.maxMessages || metrics.parts >= config.maxParts || metrics.part_bytes >= config.maxPartBytes;
  if (checkpoint && delta.messages === 0 && delta.parts === 0 && delta.message_bytes === 0 && delta.part_bytes === 0) return { run: manifest.run_id, session_id: sessionID, result: "SKIP_UNCHANGED", metrics, delta };
  if (!risky) return { run: manifest.run_id, session_id: sessionID, result: checkpoint ? "SAFE_SINCE_COMPACTION" : "SAFE", metrics, delta };
  const lock = join(config.lockRoot, sessionID);
  try { mkdirSync(lock); } catch { return { run: manifest.run_id, session_id: sessionID, result: "SKIP_LOCKED", metrics }; }
  try {
    const beforeMarker = metrics.compaction_marker;
    const admissionTime = Date.now();
    const identity = await modelFor(config.dbPath, port, sessionID);
    if (!identity) return { run: manifest.run_id, session_id: sessionID, result: "SKIP_NO_MODEL", metrics };
    const response = await fetch(`http://127.0.0.1:${port}/session/${sessionID}/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerID: identity.providerID, modelID: identity.modelID }) });
    if (!response.ok || (await response.json()) !== true) return { run: manifest.run_id, session_id: sessionID, result: "FAILED_ADMISSION", metrics };
    let completed = false;
    for (let attempt = 0; attempt < config.pollAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      const current = await (await fetch(`http://127.0.0.1:${port}/session/status`)).json();
      if (!current[sessionID]) {
        const afterMetrics = metricsFor(config.dbPath, sessionID);
        const afterMarker = afterMetrics.compaction_marker;
        completed = Boolean(afterMarker && afterMarker.id !== beforeMarker?.id && afterMarker.time_created >= admissionTime && afterMarker.auto === false);
        if (completed) break;
      }
    }
    if (completed && config.recoveryGraceMs > 0) await new Promise((resolve) => setTimeout(resolve, config.recoveryGraceMs));
    const postMetrics = metricsFor(config.dbPath, sessionID);
    const postMemory = completed ? await processMemory(runDir) : null;
    const recycleRequired = Boolean(completed && config.allowRecycle && postMemory.rss_bytes >= config.recoveryRssBytes);
    const result = { run: manifest.run_id, session_id: sessionID, result: recycleRequired ? "RECYCLE_REQUIRED" : completed ? "COMPLETED" : "TIMEOUT", compaction_status: completed ? "COMPLETED" : "NOT_COMPLETED", recovery_action: recycleRequired ? "RECYCLE_REQUIRED" : "NONE", metrics: postMetrics, memory: postMemory, checkpoint: completed ? { session_id: sessionID, completed_at: new Date().toISOString(), messages_at_compaction: postMetrics.messages, parts_at_compaction: postMetrics.parts, message_bytes_at_compaction: postMetrics.message_bytes, part_bytes_at_compaction: postMetrics.part_bytes, largest_part_at_compaction: postMetrics.largest_part, compaction_marker_id: postMetrics.compaction_marker.id, compaction_marker_time_created: postMetrics.compaction_marker.time_created, compaction_manual: true } : null };
    await atomicWrite(metadataPath, result);
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

const main = async () => {
  const args = parseArgs();
  const runtimeRoot = process.env.RUNTIME_ROOT || join(process.env.HOME, ".cache/opencode-team/runtime");
  const dataRoot = process.env.DATA_ROOT || join(process.env.HOME, ".local/share/opencode-team");
  const config = {
    dbPath: process.env.BEST_OPENCODE_DB || join(dataRoot, "best/data/opencode/opencode.db"),
    metadataRoot: process.env.BEST_MEMORY_SAFETY_METADATA || join(dataRoot, "best/state/memory-safety"),
    lockRoot: process.env.BEST_MEMORY_SAFETY_LOCKS || join(dataRoot, "best/state/memory-safety/locks"),
    maxMessages: numberEnv("BEST_MEMORY_MAX_MESSAGES", 1200),
    maxParts: numberEnv("BEST_MEMORY_MAX_PARTS", 6000),
    maxPartBytes: numberEnv("BEST_MEMORY_MAX_PART_BYTES", 16 * 1024 * 1024),
    maxMessagesSinceCompaction: numberEnv("BEST_MEMORY_MAX_MESSAGES_SINCE_COMPACTION", 1200),
    maxPartsSinceCompaction: numberEnv("BEST_MEMORY_MAX_PARTS_SINCE_COMPACTION", 6000),
    maxPartBytesSinceCompaction: numberEnv("BEST_MEMORY_MAX_PART_BYTES_SINCE_COMPACTION", 16 * 1024 * 1024),
    // 768 MiB warns before the observed ~1.06 GiB historical peak; 1.5 GiB
    // blocks new fanout before the observed ~1.86 GiB compaction peak.
    warnRssBytes: numberEnv("BEST_MEMORY_WARN_RSS_BYTES", 768 * 1024 * 1024),
    blockRssBytes: numberEnv("BEST_MEMORY_BLOCK_RSS_BYTES", 1536 * 1024 * 1024),
    warnAvailableBytes: numberEnv("BEST_MEMORY_WARN_AVAILABLE_BYTES", 4 * 1024 * 1024 * 1024),
    blockAvailableBytes: numberEnv("BEST_MEMORY_BLOCK_AVAILABLE_BYTES", 2 * 1024 * 1024 * 1024),
    pollIntervalMs: numberEnv("BEST_MEMORY_POLL_INTERVAL_MS", 1000),
    pollAttempts: numberEnv("BEST_MEMORY_POLL_ATTEMPTS", 180),
    recoveryRssBytes: numberEnv("BEST_MEMORY_RECOVERY_RSS_BYTES", 1024 * 1024 * 1024),
    recoveryGraceMs: numberEnv("BEST_MEMORY_RECOVERY_GRACE_MS", 5000),
    allowRecycle: process.env.BEST_MEMORY_ALLOW_RECYCLE === "1",
  };
  await mkdir(config.metadataRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.lockRoot, { recursive: true, mode: 0o700 });
  const results = [];
  for (const runDir of await candidateRuns(runtimeRoot, args.runDir)) {
    try { results.push(await compactRun(runDir, config)); } catch (error) { results.push({ run: runDir, result: "ERROR", error: String(error) }); }
  }
  process.stdout.write(`${JSON.stringify({ thresholds: { messages: config.maxMessages, parts: config.maxParts, part_bytes: config.maxPartBytes, messages_since_compaction: config.maxMessagesSinceCompaction, parts_since_compaction: config.maxPartsSinceCompaction, part_bytes_since_compaction: config.maxPartBytesSinceCompaction, warn_rss_bytes: config.warnRssBytes, block_rss_bytes: config.blockRssBytes, warn_available_bytes: config.warnAvailableBytes, block_available_bytes: config.blockAvailableBytes, recovery_rss_bytes: config.recoveryRssBytes }, results })}\n`);
};

await main();
