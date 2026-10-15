import test from "node:test";
import assert from "node:assert/strict";
import { createBestNativeRouter } from "../teams/best/best-native-router.mjs";

function createHarness(sessionID = "ses-native-test", classify = async (prompt) =>
  prompt.includes("ROUTE_FANOUT") ? "FANOUT" : prompt.includes("ROUTE_FOUR") ? "FOUR" : "DIRECT") {
  const handlers = new Map();
  createBestNativeRouter({ classify, logger: () => {} })({ on: (event, handler) => handlers.set(event, handler) });
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionID },
  };
  return { handlers, ctx };
}

function routePrompt(harness, prompt) {
  return harness.handlers.get("input")({ text: prompt, source: "interactive" }, harness.ctx);
}

function toolCall(harness, toolName, input, toolCallId = `${toolName}-call`) {
  return harness.handlers.get("tool_call")({ toolName, input, toolCallId }, harness.ctx);
}

function toolResult(harness, toolName, input, toolCallId = `${toolName}-call`, isError = false) {
  return harness.handlers.get("tool_result")({ toolName, input, toolCallId, isError, content: [] }, harness.ctx);
}

test("Native BEST router transforms complex prompts and fails closed until exact tasks launch", async () => {
  const harness = createHarness();
  const transformed = await routePrompt(harness, "ROUTE_FOUR: complex multi-agent request");
  assert.equal(transformed.action, "transform");
  assert.match(transformed.text, /BEST ROUTE FOUR/);
  assert.match(transformed.text, /<BEST_ROUTER_ROUTE>FOUR<\/BEST_ROUTER_ROUTE>/);

  const direct = await toolCall(harness, "read", { path: "README.md" });
  assert.equal(direct.block, true);
  assert.match(direct.reason, /requires native task delegation/i);

  const wrong = await toolCall(harness, "task", { subagent_type: "general" }, "wrong");
  assert.equal(wrong.block, true);

  const agents = ["explore", "librarian", "openai-architect", "openai-reviewer"];
  const callIds = new Map();
  for (const agent of agents) {
    const args = { subagent_type: agent };
    const result = await toolCall(harness, "task", args, `task-${agent}`);
    assert.equal(result, undefined);
    assert.equal(args.run_in_background, true);
    callIds.set(agent, `task-${agent}`);
  }
  assert.equal((await toolCall(harness, "task", { subagent_type: "explore", run_in_background: true }, "duplicate")).block, true);

  for (const agent of agents.slice(0, -1)) {
    await toolResult(harness, "task", {}, callIds.get(agent));
    assert.equal((await toolCall(harness, "read", { path: "README.md" })).block, true);
  }
  await toolResult(harness, "task", {}, callIds.get("openai-reviewer"));
  assert.equal(await toolCall(harness, "read", { path: "README.md" }), undefined);
});

test("Native BEST FANOUT route admits two disjoint implementation workers and a reviewer", async () => {
  const harness = createHarness();
  const transformed = await routePrompt(harness, "ROUTE_FANOUT: implement a complex multi-file feature");
  assert.match(transformed.text, /BEST ROUTE FANOUT/);
  assert.match(transformed.text, /<BEST_ROUTER_ROUTE>FANOUT<\/BEST_ROUTER_ROUTE>/);
  const agents = ["explore", "librarian", "openai-coder-1", "openai-coder-2"];
  const callIds = new Map();
  for (const agent of agents) {
    const callId = `fanout-${agent}`;
    await toolCall(harness, "task", { subagent_type: agent, run_in_background: true }, callId);
    callIds.set(agent, callId);
  }
  assert.equal((await toolCall(harness, "read", { path: "README.md" })).block, true);
  for (const agent of agents) await toolResult(harness, "task", {}, callIds.get(agent));
  const reviewerCallID = "fanout-openai-reviewer";
  await toolCall(harness, "task", { subagent_type: "openai-reviewer", run_in_background: true }, reviewerCallID);
  await toolResult(harness, "task", {}, reviewerCallID);
  assert.equal(await toolCall(harness, "read", { path: "README.md" }), undefined);
});

test("Native BEST re-arms delegation for a short continuation in the same session", async () => {
  const harness = createHarness("ses-native-followup");
  const initial = await routePrompt(harness, "ROUTE_FANOUT: implement the requested feature");
  assert.equal(initial.action, "transform");
  const initialAgents = ["explore", "librarian", "openai-coder-1", "openai-coder-2"];
  for (const agent of initialAgents) {
    const id = `initial-${agent}`;
    await toolCall(harness, "task", { subagent_type: agent, run_in_background: true }, id);
    await toolResult(harness, "task", {}, id);
  }
  const reviewerID = "initial-reviewer";
  await toolCall(harness, "task", { subagent_type: "openai-reviewer", run_in_background: true }, reviewerID);
  await toolResult(harness, "task", {}, reviewerID);

  const followup = await routePrompt(harness, "continua con la prossima parte");
  assert.equal(followup.action, "transform");
  assert.match(followup.text, /BEST ROUTE FANOUT/);
  assert.match(followup.text, /<BEST_ROUTER_ROUTE>FANOUT<\/BEST_ROUTER_ROUTE>/);
  assert.equal((await toolCall(harness, "edit", { path: "src/next.js" })).block, true);
});

test("Native BEST router blocks legacy delegation and unsafe recursive scans", async () => {
  const harness = createHarness("ses-native-safety");
  assert.equal((await toolCall(harness, "call_omo_agent", {})).block, true);
  const unsafe = await toolCall(harness, "bash", { command: "rg -a pattern ." });
  assert.equal(unsafe.block, true);
  assert.match(unsafe.reason, /unsafe binary-text recursive scan/i);
});

test("Native BEST router leaves ordinary prompts unmodified", async () => {
  const harness = createHarness("ses-native-direct");
  assert.deepEqual(await routePrompt(harness, "What does this one function do?"), { action: "continue" });
  assert.equal(await toolCall(harness, "read", { path: "README.md" }), undefined);
});
