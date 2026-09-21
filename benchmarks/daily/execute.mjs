#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAILY_PRICING, dailyCost } from "../../teams/daily/daily-policy.mjs";
import { captureFixtureState, compareFixtureState, loadManifest, normalizeResult } from "./runner.mjs";
import { assertKnownVerificationLabels, classifyFixtureDiff, evaluateRun } from "./evaluate.mjs";
import { atomicWriteFile, buildFingerprints, ensureCheckpointCompatible, loadCheckpoint, writeCheckpoint } from "./checkpoint.mjs";

export const CONTROL_PROFILE = "OPENAI";
export const TREATMENT_PROFILE = "DAILY";
export const SEED_POLICY = "fixed-alternating-selection-v1";
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OPENCODE_TEAM_BIN = join(ROOT, "bin/opencode-team");
const DEFAULT_SELECTION = join(ROOT, "benchmarks/daily/selection-12.json");
const FIXTURES = join(ROOT, "benchmarks/daily/fixtures");
const EVIDENCE_FILES = Object.freeze(["metadata", "fixture-before", "fixture-after", "fixture-diff", "result", "telemetry", "gate-evidence", "runtime-summary", "assistant-response"]);
const SECRET_KEY = /(?:^|_)(?:api_?key|secret|token|password|credential|auth)(?:_|$)/i;
const SECRET_VALUE = /\bsk-[A-Za-z0-9_-]{8,}\b|(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*\S+/i;
const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function loadSelection(path = DEFAULT_SELECTION) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function selectedManifestTasks(manifest, selection) {
  const byId = new Map((manifest.tasks ?? []).map((task) => [task.task_id, task]));
  return (selection.tasks ?? []).map((taskId) => {
    const task = byId.get(taskId);
    if (!task) throw new Error(`selection_task_not_in_manifest:${taskId}`);
    return task;
  });
}

export function validateSelection(manifest, selection) {
  const errors = [];
  if (selection?.schema_version !== 1) errors.push("selection_schema");
  if (selection?.variant_mapping?.control !== CONTROL_PROFILE) errors.push("control_must_be_OPENAI");
  if (selection?.variant_mapping?.treatment !== TREATMENT_PROFILE) errors.push("treatment_must_be_DAILY");
  if (!Array.isArray(selection?.tasks) || selection.tasks.length !== 12) errors.push("selection_must_have_12_tasks");
  const seen = new Set();
  const byId = new Map((manifest.tasks ?? []).map((task) => [task.task_id, task]));
  const tierCounts = {};
  for (const taskId of selection?.tasks ?? []) {
    if (seen.has(taskId)) errors.push(`duplicate_selection_task:${taskId}`);
    seen.add(taskId);
    const task = byId.get(taskId);
    if (!task) errors.push(`unknown_selection_task:${taskId}`);
    else tierCounts[task.tier] = (tierCounts[task.tier] ?? 0) + 1;
  }
  for (const [tier, count] of Object.entries(selection?.tier_counts ?? {})) {
    if ((tierCounts[tier] ?? 0) !== count) errors.push(`tier_count:${tier}`);
  }
  return errors;
}

export function buildRunMatrix({ manifest, selection, generation }) {
  const tasks = selectedManifestTasks(manifest, selection);
  const benchmarkRunId = hash(`${selection.selection_version ?? "selection"}\ngeneration:${generation}`).slice(0, 24);
  const runs = [];
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const first = taskIndex % 2 === 0 ? "treatment" : "control";
    for (const variant of [first, first === "control" ? "treatment" : "control"]) {
      const assignmentProfile = variant === "control" ? CONTROL_PROFILE : TREATMENT_PROFILE;
      runs.push({
        schema_version: 1,
        benchmark_run_id: benchmarkRunId,
        generation,
        suite_version: manifest.suite_version,
        package_version: manifest.package_version,
        selection_version: selection.selection_version,
        seed_policy: SEED_POLICY,
        sequence: runs.length,
        task_index: taskIndex,
        task_id: tasks[taskIndex].task_id,
        tier: tasks[taskIndex].tier,
        task_type: tasks[taskIndex].type,
        objective: tasks[taskIndex].objective,
        verification: [...tasks[taskIndex].verification],
        gates: [...tasks[taskIndex].gates],
        expected_agent: tasks[taskIndex].expected_agent,
        fixture: tasks[taskIndex].fixture,
        variant,
        assignment: {
          role: variant,
          profile: assignmentProfile,
          control: CONTROL_PROFILE,
          treatment: TREATMENT_PROFILE,
        },
        profile: assignmentProfile,
        attempt: 1,
      });
    }
  }
  return runs;
}

export function assertAssignmentIntegrity(run) {
  const expected = run.variant === "control" ? CONTROL_PROFILE : run.variant === "treatment" ? TREATMENT_PROFILE : null;
  if (!expected) throw new Error(`invalid_variant:${run.variant}`);
  if (run.profile !== expected || run.assignment?.profile !== expected) throw new Error(`assignment_profile_mismatch:${run.task_id}:${run.variant}`);
  if (run.assignment?.control !== CONTROL_PROFILE) throw new Error("control_assignment_mutated");
  if (run.assignment?.treatment !== TREATMENT_PROFILE) throw new Error("treatment_assignment_mutated");
  if (run.variant === "control" && String(run.assignment?.profile).toUpperCase() !== CONTROL_PROFILE) throw new Error("control_not_OPENAI");
  if (run.variant === "treatment" && String(run.assignment?.profile).toUpperCase() !== TREATMENT_PROFILE) throw new Error("treatment_not_DAILY");
}

export function renderDryRunPlan({ manifest, selection, generation }) {
  const runs = buildRunMatrix({ manifest, selection, generation });
  const tasks = selectedManifestTasks(manifest, selection);
  const lines = [
    "DAILY BENCHMARK EXECUTION PLAN",
    `GENERATION=${generation}`,
    "DRY_RUN=true",
    `LOGICAL_TASKS=${tasks.length}`,
    `PROFILE_RUNS=${runs.length}`,
    `CONTROL=${CONTROL_PROFILE}`,
    `TREATMENT=${TREATMENT_PROFILE}`,
    "ORDER=fixed alternating order",
    "ISOLATED_FIXTURE_PER_RUN=true",
    "MODEL_CALLS=0",
  ];
  for (const task of tasks) lines.push(`TASK\t${task.task_id}\t${task.tier}\t${task.type}`);
  for (const run of runs) lines.push(`RUN\t${run.sequence + 1}\t${run.task_id}\t${run.variant}\t${run.profile}\tfixture/`);
  return `${lines.join("\n")}\n`;
}

