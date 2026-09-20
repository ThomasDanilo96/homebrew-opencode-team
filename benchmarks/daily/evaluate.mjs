import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const truthy = (value) => value === true;
const textOf = (rawResult = {}) => [
  rawResult.response_text,
  rawResult.response,
  rawResult.summary,
  rawResult.answer,
  rawResult.response_evidence?.assistant_excerpt,
].filter((value) => typeof value === "string").join("\n").toLowerCase();

export const KNOWN_VERIFICATION_LABELS = Object.freeze(new Set([
  "answer_key",
  "no_files_changed",
  "exact_diff",
  "git_diff_scope",
  "tests_pass",
  "expected_files",
  "unexpected_files_absent",
  "before_after_behavior",
  "deny_matrix",
  "allow_matrix",
  "review_pass",
  "critical_review_pass",
  "gate_order",
  "four_required_slices",
  "integration_pass",
  "transition_matrix",
  "no_race_reported",
  "policy_matrix",
  "four_parallel_lanes",
  "no_duplicate_findings",
  "upgrade_pass",
  "rollback_pass",
  "reproduction_pass",
  "stress_test",
  "recovery_pass",
  "state_invariants",
]));

export function assertKnownVerificationLabels(run) {
  for (const label of run.verification ?? []) {
    if (!KNOWN_VERIFICATION_LABELS.has(label)) {
      throw Object.assign(new Error(`unknown_verification_label:${label}`), { code: "HARNESS_ERROR" });
    }
  }
}

function fileText(root, path) {
  try { return readFileSync(join(root, path), "utf8"); } catch { return ""; }
}

function expectedFilesFor(run) {
  const byTask = {
    "parser-boundary-fix": ["parser.js", "parser.test.js"],
    "two-file-feature": ["calculator.js", "calculator.test.js"],
    "multi-module-bug": ["api.js", "store.js", "multi-module.test.js"],
    "reviewed-policy-change": ["policy.js", "policy.test.js"],
    "critical-authorship-change": ["authorship.js", "authorship.test.js"],
    "end-to-end-runtime-recovery": ["runtime-recovery.js", "runtime-recovery.test.js"],
  };
  return byTask[run.task_id] ?? [];
}

function answerKey(run, rawResult) {
  if (rawResult.required_checks?.answer_key === true) return true;
  const text = textOf(rawResult);
  if (!text) return false;
  if (run.task_id === "lookup-routing-contract") {
    return [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "codex_executor",
      "reviewer_critical",
    ].every((needle) => text.includes(needle));
  }
  if (run.task_id === "locate-single-bug") return text.includes("parser") && (text.includes("boundary") || text.includes("off-by-one"));
  if (run.task_id === "security-policy-audit") return text.includes("guest") && text.includes("admin") && (text.includes("deny") || text.includes("denied"));
  if (run.task_id === "architecture-slice-analysis") return ["runtime", "persistence", "api", "test"].every((needle) => text.includes(needle));
  return false;
}

function exactDiff(run, diff, root) {
  if (run.task_id === "one-line-doc-fix") {
    const readme = fileText(root, "README.md");
    return diff.changed.length === 1 && diff.changed[0] === "README.md" && diff.added.length === 0 && diff.deleted.length === 0 && readme.includes("receive") && !readme.includes("recieve");
  }
  return false;
}

function gitDiffScope(run, diff, rawResult) {
  if (rawResult.required_checks?.git_diff_scope === true) return true;
  const touched = [...diff.changed, ...diff.added, ...diff.deleted];
  if (!touched.length) return false;
  if (run.task_id === "one-line-doc-fix") return touched.every((path) => path === "README.md");
  const expected = expectedFilesFor(run);
  return expected.length ? touched.every((path) => expected.includes(path)) : false;
}

function testsPass(run, rawResult) {
  return truthy(rawResult.required_checks?.tests_pass) || truthy(rawResult.tests_pass);
}

function expectedFiles(run, diff, rawResult) {
  if (rawResult.required_checks?.expected_files === true) return true;
  const expected = expectedFilesFor(run);
  if (!expected.length) return false;
  const touched = new Set([...diff.changed, ...diff.added]);
  return expected.every((path) => touched.has(path) || existsSync(join(run.fixture_root, path)));
}

function unexpectedFilesAbsent(diff, rawResult) {
  if (rawResult.required_checks?.unexpected_files_absent === true) return true;
  return diff.added.every((path) => !path.includes("/") && !path.startsWith("."));
}

