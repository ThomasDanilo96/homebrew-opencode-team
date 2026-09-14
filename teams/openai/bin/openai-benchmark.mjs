#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const required = ['task_id', 'objective', 'repository_fixture_description', 'classification', 'acceptance_criteria', 'focused_verification_commands', 'correctness_evaluator', 'expected_agent', 'risk', 'tags'];
const unsafeCommand = /(?:^|\s)(?:rm|mv|cp|dd|sudo|chmod|chown|truncate|mkfs|kill|pkill|git\s+(?:reset|clean|checkout|restore|commit|push|rebase))(?:\s|$)|(?:;|&&|\|\||\||>|<|`|\$\(|\$\{|&)/;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 2;
}

function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('E_MANIFEST_READ');
    return null;
  }
}

function validate(manifest) {
  if (!manifest || manifest.schema_version !== 1) return 'E_SCHEMA_VERSION';
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length < 3) return 'E_SCENARIOS';
  const taskIds = new Set();
  for (const scenario of manifest.scenarios) {
    if (!scenario || typeof scenario !== 'object') return 'E_SCENARIO';
    for (const field of required) {
      if (!(field in scenario)) return field === 'acceptance_criteria' ? 'E_MISSING_ACCEPTANCE_CRITERIA' : 'E_MISSING_FIELD';
      if (typeof scenario[field] === 'string' && !scenario[field].trim()) return 'E_MISSING_FIELD';
    }
    if (taskIds.has(scenario.task_id)) return 'E_DUPLICATE_TASK_ID';
    taskIds.add(scenario.task_id);
    if (!Array.isArray(scenario.acceptance_criteria) || scenario.acceptance_criteria.length === 0) return 'E_MISSING_ACCEPTANCE_CRITERIA';
    if (scenario.correctness_threshold !== undefined && (!Number.isFinite(scenario.correctness_threshold) || scenario.correctness_threshold < 0 || scenario.correctness_threshold > 1)) return 'E_QUALITY_THRESHOLD';
    if (!Array.isArray(scenario.focused_verification_commands) || scenario.focused_verification_commands.length === 0) return 'E_EMPTY_VALIDATORS';
    if (!scenario.focused_verification_commands.every((command) => typeof command === 'string' && command.trim() && !unsafeCommand.test(command))) return 'E_UNSAFE_VERIFICATION_COMMAND';
    if (!Array.isArray(scenario.tags) || scenario.tags.length === 0) return 'E_MISSING_FIELD';
  }
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

const metadataFields = ['model', 'model_version', 'reasoning_effort', 'config_fingerprint', 'prompt_policy_version', 'code_revision', 'environment_fingerprint', 'timestamp'];
const metadataEnvironment = Object.freeze({
  model: 'BENCHMARK_MODEL', model_version: 'BENCHMARK_MODEL_VERSION', reasoning_effort: 'BENCHMARK_REASONING_EFFORT', config_fingerprint: 'BENCHMARK_CONFIG_FINGERPRINT', prompt_policy_version: 'BENCHMARK_PROMPT_POLICY_VERSION', code_revision: 'BENCHMARK_CODE_REVISION', environment_fingerprint: 'BENCHMARK_ENVIRONMENT_FINGERPRINT', timestamp: 'BENCHMARK_TIMESTAMP', warmup: 'BENCHMARK_WARMUP',
});
const unsafeMetadata = /(?:^|[-_])(api[-_]?key|secret|token|password)(?:$|[-_])|\bsk-[a-z0-9]{8,}\b|[\\/]|~|\$|\r|\n/i;
const safeMetadata = /^[a-z0-9][a-z0-9._:-]*$/;

function normalizeMetadataValue(value) {
  const normalized = String(value ?? 'unknown').trim().toLowerCase() || 'unknown';
  return !unsafeMetadata.test(normalized) && safeMetadata.test(normalized) ? normalized : null;
}

function normalizeWarmup(value) {
  if (value === undefined || value === null || value === '') return false;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return null;
}

function executionMetadata(options = {}) {
  const metadata = {};
  for (const field of metadataFields) {
    const value = normalizeMetadataValue(options[field] ?? process.env[metadataEnvironment[field]]);
    if (value === null) return null;
    metadata[field] = value;
  }
  metadata.warmup = normalizeWarmup(options.warmup ?? process.env.BENCHMARK_WARMUP);
  return metadata.warmup === null ? null : metadata;
}

function validExecutionMetadata(record) {
  return metadataFields.every((field) => typeof record[field] === 'string' && record[field] === normalizeMetadataValue(record[field])) && typeof record.warmup === 'boolean';
}

function executionIdentity(record) { return canonical(Object.fromEntries(metadataFields.map((field) => [field, record[field]]))); }
function executionIdentityFields(record) { return Object.fromEntries(metadataFields.map((field) => [field, record[field]])); }

const quantitativeNames = ['duration_ms', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'cost', 'retry_count', 'tool_call_count', 'compaction_count', 'wrapper_round_trips'];
const metricNames = ['success', 'correctness_score', 'required_checks', ...quantitativeNames, 'agent', 'classification', 'complexity', 'reasoning_effort', 'reviewer_outcome', 'error_code'];
const totalNames = quantitativeNames.filter((name) => name !== 'duration_ms');
const efficiencyNames = ['duration_ms', 'uncached_input_tokens', 'cost', 'retry_count', 'wrapper_round_trips'];

function readJson(path, code) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail(code); return null; }
}

function readJsonl(path, prefix) {
  let input;
  try { input = readFileSync(path, 'utf8'); } catch { fail(`${prefix}_READ`); return null; }
  const lines = input.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { records.push(JSON.parse(lines[index])); } catch { fail(`${prefix}_LINE_${index + 1}`); return null; }
  }
  return records;
}

function validResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.schema_version !== undefined && result.schema_version !== 1) return false;
  if (typeof result.success !== 'boolean') return false;
  if (!Number.isFinite(result.correctness_score) || result.correctness_score < 0 || result.correctness_score > 1) return false;
  for (const name of ['duration_ms', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'cost']) if (result[name] !== null && (!Number.isFinite(result[name]) || result[name] < 0)) return false;
  for (const name of ['retry_count', 'tool_call_count', 'compaction_count', 'wrapper_round_trips']) if (result[name] !== null && (!Number.isSafeInteger(result[name]) || result[name] < 0)) return false;
  if (!Object.hasOwn(result, 'required_checks') || !result.required_checks || typeof result.required_checks !== 'object' || Array.isArray(result.required_checks) || !Object.values(result.required_checks).every((passed) => typeof passed === 'boolean')) return false;
  return ['agent', 'classification', 'complexity', 'reasoning_effort', 'reviewer_outcome', 'error_code'].every((name) => typeof result[name] === 'string' && result[name].trim());
}

function identity(record) { return `${record.benchmark_run_id}\u0000${record.task_id}\u0000${record.variant}\u0000${record.attempt}`; }
function validQualityRequirements(value) { return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.required_checks) && value.required_checks.length > 0 && value.required_checks.every((check) => typeof check === 'string' && check.trim()) && (value.correctness_threshold === null || Number.isFinite(value.correctness_threshold) && value.correctness_threshold >= 0 && value.correctness_threshold <= 1); }
function validIdentity(record) { return record && record.schema_version === 1 && typeof record.benchmark_run_id === 'string' && record.benchmark_run_id && typeof record.cohort === 'string' && record.cohort && typeof record.manifest_version === 'string' && record.manifest_version && typeof record.scenario_version === 'string' && record.scenario_version && record.seed_policy === 'sha256-seeded-paired-v1' && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.task_id === 'string' && record.task_id && ['control', 'treatment'].includes(record.variant) && Number.isSafeInteger(record.attempt) && record.attempt >= 1 && validQualityRequirements(record.quality_requirements) && validExecutionMetadata(record); }
function number(value) { return Number(value.toFixed(6)); }
function quantile(values, percentile) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]; }

function aggregate(records) {
  const count = records.length;
  const measured = (name) => records.map((record) => record[name]).filter(Number.isFinite);
  const sum = (name) => { const values = measured(name); return values.length ? values.reduce((total, value) => total + value, 0) : null; };
  const duration = measured('duration_ms');
  const cachePairs = records.filter((record) => Number.isFinite(record.uncached_input_tokens) && Number.isFinite(record.cached_input_tokens));
  const uncached = cachePairs.reduce((total, record) => total + record.uncached_input_tokens, 0);
  const cached = cachePairs.reduce((total, record) => total + record.cached_input_tokens, 0);
  const summary = {
    count,
    success_rate: number(records.filter((record) => record.success).length / count),
    avg_correctness: number(records.reduce((total, record) => total + record.correctness_score, 0) / count),
    required_check_success_rate: number(records.flatMap((record) => Object.values(record.required_checks)).filter(Boolean).length / records.reduce((total, record) => total + Object.keys(record.required_checks).length, 0)),
    median_duration_ms: duration.length ? number(quantile(duration, 0.5)) : null,
    p95_duration_ms: duration.length ? number(quantile(duration, 0.95)) : null,
    cache_ratio: cachePairs.length ? number(cached / (uncached + cached || 1)) : null,
  };
  for (const name of quantitativeNames) summary[name] = sum(name);
  for (const name of quantitativeNames) summary[`${name}_measured_count`] = measured(name).length;
  summary.cache_ratio_measured_count = cachePairs.length;
  return summary;
}

function compareResults(records, sampleCounts) {
  const tasks = [...new Set(records.map((record) => record.task_id))].sort();
  const byVariant = (task, variant) => records.filter((record) => record.variant === variant && (task === null || record.task_id === task));
  const reasons = [];
  const taskRows = {};
  for (const task of tasks) {
    const control = byVariant(task, 'control');
    const treatment = byVariant(task, 'treatment');
    if (!control.length || !treatment.length) reasons.push(`E_MISSING_VARIANT:${task}`);
    else {
      const attempts = [...new Set([...control, ...treatment].map((r) => r.attempt))].sort((a, b) => a - b);
      for (const attempt of attempts) if (!control.some((r) => r.attempt === attempt) || !treatment.some((r) => r.attempt === attempt)) reasons.push(`E_MISSING_PAIR:${task}:${attempt}`);
    }
    if (control.length && treatment.length) taskRows[task] = { control: aggregate(control), treatment: aggregate(treatment) };
  }
  const control = aggregate(byVariant(null, 'control'));
  const treatment = aggregate(byVariant(null, 'treatment'));
  const floorFor = (variant) => {
    const variantRecords = byVariant(null, variant);
    const failures = [];
    for (const record of variantRecords) {
      const requiredChecks = record.quality_requirements.required_checks;
      if (!record.required_checks || requiredChecks.some((check) => record.required_checks[check] !== true)) failures.push({ task_id: record.task_id, attempt: record.attempt, reason: 'required_checks' });
      if (record.quality_requirements.correctness_threshold !== null && record.correctness_score < record.quality_requirements.correctness_threshold) failures.push({ task_id: record.task_id, attempt: record.attempt, reason: 'correctness_threshold' });
    }
    return { eligible: failures.length === 0, failures };
  };
  const quality_floor = { control: floorFor('control'), treatment: floorFor('treatment') };
  quality_floor.eligible = quality_floor.control.eligible && quality_floor.treatment.eligible;
  const quality = [['success_rate', 'E_QUALITY_SUCCESS_RATE'], ['avg_correctness', 'E_QUALITY_CORRECTNESS'], ['required_check_success_rate', 'E_QUALITY_REQUIRED_CHECKS']];
  let qualityImproved = false, qualityRegression = false;
  for (const [name, regression] of quality) {
    if (treatment[name] < control[name]) { reasons.push(regression); qualityRegression = true; }
    if (treatment[name] > control[name]) { reasons.push(`QUALITY_IMPROVEMENT:${name === 'avg_correctness' ? 'correctness_score' : name}`); qualityImproved = true; }
  }
  const pairedMeasurementsAvailable = (name) => {
    const controlRecords = byVariant(null, 'control');
    const treatmentRecords = byVariant(null, 'treatment');
    if (controlRecords.length !== treatmentRecords.length) return false;
    return controlRecords.every((controlRecord) => {
      const treatmentRecord = treatmentRecords.find((record) => record.task_id === controlRecord.task_id && record.attempt === controlRecord.attempt);
      return Number.isFinite(controlRecord[name]) && treatmentRecord && Number.isFinite(treatmentRecord[name]);
    });
  };
  const missing_metrics = quantitativeNames.filter((name) => !pairedMeasurementsAvailable(name));
  const missingEfficiency = efficiencyNames.filter((name) => missing_metrics.includes(name));
  let efficiencyImproved = false;
  if (!qualityImproved && !qualityRegression && !missingEfficiency.length) {
    for (const name of efficiencyNames) {
      if (treatment[name] < control[name]) efficiencyImproved = true;
      if (treatment[name] > control[name] && (control[name] === 0 || (treatment[name] - control[name]) / control[name] > 0.1)) reasons.push(`E_EFFICIENCY_REGRESSION:${name}`);
    }
    if (!efficiencyImproved) reasons.push('E_NO_EFFICIENCY_IMPROVEMENT');
  } else if (!qualityImproved && !qualityRegression && missingEfficiency.length) reasons.push(`E_UNMEASURED_EFFICIENCY:${missingEfficiency.join(',')}`);
  const identities = Object.fromEntries(['control', 'treatment'].map((variant) => [variant, executionIdentityFields(records.find((record) => record.variant === variant))]));
  const identity_differences = metadataFields.filter((field) => records.find((record) => record.variant === 'control')[field] !== records.find((record) => record.variant === 'treatment')[field]);
  const measurement_confidence = missing_metrics.length || records.some((record) => metadataFields.some((field) => record[field] === 'unknown')) ? 'limited' : 'high';
  let decision;
  if (qualityRegression) decision = 'reject';
  else if (!quality_floor.eligible) decision = 'inconclusive_quality_floor';
  else if (qualityImproved) decision = 'accept';
  else if (missingEfficiency.length) decision = 'inconclusive_unmeasured';
  else decision = reasons.length ? 'reject' : 'accept';
  return { schema_version: 1, decision, winner: decision === 'accept' ? 'treatment' : null, reasons, quality_floor, measurement_confidence, missing_metrics, sample_counts: sampleCounts, identity_differences, execution_identities: identities, overall: { control, treatment }, tasks: taskRows };
}

function renderCompare(report) {
  const header = 'scope\tvariant\tcount\tsuccess_rate\tavg_correctness\tmedian_duration_ms\tp95_duration_ms\tuncached_input_tokens\tcached_input_tokens\toutput_tokens\treasoning_tokens\tcost\tretry_count\ttool_call_count\tcompaction_count\twrapper_round_trips\tcache_ratio';
  const printable = (value) => value === null ? 'unknown' : value;
  const row = (scope, variant, summary) => [scope, variant, summary.count, summary.success_rate, summary.avg_correctness, summary.median_duration_ms, summary.p95_duration_ms, ...totalNames.map((name) => summary[name]), summary.cache_ratio].map(printable).join('\t');
  const rows = [header, row('overall', 'control', report.overall.control), row('overall', 'treatment', report.overall.treatment)];
  for (const task of Object.keys(report.tasks)) { rows.push(row(task, 'control', report.tasks[task].control), row(task, 'treatment', report.tasks[task].treatment)); }
  return `${canonical(report)}\n${rows.join('\n')}\n`;
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lockOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    return owner && typeof owner.token === 'string' && owner.token && Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isFinite(owner.created_at) ? owner : null;
  } catch { return null; }
}
function ownerIsLive(owner) {
  if (!owner) return false;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
function reclaimDeadLock(lock, token) {
  const claim = `${lock}.claim-${token}`;
  try { linkSync(lock, claim); } catch { return false; }
  try {
    const owner = lockOwner(claim);
    let source, claimed;
    try { source = statSync(lock); claimed = statSync(claim); } catch { return false; }
    if (source.ino !== claimed.ino || source.dev !== claimed.dev || ownerIsLive(owner)) return false;
    try { unlinkSync(lock); } catch {}
    return true;
  } finally { try { unlinkSync(claim); } catch {} }
}
function withLock(resultsPath, fn) {
  const waitMs = Number(process.env.BENCHMARK_LOCK_WAIT_MS);
  const lock = `${resultsPath}.lock`, token = randomUUID(), deadline = Date.now() + (Number.isSafeInteger(waitMs) && waitMs > 0 ? waitMs : 5000);
  while (true) {
    try { writeFileSync(lock, JSON.stringify({ token, pid: process.pid, created_at: Date.now() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); break; } catch {
      if (reclaimDeadLock(lock, token)) continue;
      if (Date.now() >= deadline) return fail('E_RESULTS_LOCK_TIMEOUT');
      pause(20);
    }
  }
  const holdMs = Number(process.env.BENCHMARK_LOCK_HOLD_MS);
  if (Number.isSafeInteger(holdMs) && holdMs > 0) pause(holdMs);
  try { return fn(); } finally {
    const owner = lockOwner(lock);
    if (owner?.token === token) { try { unlinkSync(lock); } catch {} }
  }
}

function record(assignmentPath, taskId, variant, resultPath, resultsPath) {
  const assignments = readJsonl(assignmentPath, 'E_ASSIGNMENT_JSONL');
  const result = readJson(resultPath, 'E_RESULT_READ');
  if (!assignments || !result) return;
  if (!validResult(result)) return fail('E_RESULT_METRICS');
  const matches = assignments.filter((assignment) => validIdentity(assignment) && assignment.task_id === taskId && assignment.variant === variant);
  if (matches.length !== 1) return fail(matches.length ? 'E_ASSIGNMENT_DUPLICATE' : 'E_ASSIGNMENT_NOT_FOUND');
  const recordValue = { schema_version: 1, benchmark_run_id: matches[0].benchmark_run_id, cohort: matches[0].cohort, manifest_version: matches[0].manifest_version, scenario_version: matches[0].scenario_version, seed_policy: matches[0].seed_policy, sequence: matches[0].sequence, quality_requirements: matches[0].quality_requirements, task_id: taskId, variant, attempt: matches[0].attempt, ...Object.fromEntries([...metadataFields, 'warmup'].map((field) => [field, matches[0][field]])) };
  for (const name of metricNames) if (result[name] !== undefined) recordValue[name] = result[name];
  try { mkdirSync(dirname(resultsPath), { recursive: true, mode: 0o700 }); } catch { return fail('E_RESULTS_WRITE'); }
  withLock(resultsPath, () => {
    const prior = existsSync(resultsPath) ? readJsonl(resultsPath, 'E_RESULTS_JSONL') : [];
    if (!prior) return;
    for (let index = 0; index < prior.length; index += 1) {
      if (!validIdentity(prior[index]) || !validResult(prior[index])) return fail(`E_RESULTS_METRICS_LINE_${index + 1}`);
      if (identity(prior[index]) === identity(recordValue)) return fail('E_DUPLICATE_RESULT');
    }
    try { appendFileSync(resultsPath, `${canonical(recordValue)}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { return fail('E_RESULTS_WRITE'); }
    process.stdout.write('BENCHMARK RESULT RECORDED\n');
  });
}

