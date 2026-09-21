import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PROFILE,
  TREATMENT_PROFILE,
  buildRunEnv,
  buildRunMatrix,
  collectTelemetryFromRoot,
  defaultStartProfile,
  executeBenchmark,
  executeRun,
  loadSelection,
  normalizeGateEvidence,
  normalizeExecutionResult,
  postPromptAndPoll,
  prepareRun,
  renderDryRunPlan,
  validateSelection,
  waitForRuntimeReady,
} from "../benchmarks/daily/execute.mjs";
import { classifyFixtureDiff, evaluateRun } from "../benchmarks/daily/evaluate.mjs";
import { atomicWriteFile, loadCheckpoint } from "../benchmarks/daily/checkpoint.mjs";
import { loadManifest } from "../benchmarks/daily/runner.mjs";

const manifest = loadManifest();
const selection = loadSelection();
const matrix = () => buildRunMatrix({ manifest, selection, generation: 2 });
const byTask = (taskId, profile) => matrix().find((run) => run.task_id === taskId && run.profile === profile);

test("isolated runtime bridges default host auth sources without copying credentials", () => {
  const run = prepareRun(byTask("lookup-routing-contract", CONTROL_PROFILE));
  const env = buildRunEnv(run, {}, { HOME: process.env.HOME });
  assert.equal(env.OPENCODE_AUTH_SOURCE, join(process.env.HOME, ".local/share/opencode/auth.json"));
  assert.equal(env.OPENAI_CODEX_AUTH_SOURCE, join(process.env.HOME, ".codex/auth.json"));
  assert.equal(env.OPENCODE_TEAM_HOME, run.home.root);
  rmSync(run.root, { recursive: true, force: true });
});

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
    assert.deepEqual(outcome.fixtureDiff.task_relevant, { changed: [], added: [], deleted: [], outside_fixture: [] });
    assert.deepEqual(outcome.fixtureDiff.raw, { changed: [], added: [], deleted: [], outside_fixture: [] });
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
    assert.deepEqual(outcome.fixtureDiff.task_relevant.added, []);
    assert.deepEqual(outcome.fixtureDiff.task_relevant.deleted, []);
    assert.deepEqual(outcome.fixtureDiff.task_relevant.changed, ["README.md"]);
    assert.deepEqual(outcome.fixtureDiff.task_relevant.outside_fixture, []);
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
    assert.deepEqual(outcome.fixtureDiff.task_relevant.changed, ["README.md"]);
    assert.equal(outcome.fixtureDiff.task_relevant.added.includes("setup-marker.txt"), false);
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("startup-generated Serena files belong to the task baseline, not the task diff", async () => {
  const outcome = await executeRun(byTask("one-line-doc-fix", CONTROL_PROFILE), {
    startupSettleIntervalMs: 0,
    hooks: {
      ...fakeLifecycle,
      startProfile: async (run) => {
        mkdirSync(join(run.fixture_root, ".serena"), { recursive: true });
        for (const file of [".gitignore", "project.yml", "project.local.yml"]) writeFileSync(join(run.fixture_root, ".serena", file), "startup\n");
        return { status: "OK" };
      },
      executeTask: async (run) => {
        writeFileSync(join(run.fixture_root, "README.md"), readFileSync(join(run.fixture_root, "README.md"), "utf8").replace("recieve", "receive"));
        return {};
      },
    },
  });
  try {
    assert.equal(outcome.result.success, true);
    assert.deepEqual(outcome.fixtureDiff.task_relevant, { changed: ["README.md"], added: [], deleted: [], outside_fixture: [] });
    const baseline = JSON.parse(readFileSync(join(outcome.run.evidence_root, "fixture-before.json"), "utf8"));
    assert.equal(Object.hasOwn(baseline.files, ".serena/project.yml"), true);
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("startup settle waits for asynchronous fixture initialization before the prompt", async () => {
  const events = [];
  let startupFixtureRoot;
  const outcome = await executeRun(byTask("one-line-doc-fix", CONTROL_PROFILE), {
    startupSettleIntervalMs: 0,
    hooks: {
      ...fakeLifecycle,
      startProfile: async (run) => {
        startupFixtureRoot = run.fixture_root;
        return { status: "OK" };
      },
      sleep: async (_ms) => {
        events.push("startup-settle");
        if (events.length === 1) {
          mkdirSync(join(startupFixtureRoot, ".serena"), { recursive: true });
          writeFileSync(join(startupFixtureRoot, ".serena", "project.yml"), "startup\n");
        }
      },
      executeTask: async (run) => {
        assert.equal(existsSync(join(run.evidence_root, "fixture-before.json")), true);
        events.push("prompt");
        return { required_checks: { exact_diff: true, git_diff_scope: true } };
      },
    },
  });
  try {
    assert.equal(outcome.result.success, true);
    assert.deepEqual(outcome.fixtureDiff.task_relevant.added, []);
    assert.equal(events.at(-1), "prompt");
    assert.ok(events.indexOf("startup-settle") < events.indexOf("prompt"));
  } finally {
    rmSync(outcome.run.root, { recursive: true, force: true });
  }
});

test("unstable startup fails before prompt delivery", async () => {
  const runPlan = byTask("lookup-routing-contract", CONTROL_PROFILE);
  let tick = 0;
  let promptCalled = false;
  let currentRunRoot;
  const outcome = await executeRun(runPlan, {
    startupSettleIntervalMs: 0,
    startupSettleTimeoutMs: 3,
    hooks: {
      ...fakeLifecycle,
      now: () => ++tick,
      startProfile: async (run) => {
        currentRunRoot = run.fixture_root;
        return { status: "OK" };
      },
      sleep: async () => {
        const file = join(".serena", `unstable-${tick}.yml`);
        mkdirSync(join(currentRunRoot, ".serena"), { recursive: true });
        writeFileSync(join(currentRunRoot, file), "unstable\n");
      },
      executeTask: async () => {
        promptCalled = true;
        return { required_checks: { answer_key: true } };
      },
    },
  });
  try {
    assert.equal(promptCalled, false);
    assert.equal(outcome.result.error_code, "INFRA_FAILURE");
    assert.equal(outcome.runtime.failure_reason, "STARTUP_FIXTURE_NOT_STABLE");
    assert.equal(outcome.runtime.model_call_started, false);
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

test("failed shutdown becomes INFRA_FAILURE after result collection", async () => {
  const outcome = await executeRun(byTask("safe-helper-refactor", CONTROL_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      executeTask: async () => ({ success: true, required_checks: { before_after_behavior: true, tests_pass: true, git_diff_scope: true } }),
      stopProfile: async () => { throw Object.assign(new Error("stop"), { code: "STOP_FAILED" }); },
    },
  });
  try {
    assert.equal(outcome.result.success, false);
    assert.equal(outcome.result.error_code, "INFRA_FAILURE");
    assert.equal(outcome.runtime.status, "INFRA_FAILURE");
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
        writeFileSync(join(run.telemetry_root, "logs", "latency-metrics.jsonl"), `${JSON.stringify({ task_id: run.task_id, model: "gpt-5.6-luna", duration_ms: 1234, retry_count: 2, tool_call_count: 4, compaction_count: 1, wrapper_round_trips: 3 })}\n`);
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
    assert.equal(present.result.raw_metrics.wall_clock_ms, 1234);
    assert.deepEqual(present.result.raw_metrics.model_mix, { Luna: 1, Terra: 0, Sol: 0, other: 0 });
    assert.equal(present.result.provider_reported_cost, null);
    assert.equal(present.result.estimated_cost, 0.000067);
    assert.equal(present.result.cost, 0.000067);
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

test("model mix counts observed models, preserves unknowns, and deduplicates correlated records", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-model-mix-test-"));
  const logs = join(root, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "latency-metrics.jsonl"), [
    { model: "openai/gpt-5.6-luna", request_id: "luna-1" },
    { model: "gpt-5.6-luna", request_id: "luna-1" },
    { model: "gpt-5.6-terra", request_id: "terra-1" },
    { model: "gpt-5.6-sol", request_id: "sol-1" },
    { model: "vendor/future-model", request_id: "unknown-1" },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  try {
    const telemetry = collectTelemetryFromRoot({ task_id: "lookup-routing-contract" }, root);
    assert.deepEqual(telemetry.model_mix, { Luna: 1, Terra: 1, Sol: 1, other: 1 });
    const normalized = normalizeExecutionResult({
      run: byTask("lookup-routing-contract", TREATMENT_PROFILE),
      rawResult: { success: true },
      telemetry,
      gateEvidence: {},
      fixtureDiff: { changed: [], added: [], deleted: [], outside_fixture: [] },
      durationMs: 50,
      taskDurationMs: null,
      modelCallStarted: true,
    });
    assert.deepEqual(normalized.raw_metrics.model_mix, telemetry.model_mix);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing authoritative task duration remains null in normalized wall clock", () => {
  const normalized = normalizeExecutionResult({
    run: byTask("lookup-routing-contract", CONTROL_PROFILE),
    rawResult: { success: true },
    telemetry: { metrics: {}, model_mix: { Luna: 1, Terra: 0, Sol: 0, other: 0 } },
    gateEvidence: {},
    fixtureDiff: { changed: [], added: [], deleted: [], outside_fixture: [] },
    durationMs: null,
    taskDurationMs: null,
    modelCallStarted: true,
  });
  assert.equal(normalized.raw_metrics.wall_clock_ms, null);
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

test("prompt polling skips empty intermediate assistant messages", async () => {
  const run = prepareRun(byTask("lookup-routing-contract", CONTROL_PROFILE));
  let messageCalls = 0;
  try {
    const fetch = async (url) => {
      if (url.endsWith("/message")) {
        messageCalls += 1;
        return {
          ok: true,
          json: async () => messageCalls === 1
            ? []
            : messageCalls === 2
            ? [{ info: { role: "assistant" }, parts: [] }]
            : [{ info: { role: "assistant" }, parts: [{ type: "text", text: "final answer" }] }],
        };
      }
      if (url.endsWith("/prompt_async")) return { ok: true, json: async () => ({ accepted: true }) };
      if (url.endsWith("/session/status")) return { ok: true, json: async () => ({ ses_parent: { type: "unknown" } }) };
      throw new Error(`unexpected url: ${url}`);
    };
    const response = await postPromptAndPoll({ baseUrl: "http://127.0.0.1:5678", parent_session_id: "ses_parent" }, "Objective", { fetch, sleep: async () => {} });
    assert.equal(response.assistant.parts[0].text, "final answer");
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("evaluator returns deterministic PASS, PARTIAL, FAIL and rejects unknown labels", () => {
  const run = prepareRun(byTask("lookup-routing-contract", TREATMENT_PROFILE));
  try {
    const cleanDiff = { raw: { changed: [], added: [], deleted: [], outside_fixture: [] }, task_relevant: { changed: [], added: [], deleted: [], outside_fixture: [] }, ignored_runtime_generated: [] };
    const pass = evaluateRun({ run, rawResult: { required_checks: { answer_key: true } }, gateEvidence: {}, fixtureDiff: cleanDiff });
    assert.equal(pass.outcome, "PASS");
    const partial = evaluateRun({ run, rawResult: { response_text: "openai/gpt-5.6-luna only" }, gateEvidence: {}, fixtureDiff: cleanDiff });
    assert.equal(partial.outcome, "PARTIAL");
    const fail = evaluateRun({ run, rawResult: {}, gateEvidence: {}, fixtureDiff: { ...cleanDiff, task_relevant: { changed: ["README.md"], added: [], deleted: [], outside_fixture: [] } } });
    assert.equal(fail.outcome, "FAIL");
    assert.throws(() => evaluateRun({ run: { ...run, verification: ["mystery_label"] }, rawResult: {}, gateEvidence: {}, fixtureDiff: cleanDiff }), /unknown_verification_label:mystery_label/);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("exact README diff is deterministic and answer-key tasks remain read-only", async () => {
  const mutation = await executeRun(byTask("one-line-doc-fix", CONTROL_PROFILE), {
    hooks: {
      ...fakeLifecycle,
      executeTask: async (run) => {
        writeFileSync(join(run.fixture_root, "README.md"), readFileSync(join(run.fixture_root, "README.md"), "utf8").replace("recieve", "receive"));
        return {};
      },
    },
  });
  const readOnly = await executeRun(byTask("lookup-routing-contract", CONTROL_PROFILE), {
    hooks: { ...fakeLifecycle, executeTask: async () => ({ required_checks: { answer_key: true } }) },
  });
  try {
    assert.equal(mutation.result.required_checks.exact_diff, true);
    assert.equal(mutation.result.required_checks.git_diff_scope, true);
    assert.equal(mutation.result.success, true);
    assert.equal(readOnly.result.required_checks.no_files_changed, true);
    assert.equal(readOnly.result.success, true);
  } finally {
    rmSync(mutation.run.root, { recursive: true, force: true });
    rmSync(readOnly.run.root, { recursive: true, force: true });
  }
});

test("runtime continuation JSON is excluded only as exact regular benchmark-generated files", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-runtime-exclusion-"));
  try {
    const continuation = join(root, ".omo/run-continuation");
    mkdirSync(continuation, { recursive: true });
    const createdAt = Date.now();
    writeFileSync(join(continuation, "ses_test.json"), "{}\n");
    const classified = classifyFixtureDiff({ changed: [], added: [".omo/run-continuation/ses_test.json", ".omo/other.json"], deleted: [], outside_fixture: [] }, root, createdAt);
    assert.deepEqual(classified.task_relevant.added, [".omo/other.json"]);
    assert.deepEqual(classified.ignored_runtime_generated, [{ path: ".omo/run-continuation/ses_test.json", classification: "BENCHMARK_RUNTIME_GENERATED" }]);
    assert.deepEqual(classified.raw.added, [".omo/run-continuation/ses_test.json", ".omo/other.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint writes atomically and resume skips terminal runs with shared dependencies", async () => {
  const generationRoot = mkdtempSync(join(tmpdir(), "daily-generation-"));
  const dependencyRoots = [];
  const hooks = {
    ...fakeLifecycle,
    executeTask: async (run) => {
      dependencyRoots.push(run.dependency_root);
      return { required_checks: { answer_key: true } };
    },
  };
  try {
    const dependencyRoot = join(generationRoot, "dependencies");
    await executeBenchmark({ manifest, selection, generation: 2, real: true, generationRoot, dependencyRoot, maxRuns: 1, hooks, commit: "test-commit" });
    await executeBenchmark({ manifest, selection, generation: 2, real: true, resume: true, generationRoot, dependencyRoot, maxRuns: 1, hooks, commit: "test-commit" });
    const checkpoint = loadCheckpoint(generationRoot);
    assert.equal(checkpoint.results.length, 2);
    assert.deepEqual(checkpoint.results.map((row) => row.sequence), [0, 1]);
    assert.equal(new Set(dependencyRoots).size, 1);
    assert.equal(dependencyRoots[0], join(generationRoot, "dependencies"));
    assert.equal(existsSync(join(generationRoot, "generation-state.json")), true);
    assert.equal(existsSync(join(generationRoot, "results.jsonl")), true);
    assert.equal(existsSync(join(generationRoot, "paired-results.jsonl")), true);
  } finally {
    rmSync(generationRoot, { recursive: true, force: true });
  }
});

test("atomic checkpoint writer leaves a complete JSON file", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-atomic-"));
  try {
    const path = join(root, "generation-state.json");
    atomicWriteFile(path, `${JSON.stringify({ ok: true })}\n`);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
