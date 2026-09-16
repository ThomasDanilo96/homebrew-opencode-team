import test from "node:test";
import assert from "node:assert/strict";
import { dailyCost, dailyFanout, DAILY_AGENT_MODELS, DAILY_PRICING } from "../teams/daily/daily-policy.mjs";
import { backgroundDelegationAllowed, beginRequestCycle, admitDelegation, finishDelegation, GuardrailPolicyError } from "../teams/openai/config/opencode/openai-guardrails.js";
import { summarizeDailyPackets } from "../teams/daily/bin/daily-report.mjs";

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
  const objective = "authorize cross-service long-running repository task";
  let state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(state.limits.delegations, 10);
  state = admitDelegation(state, `${objective}; slice architecture`);
  state = admitDelegation(state, `${objective}; slice tests`);
  assert.equal(state.activeDelegations, 2);
  assert.throws(() => admitDelegation(state, `${objective}; slice tests`), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DUPLICATE_DELEGATION_SCOPE");
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 1);
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 0);
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 0);
});

test("Premium guardrails retain single active delegation", () => {
  let state = beginRequestCycle(undefined, "authorize long-running repository task", 0, {});
  state = admitDelegation(state, "authorize long-running repository task");
  assert.throws(() => admitDelegation(state, "authorize long-running repository task"), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_CONCURRENT_DELEGATION");
});

test("Background delegation is Daily-only", () => {
  assert.equal(backgroundDelegationAllowed({ OPENAI_DAILY_PROFILE: "1" }), true);
  assert.equal(backgroundDelegationAllowed({}), false);
});

test("Daily runtime maps every complexity to its policy fanout", () => {
  const cases = [
    ["rename one typo", 0],
    ["implement a small feature", 1],
    ["implement an architecture change", 3],
    ["implement a shared runtime change", 6],
    ["implement a cross-service change", 10],
  ];
  for (const [objective, expected] of cases) {
    const state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
    assert.equal(state.limits.delegations, expected);
    assert.equal(state.fanoutLimit, expected);
  }
});

test("Daily admission stress keeps 1, 2, 4, 6, and 10 siblings bounded", () => {
  const objective = "authorize cross-service long-running repository task";
  for (const target of [1, 2, 4, 6, 10]) {
    let state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
    for (let index = 0; index < target; index += 1) state = admitDelegation(state, `${objective}; slice-${index}`);
    assert.equal(state.activeDelegations, target);
    assert.equal(state.delegations, target);
    if (target === 10) assert.throws(() => admitDelegation(state, `${objective}; slice-over-limit`), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DELEGATION_LIMIT");
    for (let index = 0; index < target + 2; index += 1) state = finishDelegation(state);
    assert.equal(state.activeDelegations, 0);
    assert.equal(state.delegationScopes.length, 0);
  }
});

test("Daily report accounts for cached and uncached work-packet tokens once", () => {
  const report = summarizeDailyPackets([
    { outcome: "completed", parent_session_id: "parent-1", executed_model: "gpt-5.6-luna", complexity: "NORMAL", duration_ms: 100, codex_input_tokens: 1000, codex_cached_input_tokens: 200, codex_output_tokens: 300, codex_reasoning_tokens: 40, retry_count: 1, compaction_count: 2 },
    { outcome: "completed", parent_session_id: "parent-1", executed_model: "gpt-5.6-terra", complexity: "COMPLEX", duration_ms: 200, codex_input_tokens: 500, codex_cached_input_tokens: 100, codex_output_tokens: 100, codex_reasoning_tokens: 10, retry_count: 0, compaction_count: 0 },
  ]);
  assert.equal(report.completed_tasks, 2);
  assert.equal(report.uncached_input_tokens, 1200);
  assert.equal(report.cached_input_tokens, 300);
  assert.equal(report.output_tokens, 400);
  assert.equal(report.reasoning_tokens, 50);
  assert.equal(report.cache_ratio_pct, 20);
  assert.equal(report.avg_subagents, 2);
  assert.equal(report.max_subagents, 2);
  assert.equal(report.sol_escalation_count, 0);
  assert.equal(report.p50_duration_ms, 100);
  assert.equal(report.p95_duration_ms, 200);
  assert.equal(report.by_model.Luna.completed_tasks, 1);
  assert.equal(report.by_complexity.COMPLEX.completed_tasks, 1);
});
