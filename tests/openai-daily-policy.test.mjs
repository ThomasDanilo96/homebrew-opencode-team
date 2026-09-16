import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dailyCost, dailyFanout, DAILY_AGENT_MODELS, DAILY_PRICING } from "../teams/daily/daily-policy.mjs";
import { backgroundDelegationAllowed, beginRequestCycle, admitDelegation, admitToolCall, createGuardrailState, finishDelegation, GuardrailPolicyError, preserveChildGuardState, recoverRootRequestState, updateStopLatch } from "../teams/openai/config/opencode/openai-guardrails.js";
import { summarizeDailyPackets } from "../teams/daily/bin/daily-report.mjs";
import { analyzeObjective, routeDelegatedAgent, selectAuthoritativeObjective } from "../teams/openai/config/opencode/openai-routing.js";
import { OpenAIAuthorshipGuard } from "../teams/openai/config/opencode/openai-authorship-guard.js";
import { latestUserObjective, resolveInitialObjectiveFromClient } from "../teams/openai/config/opencode/openai-team-tools.js";

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

test("Routing ignores explicitly negated mutations without hiding genuine mutations", () => {
  assert.equal(analyzeObjective("Read only README.md line 3. Do not modify anything and do not call task.").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not analyze, modify the file").classification, "MUTATING");
  assert.equal(analyzeObjective("Do not modify or delete files; review them").classification, "READ_ONLY");
  assert.equal(analyzeObjective("Do not modify and delete files; review them").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not modify and then delete the file").classification, "MUTATING");
  assert.equal(analyzeObjective("Don’t modify files").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not ever modify files").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not modify files, but delete the file").classification, "MUTATING");
  assert.equal(analyzeObjective("do not modify files; then delete the file").classification, "MUTATING");
});

test("Serena project activation is read-only for the authorship guard", async () => {
  const guard = await OpenAIAuthorshipGuard();
  await assert.doesNotReject(() => guard["tool.execute.before"]({
    agent: "openai_orchestrator", sessionID: "serena-read-only-test", tool: "serena_activate_project",
  }, { args: {} }));
});

test("Child review wording cannot override an explicitly requested read-only agent", () => {
  assert.equal(routeDelegatedAgent("Inspect the fixture structure", "Review the fixture structure", "openai_explore").agent, "openai_explore");
  assert.equal(routeDelegatedAgent("Review the fixture structure", "Review the fixture structure", "openai_explore").agent, "reviewer");
  assert.equal(routeDelegatedAgent("Critical security review of the fixture", "Review the fixture structure", "openai_explore").agent, "reviewer_critical");
  assert.equal(routeDelegatedAgent("Inspect the fixture structure", "Review the fixture structure", "reviewer").agent, "reviewer");
  assert.equal(routeDelegatedAgent("Inspect the fixture structure", "Modify the fixture", "openai_explore").agent, "codex_executor");
});

test("Routing uses the current request objective instead of an older session turn", () => {
  assert.equal(selectAuthoritativeObjective("Inspect the fixture structure", "Review the old implementation"), "Inspect the fixture structure");
  assert.equal(selectAuthoritativeObjective("Review the current implementation", "Inspect the old fixture"), "Review the current implementation");
  assert.equal(routeDelegatedAgent(selectAuthoritativeObjective("Inspect the fixture", "Review the old implementation"), "Review the fixture", "openai_explore").agent, "openai_explore");
  assert.equal(routeDelegatedAgent(selectAuthoritativeObjective("Review the current implementation", "Inspect the old fixture"), "Inspect the implementation", "openai_explore").agent, "reviewer");
});

test("Guardrail authority survives operational sequential cycles and terminal verification", () => {
  const user = beginRequestCycle(undefined, "Inspect the fixture", 1);
  const sequential = beginRequestCycle({ ...user, delegations: 1 }, "Review the fixture", 2, process.env, { preserveVerificationTerminal: true });
  assert.equal(sequential.objective, "Review the fixture");
  assert.equal(sequential.authoritativeObjective, "Inspect the fixture");
  assert.deepEqual(beginRequestCycle({ ...user, verificationTerminal: true }, "Review the fixture", 2, process.env, { preserveVerificationTerminal: true }), { ...user, verificationTerminal: true });
  const reviewed = beginRequestCycle(undefined, "Review the fixture", 3);
  assert.equal(reviewed.authoritativeObjective, "Review the fixture");
});

test("Objective recovery selects the latest root user message and safely follows resumed parents", async () => {
  const sessions = {
    root: { id: "root", parentID: null },
    child: { id: "child", parentID: "root" },
  };
  const messages = {
    root: [
      { info: { role: "user" }, parts: [{ type: "text", text: "Inspect the old fixture" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "Review the current fixture" }] },
    ],
    child: [{ info: { role: "user" }, parts: [{ type: "text", text: "Review synthetic child prompt" }] }],
  };
  const client = { session: {
    get: async ({ path: { id } }) => ({ data: sessions[id] }),
    messages: async ({ path: { id } }) => ({ data: messages[id] }),
  } };
  assert.equal(latestUserObjective(messages.root), "Review the current fixture");
  const resolved = await resolveInitialObjectiveFromClient(client, "child");
  assert.deepEqual(resolved, { objective: "Review the current fixture", parentSessionID: "root", rootSessionID: "root" });
});

test("Objective recovery falls back on lookup failure and breaks parent loops", async () => {
  const failing = { session: { get: async () => { throw new Error("unavailable"); }, messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "Review synthetic child" }] }] }) } };
  assert.equal(await resolveInitialObjectiveFromClient(failing, "child"), null);
  const loop = { session: { get: async ({ path: { id } }) => ({ data: { id, parentID: id === "a" ? "b" : "a" } }), messages: async ({ path: { id } }) => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: `Inspect ${id}` }] }] }) } };
  assert.equal(await resolveInitialObjectiveFromClient(loop, "a"), null);
  assert.equal(routeDelegatedAgent(null, "Review synthetic child", "openai_explore").agent, "openai_explore");
});

