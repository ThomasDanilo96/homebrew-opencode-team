import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, validateManifest, createIsolatedRunRoot, prepareTasks, normalizeResult, aggregate, externalEvidenceStatus, buildReport } from "../benchmarks/daily/runner.mjs";
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