export function createRunRoot(prefix = "opencode-daily-execute-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const path of ["fixture", "home/config", "home/data", "home/state", "home/cache/runtime", "runtime", "logs", "evidence"]) {
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  }
  return root;
}

export function prepareRun(run, { root = createRunRoot() } = {}) {
  assertAssignmentIntegrity(run);
  assertKnownVerificationLabels(run);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  root = realpathSync(root);
  for (const path of ["fixture", "home/config", "home/data", "home/state", "home/cache/runtime", "runtime", "logs", "evidence"]) {
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  }
  const fixtureRoot = join(root, "fixture");
  cpSync(FIXTURES, fixtureRoot, { recursive: true });
  const dependencyRoot = run.dependency_root ?? join(root, "home/data/dependencies");
  const prepared = {
    ...run,
    root,
    dependency_root: dependencyRoot,
    fixture_root: fixtureRoot,
    home: {
      root: join(root, "home"),
      config: join(root, "home/config"),
      data: join(root, "home/data"),
      state: join(root, "home/state"),
      cache: join(root, "home/cache"),
    },
    runtime_root: join(root, "runtime"),
    runtime_cache_root: join(root, "home/cache/runtime", run.profile.toLowerCase()),
    telemetry_root: join(root, "home/data", run.profile.toLowerCase(), "state/team"),
    logs_root: join(root, "logs"),
    evidence_root: join(root, "evidence"),
  };
  return prepared;
}

function redactString(value, run) {
  let output = value;
  for (const [label, path] of [["<run-root>", run?.root], ["<fixture>", run?.fixture_root], ["<home-config>", run?.home?.config], ["<home-data>", run?.home?.data], ["<home-state>", run?.home?.state], ["<home-cache>", run?.home?.cache]]) {
    if (path) output = output.split(path).join(label);
  }
  output = output.replace(SECRET_VALUE, "<redacted>");
  return output.length > 2048 ? `${output.slice(0, 2048)}...<truncated>` : output;
}

export function safeEvidence(value, run, depth = 0) {
  if (depth > 8) return "<max-depth>";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "string") return redactString(value, run);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeEvidence(item, run, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, SECRET_KEY.test(key) ? "<redacted>" : safeEvidence(item, run, depth + 1)]));
  }
  return null;
}

