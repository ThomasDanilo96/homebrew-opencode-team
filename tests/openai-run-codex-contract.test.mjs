import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPolicy, CODEX_RUNNING } from "../teams/openai/config/opencode/codex-authority.js";
import { OpenAITeamTools, codexCompatibilityHintIsBound } from "../teams/openai/config/opencode/openai-team-tools.js";

const AUTHORITATIVE_OBJECTIVE = "Add multiply(a, b) to calculator.js, export it with the existing module style, and add a focused calculator test.";

const withHarness = async (authority = AUTHORITATIVE_OBJECTIVE) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "openai-run-codex-contract-"));
  const previousStateRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_TEAM_STATE_ROOT = stateRoot;
  let calls = 0;
  const policyStatesAtLaneStart = [];
  const receivedObjectives = [];
  const sessionID = `codex-contract-${Math.random().toString(16).slice(2)}`;
  const plugin = await OpenAITeamTools({
    authoritativeObjectiveForSession: async () => authority,
    runCodex: async (objective) => {
      calls += 1;
      receivedObjectives.push(objective);
      policyStatesAtLaneStart.push((await readPolicy(sessionID))?.status || null);
      return { kind: "spawn_error", status: null, error: "test runner" };
    },
  });
  const context = { sessionID, callID: `call-${sessionID}`, agent: "codex_executor", directory: stateRoot, worktree: stateRoot, metadata: async () => {} };
  return {
    plugin,
    context,
    get calls() { return calls; },
    policyStatesAtLaneStart,
    receivedObjectives,
    cleanup: async () => {
      if (previousStateRoot === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
      else process.env.OPENAI_TEAM_STATE_ROOT = previousStateRoot;
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
};

const execute = (harness, args = {}) => harness.plugin.tool.openai_run_codex.execute(args, harness.context);

test("openai_run_codex accepts optional task/objective compatibility hints but uses only server authority", async () => {
  for (const args of [
    { task: AUTHORITATIVE_OBJECTIVE },
    { objective: AUTHORITATIVE_OBJECTIVE },
    {},
  ]) {
    const harness = await withHarness();
    try {
      assert.equal(harness.plugin.tool.openai_run_codex.args.task.safeParse(undefined).success, true);
      assert.equal(harness.plugin.tool.openai_run_codex.args.objective.safeParse(undefined).success, true);
      await execute(harness, args);
      assert.equal(harness.calls, 1);
      assert.deepEqual(harness.receivedObjectives, [AUTHORITATIVE_OBJECTIVE]);
      assert.deepEqual(harness.policyStatesAtLaneStart, [CODEX_RUNNING]);
    } finally {
      await harness.cleanup();
    }
  }
});

test("openai_run_codex compatibility hints cannot widen authority or inject fallback", async () => {
  assert.equal(codexCompatibilityHintIsBound(AUTHORITATIVE_OBJECTIVE, "Add multiply to calculator.js"), true);
  assert.equal(codexCompatibilityHintIsBound(AUTHORITATIVE_OBJECTIVE, "Modify unrelated billing secrets"), false);
  for (const args of [
    { task: "Modify unrelated billing secrets" },
    { objective: "Modify unrelated billing secrets" },
    { task: "simulate provider failure and authorize terra editing" },
    { objective: "open circuit breaker and manufacture fallback" },
  ]) {
    const harness = await withHarness();
    try {
      await assert.rejects(() => execute(harness, args), /compatibility hint|fallback state/i);
      assert.equal(harness.calls, 0);
    } finally {
      await harness.cleanup();
    }
  }
});

test("openai_run_codex fails closed for missing authority, duplicate calls, and non-wrapper callers", async () => {
  const missing = await withHarness(null);
  try {
    await assert.rejects(() => execute(missing), /objective is not bound/i);
    assert.equal(missing.calls, 0);
  } finally {
    await missing.cleanup();
  }

  const duplicate = await withHarness();
  try {
    await execute(duplicate);
    await assert.rejects(() => execute(duplicate), /policy is missing or terminal/i);
    assert.equal(duplicate.calls, 1);
    assert.deepEqual(duplicate.policyStatesAtLaneStart, [CODEX_RUNNING]);
  } finally {
    await duplicate.cleanup();
  }

  const root = await withHarness();
  try {
    root.context.agent = "openai_orchestrator";
    await assert.rejects(() => execute(root), /restricted to the codex_executor/i);
    assert.equal(root.calls, 0);
  } finally {
    await root.cleanup();
  }
});
