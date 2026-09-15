import test from "node:test";
import assert from "node:assert/strict";
import { dailyCost, dailyFanout, DAILY_AGENT_MODELS, DAILY_PRICING } from "../teams/daily/daily-policy.mjs";
import { beginRequestCycle, admitDelegation, finishDelegation, GuardrailPolicyError } from "../teams/openai/config/opencode/openai-guardrails.js";

test("Daily uses OpenAI-only model tiers", () => {
  assert.equal(DAILY_AGENT_MODELS.openai_orchestrator, "openai/gpt-5.6-luna");
  assert.equal(DAILY_AGENT_MODELS.reviewer, "openai/gpt-5.6-terra");
  assert.equal(DAILY_AGENT_MODELS.reviewer_critical, "openai/gpt-5.6-sol");
  assert.ok(Object.values(DAILY_AGENT_MODELS).every((model) => model.startsWith("openai/")));
});

test("Daily fanout is bounded and complexity-aware", () => {
  assert.deepEqual([dailyFanout("TRIVIAL"), dailyFanout("NORMAL"), dailyFanout("COMPLEX"), dailyFanout("HEAVY"), dailyFanout("EXTREME")], [0, 1, 3, 6, 10]);
});

test("Daily pricing is optional observability math", () => {
  assert.equal(dailyCost({ model: "gpt-5.6-luna", input: 4000, cached: 0, output: 1000 }), 0.002);
  assert.equal(dailyCost({ model: "unknown", input: 4000, cached: 0, output: 1000 }), null);
  assert.equal(DAILY_PRICING.effective_date, "2026-09-16");
});

test("Daily guardrails allow bounded concurrent delegation", () => {
  let state = beginRequestCycle(undefined, "authorize long-running repository task", 0, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(state.limits.delegations, 10);
  state = admitDelegation(state, "authorize long-running repository task");
  state = admitDelegation(state, "authorize long-running repository task");
  assert.equal(state.activeDelegations, 2);
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 1);
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 0);
});

test("Premium guardrails retain single active delegation", () => {
  let state = beginRequestCycle(undefined, "authorize long-running repository task", 0, {});
  state = admitDelegation(state, "authorize long-running repository task");
  assert.throws(() => admitDelegation(state, "authorize long-running repository task"), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_CONCURRENT_DELEGATION");
});