export function writeEvidence(run, name, value) {
  if (!EVIDENCE_FILES.includes(name)) throw new Error(`unknown_evidence_file:${name}`);
  const path = join(run.evidence_root, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(safeEvidence(value, run), null, 2)}\n`, { mode: 0o600 });
  return path;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function numericFrom(records, names) {
  for (const record of records) {
    for (const name of names) {
      const value = finite(record?.[name]);
      if (value !== null) return { value, source: record.__source ?? "telemetry" };
    }
  }
  return { value: null, source: null };
}

function packetTokens(packet, metric) {
  const token = (field) => packet[field] === undefined ? 0 : finite(packet[field]);
  const codexInput = token("codex_input_tokens");
  const codexCached = token("codex_cached_input_tokens");
  const opencodeInput = token("opencode_input_tokens");
  const opencodeCached = token("opencode_cached_input_tokens");
  if ([codexInput, codexCached, opencodeInput, opencodeCached].some((value) => value === null)) return null;
  if (metric === "cached_input_tokens") return codexCached + opencodeCached;
  if (metric === "uncached_input_tokens") return codexInput - codexCached + opencodeInput - opencodeCached;
  const fields = metric === "output_tokens" ? ["codex_output_tokens", "opencode_output_tokens"] : metric === "reasoning_tokens" ? ["codex_reasoning_tokens", "opencode_reasoning_tokens"] : [];
  if (!fields.length) return null;
  const values = fields.map((field) => token(field));
  return values.some((value) => value === null) ? null : values.reduce((total, value) => total + value, 0);
}

function sumMetric(records, names) {
  const values = records.map((record) => names.map((name) => finite(record?.[name])).find((value) => value !== null)).filter((value) => value !== undefined);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

const MODEL_BUCKETS = Object.freeze(["Luna", "Terra", "Sol", "other"]);
const MODEL_CORRELATION_FIELDS = Object.freeze(["invocation_id", "request_id", "call_id", "task_call_id", "packet_id", "message_id"]);

function modelBucket(model) {
  const normalized = String(model ?? "").toLowerCase().replace(/^openai\//, "");
  if (normalized.includes("luna")) return "Luna";
  if (normalized.includes("terra")) return "Terra";
  if (normalized.includes("sol")) return "Sol";
  return "other";
}

function modelCorrelationKey(record) {
  for (const field of MODEL_CORRELATION_FIELDS) {
    const value = record?.[field];
    if (value !== undefined && value !== null && String(value).trim()) return `${field}:${value}`;
  }
  return null;
}

function modelMixFromRecords(records) {
  const counts = Object.fromEntries(MODEL_BUCKETS.map((bucket) => [bucket, 0]));
  const seen = new Set();
  const observed = records.filter((record) => record.__source !== "packet" && (record?.executed_model || record?.requested_model || record?.model));
  const candidates = observed.length ? observed : records;
  for (const record of candidates) {
    const model = record?.executed_model || record?.requested_model || record?.model;
    if (!model) continue;
    const correlationKey = modelCorrelationKey(record);
    if (correlationKey && seen.has(correlationKey)) continue;
    if (correlationKey) seen.add(correlationKey);
    counts[modelBucket(model)] += 1;
  }
  return counts;
}

export function telemetryStateRoot(run) {
  return run.telemetry_root ?? join(run.root, "home/data", String(run.profile ?? "").toLowerCase(), "state/team");
}

export function collectTelemetryFromRoot(run, stateRoot = telemetryStateRoot(run)) {
  const packetRoot = join(stateRoot, "work-packets");
  const packets = existsSync(packetRoot) ? readdirSync(packetRoot).filter((name) => name.endsWith(".json")).flatMap((name) => {
    const value = readJson(join(packetRoot, name));
    return value && typeof value === "object" ? [{ ...value, __source: "packet", __file: name }] : [];
  }) : [];
  const logs = join(stateRoot, "logs");
  const latency = existsSync(logs) ? readdirSync(logs).filter((name) => name === "latency-metrics.jsonl" || /benchmark.*\.jsonl$/i.test(name)).flatMap((name) => readJsonl(join(logs, name)).map((row) => ({ ...row, __source: name === "latency-metrics.jsonl" ? "latency" : "telemetry", __file: name }))) : [];
  const related = [...packets, ...latency].filter((record) => !record.task_id || record.task_id === run.task_id);
  const packetRelated = related.filter((record) => record.__source === "packet");
  const tokenMetric = (metric) => {
    const direct = numericFrom(related, [metric, metric.replace("uncached_", ""), metric.replace("cached_", "")]);
    if (direct.value !== null) return direct;
    const packetValues = packetRelated.map((packet) => packetTokens(packet, metric)).filter((value) => value !== null);
    return packetValues.length ? { value: packetValues.reduce((total, value) => total + value, 0), source: "packet" } : { value: null, source: null };
  };
  const metrics = {
    duration_ms: numericFrom(related, ["duration_ms", "elapsed_ms"]),
    uncached_input_tokens: tokenMetric("uncached_input_tokens"),
    cached_input_tokens: tokenMetric("cached_input_tokens"),
    output_tokens: tokenMetric("output_tokens"),
    reasoning_tokens: tokenMetric("reasoning_tokens"),
    retry_count: { value: integer(sumMetric(related, ["retry_count", "retries"])), source: related.some((record) => record.retry_count !== undefined || record.retries !== undefined) ? "telemetry" : null },
    tool_call_count: { value: integer(sumMetric(related, ["tool_call_count", "tool_calls"])), source: related.some((record) => record.tool_call_count !== undefined || record.tool_calls !== undefined) ? "telemetry" : null },
    compaction_count: { value: integer(sumMetric(related, ["compaction_count", "compact_count"])), source: related.some((record) => record.compaction_count !== undefined || record.compact_count !== undefined) ? "telemetry" : null },
    wrapper_round_trips: { value: integer(sumMetric(related, ["wrapper_round_trips", "wrapper_turns"])), source: related.some((record) => record.wrapper_round_trips !== undefined || record.wrapper_turns !== undefined) ? "telemetry" : null },
  };
  const explicitCost = numericFrom(related, ["provider_reported_cost", "cost"]);
  const model = related.map((record) => record.executed_model || record.requested_model || record.model).find(Boolean) ?? null;
  let estimatedCost = { value: null, source: null };
  if (run.profile === TREATMENT_PROFILE && model) {
    const key = String(model).toLowerCase().replace(/^openai\//, "");
    const input = metrics.uncached_input_tokens.value;
    const cached = metrics.cached_input_tokens.value;
    const output = metrics.output_tokens.value;
    if ([input, cached, output].every((value) => value !== null)) {
      estimatedCost = { value: dailyCost({ model: key, input, cached, output }), source: DAILY_PRICING.source };
    }
  }
  metrics.provider_reported_cost = explicitCost;
  metrics.estimated_cost = estimatedCost;
  metrics.cost = { value: estimatedCost.value ?? explicitCost.value, source: estimatedCost.source ?? explicitCost.source };
  return {
    schema_version: 1,
    source_root: stateRoot,
    task_id: run.task_id,
    profile: run.profile,
    packet_count: packets.length,
    latency_count: latency.length,
    related_count: related.length,
    model,
    model_mix: modelMixFromRecords(related),
    pricing_source: run.profile === TREATMENT_PROFILE ? DAILY_PRICING.source : null,
    metrics: Object.fromEntries(Object.entries(metrics).map(([name, entry]) => [name, entry.value])),
    sources: Object.fromEntries(Object.entries(metrics).map(([name, entry]) => [name, entry.source])),
  };
}

const tri = (value) => typeof value === "boolean" ? value : null;
const enumOrNull = (value, allowed) => typeof value === "string" && allowed.includes(value) ? value : null;

export function normalizeGateEvidence(raw = {}) {
  const testerSkip = raw.tester_skip_classification === "REAL_TESTER_SKIP" || raw.real_tester_skip === true ? "REAL_TESTER_SKIP" : null;
  const reviewSkip = raw.review_skip_classification === "REAL_REVIEW_SKIP" || raw.real_review_skip === true ? "REAL_REVIEW_SKIP" : null;
  const premature = raw.premature_finalization_classification === "REAL_PREMATURE_FINALIZATION" || raw.real_premature_finalization === true ? "REAL_PREMATURE_FINALIZATION" : null;
  return {
    schema_version: 1,
    tester_required: tri(raw.tester_required),
    tester_launched: tri(raw.tester_launched),
    tester_result: enumOrNull(raw.tester_result, ["PASS", "FAIL", "UNKNOWN"]),
    tester_skip_classification: testerSkip,
    review_required: tri(raw.review_required),
    review_result: enumOrNull(raw.review_result, ["PASS", "FAIL", "REJECT", "UNKNOWN"]),
    review_skip_classification: reviewSkip,
    gate_order_correct: tri(raw.gate_order_correct),
    final_success_only_after_required_gates: tri(raw.final_success_only_after_required_gates),
    premature_finalization_classification: premature,
    source: typeof raw.source === "string" ? raw.source : null,
  };
}

function requiredChecks(run, rawResult, fixtureDiff) {
  const rawChecks = rawResult?.required_checks && typeof rawResult.required_checks === "object" ? rawResult.required_checks : {};
  return Object.fromEntries(run.verification.map((name) => {
    if (name === "no_files_changed") return [name, fixtureDiff.changed.length === 0 && fixtureDiff.added.length === 0 && fixtureDiff.deleted.length === 0];
    if (Object.hasOwn(rawChecks, name)) return [name, rawChecks[name] === true];
    return [name, rawResult?.success === true && !rawResult?.partial];
  }));
}

export function normalizeExecutionResult({ run, rawResult = {}, telemetry, gateEvidence, fixtureDiff, durationMs, taskDurationMs = null, modelCallStarted = false, timedOut = false, runtimeError = null }) {
  let evaluation;
  try {
    evaluation = evaluateRun({ run, rawResult, telemetry, gateEvidence, fixtureDiff });
  } catch (error) {
    evaluation = {
      success: false,
      correctness_score: 0,
      required_checks: {},
      outcome: "FAIL",
      harness_error: error?.message ?? "HARNESS_ERROR",
    };
    runtimeError ??= { code: error?.code ?? "HARNESS_ERROR" };
  }
  const success = timedOut || runtimeError ? false : evaluation.success;
  const metrics = telemetry?.metrics ?? {};
  const taskDuration = finite(rawResult.task_duration_ms) ?? finite(rawResult.duration_ms) ?? finite(metrics.duration_ms) ?? finite(taskDurationMs);
  const providerCost = finite(rawResult.provider_reported_cost) ?? finite(rawResult.cost) ?? finite(metrics.provider_reported_cost);
  const estimatedCost = finite(rawResult.estimated_cost) ?? finite(metrics.estimated_cost);
  const result = {
    schema_version: 1,
    success,
    model_call_started: modelCallStarted,
    outcome: evaluation.outcome,
    correctness_score: evaluation.correctness_score,
    required_checks: evaluation.required_checks,
    task_duration_ms: taskDuration,
    runtime_total_ms: finite(durationMs),
    duration_ms: taskDuration ?? finite(durationMs),
    wall_clock_ms: taskDuration,
    uncached_input_tokens: finite(rawResult.uncached_input_tokens) ?? finite(metrics.uncached_input_tokens),
    cached_input_tokens: finite(rawResult.cached_input_tokens) ?? finite(metrics.cached_input_tokens),
    output_tokens: finite(rawResult.output_tokens) ?? finite(metrics.output_tokens),
    reasoning_tokens: finite(rawResult.reasoning_tokens) ?? finite(metrics.reasoning_tokens),
    model_mix: telemetry?.model_mix,
    provider_reported_cost: providerCost,
    estimated_cost: estimatedCost,
    cost: estimatedCost ?? providerCost,
    retry_count: integer(rawResult.retry_count) ?? integer(metrics.retry_count),
    tool_call_count: integer(rawResult.tool_call_count) ?? integer(metrics.tool_call_count),
    compaction_count: integer(rawResult.compaction_count) ?? integer(metrics.compaction_count),
    wrapper_round_trips: integer(rawResult.wrapper_round_trips) ?? integer(metrics.wrapper_round_trips),
    agent: String(rawResult.agent ?? run.expected_agent ?? "unknown"),
    classification: String(rawResult.classification ?? run.task_type ?? "unknown"),
    complexity: String(rawResult.complexity ?? run.tier ?? "unknown"),
    reasoning_effort: String(rawResult.reasoning_effort ?? "unknown"),
    reviewer_outcome: String(rawResult.reviewer_outcome ?? gateEvidence?.review_result ?? "UNKNOWN"),
    error_code: String(rawResult.error_code && rawResult.error_code !== "NONE" ? rawResult.error_code : timedOut ? "TIMEOUT" : runtimeError ? runtimeError.code ?? "RUNTIME_FAILURE" : evaluation.harness_error ? "HARNESS_ERROR" : "NONE"),
  };
  return { ...result, raw_metrics: normalizeResult({ ...result, ...gateEvidence, profile: run.profile.toLowerCase() }) };
}

const boundedText = (value, limit = 4096) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...<truncated>` : text;
};

