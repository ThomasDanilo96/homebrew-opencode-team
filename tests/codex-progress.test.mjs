import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCodexProgressParser,
  createCodexProgressTracker,
  parseCodexProgressRecord,
  redactCodexProgressText,
} from "../teams/openai/config/opencode/codex-progress.js";
import { runProcessAsync } from "../teams/openai/config/opencode/process-async.js";

const line = (record) => `${JSON.stringify(record)}\n`;
const commandRecord = (id, command, status = "in_progress") => ({
  type: "item.started",
  item: { id, type: "command_execution", command, status },
});

test("structured progress becomes a visible native metadata update", () => {
  let clock = 0;
  const updates = [];
  const parser = createCodexProgressParser();
  const tracker = createCodexProgressTracker({ model: "gpt-test", now: () => clock, emit: (update) => updates.push(update) });
  tracker.start();
  clock = 100;
  const [event] = parser.push(line(commandRecord("cmd-1", "pytest tests/test_small.py")));
  tracker.ingest(event);
  assert.equal(updates.at(-1).metadata.activity, "ACTIVE");
  assert.equal(updates.at(-1).metadata.recent_events[0].category, "TEST");
  assert.match(updates.at(-1).title, /^Codex · gpt-test ·/);
});

test("edit events expose only a bounded concise path and action", () => {
  const path = `/private/${"nested/".repeat(80)}src/candidates.py`;
  const event = parseCodexProgressRecord({
    type: "item.completed",
    item: { id: "edit-1", type: "file_change", status: "completed", changes: [{ path, kind: "update" }] },
  });
  assert.equal(event.category, "EDIT");
  assert.ok(event.detail.length <= 160);
  assert.match(event.detail, /src\/candidates\.py$/);
  assert.match(event.label, /^update /);
});

test("test commands are classified, bounded, and redacted", () => {
  const secret = "dont-leak-this-value";
  const parser = createCodexProgressParser();
  const [event] = parser.push(line(commandRecord("cmd-2", `API_KEY=${secret} pytest ${"very-long/".repeat(80)}test_one.py`)));
  const [completed] = parser.push(line({
    type: "item.completed",
    item: { id: "cmd-2", type: "command_execution", command: "pytest test_one.py", status: "completed" },
  }));
  assert.equal(event.category, "TEST");
  assert.equal(completed.status, "completed");
  assert.ok(event.detail.length <= 220);
  assert.doesNotMatch(event.detail, new RegExp(secret));
  assert.match(event.detail, /API_KEY=\[REDACTED\]/i);
});

test("reasoning and agent messages are never progress events", () => {
  assert.equal(parseCodexProgressRecord({ type: "item.completed", item: { type: "reasoning", text: "private thought" } }), null);
  assert.equal(parseCodexProgressRecord({ type: "item.completed", item: { type: "agent_message", text: "model prose" } }), null);
  assert.equal(parseCodexProgressRecord({ type: "response.reasoning", encrypted_content: "payload" }), null);
});

test("secret-like values are redacted from visible text", () => {
  const visible = redactCodexProgressText("Bearer bearer-secret API_TOKEN=token-secret eyJhbGciOiJIUzI1NiJ9.abcdefghijklmno.signaturevalue");
  assert.doesNotMatch(visible, /bearer-secret|token-secret|eyJhbGci/);
  assert.match(visible, /\[REDACTED\]/);
});

test("rapid non-important events are coalesced to the refresh interval", () => {
  let clock = 0;
  const updates = [];
  const tracker = createCodexProgressTracker({ now: () => clock, emit: (update) => updates.push(update), minRefreshMs: 500 });
  tracker.start();
  clock = 100;
  assert.equal(tracker.ingest({ category: "SEARCH", phase: "searching", status: "running", label: "search one", detail: "", important: false }), false);
  clock = 200;
  assert.equal(tracker.ingest({ category: "SEARCH", phase: "searching", status: "running", label: "search two", detail: "", important: false }), false);
  clock = 499;
  assert.equal(tracker.tick(), false);
  clock = 500;
  assert.equal(tracker.tick(), true);
  assert.equal(updates.length, 2);
  assert.equal(updates.at(-1).metadata.event_count, 2);
});

test("heartbeat is emitted only for a quiet live execution", () => {
  let clock = 0;
  const updates = [];
  const tracker = createCodexProgressTracker({ now: () => clock, emit: (update) => updates.push(update), quietAfterMs: 5_000, stalledAfterMs: 30_000 });
  tracker.start();
  clock = 4_999;
  assert.equal(tracker.tick(), false);
  clock = 5_000;
  assert.equal(tracker.tick(), true);
  assert.equal(updates.at(-1).metadata.activity, "QUIET_BUT_ALIVE");
  assert.match(updates.at(-1).metadata.detail, /last activity 5s ago/);
});

test("heartbeat stops after terminal success and failure", () => {
  for (const success of [true, false]) {
    let clock = 0;
    const updates = [];
    const tracker = createCodexProgressTracker({ now: () => clock, emit: (update) => updates.push(update), quietAfterMs: 1 });
    tracker.start();
    clock = 2_000;
    assert.equal(tracker.finish({ success, reason: "provider failed" }), true);
    const count = updates.length;
    clock = 60_000;
    assert.equal(tracker.tick(), false);
    assert.equal(updates.length, count);
    assert.match(updates.at(-1).title, success ? /^Codex completed ·/ : /^Codex failed ·/);
  }
});

test("successful process preserves terminal JSON while exposing compatible progress", async () => {
  const progress = [];
  const payload = { schema_version: 3, status: "completed", value: 7 };
  const result = await runProcessAsync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(${JSON.stringify(payload)}))`], {
    timeoutSeconds: 5,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), payload);
  assert.ok(progress.some((event) => event.stream === "stdout" && event.bytes > 0 && typeof event.lines === "number" && event.chunk.includes("schema_version")));
});

test("failed process preserves structured stderr and exit status", async () => {
  const payload = { schema_version: 3, status: "failed", reason: "fixture" };
  const result = await runProcessAsync(process.execPath, ["-e", `process.stderr.write(JSON.stringify(${JSON.stringify(payload)})); process.exit(7)`], { timeoutSeconds: 5 });
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(result.stderr), payload);
});

test("parser carry and recent-event windows remain bounded", () => {
  const parser = createCodexProgressParser({ maxEvents: 5 });
  parser.push("x".repeat(100_000));
  assert.ok(parser.bufferedChars() <= 64 * 1024);
  parser.push("\n");
  parser.push(Array.from({ length: 20 }, (_, index) => line(commandRecord(`cmd-${index}`, `rg term-${index} src`))).join(""));
  assert.equal(parser.recent().length, 5);
});

test("openai_run_codex keeps its terminal JSON return contract and wires chunk progress", async () => {
  const source = await readFile(new URL("../teams/openai/config/opencode/openai-team-tools.js", import.meta.url), "utf8");
  assert.match(source, /timeoutMs: timeoutSeconds \* 1000, onProgress/);
  assert.match(source, /return JSON\.stringify\(terminal\)/);
  assert.match(source, /progressParser\.push\(event\.chunk\)/);
});
