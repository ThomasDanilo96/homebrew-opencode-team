import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROL_PROFILE,
  TREATMENT_PROFILE,
  buildRunMatrix,
  collectTelemetryFromRoot,
  defaultStartProfile,
  executeBenchmark,
  executeRun,
  loadSelection,
  normalizeGateEvidence,
  postPromptAndPoll,
  prepareRun,
  renderDryRunPlan,
  validateSelection,
  waitForRuntimeReady,
} from "../benchmarks/daily/execute.mjs";
import { loadManifest } from "../benchmarks/daily/runner.mjs";

const manifest = loadManifest();
const selection = loadSelection();
const matrix = () => buildRunMatrix({ manifest, selection, generation: 2 });
const byTask = (taskId, profile) => matrix().find((run) => run.task_id === taskId && run.profile === profile);
const fakeLifecycle = {
  setupProfile: async () => ({ status: "OK" }),
  startProfile: async () => ({ status: "OK" }),
  stopProfile: async () => ({ status: "OK" }),
};

test("execute dry-run renders the frozen 12-task and 24-profile-run matrix", async () => {
  const result = await executeBenchmark({ manifest, selection, generation: 2, dryRun: true });
  assert.equal(result.dry_run, true);
  assert.match(result.output, /LOGICAL_TASKS=12/);
  assert.match(result.output, /PROFILE_RUNS=24/);
  assert.match(result.output, /CONTROL=OPENAI/);
  assert.match(result.output, /TREATMENT=DAILY/);
  assert.match(result.output, /ORDER=fixed alternating order/);
  assert.match(result.output, /ISOLATED_FIXTURE_PER_RUN=true/);
  assert.match(result.output, /MODEL_CALLS=0/);
  assert.equal(result.output.split("\n").filter((line) => line.startsWith("TASK\t")).length, 12);
  assert.equal(result.output.split("\n").filter((line) => line.startsWith("RUN\t")).length, 24);
});

test("assignment metadata is profile-strict and rejects crossed control/treatment data", () => {
  const runs = matrix();
  assert.equal(runs[0].variant, "treatment");
  assert.equal(runs[0].profile, TREATMENT_PROFILE);
  assert.equal(runs[1].variant, "control");
  assert.equal(runs[1].profile, CONTROL_PROFILE);
  assert.equal(runs[2].variant, "control");
  assert.equal(runs[2].profile, CONTROL_PROFILE);
  assert.deepEqual(validateSelection(manifest, selection), []);
  assert.deepEqual(validateSelection(manifest, { ...selection, variant_mapping: { control: "DAILY", treatment: "OPENAI" } }), ["control_must_be_OPENAI", "treatment_must_be_DAILY"]);
});

test("real execution is gated behind --real", async () => {
  await assert.rejects(() => executeBenchmark({ manifest, selection, generation: 2 }), /real_execution_requires_--real/);
});