function fourRequiredSlices(rawResult) {
  if (rawResult.required_checks?.four_required_slices === true) return true;
  const text = textOf(rawResult);
  return ["runtime", "persistence", "api", "test"].every((needle) => text.includes(needle));
}

function rawRequired(label, rawResult) {
  return rawResult.required_checks && Object.hasOwn(rawResult.required_checks, label) ? rawResult.required_checks[label] === true : false;
}

function gateCheck(label, rawResult, gateEvidence) {
  if (rawRequired(label, rawResult)) return true;
  if (label === "review_pass") return gateEvidence?.review_result === "PASS";
  if (label === "critical_review_pass") return gateEvidence?.review_result === "PASS" && gateEvidence?.review_required === true;
  if (label === "gate_order") return gateEvidence?.gate_order_correct === true && gateEvidence?.final_success_only_after_required_gates === true;
  return false;
}

function labelValue(label, { run, rawResult, gateEvidence, fixtureDiff }) {
  const diff = fixtureDiff.task_relevant ?? fixtureDiff;
  switch (label) {
    case "answer_key": return answerKey(run, rawResult);
    case "no_files_changed": return diff.changed.length === 0 && diff.added.length === 0 && diff.deleted.length === 0;
    case "exact_diff": return exactDiff(run, diff, run.fixture_root) || rawRequired(label, rawResult);
    case "git_diff_scope": return gitDiffScope(run, diff, rawResult);
    case "tests_pass": return testsPass(run, rawResult);
    case "expected_files": return expectedFiles(run, diff, rawResult);
    case "unexpected_files_absent": return unexpectedFilesAbsent(diff, rawResult);
    case "four_required_slices": return fourRequiredSlices(rawResult);
    case "review_pass":
    case "critical_review_pass":
    case "gate_order":
      return gateCheck(label, rawResult, gateEvidence);
    case "before_after_behavior":
    case "deny_matrix":
    case "allow_matrix":
    case "integration_pass":
    case "transition_matrix":
    case "no_race_reported":
    case "policy_matrix":
    case "four_parallel_lanes":
    case "no_duplicate_findings":
    case "upgrade_pass":
    case "rollback_pass":
    case "reproduction_pass":
    case "stress_test":
    case "recovery_pass":
    case "state_invariants":
      return rawRequired(label, rawResult);
    default:
      throw Object.assign(new Error(`unknown_verification_label:${label}`), { code: "HARNESS_ERROR" });
  }
}

export function evaluateRun({ run, rawResult = {}, gateEvidence = {}, fixtureDiff }) {
  assertKnownVerificationLabels(run);
  const checks = Object.fromEntries((run.verification ?? []).map((label) => [label, labelValue(label, { run, rawResult, gateEvidence, fixtureDiff })]));
  const values = Object.values(checks);
  const passed = values.filter(Boolean).length;
  const requiredCount = values.length;
  const terminalFailure = rawResult.success === false || rawResult.partial === false && rawResult.error_code && rawResult.error_code !== "NONE";
  const outcome = requiredCount > 0 && passed === requiredCount && !rawResult.partial && !terminalFailure ? "PASS" : passed > 0 && !terminalFailure ? "PARTIAL" : "FAIL";
  return {
    schema_version: 1,
    outcome,
    success: outcome === "PASS",
    correctness_score: requiredCount ? Number((passed / requiredCount).toFixed(6)) : 0,
    required_checks: checks,
    harness_error: null,
  };
}

export function continuationRuntimeGenerated(path, absolutePath, startedAtMs) {
  if (!/^\.omo\/run-continuation\/[^/]+\.json$/.test(path)) return false;
  try {
    const stat = lstatSync(absolutePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs >= startedAtMs - 1000;
  } catch {
    return false;
  }
}

export function classifyFixtureDiff(rawDiff, fixtureRoot, startedAtMs) {
  const ignored = [];
  const filter = (paths) => paths.filter((path) => {
    if (continuationRuntimeGenerated(path, join(fixtureRoot, path), startedAtMs)) {
      ignored.push({ path, classification: "BENCHMARK_RUNTIME_GENERATED" });
      return false;
    }
    return true;
  });
  const taskRelevant = {
    changed: filter(rawDiff.changed ?? []),
    added: filter(rawDiff.added ?? []),
    deleted: filter(rawDiff.deleted ?? []),
    outside_fixture: rawDiff.outside_fixture ?? [],
  };
  return {
    ...taskRelevant,
    raw: rawDiff,
    task_relevant: taskRelevant,
    ignored_runtime_generated: ignored.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