const childExit = (child) => new Promise((resolvePromise, reject) => {
  if (child.exitCode !== null && child.exitCode !== undefined) return resolvePromise({ code: child.exitCode, signal: child.signalCode ?? null });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});

export function dependencyRootForRun(run, env = process.env) {
  if (env.OPENCODE_TEAM_DEPENDENCY_ROOT) return env.OPENCODE_TEAM_DEPENDENCY_ROOT;
  if (run.dependency_root) return run.dependency_root;
  if (env.OPENAI_DEPENDENCY_ROOT) return dirname(env.OPENAI_DEPENDENCY_ROOT);
  return join(run.home.root, "data/dependencies");
}

export function buildRunEnv(run, extra = {}, env = process.env) {
  const next = {
    ...env,
    OPENCODE_TEAM_HOME: run.home.root,
    OPENCODE_TEAM_DEPENDENCY_ROOT: dependencyRootForRun(run, env),
    ...extra,
  };
  if (!Object.hasOwn(next, "OPENAI_DEPENDENCY_ROOT")) next.OPENAI_DEPENDENCY_ROOT = join(next.OPENCODE_TEAM_DEPENDENCY_ROOT, "openai");
  const hostHome = env.HOME || homedir();
  if (!Object.hasOwn(next, "OPENCODE_AUTH_SOURCE")) {
    const source = join(hostHome, ".local/share/opencode/auth.json");
    if (existsSync(source)) next.OPENCODE_AUTH_SOURCE = source;
  }
  if (!Object.hasOwn(next, "OPENAI_CODEX_AUTH_SOURCE")) {
    const source = join(hostHome, ".codex/auth.json");
    if (existsSync(source)) next.OPENAI_CODEX_AUTH_SOURCE = source;
  }
  if (env.OPENCODE_AUTH_SOURCE) next.OPENCODE_AUTH_SOURCE = env.OPENCODE_AUTH_SOURCE;
  if (env.OPENAI_CODEX_AUTH_SOURCE) next.OPENAI_CODEX_AUTH_SOURCE = env.OPENAI_CODEX_AUTH_SOURCE;
  return next;
}