test("successful read-only run requires an empty fixture diff and writes bounded safe evidence", async () => {
  const outcome = await executeRun(byTask("lookup-routing-contract", TREATMENT_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      executeTask: async () => ({ success: true, required_checks: { answer_key: true }, secret_token: "sk-testsecret123456" }),
    },
  });
  try {
    assert.equal(outcome.result.success, true);
    assert.deepEqual(outcome.fixtureDiff, { changed: [], added: [], deleted: [], outside_fixture: [] });
    for (const name of ["metadata", "fixture-before", "fixture-after", "fixture-diff", "result", "telemetry", "gate-evidence", "runtime-summary"]) {
      assert.equal(existsSync(join(outcome.run.evidence_root, `${name}.json`)), true);
    }
    const metadata = readFileSync(join(outcome.run.evidence_root, "metadata.json"), "utf8");
    assert.doesNotMatch(metadata, new RegExp(outcome.run.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(metadata, /<run-root>/);
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("read-only task fails when the fixture changes and ignores outside-fixture files", async () => {
  const outcome = await executeRun(byTask("lookup-routing-contract", CONTROL_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      executeTask: async (run) => {
        writeFileSync(join(run.logs_root, "outside.log"), "not part of fixture\n");
        writeFileSync(join(run.fixture_root, "README.md"), "mutated\n");
        return { success: true, required_checks: { answer_key: true } };
      },
    },
  });
  try {
    assert.equal(outcome.result.success, false);
    assert.deepEqual(outcome.fixtureDiff.added, []);
    assert.deepEqual(outcome.fixtureDiff.deleted, []);
    assert.deepEqual(outcome.fixtureDiff.changed, ["README.md"]);
    assert.deepEqual(outcome.fixtureDiff.outside_fixture, []);
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("successful mutation run scores fixture after setup baseline", async () => {
  const outcome = await executeRun(byTask("one-line-doc-fix", CONTROL_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      setupProfile: async (run) => {
        writeFileSync(join(run.fixture_root, "setup-marker.txt"), "baseline\n");
        return { status: "OK" };
      },
      executeTask: async (run) => {
        writeFileSync(join(run.fixture_root, "README.md"), `${readFileSync(join(run.fixture_root, "README.md"), "utf8")}\nfixed\n`);
        return { success: true, required_checks: { exact_diff: true, git_diff_scope: true } };
      },
    },
  });
  try {
    assert.equal(outcome.result.success, true);
    assert.deepEqual(outcome.fixtureDiff.changed, ["README.md"]);
    assert.equal(outcome.fixtureDiff.added.includes("setup-marker.txt"), false);
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("partial and failure results normalize to unsuccessful authoritative records", async () => {
  const partial = await executeRun(byTask("two-file-feature", TREATMENT_PROFILE), {
    hooks: { ...fakeLifecycle, executeTask: async () => ({ success: true, partial: true }) },
  });
  const failure = await executeRun(byTask("two-file-feature", CONTROL_PROFILE), {
    hooks: { ...fakeLifecycle, executeTask: async () => ({ success: false, required_checks: { tests_pass: false, expected_files: true, git_diff_scope: true }, error_code: "CHECK_FAILED" }) },
  });
  try {
    assert.equal(partial.result.success, false);
    assert.equal(failure.result.success, false);
    assert.equal(failure.result.error_code, "CHECK_FAILED");
  } finally {
    rmSync(partial.run.root, { recursive: true, force: true });
    rmSync(failure.run.root, { recursive: true, force: true });
  }
});

test("runtime/auth failure and timeout are reported without broad process cleanup", async () => {
  const auth = await executeRun(byTask("security-policy-audit", CONTROL_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      startProfile: async () => { throw Object.assign(new Error("auth"), { code: "AUTH_FAILURE" }); },
      executeTask: async () => ({ success: true }),
    },
  });
  const stopped = [];
  const timeout = await executeRun(byTask("security-policy-audit", TREATMENT_PROFILE), {
    timeoutMs: 5,
    hooks: {
      ...fakeLifecycle,
      executeTask: async () => new Promise(() => {}),
      stopProfile: async (_run, _handle, reason) => {
        stopped.push(reason);
        return { status: "OK" };
      },
    },
  });
  try {
    assert.equal(auth.runtime.status, "AUTH_FAILURE");
    assert.equal(auth.result.error_code, "AUTH_FAILURE");
    assert.equal(timeout.runtime.status, "TIMEOUT");
    assert.equal(timeout.result.error_code, "TIMEOUT");
    assert.deepEqual(stopped, ["timeout"]);
  } finally {
    rmSync(auth.run.root, { recursive: true, force: true });
    rmSync(timeout.run.root, { recursive: true, force: true });
  }
});

test("failed shutdown is preserved in runtime summary while keeping result collection", async () => {
  const outcome = await executeRun(byTask("safe-helper-refactor", CONTROL_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      executeTask: async () => ({ success: true, required_checks: { before_after_behavior: true, tests_pass: true, git_diff_scope: true } }),
      stopProfile: async () => { throw Object.assign(new Error("stop"), { code: "STOP_FAILED" }); },
    },
  });
  try {
    assert.equal(outcome.result.success, true);
    assert.equal(outcome.runtime.stop_status, "FAILED");
    assert.equal(outcome.runtime.stop_error_code, "STOP_FAILED");
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("telemetry present includes packet/latency attribution and DAILY pricing; absent stays null", async () => {
  const present = await executeRun(byTask("state-machine-fix", TREATMENT_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      executeTask: async (run) => {
        mkdirSync(join(run.telemetry_root, "work-packets"), { recursive: true });
        mkdirSync(join(run.telemetry_root, "logs"), { recursive: true });
        writeFileSync(join(run.telemetry_root, "work-packets", "packet.json"), JSON.stringify({
          task_id: run.task_id,
          outcome: "completed",
          requested_model: "openai/gpt-5.6-luna",
          codex_input_tokens: 100,
          codex_cached_input_tokens: 20,
          opencode_input_tokens: 50,
          opencode_cached_input_tokens: 10,
          codex_output_tokens: 30,
          opencode_output_tokens: 5,
          codex_reasoning_tokens: 7,
          opencode_reasoning_tokens: 3,
        }));
        writeFileSync(join(run.telemetry_root, "logs", "latency-metrics.jsonl"), `${JSON.stringify({ task_id: run.task_id, duration_ms: 1234, retry_count: 2, tool_call_count: 4, compaction_count: 1, wrapper_round_trips: 3 })}\n`);
        return { success: true, required_checks: { tests_pass: true, transition_matrix: true, no_race_reported: true } };
      },
    },
  });
  const absent = collectTelemetryFromRoot({ task_id: "none", profile: CONTROL_PROFILE, root: present.run.root }, join(present.run.root, "missing-state"));
  try {
    assert.equal(present.result.duration_ms, 1234);
    assert.equal(present.result.uncached_input_tokens, 120);
    assert.equal(present.result.cached_input_tokens, 30);
    assert.equal(present.result.output_tokens, 35);
    assert.equal(present.result.reasoning_tokens, 10);
    assert.equal(present.result.retry_count, 2);
    assert.equal(present.result.tool_call_count, 4);
    assert.equal(present.result.compaction_count, 1);
    assert.equal(present.result.wrapper_round_trips, 3);
    assert.equal(present.telemetry.sources.duration_ms, "latency");
    assert.equal(present.telemetry.sources.uncached_input_tokens, "packet");
    assert.equal(present.telemetry.sources.cost, "https://platform.openai.com/docs/pricing");
    assert.equal(absent.metrics.uncached_input_tokens, null);
    assert.equal(absent.metrics.cost, null);
  } finally {
    rmSync(present.run.root, { recursive: true, force: true });
  }
});

test("gate evidence stays tri-state and skip classifications require explicit evidence", () => {
  assert.deepEqual(normalizeGateEvidence({}), {
    schema_version: 1,
    tester_required: null,
    tester_launched: null,
    tester_result: null,
    tester_skip_classification: null,
    review_required: null,
    review_result: null,
    review_skip_classification: null,
    gate_order_correct: null,
    final_success_only_after_required_gates: null,
    premature_finalization_classification: null,
    source: null,
  });
  assert.equal(normalizeGateEvidence({ tester_required: true, tester_launched: false }).tester_skip_classification, null);
  assert.equal(normalizeGateEvidence({ real_tester_skip: true }).tester_skip_classification, "REAL_TESTER_SKIP");
  assert.equal(normalizeGateEvidence({ real_review_skip: true }).review_skip_classification, "REAL_REVIEW_SKIP");
  assert.equal(normalizeGateEvidence({ real_premature_finalization: true }).premature_finalization_classification, "REAL_PREMATURE_FINALIZATION");
});

test("renderDryRunPlan is deterministic", () => {
  assert.equal(renderDryRunPlan({ manifest, selection, generation: 2 }), renderDryRunPlan({ manifest, selection, generation: 2 }));
});

test("default start discovers the profile runtime root using injected spawn and fetch", async () => {
  const run = prepareRun(byTask("lookup-routing-contract", TREATMENT_PROFILE));
  const spawned = [];
  try {
    const deps = {
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        const runtimeDir = join(run.home.root, "cache/runtime/daily/runs/abc12345");
        mkdirSync(runtimeDir, { recursive: true });
        writeFileSync(join(runtimeDir, "port"), "4567\n");
        writeFileSync(join(runtimeDir, "parent_session_id"), "ses_parent\n");
        writeFileSync(join(runtimeDir, "server.pid"), "4242\n");
        const child = new EventEmitter();
        child.pid = 4242;
        child.exitCode = null;
        child.signalCode = null;
        child.unref = () => {};
        return child;
      },
      fetch: async (url) => ({ ok: url === "http://127.0.0.1:4567/" }),
      sleep: async () => {},
    };
    const handle = await defaultStartProfile(run, deps);
    assert.equal(handle.status, "OK");
    assert.equal(handle.runtime.baseUrl, "http://127.0.0.1:4567");
    assert.equal(handle.runtime.parent_session_id, "ses_parent");
    assert.equal(spawned[0].args[0], "daily");
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.cwd, run.fixture_root);
    assert.equal(spawned[0].options.env.OPENCODE_TEAM_HOME, run.home.root);
    assert.equal(spawned[0].options.env.TEAM_RUNTIME_HEADLESS, "1");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("waitForRuntimeReady and prompt polling use injected fetch without model calls", async () => {
  const run = prepareRun(byTask("lookup-routing-contract", CONTROL_PROFILE));
  const runtimeDir = join(run.home.root, "cache/runtime/openai/runs/def67890");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "port"), "5678\n");
  writeFileSync(join(runtimeDir, "parent_session_id"), "ses_parent\n");
  writeFileSync(join(runtimeDir, "server.pid"), "4343\n");
  const calls = [];
  let posted = false;
  try {
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "http://127.0.0.1:5678/") return { ok: true, json: async () => ({}) };
      if (url.endsWith("/message")) return { ok: true, json: async () => posted ? [{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }] : [] };
      if (url.endsWith("/prompt_async")) {
        posted = true;
        const body = JSON.parse(options.body);
        assert.match(body.parts[0].text, /Objective:/);
        assert.match(body.parts[0].text, /Do not claim success from prose alone/);
        return { ok: true, json: async () => ({ accepted: true }) };
      }
      if (url.endsWith("/session/status")) return { ok: true, json: async () => ({ ses_parent: { type: "idle" } }) };
      throw new Error(`unexpected url: ${url}`);
    };
    const runtime = await waitForRuntimeReady(run, { fetch, sleep: async () => {} });
    const response = await postPromptAndPoll(runtime, "Objective:\ninspect\n\nDo not claim success from prose alone.", { fetch, sleep: async () => {} });
    assert.equal(response.status, "OK");
    assert.equal(response.after_count, 1);
    assert.equal(calls.some((call) => call.url.endsWith("/prompt_async") && call.options.method === "POST"), true);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
