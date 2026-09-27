import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

test("memory safety compacts a risky idle session once", async () => {
  const root = await mkdtemp(join(tmpdir(), "best-memory-safety-"));
  const runDir = join(root, "run");
  const dbPath = join(root, "opencode.db");
  const sessionID = "ses_memory_safety_fixture";
  let summarized = false;
  let summarizeCalls = 0;
  let unboundedMessageFetch = false;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/session/status") return response.end("{}");
    if (request.url === `/session/${sessionID}/message`) unboundedMessageFetch = true;
    if (request.url.startsWith(`/session/${sessionID}/message`)) {
      return response.end(JSON.stringify([{ info: { providerID: "openai", modelID: "gpt-5.6-luna" }, parts: summarized ? [{ type: "compaction", auto: false }] : [] }]));
    }
    if (request.url === `/session/${sessionID}/summarize` && request.method === "POST") {
      summarizeCalls += 1;
      summarized = true;
      const markerDB = new DatabaseSync(dbPath);
      markerDB.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(`compaction-${summarizeCalls}`, sessionID, JSON.stringify({ type: "compaction", auto: false }), Date.now());
      markerDB.close();
      return response.end("true");
    }
    response.statusCode = 404;
    return response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ run_id: "a1b2c3d4", parent_session_id: sessionID, team: "best", state: "ACTIVE" }));
    await writeFile(join(runDir, "port"), `${port}\n`);
    await writeFile(join(runDir, "server.pid"), `${process.pid}\n`);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER); CREATE TABLE part (id TEXT, session_id TEXT, data TEXT, time_created INTEGER); CREATE TABLE todo (session_id TEXT, status TEXT);");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", sessionID, JSON.stringify({ providerID: "openai", modelID: "gpt-5.6-luna" }), 1);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p1", sessionID, JSON.stringify({ type: "text" }), 1);
    db.close();
    const env = { ...process.env, RUNTIME_ROOT: root, BEST_OPENCODE_DB: dbPath, BEST_MEMORY_SAFETY_METADATA: join(root, "metadata"), BEST_MEMORY_SAFETY_LOCKS: join(root, "locks"), BEST_MEMORY_MAX_MESSAGES: "1", BEST_MEMORY_MAX_MESSAGES_SINCE_COMPACTION: "2", BEST_MEMORY_POLL_INTERVAL_MS: "1", BEST_MEMORY_POLL_ATTEMPTS: "5", BEST_MEMORY_RECOVERY_GRACE_MS: "1", BEST_MEMORY_WARN_RSS_BYTES: "999999999999", BEST_MEMORY_BLOCK_RSS_BYTES: "999999999999", BEST_MEMORY_WARN_AVAILABLE_BYTES: "1", BEST_MEMORY_BLOCK_AVAILABLE_BYTES: "1" };
    const script = join(process.cwd(), "teams/best/session-memory-safety.mjs");
    const first = JSON.parse((await execFileAsync("node", [script, "--run-dir", runDir], { env })).stdout);
    assert.equal(first.results[0].result, "COMPLETED");
    const second = JSON.parse((await execFileAsync("node", [script, "--run-dir", runDir], { env })).stdout);
    assert.equal(second.results[0].result, "SKIP_UNCHANGED");
    assert.equal(summarizeCalls, 1);
    assert.equal(unboundedMessageFetch, false);
    const metadata = JSON.parse(await readFile(join(root, "metadata", `${sessionID}.json`), "utf8"));
    assert.equal(metadata.result, "COMPLETED");
    assert.equal(metadata.checkpoint.compaction_manual, true);
    assert.equal(typeof metadata.checkpoint.messages_at_compaction, "number");
    const dbAfter = new DatabaseSync(dbPath);
    dbAfter.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m2", sessionID, JSON.stringify({ role: "user" }), 2);
    dbAfter.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p2", sessionID, JSON.stringify({ type: "text", data: "tiny" }), 2);
    dbAfter.close();
    const tiny = JSON.parse((await execFileAsync("node", [script, "--run-dir", runDir], { env })).stdout);
    assert.equal(tiny.results[0].result, "SAFE_SINCE_COMPACTION");
    const dbGrowth = new DatabaseSync(dbPath);
    dbGrowth.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m3", sessionID, JSON.stringify({ role: "user" }), 3);
    dbGrowth.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p3", sessionID, JSON.stringify({ type: "text", data: "growth" }), 3);
    dbGrowth.close();
    const regrowth = JSON.parse((await execFileAsync("node", [script, "--run-dir", runDir], { env })).stdout);
    assert.equal(regrowth.results[0].result, "COMPLETED");
    assert.equal(summarizeCalls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

const runMarkerScenario = async ({ beforeAuto = null, afterAuto = null, statusBody = "{}", allowRecycle = false, repeat = false, lockHeld = false }) => {
  const root = await mkdtemp(join(tmpdir(), "best-memory-marker-"));
  const runDir = join(root, "run");
  const dbPath = join(root, "opencode.db");
  const sessionID = "ses_marker_fixture";
  let summarizeCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/session/status") return response.end(statusBody);
    if (request.url.startsWith(`/session/${sessionID}/message`)) return response.end("[]");
    if (request.url === `/session/${sessionID}/summarize`) {
      summarizeCalls += 1;
      if (afterAuto !== null) {
        const markerDB = new DatabaseSync(dbPath);
        markerDB.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("after", sessionID, JSON.stringify({ type: "compaction", auto: afterAuto }), Date.now());
        markerDB.close();
      }
      return response.end("true");
    }
    response.statusCode = 404;
    return response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ run_id: "marker-run", parent_session_id: sessionID }));
    await writeFile(join(runDir, "port"), `${port}\n`);
    await writeFile(join(runDir, "server.pid"), `${process.pid}\n`);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER); CREATE TABLE part (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", sessionID, JSON.stringify({ providerID: "openai", modelID: "gpt-5.6-luna" }), 1);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p1", sessionID, JSON.stringify({ type: "text" }), 1);
    if (beforeAuto !== null) db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("before", sessionID, JSON.stringify({ type: "compaction", auto: beforeAuto }), Date.now() - 1000);
    db.close();
    if (lockHeld) await mkdir(join(root, "locks", sessionID), { recursive: true });
    const env = { ...process.env, RUNTIME_ROOT: root, BEST_OPENCODE_DB: dbPath, BEST_MEMORY_SAFETY_METADATA: join(root, "metadata"), BEST_MEMORY_SAFETY_LOCKS: join(root, "locks"), BEST_MEMORY_MAX_MESSAGES: "1", BEST_MEMORY_POLL_INTERVAL_MS: "1", BEST_MEMORY_POLL_ATTEMPTS: "2", BEST_MEMORY_RECOVERY_GRACE_MS: "1", BEST_MEMORY_WARN_RSS_BYTES: "999999999999", BEST_MEMORY_BLOCK_RSS_BYTES: "999999999999", BEST_MEMORY_WARN_AVAILABLE_BYTES: "1", BEST_MEMORY_BLOCK_AVAILABLE_BYTES: "1", BEST_MEMORY_ALLOW_RECYCLE: allowRecycle ? "1" : "0", BEST_MEMORY_RECOVERY_RSS_BYTES: allowRecycle ? "1" : "1073741824" };
    const output = JSON.parse((await execFileAsync("node", [join(process.cwd(), "teams/best/session-memory-safety.mjs"), "--run-dir", runDir], { env })).stdout);
    const second = repeat ? JSON.parse((await execFileAsync("node", [join(process.cwd(), "teams/best/session-memory-safety.mjs"), "--run-dir", runDir], { env })).stdout) : null;
    return { result: output.results[0].result, secondResult: second?.results[0].result, summarizeCalls };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};

