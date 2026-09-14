import test from "node:test";
import assert from "node:assert/strict";
import { exportLatestResponse } from "../exporter.js";

const parent = { id: "p", agent: "orchestrator", model: { providerID: "test", id: "model" }, parentID: undefined };
const user = (id) => ({ id, role: "user", sessionID: "p", time: { created: 1 } });
const assistant = (id, parentID = "u") => ({ id, role: "assistant", sessionID: "p", parentID, agent: "orchestrator", providerID: "test", modelID: "model", time: { created: 2 } });
const text = (id, messageID, value) => ({ id, messageID, sessionID: "p", type: "text", text: value });
const fixture = (messages, parts = {}, extras = {}) => exportLatestResponse({ parentSession: parent, messages: { p: messages }, parts, sessions: new Map(), statuses: new Map(), ...extras });

test("copies one parent turn and excludes the user", () => {
  const a = assistant("a");
  const result = fixture([user("u"), a], { a: [text("t", "a", "parent answer")] });
  assert.equal(result.status, "ready");
  assert.match(result.text, /parent answer/);
  assert.doesNotMatch(result.text, /USER_PROMPT/);
});

test("only latest user turn is exported", () => {
  const old = assistant("old", "old-user");
  const current = assistant("current", "new-user");
  const result = fixture([user("old-user"), old, user("new-user"), current], { old: [text("t1", "old", "old answer")], current: [text("t2", "current", "new answer")] });
  assert.doesNotMatch(result.text, /old answer/);
  assert.match(result.text, /new answer/);
  assert.doesNotMatch(result.text, /new-user/);
});

test("includes a current child and excludes an old or unrelated child", () => {
  const a = assistant("a");
  const child = { id: "c", parentID: "p", agent: "explore", model: { providerID: "test", id: "child" } };
  const old = { id: "old-child", parentID: "p", agent: "explore" };
  const unrelated = { id: "unrelated", parentID: "other", agent: "explore" };
  const task = { id: "task", messageID: "a", sessionID: "p", type: "tool", tool: "task", callID: "call", state: { status: "completed", metadata: { parentSessionId: "p", sessionId: "c" }, output: "internal" } };
  const result = exportLatestResponse({ parentSession: parent, messages: { p: [user("u"), a], c: [user("cu"), assistant("ca", "cu")], "old-child": [user("ou"), assistant("oa", "ou")], unrelated: [user("xu"), assistant("xa", "xu")] }, parts: { a: [task, text("pt", "a", "parent")], ca: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "child-check" }, output: "child output" } }, text("ct", "ca", "child marker")] }, sessions: new Map([["c", child], ["old-child", old], ["unrelated", unrelated]]), statuses: new Map() });
  assert.match(result.text, /child marker/);
  assert.match(result.text, /child-check[\s\S]*child output/);
  assert.doesNotMatch(result.text, /old-child|unrelated/);
});

test("orders parallel children and includes nested children", () => {
  const a = assistant("a");
  const c1 = { id: "c1", parentID: "p", agent: "first", model: { providerID: "x", id: "m" } };
  const c2 = { id: "c2", parentID: "p", agent: "second", model: { providerID: "x", id: "m" } };
  const nested = { id: "n", parentID: "c1", agent: "nested", model: { providerID: "x", id: "m" } };
  const task = (id, sessionId) => ({ id, messageID: "a", sessionID: "p", type: "tool", tool: "task", callID: id, state: { status: "completed", metadata: { parentSessionId: "p", sessionId }, output: "internal" } });
  const nestedTask = task("nt", "n");
  nestedTask.messageID = "c1a";
  nestedTask.state.metadata.parentSessionId = "c1";
  const result = exportLatestResponse({ parentSession: parent, messages: { p: [user("u"), a], c1: [user("c1u"), assistant("c1a", "c1u")], c2: [user("c2u"), assistant("c2a", "c2u")], n: [user("nu"), assistant("na", "nu")] }, parts: { a: [task("one", "c1"), task("two", "c2")], c1a: [nestedTask, text("c1t", "c1a", "first")], c2a: [text("c2t", "c2a", "second")], na: [text("nt", "na", "nested")] }, sessions: new Map([["c1", c1], ["c2", c2], ["n", nested]]), statuses: new Map() });
  assert.ok(result.text.indexOf("first") < result.text.indexOf("second"));
  assert.match(result.text, /nested/);
});