function compare(path) {
  const records = readJsonl(path, 'E_RESULTS_JSONL');
  if (!records) return;
  const seen = new Set();
  for (let index = 0; index < records.length; index += 1) {
    if (!validIdentity(records[index]) || !validResult(records[index])) return fail(`E_RESULTS_METRICS_LINE_${index + 1}`);
    const key = identity(records[index]);
    if (seen.has(key)) return fail('E_DUPLICATE_RESULT');
    seen.add(key);
  }
  if (!records.length) return fail('E_RESULTS_EMPTY');
  const cohort = records[0].cohort, run = records[0].benchmark_run_id, manifest = records[0].manifest_version, policy = records[0].seed_policy;
  if (records.some((r) => r.cohort !== cohort)) return fail('E_MIXED_COHORT');
  if (records.some((r) => r.benchmark_run_id !== run)) return fail('E_MIXED_BENCHMARK_RUN');
  if (records.some((r) => r.manifest_version !== manifest || r.seed_policy !== policy)) return fail('E_MIXED_SCHEMA');
  const scenarioVersions = new Map();
  for (const record of records) {
    const prior = scenarioVersions.get(record.task_id);
    if (prior !== undefined && prior !== record.scenario_version) return fail('E_MIXED_SCHEMA');
    scenarioVersions.set(record.task_id, record.scenario_version);
  }
  for (const variant of ['control', 'treatment']) if (new Set(records.filter((record) => record.variant === variant).map(executionIdentity)).size > 1) return fail('E_MIXED_IDENTITY');
  const analyzed = records.filter((record) => !record.warmup);
  if (!analyzed.length) return fail('E_RESULTS_EMPTY');
  const taskIds = [...new Set(analyzed.map((record) => record.task_id))].sort();
  for (const taskId of taskIds) {
    const variants = new Set(analyzed.filter((record) => record.task_id === taskId).map((record) => record.variant));
    if (!variants.has('control') || !variants.has('treatment')) return fail(`E_MISSING_VARIANT:${taskId}`);
  }
  process.stdout.write(renderCompare(compareResults(analyzed, { recorded: records.length, analyzed: analyzed.length, warmups_excluded: records.length - analyzed.length })));
}