test("old manual marker cannot falsely complete", async () => {
  assert.deepEqual(await runMarkerScenario({ beforeAuto: false }), { result: "TIMEOUT", secondResult: undefined, summarizeCalls: 1 });
});

test("automatic compaction cannot complete manual summarize", async () => {
  assert.deepEqual(await runMarkerScenario({ afterAuto: true }), { result: "TIMEOUT", secondResult: undefined, summarizeCalls: 1 });
});

test("new manual marker completes manual summarize", async () => {
  assert.deepEqual(await runMarkerScenario({ afterAuto: false }), { result: "COMPLETED", secondResult: undefined, summarizeCalls: 1 });
});

test("same root busy skips compaction", async () => {
  assert.deepEqual(await runMarkerScenario({ statusBody: JSON.stringify({ ses_marker_fixture: { status: "busy" } }) }), { result: "SKIP_BUSY", secondResult: undefined, summarizeCalls: 0 });
});

test("other root busy fences the whole server", async () => {
  assert.deepEqual(await runMarkerScenario({ statusBody: JSON.stringify({ ses_other_root: { status: "busy" } }) }), { result: "SKIP_BUSY", secondResult: undefined, summarizeCalls: 0 });
});

test("RECYCLE_REQUIRED retains its checkpoint for later invocations", async () => {
  assert.deepEqual(await runMarkerScenario({ afterAuto: false, allowRecycle: true, repeat: true }), { result: "RECYCLE_REQUIRED", secondResult: "SKIP_UNCHANGED", summarizeCalls: 1 });
});

test("concurrent compaction lock prevents admission", async () => {
  assert.deepEqual(await runMarkerScenario({ lockHeld: true }), { result: "SKIP_LOCKED", secondResult: undefined, summarizeCalls: 0 });
});