test("Objective recovery has fresh per-call root reads", async () => {
  let current = "Inspect the fixture";
  const client = { session: {
    get: async () => ({ data: { id: "root", parentID: null } }),
    messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: current }] }] }),
  } };
  assert.equal((await resolveInitialObjectiveFromClient(client, "root")).objective, "Inspect the fixture");
  current = "Review the fixture";
  assert.equal((await resolveInitialObjectiveFromClient(client, "root")).objective, "Review the fixture");
});

test("Synthetic child messages preserve the inherited guard without resuming it", () => {
  const root = { ...beginRequestCycle(undefined, "Inspect the fixture", 1), activeDelegation: true, activeDelegations: 1, toolCalls: 7, weightedUnits: 8, stopped: true, verificationTerminal: true };
  const child = preserveChildGuardState(beginRequestCycle(undefined, "Review synthetic child", 2), root, "Inspect the fixture");
  assert.equal(child.activeDelegation, true);
  assert.equal(child.activeDelegations, 1);
  assert.equal(child.toolCalls, 7);
  assert.equal(child.weightedUnits, 8);
  assert.equal(child.stopped, true);
  assert.equal(child.verificationTerminal, true);
  assert.equal(child.authoritativeObjective, "Inspect the fixture");
  assert.equal(child.stopped, true);
  assert.equal(updateStopLatch(beginRequestCycle({ ...root, verificationTerminal: false }, "Inspect the fixture", 3), "Continue", true).stopped, false);
});

test("Cold child state remains the local monotonic base", () => {
  const root = { ...beginRequestCycle(undefined, "Inspect the fixture", 1), stopped: false, authoritativeObjective: "Inspect the fixture" };
  const coldChild = { ...beginRequestCycle(undefined, "Review synthetic child", 2), stopped: true, budgetTerminal: true, toolCalls: 9, weightedUnits: 11, authoritativeObjective: null };
  const merged = preserveChildGuardState(coldChild, root, "Inspect the fixture");
  assert.equal(merged.stopped, true);
  assert.equal(merged.budgetTerminal, true);
  assert.equal(merged.toolCalls, 9);
  assert.equal(merged.weightedUnits, 11);
  assert.equal(merged.authoritativeObjective, "Inspect the fixture");
  const rootStopped = preserveChildGuardState({ ...coldChild, stopped: false }, { ...root, stopped: true }, "Inspect the fixture");
  assert.equal(rootStopped.stopped, true);
});