const rawArgs = process.argv.slice(2);
const command = rawArgs.shift();
const helpText = 'Usage: openai-benchmark <command> [arguments]\nCommands:\n  validate <manifest.json>\n  assign <manifest.json> <seed> [--model <value> --model-version <value> --reasoning-effort <value> --config-fingerprint <value> --prompt-policy-version <value> --code-revision <value> --environment-fingerprint <value> --timestamp <value> --warmup <true|false>]\n  record <assignments.jsonl> <task_id> <control|treatment> <result.json> <results.jsonl>\n  compare <results.jsonl>\nResult fields: success, correctness_score, required_checks, duration_ms, uncached_input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost, retry_count, tool_call_count, compaction_count, wrapper_round_trips, agent, classification, complexity, reasoning_effort, reviewer_outcome, error_code. Quantitative fields may be null only when unavailable; quality fields are required.\n';
if (command === '--help' || command === '-h') {
  process.stdout.write(helpText);
  process.exit(0);
}
const options = {};
const positionals = [];
const optionNames = new Set(['model', 'model_version', 'reasoning_effort', 'config_fingerprint', 'prompt_policy_version', 'code_revision', 'environment_fingerprint', 'timestamp', 'warmup']);
let optionError = false;
while (rawArgs.length) {
  const argument = rawArgs.shift();
  if (!argument.startsWith('--')) { positionals.push(argument); continue; }
  const [rawName, inline] = argument.slice(2).split('=', 2);
  const name = rawName.replaceAll('-', '_');
  if (!optionNames.has(name) || Object.hasOwn(options, name)) { optionError = true; break; }
  const value = inline === undefined ? rawArgs.shift() : inline;
  if (value === undefined || value.startsWith('--')) { optionError = true; break; }
  options[name] = value;
}
const [manifestPath, seed, fourth, fifth, sixth] = positionals;
if (optionError) {
  fail('E_USAGE');
} else if (command === 'record' && manifestPath && seed && fourth && fifth && sixth && positionals.length === 5) {
  record(manifestPath, seed, fourth, fifth, sixth);
} else if (command === 'compare' && manifestPath && positionals.length === 1) {
  compare(manifestPath);
} else if (!['validate', 'assign'].includes(command) || !manifestPath || positionals.length !== (command === 'assign' ? 2 : 1)) {
  fail('E_USAGE');
} else {
  const manifest = load(manifestPath);
  const error = manifest && validate(manifest);
  if (error) fail(error);
  else if (manifest) {
    if (command === 'validate') process.stdout.write('BENCHMARK MANIFEST VALID\n');
    else {
      const metadata = executionMetadata(options);
      if (!metadata) fail('E_METADATA_UNSAFE');
      else {
        const manifestVersion = String(manifest.schema_version), cohort = hash(canonical(manifest)).slice(0, 24), runId = hash(`${cohort}\n${seed}`).slice(0, 24);
        const ordered = manifest.scenarios.flatMap((scenario) => ['control', 'treatment'].map((variant) => ({ task_id: scenario.task_id, variant, scenario_version: hash(canonical(scenario)).slice(0, 24), quality_requirements: { required_checks: scenario.acceptance_criteria, correctness_threshold: Number.isFinite(scenario.correctness_threshold) ? scenario.correctness_threshold : null }, rank: hash(`${seed}\n${scenario.task_id}\n${variant}`) }))).sort((a, b) => a.rank.localeCompare(b.rank));
        for (let sequence = 0; sequence < ordered.length; sequence += 1) { const entry = ordered[sequence]; process.stdout.write(`${JSON.stringify({ schema_version: 1, benchmark_run_id: runId, cohort, manifest_version: manifestVersion, scenario_version: entry.scenario_version, seed_policy: 'sha256-seeded-paired-v1', sequence, task_id: entry.task_id, variant: entry.variant, attempt: 1, quality_requirements: entry.quality_requirements, ...metadata })}\n`); }
      }
    }
  }
}