async function runCommand({ run, args, logName, env = {}, detached = false, wait = true, deps = {} }) {
  mkdirSync(run.logs_root, { recursive: true, mode: 0o700 });
  const stdoutPath = join(run.logs_root, `${logName}.out`);
  const stderrPath = join(run.logs_root, `${logName}.err`);
  const stdout = openSync(stdoutPath, "a", 0o600);
  const stderr = openSync(stderrPath, "a", 0o600);
  let child;
  try {
    child = (deps.spawn ?? spawn)(args[0], args.slice(1), {
      cwd: run.fixture_root,
      env: buildRunEnv(run, env, deps.env ?? process.env),
      detached,
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const exited = childExit(child);
  if (detached) child.unref?.();
  const handle = { child, pid: child.pid, process_group_id: detached ? child.pid : null, stdout: stdoutPath, stderr: stderrPath, exited };
  if (!wait) return handle;
  const exit = await exited;
  if (exit.code !== 0) {
    const error = Object.assign(new Error(`${logName}_failed`), { code: `${logName.toUpperCase().replaceAll("-", "_")}_FAILED`, exit, stdout: stdoutPath, stderr: stderrPath });
    throw error;
  }
  return { ...handle, exit, status: "OK" };
}

export async function defaultSetupProfile(run, deps = {}) {
  await runCommand({ run, args: [OPENCODE_TEAM_BIN, "setup"], logName: "setup", deps });
  return { status: "OK" };
}

function readText(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

export function discoverRuntimeRuns(run) {
  const profile = String(run.profile ?? "").toLowerCase();
  const runsRoot = join(run.home.root, "cache/runtime", profile, "runs");
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const run_dir = join(runsRoot, entry.name);
    const port = Number(readText(join(run_dir, "port")));
    const parent_session_id = readText(join(run_dir, "parent_session_id"));
    const server_pid = Number(readText(join(run_dir, "server.pid")));
    return { run_dir, run_id: entry.name, port, parent_session_id, server_pid };
  }).filter((candidate) => Number.isSafeInteger(candidate.port) && candidate.port > 0 && candidate.port < 65536 && candidate.parent_session_id && Number.isSafeInteger(candidate.server_pid) && candidate.server_pid > 0).sort((a, b) => a.run_id.localeCompare(b.run_id));
}

async function fetchJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  if (!response?.ok) throw Object.assign(new Error(`http_${response?.status ?? "error"}`), { code: "HTTP_FAILURE", status: response?.status ?? null, url });
  if (response.json) {
    try { return await response.json(); } catch { return null; }
  }
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

export async function waitForRuntimeReady(run, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw Object.assign(new Error("fetch_unavailable"), { code: "FETCH_UNAVAILABLE" });
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.timeoutMs ?? 120_000);
  let lastError = null;
  while (now() <= deadline) {
    for (const candidate of discoverRuntimeRuns(run)) {
      try {
        const baseUrl = `http://127.0.0.1:${candidate.port}`;
        const response = await fetchImpl(`${baseUrl}/`);
        if (response?.ok) return { status: "OK", baseUrl, ...candidate };
        lastError = Object.assign(new Error(`http_${response?.status ?? "not_ok"}`), { code: "RUNTIME_HTTP_NOT_READY" });
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(options.intervalMs ?? 1000);
  }
  throw Object.assign(new Error("runtime_readiness_timeout"), { code: "RUNTIME_READINESS_TIMEOUT", cause: lastError });
}

export async function defaultStartProfile(run, deps = {}) {
  const profile = String(run.profile).toLowerCase();
  const processHandle = await runCommand({
    run,
    args: [OPENCODE_TEAM_BIN, profile],
    logName: "runtime",
    env: { TEAM_RUNTIME_HEADLESS: "1" },
    detached: true,
    wait: false,
    deps,
  });
  try {
    const runtime = await waitForRuntimeReady(run, { fetch: deps.fetch, sleep: deps.sleep, now: deps.now, timeoutMs: deps.readinessTimeoutMs, intervalMs: deps.readinessIntervalMs });
    return { status: "OK", ...processHandle, runtime };
  } catch (error) {
    if (processHandle.child?.exitCode !== null && processHandle.child?.exitCode !== undefined) {
      throw Object.assign(new Error("runtime_start_failed"), { code: "START_FAILED", cause: error });
    }
    throw error;
  }
}

export function buildTaskPrompt(run) {
  return [
    "Execute this benchmark task inside the current fixture directory only.",
    "",
    `Task ID: ${run.task_id}`,
    `Tier: ${run.tier}`,
    `Type: ${run.task_type}`,
    "",
    "Objective:",
    run.objective,
    "",
    "Verification requirements:",
    ...run.verification.map((item) => `- ${item}`),
    "",
    "Constraints:",
    "- Work only inside this fixture.",
    "- Preserve product routing, model assignments, and release metadata.",
    "- For read-only tasks, do not change files.",
    "- For mutating tasks, make the required file changes and run the most focused verification available in the fixture.",
    "- Do not claim success from prose alone; report concrete files inspected or changed and verification evidence.",
  ].join("\n");
}

function assistantCount(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message?.info?.role === "assistant" || message?.role === "assistant").length;
}

function lastAssistant(messages) {
  const assistants = (Array.isArray(messages) ? messages : []).filter((message) => message?.info?.role === "assistant" || message?.role === "assistant");
  return assistants.at(-1) ?? null;
}

function assistantText(message) {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function postPromptAndPoll(runtime, prompt, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw Object.assign(new Error("fetch_unavailable"), { code: "FETCH_UNAVAILABLE" });
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const deadline = now() + timeoutMs;
  const sessionUrl = `${runtime.baseUrl}/session/${runtime.parent_session_id}`;
  const before = await fetchJson(fetchImpl, `${sessionUrl}/message`);
  const beforeAssistantCount = assistantCount(before);
  await fetchJson(fetchImpl, `${sessionUrl}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "openai_orchestrator", parts: [{ type: "text", text: prompt }] }),
  });
  let latest = before, latestStatus = null;
  while (now() <= deadline) {
    const statuses = await fetchJson(fetchImpl, `${runtime.baseUrl}/session/status`);
    latestStatus = statuses?.[runtime.parent_session_id]?.type ?? "unknown";
    latest = await fetchJson(fetchImpl, `${sessionUrl}/message`);
    const assistant = lastAssistant(latest);
    if (!["busy", "retry"].includes(latestStatus) && assistantCount(latest) > beforeAssistantCount && assistantText(assistant)) {
      return { status: "OK", session_status: latestStatus, before_count: Array.isArray(before) ? before.length : null, after_count: Array.isArray(latest) ? latest.length : null, assistant, messages: latest };
    }
    await sleep(options.intervalMs ?? 1000);
  }
  throw Object.assign(new Error("prompt_poll_timeout"), { code: "PROMPT_POLL_TIMEOUT", session_status: latestStatus, messages: latest });
}

async function defaultExecuteTask(run, profileHandle, deps = {}) {
  const runtime = profileHandle?.runtime ?? await waitForRuntimeReady(run, { fetch: deps.fetch, sleep: deps.sleep, now: deps.now, timeoutMs: deps.readinessTimeoutMs, intervalMs: deps.readinessIntervalMs });
  const response = await postPromptAndPoll(runtime, buildTaskPrompt(run), { fetch: deps.fetch, sleep: deps.sleep, now: deps.now, timeoutMs: deps.promptTimeoutMs, intervalMs: deps.promptPollIntervalMs });
  const responseText = boundedText(assistantText(response.assistant), 4096);
  return {
    error_code: "NONE",
    response_text: responseText,
    response_evidence: {
      session_status: response.session_status,
      before_count: response.before_count,
      after_count: response.after_count,
      assistant_excerpt: responseText,
    },
  };
}

export function collectGateEvidenceFromRoot(run, stateRoot = telemetryStateRoot(run)) {
  const packetRoot = join(stateRoot, "work-packets");
  const packets = existsSync(packetRoot) ? readdirSync(packetRoot).filter((name) => name.endsWith(".json")).flatMap((name) => {
    const value = readJson(join(packetRoot, name));
    return value && typeof value === "object" && (!value.task_id || value.task_id === run.task_id || value.task_fingerprint === run.task_id) ? [value] : [];
  }) : [];
  const latest = packets.at(-1) ?? {};
  return {
    tester_required: latest.tester_required,
    tester_launched: latest.tester_launched,
    tester_result: latest.tester_result ?? (latest.tester_status === "passed" ? "PASS" : latest.tester_status === "failed" ? "FAIL" : latest.tester_status === "unknown" ? "UNKNOWN" : undefined),
    tester_skip_classification: latest.tester_skip_classification,
    review_required: latest.review_required,
    review_result: latest.review_result ?? latest.review_status,
    review_skip_classification: latest.review_skip_classification,
    gate_order_correct: latest.gate_order_correct,
    final_success_only_after_required_gates: latest.final_success_only_after_required_gates,
    premature_finalization_classification: latest.premature_finalization_classification,
    source: packets.length ? "work-packets" : null,
  };
}

export async function defaultStopProfile(_run, handle, _reason, deps = {}) {
  if (!handle?.pid) return { status: "NOT_STARTED" };
  const kill = deps.kill ?? process.kill;
  try {
    kill(-handle.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "OK", reason: "already_exited" };
    throw Object.assign(error, { code: error?.code ?? "STOP_SIGNAL_FAILED" });
  }
  const sleep = deps.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (deps.stopTimeoutMs ?? 10_000);
  while (now() <= deadline) {
    if (handle.child?.exitCode !== null && handle.child?.exitCode !== undefined) return { status: "OK" };
    const settled = await Promise.race([handle.exited.then(() => true), sleep(100).then(() => false)]);
    if (settled) return { status: "OK" };
  }
  throw Object.assign(new Error("runtime_stop_timeout"), { code: "STOP_FAILED" });
}

export async function forceCleanupRuntime(run, handle, deps = {}) {
  if (!handle?.pid) return { status: "NOT_STARTED" };
  const kill = deps.kill ?? process.kill;
  try {
    kill(-handle.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw Object.assign(error, { code: error?.code ?? "FORCE_CLEANUP_FAILED" });
  }
  const runDir = handle.runtime?.run_dir;
  if (runDir && String(runDir).startsWith(join(run.home.root, "cache/runtime"))) {
    rmSync(runDir, { recursive: true, force: true });
  }
  return { status: "OK" };
}

export function defaultHooks(deps = {}) {
  return {
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))),
    setTimeout: deps.setTimeout ?? setTimeout,
    clearTimeout: deps.clearTimeout ?? clearTimeout,
    setupProfile: (run) => defaultSetupProfile(run, deps),
    startProfile: (run) => defaultStartProfile(run, deps),
    executeTask: (run, profileHandle) => defaultExecuteTask(run, profileHandle, deps),
    collectTelemetry: async (run) => collectTelemetryFromRoot(run),
    collectGateEvidence: async (run) => collectGateEvidenceFromRoot(run),
    stopProfile: (run, handle, reason) => defaultStopProfile(run, handle, reason, deps),
    forceCleanup: (run, handle) => forceCleanupRuntime(run, handle, deps),
  };
}

async function withTimeout(promise, timeoutMs, hooks) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return { timedOut: false, value: await promise };
  let timeout;
  const timeoutPromise = new Promise((resolvePromise) => {
    timeout = hooks.setTimeout(() => resolvePromise({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([promise.then((value) => ({ timedOut: false, value }), (error) => ({ timedOut: false, error })), timeoutPromise]);
  hooks.clearTimeout(timeout);
  if (result.timedOut) return result;
  if (result.error) throw result.error;
  return result;
}

let activeRuntime = null;
let activeCheckpointFlush = null;

export async function handleBenchmarkSignal(signal, hooks = defaultHooks()) {
  const active = activeRuntime;
  if (active?.run) {
    mkdirSync(active.run.evidence_root, { recursive: true, mode: 0o700 });
    atomicWriteFile(join(active.run.evidence_root, "interruption.json"), `${JSON.stringify({ schema_version: 1, signal, interrupted_at: new Date().toISOString(), run: { sequence: active.run.sequence, task_id: active.run.task_id, profile: active.run.profile } }, null, 2)}\n`);
  }
  if (active?.run && active?.handle) {
    try { await hooks.stopProfile(active.run, active.handle, "interrupted"); } catch {}
  }
  if (activeCheckpointFlush) {
    try { activeCheckpointFlush(); } catch {}
  }
}

export function installBenchmarkSignalHandlers(hooks = defaultHooks()) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      handleBenchmarkSignal(signal, hooks).finally(() => process.exit(130));
    });
  }
}

export async function settleFixture(run, options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = now() + timeoutMs;
  let snapshot = captureFixtureState(run.fixture_root);
  let stableSnapshots = 1;
  let previousKey = JSON.stringify(snapshot);
  while (stableSnapshots < 2) {
    if (now() > deadline) throw Object.assign(new Error("startup_fixture_not_stable"), { code: "STARTUP_FIXTURE_NOT_STABLE" });
    await sleep(intervalMs);
    const next = captureFixtureState(run.fixture_root);
    const nextKey = JSON.stringify(next);
    if (nextKey === previousKey) stableSnapshots += 1;
    else stableSnapshots = 1;
    snapshot = next;
    previousKey = nextKey;
  }
  return snapshot;
}

export async function executeRun(runPlan, options = {}) {
  const hooks = { ...defaultHooks(options.deps ?? {}), ...(options.hooks ?? {}) };
  const run = prepareRun(runPlan, options.prepare ?? {});
  const startedAt = hooks.now();
  let taskStartedAt = null;
  let modelCallStarted = false;
  let profileHandle = null, rawResult = {}, telemetry = null, gateEvidence = null, fixtureBaseline = null, fixtureAfter = null, fixtureDiff = null;
  const runtime = { schema_version: 1, status: "UNKNOWN", setup_status: "UNKNOWN", start_status: "UNKNOWN", stop_status: "UNKNOWN", timed_out: false, error_code: null };
  try {
    const setup = await hooks.setupProfile(run);
    runtime.setup_status = setup?.status ?? "OK";
    profileHandle = await hooks.startProfile(run);
    activeRuntime = { run, handle: profileHandle };
    runtime.start_status = profileHandle?.status ?? "OK";
    fixtureBaseline = await settleFixture(run, {
      sleep: hooks.sleep,
      now: hooks.now,
      intervalMs: options.startupSettleIntervalMs,
      timeoutMs: options.startupSettleTimeoutMs,
    });
    writeEvidence(run, "fixture-before", fixtureBaseline);
    taskStartedAt = hooks.now();
    modelCallStarted = true;
    const completion = await withTimeout(Promise.resolve(hooks.executeTask(run, profileHandle)), options.timeoutMs ?? 30 * 60 * 1000, hooks);
    if (completion.timedOut) {
      runtime.timed_out = true;
      rawResult = { success: false, error_code: "TIMEOUT" };
    } else {
      rawResult = completion.value ?? {};
    }
  } catch (error) {
    runtime.error_code = error?.code === "STARTUP_FIXTURE_NOT_STABLE" ? "INFRA_FAILURE" : error?.code ?? "RUNTIME_FAILURE";
    if (error?.code === "STARTUP_FIXTURE_NOT_STABLE") runtime.failure_reason = error.code;
    rawResult = { success: false, error_code: runtime.error_code };
  } finally {
    activeRuntime = profileHandle ? { run, handle: profileHandle } : null;
    try {
      gateEvidence = normalizeGateEvidence(await hooks.collectGateEvidence(run, profileHandle));
    } catch (error) {
      gateEvidence = normalizeGateEvidence({ source: `collection_error:${error?.code ?? "GATE_COLLECTION_FAILURE"}` });
    }
    try {
      telemetry = await hooks.collectTelemetry(run, profileHandle);
    } catch (error) {
      telemetry = { schema_version: 1, metrics: {}, sources: {}, collection_error: error?.code ?? "TELEMETRY_COLLECTION_FAILURE" };
    }
    try {
      if (profileHandle) {
        const stop = await hooks.stopProfile(run, profileHandle, runtime.timed_out ? "timeout" : "complete");
        runtime.stop_status = stop?.status ?? "OK";
      } else {
        runtime.stop_status = "NOT_STARTED";
      }
    } catch (error) {
      runtime.stop_status = "FAILED";
      runtime.stop_error_code = error?.code ?? "STOP_FAILURE";
      runtime.error_code = "INFRA_FAILURE";
      rawResult = { ...rawResult, success: false, error_code: "INFRA_FAILURE" };
    }
  }
  fixtureAfter = captureFixtureState(run.fixture_root);
  fixtureDiff = classifyFixtureDiff(compareFixtureState(fixtureBaseline ?? fixtureAfter, run.fixture_root), run.fixture_root, startedAt);
  const endedAt = hooks.now();
  runtime.duration_ms = Math.max(0, endedAt - startedAt);
  if (rawResult.response_evidence) runtime.response_evidence = rawResult.response_evidence;
  const result = normalizeExecutionResult({ run, rawResult, telemetry, gateEvidence, fixtureDiff, durationMs: runtime.duration_ms, taskDurationMs: taskStartedAt === null ? null : Math.max(0, endedAt - taskStartedAt), modelCallStarted, timedOut: runtime.timed_out, runtimeError: runtime.error_code ? { code: runtime.error_code } : null });
  runtime.model_call_started = modelCallStarted;
  runtime.status = result.success === true && !runtime.timed_out && !runtime.error_code ? "COMPLETED" : runtime.timed_out ? "TIMEOUT" : runtime.error_code === "AUTH_FAILURE" ? "AUTH_FAILURE" : runtime.error_code === "INFRA_FAILURE" ? "INFRA_FAILURE" : "FAILED";
  const metadata = { ...run, started_at: new Date(startedAt).toISOString(), ended_at: new Date(endedAt).toISOString(), evidence_files: Object.fromEntries(EVIDENCE_FILES.map((name) => [name, join(run.evidence_root, `${name}.json`)])) };
  writeEvidence(run, "metadata", metadata);
  writeEvidence(run, "fixture-after", fixtureAfter);
  writeEvidence(run, "fixture-diff", fixtureDiff);
  writeEvidence(run, "result", result);
  writeEvidence(run, "telemetry", telemetry);
  writeEvidence(run, "gate-evidence", gateEvidence);
  writeEvidence(run, "runtime-summary", runtime);
  if (rawResult.response_evidence) writeEvidence(run, "assistant-response", rawResult.response_evidence);
  if (runtime.stop_status === "FAILED" && profileHandle) {
    try { await hooks.forceCleanup(run, profileHandle); } catch (error) { runtime.force_cleanup_error_code = error?.code ?? "FORCE_CLEANUP_FAILED"; }
  }
  if (activeRuntime?.run?.root === run.root) activeRuntime = null;
  return { run, result, telemetry, gateEvidence, fixtureDiff, runtime };
}

export function currentGitCommit(deps = {}) {
  const runner = deps.spawnSync ?? spawnSync;
  const result = runner("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function createGenerationRoot(generation, prefix = "opencode-daily-generation-") {
  const root = mkdtempSync(join(tmpdir(), `${prefix}${generation}-`));
  for (const path of ["runs", "dependencies"]) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  return root;
}

function rowForOutcome(outcome) {
  return {
    schema_version: 1,
    generation: outcome.run.generation,
    sequence: outcome.run.sequence,
    task_index: outcome.run.task_index,
    task_id: outcome.run.task_id,
    variant: outcome.run.variant,
    profile: outcome.run.profile,
    evidence_root: outcome.run.evidence_root,
    run_root: outcome.run.root,
    runtime_status: outcome.runtime.status,
    result: outcome.result,
  };
}

function terminalValid(row) {
  if (!row || !Number.isSafeInteger(row.sequence) || !row.result) return false;
  const code = row.result.error_code;
  if (code === "INFRA_FAILURE" || code === "INTERRUPTED") return false;
  return ["COMPLETED", "FAILED", "TIMEOUT", "AUTH_FAILURE"].includes(row.runtime_status);
}

export async function executeBenchmark(options = {}) {
  const manifest = options.manifest ?? loadManifest(options.manifestPath);
  const selection = options.selection ?? loadSelection(options.selectionPath);
  const generation = Number(options.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generation_required");
  const errors = validateSelection(manifest, selection);
  if (errors.length) throw new Error(errors.join(","));
  if (options.dryRun) return { dry_run: true, output: renderDryRunPlan({ manifest, selection, generation }) };
  if (!options.real) throw new Error("real_execution_requires_--real");
  const generationRoot = options.generationRoot ? resolve(options.generationRoot) : createGenerationRoot(generation);
  mkdirSync(join(generationRoot, "runs"), { recursive: true, mode: 0o700 });
  const commit = options.commit ?? currentGitCommit(options.deps ?? {});
  const fingerprints = buildFingerprints({ manifest, selection, commit });
  const expectedState = {
    schema_version: 1,
    generation,
    suite_version: manifest.suite_version,
    package_version: manifest.package_version,
    selection_version: selection.selection_version,
    generation_root: generationRoot,
    stable_gen2_sequence_start: 0,
    fingerprints,
  };
  ensureCheckpointCompatible(generationRoot, expectedState, { resume: options.resume === true });
  const checkpoint = loadCheckpoint(generationRoot);
  const prior = new Map((checkpoint.results ?? []).map((row) => [row.sequence, row]));
  const sharedDependencyRoot = options.dependencyRoot ?? process.env.OPENCODE_TEAM_DEPENDENCY_ROOT ?? (process.env.OPENAI_DEPENDENCY_ROOT ? dirname(process.env.OPENAI_DEPENDENCY_ROOT) : join(generationRoot, "dependencies"));
  mkdirSync(sharedDependencyRoot, { recursive: true, mode: 0o700 });
  const runs = buildRunMatrix({ manifest, selection, generation }).map((run) => ({ ...run, dependency_root: sharedDependencyRoot }));
  const maxRuns = Number.isSafeInteger(options.maxRuns) ? options.maxRuns : null;
  const throughSequence = Number.isSafeInteger(options.throughSequence) ? options.throughSequence : null;
  const results = [...(checkpoint.results ?? [])];
  let executed = 0;
  activeCheckpointFlush = () => writeCheckpoint(generationRoot, expectedState, results);
  activeCheckpointFlush();
  for (const run of runs) {
    if (throughSequence !== null && run.sequence > throughSequence) break;
    if (maxRuns !== null && executed >= maxRuns) break;
    const existing = prior.get(run.sequence);
    if (terminalValid(existing)) continue;
    if (existing && !options.retryInfra) throw new Error(`resume_requires_explicit_retry_policy:${run.sequence}`);
    const runRoot = join(generationRoot, "runs", String(run.sequence).padStart(2, "0"));
    if (existing) rmSync(runRoot, { recursive: true, force: true });
    const outcome = await executeRun(run, { ...options, prepare: { ...(options.prepare ?? {}), root: runRoot } });
    const row = rowForOutcome(outcome);
    const index = results.findIndex((candidate) => candidate.sequence === row.sequence);
    if (index >= 0) results[index] = row;
    else results.push(row);
    prior.set(row.sequence, row);
    executed += 1;
    activeCheckpointFlush();
  }
  activeCheckpointFlush = null;
  return { dry_run: false, generation, generation_root: generationRoot, results };
}

export function parseArgs(argv) {
  const args = { command: argv[0] ?? "execute", selectionPath: DEFAULT_SELECTION, manifestPath: undefined, dryRun: false, real: false, resume: false, retryInfra: false };
  for (let index = 1; index < argv.length; index += 1) {
    const [rawKey, inline] = argv[index].split("=", 2);
    if (!rawKey.startsWith("--")) throw new Error(`unknown_argument:${argv[index]}`);
    const key = rawKey.slice(2).replaceAll("-", "_");
    if (["dry_run", "real", "resume", "retry_infra"].includes(key)) args[key === "dry_run" ? "dryRun" : key === "retry_infra" ? "retryInfra" : key] = true;
    else {
      const value = inline ?? argv[++index];
      if (!value) throw new Error(`missing_value:${rawKey}`);
      if (key === "selection") args.selectionPath = value;
      else if (key === "manifest") args.manifestPath = value;
      else if (key === "generation_root") args.generationRoot = value;
      else if (key === "generation") args.generation = Number(value);
      else if (key === "timeout_ms") args.timeoutMs = Number(value);
      else if (key === "max_runs") args.maxRuns = Number(value);
      else if (key === "through_sequence") args.throughSequence = Number(value);
      else throw new Error(`unknown_option:${rawKey}`);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command !== "execute") throw new Error("usage: daily-benchmark execute --selection <selection.json> --generation <n> [--dry-run|--real]");
  const result = await executeBenchmark(args);
  if (result.dry_run) process.stdout.write(result.output);
  else process.stdout.write(`${JSON.stringify({ schema_version: 1, generation: result.generation, generation_root: result.generation_root, runs: result.results.map((row) => ({ sequence: row.sequence, task_id: row.task_id, variant: row.variant, profile: row.profile, evidence_root: row.evidence_root, success: row.result?.success, runtime_status: row.runtime_status })) }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  installBenchmarkSignalHandlers();
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