test("excludes reasoning and renders safe tools without raw metadata", () => {
  const a = assistant("a");
  const result = fixture([user("u"), a], { a: [text("t", "a", "visible"), { type: "reasoning", text: "hidden" }, { type: "tool", tool: "bash", state: { status: "completed", input: { command: "auth" }, output: "AUTHORIZATION: Bearer secret", metadata: { visible: true } } }, { type: "tool", tool: "bash", state: { status: "completed", input: { command: "safe" }, output: "safe tool result", metadata: { visible: true } } }] });
  assert.match(result.text, /visible/);
  assert.doesNotMatch(result.text, /hidden|Bearer secret/);
  assert.match(result.text, /safe tool result/);
});

test("renders recognized tools, failures, redaction, bounds, and source order", () => {
  const a = assistant("a");
  const parts = [
    text("t1", "a", "before"),
    { type: "tool", tool: "create", state: { input: { filePath: "file.txt", content: "OLD" }, status: "completed" } },
    { type: "tool", tool: "edit", state: { input: { filePath: "file.txt", oldString: "OLD", newString: "NEW" }, status: "completed" } },
    { type: "tool", tool: "bash", state: { input: { command: "printf verify" }, output: "verify", status: "completed" } },
    { type: "tool", tool: "test", state: { input: { command: "test -f file.txt" }, output: "OK", status: "completed" } },
    { type: "tool", tool: "read", state: { input: { filePath: "file.txt" }, output: "NEW", status: "completed" } },
    { type: "tool", tool: "grep", state: { input: { pattern: "NEW", path: "." }, output: "file.txt:NEW", status: "completed" } },
    { type: "tool", tool: "glob", state: { input: { pattern: "*.txt", path: "." }, output: "file.txt", status: "completed" } },
    { type: "tool", tool: "bash", state: { input: { command: "curl -H 'Authorization: Bearer secret'" }, error: "GH_TOKEN=secret", status: "error" } },
    { type: "tool", tool: "unknown", state: { input: { command: "RAW_JSON" }, output: "RAW_JSON" } },
    text("t2", "a", "after"),
  ];
  const result = fixture([user("u"), a], { a: parts });
  assert.ok(result.text.indexOf("before") < result.text.indexOf("# Created"));
  assert.ok(result.text.indexOf("# Created") < result.text.indexOf("← Patched"));
  assert.ok(result.text.indexOf("← Patched") < result.text.indexOf("$ printf verify"));
  assert.match(result.text, /OLD/);
  assert.match(result.text, /NEW/);
  assert.match(result.text, /OK|verify/);
  assert.match(result.text, /<redacted>/);
  assert.doesNotMatch(result.text, /secret|RAW_JSON/);
});

test("bounds very large tool output", () => {
  const a = assistant("a");
  const result = fixture([user("u"), a], { a: [{ type: "tool", tool: "bash", state: { input: { command: "large" }, output: "x".repeat(5000), status: "completed" } }] });
  assert.match(result.text, /\[tool output truncated\]/);
  assert.ok(result.text.length < 4300);
});

test("preserves visible parent output around a tool cycle", () => {
  const planning = assistant("planning");
  const final = assistant("final");
  const result = fixture([user("u"), planning, final], {
    planning: [text("p", "planning", "visible planning")],
    final: [{ type: "tool", tool: "task", state: { status: "completed", metadata: { sessionId: "missing" } } }, text("f", "final", "visible final")],
  });
  assert.ok(result.text.indexOf("visible planning") < result.text.indexOf("visible final"));
  assert.equal((result.text.match(/visible final/g) || []).length, 1);
});

test("deduplicates final text and handles empty output", () => {
  const earlier = assistant("earlier");
  const a = assistant("a");
  const result = fixture([user("u"), earlier, a], { earlier: [text("t0", "earlier", "same")], a: [text("t", "a", "same")] });
  assert.equal((result.text.match(/same/g) || []).length, 1);
  assert.equal(fixture([user("u")]).status, "empty");
});

test("reports busy child", () => {
  const a = assistant("a");
  const child = { id: "c", parentID: "p", agent: "explore" };
  const task = { type: "tool", tool: "task", state: { status: "completed", metadata: { parentSessionId: "p", sessionId: "c" } } };
  const result = exportLatestResponse({ parentSession: parent, messages: { p: [user("u"), a], c: [user("cu"), assistant("ca", "cu")] }, parts: { a: [task] }, sessions: new Map([["c", child]]), statuses: new Map([["c", { type: "busy" }]]) });
  assert.equal(result.status, "busy");
});
