import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBestNativeRouter } from "../teams/best/best-native-router.mjs";

function createHarness(sessionID = "ses-native-test") {
  const handlers = new Map();
  createBestNativeRouter({ logger: () => {} })({ on: (event, handler) => handlers.set(event, handler) });
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
  const logs = mkdtempSync(join(tmpdir(), "best-native-router-"));
  const oldLog = process.env.BEST_ROUTER_LOG;
  process.env.BEST_ROUTER_LOG = join(logs, "router.jsonl");
  try {
    const harness = createHarness();
    const transformed = await routePrompt(harness, "Implement a multi-file feature across the repository and test the workflow");
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
  } finally {
    if (oldLog === undefined) delete process.env.BEST_ROUTER_LOG;
    else process.env.BEST_ROUTER_LOG = oldLog;
    rmSync(logs, { recursive: true, force: true });
  }
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
