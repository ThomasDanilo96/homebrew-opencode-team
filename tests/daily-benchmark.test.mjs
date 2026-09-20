import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, validateManifest, createIsolatedRunRoot, prepareTasks, captureFixtureState, compareFixtureState, normalizeResult, aggregate, externalEvidenceStatus, buildReport } from "../benchmarks/daily/runner.mjs";
import { verifyDailyContract } from "../benchmarks/daily/contract.mjs";

test("DAILY contract matches the frozen source assignment", () => {
  const result = verifyDailyContract();
  assert.equal(result.passed, true, result.failures.join(","));
});

test("benchmark manifest has the requested 22-task tier matrix", () => {
  const manifest = loadManifest();
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.tasks.length, 22);
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.tiers).map(([tier, tasks]) => [tier, tasks.length])), { TRIVIAL: 4, NORMAL: 6, COMPLEX: 6, HEAVY: 4, EXTREME: 2 });
});

test("isolated preparation creates independent management roots", () => {
  const manifest = loadManifest();
  const first = prepareTasks(manifest, "daily", manifest.tasks.slice(0, 1));
  const second = prepareTasks(manifest, "openai", manifest.tasks.slice(1, 2));
  try {
    assert.notEqual(first.root, second.root);
    for (const name of ["config", "data", "state", "cache", "runtime", "worktrees", "logs"]) {
      assert.equal(existsSync(join(first.root, name)), true);
      assert.equal(existsSync(join(second.root, name)), true);
    }
    assert.equal(JSON.parse(readFileSync(join(first.root, "benchmark.json"))).tasks[0].profile, "daily");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("missing telemetry remains null instead of becoming fabricated metrics", () => {
  const result = normalizeResult({ success: true });
  assert.equal(result.wall_clock_ms, null);
  assert.equal(result.total_tokens, null);
  assert.deepEqual(aggregate([result]).missing_metrics.includes("estimated_cost"), true);
});

test("aggregate keeps quality and latency separate", () => {
  const report = aggregate([{ success: true, wall_clock_ms: 20, total_tokens: 10 }, { success: false, wall_clock_ms: 40, total_tokens: 20 }]);
  assert.deepEqual(report.quality, { pass: 1, partial: 0, fail: 1 });
  assert.equal(report.wall_clock_ms.median, 20);
  assert.equal(report.wall_clock_ms.p95, 40);
  assert.equal(report.totals.total_tokens, 30);
});

test("report blocks certification when external evidence is absent", () => {
  const report = buildReport({ evidence: externalEvidenceStatus(undefined), results: [] });
  assert.equal(report.certification, "BLOCKED_EXTERNAL_EVIDENCE");
  assert.equal(report.external_evidence.reason, "missing_OPENAI_DAILY_BENCHMARK_RESULTS");
});

test("fixture scoring ignores benchmark and runtime paths outside the fixture", () => {
  const root = createIsolatedRunRoot("opencode-daily-fixture-test-");
  const fixture = join(root, "worktrees", "task", "daily");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "answer.txt"), "stable\n");
  const baseline = captureFixtureState(fixture);
  writeFileSync(join(root, "logs", "runtime.log"), "generated\n");
  assert.deepEqual(compareFixtureState(baseline, fixture), { changed: [], added: [], deleted: [], outside_fixture: [] });
  rmSync(root, { recursive: true, force: true });
});

test("fixture scoring detects content, new, deleted, mode, and rejects symlink escape", () => {
  const root = createIsolatedRunRoot("opencode-daily-fixture-test-");
  const fixture = join(root, "worktrees", "task", "daily");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "changed.txt"), "before\n");
  writeFileSync(join(fixture, "deleted.txt"), "gone\n");
  const baseline = captureFixtureState(fixture);
  writeFileSync(join(fixture, "changed.txt"), "after\n");
  rmSync(join(fixture, "deleted.txt"));
  writeFileSync(join(fixture, "added.txt"), "new\n");
  chmodSync(join(fixture, "changed.txt"), 0o755);
  assert.deepEqual(compareFixtureState(baseline, fixture), {
    changed: ["changed.txt"],
    added: ["added.txt"],
    deleted: ["deleted.txt"],
    outside_fixture: [],
  });
  symlinkSync(root, join(fixture, "escape"));
  assert.throws(() => compareFixtureState(baseline, fixture), /symlink_escape/);
  rmSync(root, { recursive: true, force: true });
});

test("mtime-only fixture changes are ignored", () => {
  const root = createIsolatedRunRoot("opencode-daily-fixture-test-");
  const fixture = join(root, "worktrees", "task", "daily");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "stable.txt"), "stable\n");
  const baseline = captureFixtureState(fixture);
  const now = new Date(Date.now() + 10000);
  const file = join(fixture, "stable.txt");
  utimesSync(file, now, now);
  assert.deepEqual(compareFixtureState(baseline, fixture), { changed: [], added: [], deleted: [], outside_fixture: [] });
  rmSync(root, { recursive: true, force: true });
});

test("gate scoring preserves unknown state", () => {
  const unknown = normalizeResult({ tester_required: true, tester_launched: null, review_required: true, final_success_only_after_required_gates: null });
  const known = normalizeResult({ tester_required: true, tester_launched: false, tester_skip_classification: "REAL_TESTER_SKIP", review_required: true, review_skip_classification: "REAL_REVIEW_SKIP", final_success_only_after_required_gates: false, premature_finalization_classification: "REAL_PREMATURE_FINALIZATION" });
  const report = aggregate([unknown, known]);
  assert.equal(report.gates.tester_skipped_incorrectly, 1);
  assert.equal(report.gates.review_skipped_incorrectly, 1);
  assert.equal(report.gates.final_success_before_gate, 1);
  assert.equal(report.gates.unknown_tester_launch, 1);
  assert.equal(report.gates.unknown_finalization, 1);
});

test("model mix excludes system labels and unknown agents", () => {
  const report = aggregate([{ success: true, model_mix: { Luna: 2, title: 8, undefined: 4, other: 3 } }]);
  assert.deepEqual(report.model_calls, { Luna: 2, Terra: 0, Sol: 0, other: 3 });
});