test("Cold child delegation marker is internally consistent", () => {
  const merged = preserveChildGuardState(
    { ...beginRequestCycle(undefined, "Inspect child", 1), activeDelegations: 0, activeDelegation: false },
    { ...beginRequestCycle(undefined, "Inspect root", 1), activeDelegations: 0, activeDelegation: false },
    "Inspect root",
  );
  assert.equal(merged.activeDelegations, 1);
  assert.equal(merged.activeDelegation, true);
  assert.throws(() => admitDelegation(merged, "Inspect root", { review: false }), /CONCURRENT_DELEGATION/);

  const normal = beginRequestCycle(undefined, "Inspect normally", 1);
  assert.equal(normal.activeDelegation, false);
  assert.equal(admitDelegation(normal, "Inspect normally").activeDelegation, true);
});

test("OpenCode path plugins expose ids on their default objects", async () => {
  for (const [file, id, server] of [
    ["../teams/openai/config/opencode/openai-team-tools.js", "openai-team-tools", "OpenAITeamTools"],
    ["../teams/openai/config/opencode/openai-authorship-guard.js", "openai-authorship-guard", "OpenAIAuthorshipGuard"],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, new RegExp(`export default \\{ id: "${id}", server: ${server} \\};`));
    assert.doesNotMatch(source, new RegExp(`export const id = "${id}"`));
  }
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

test("Recovered Daily HEAVY root objective admits six delegations", () => {
  let state = recoverRootRequestState(createGuardrailState({}, 0), "implement a shared runtime change", 0, { OPENAI_DAILY_PROFILE: "1" });
  state = admitToolCall(state, "task", 1);
  assert.equal(state.limits.delegations, 6);
  for (let index = 0; index < 6; index += 1) state = admitDelegation(state, `implement a shared runtime change; slice-${index}`);
  assert.equal(state.delegations, 6);
});

test("Late root recovery preserves consumed and terminal state", () => {
  const state = recoverRootRequestState({ ...createGuardrailState({}, 100), toolCalls: 9, weightedUnits: 12, delegations: 2, activeDelegations: 2, activeDelegation: true, delegationScopes: ["existing"], stopped: true, budgetTerminal: true, verificationTerminal: true }, "implement a shared runtime change", 200, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(state.startedAt, 100);
  assert.equal(state.toolCalls, 9);
  assert.equal(state.weightedUnits, 12);
  assert.equal(state.delegations, 2);
  assert.equal(state.activeDelegations, 2);
  assert.equal(state.activeDelegation, true);
  assert.deepEqual(state.delegationScopes, ["existing"]);
  assert.equal(state.limits.delegations, 6);
  assert.equal(state.stopped, true);
  assert.equal(state.budgetTerminal, true);
  assert.equal(state.verificationTerminal, true);
});

test("Recovered child guard stays active without starting a fresh budget", () => {
  const root = { ...beginRequestCycle(createGuardrailState(), "implement a shared runtime change", 10, { OPENAI_DAILY_PROFILE: "1" }), activeDelegations: 2, activeDelegation: true, toolCalls: 4, weightedUnits: 6 };
  const child = preserveChildGuardState(beginRequestCycle(createGuardrailState(), "child slice", 100, { OPENAI_DAILY_PROFILE: "1" }), root, "implement a shared runtime change");
  assert.equal(child.activeDelegation, true);
  assert.equal(child.startedAt, 10);
  assert.equal(child.toolCalls, 4);
  assert.equal(child.weightedUnits, 6);
});

test("Unresolved objective remains fail-closed without review or extra budget", () => {
  const state = createGuardrailState({}, 0);
  assert.equal(state.authoritativeObjective, null);
  assert.deepEqual(state.limits, { minutes: 15, toolCalls: 20, delegations: 1 });
  assert.throws(() => admitDelegation(state, "review the repository", { review: true }), /OBJECTIVE_UNBOUND/);
});

test("Recovered root objective leaves premium limits unchanged", () => {
  const state = beginRequestCycle(createGuardrailState(), "implement an architecture change", 0, {});
  assert.equal(state.limits.delegations, 2);
  assert.equal(state.limits.minutes, 45);
  assert.equal(state.limits.toolCalls, 50);
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
