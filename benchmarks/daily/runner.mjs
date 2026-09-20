#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAILY_CONTRACT, OPENAI_CONTRACT, verifyDailyContract } from "./contract.mjs";
import { summarizeDailyPackets } from "../../teams/daily/bin/daily-report.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MANIFEST = join(ROOT, "benchmarks/daily/manifest.json");
const TIERS = ["TRIVIAL", "NORMAL", "COMPLEX", "HEAVY", "EXTREME"];
const numeric = ["wall_clock_ms", "time_to_first_meaningful_action_ms", "total_tokens", "input_tokens", "output_tokens", "cached_tokens", "estimated_cost", "delegation_count", "parallel_fanout_peak", "retry_count", "max_depth"];

export function loadManifest(path = MANIFEST) { return JSON.parse(readFileSync(path, "utf8")); }

export function validateManifest(manifest) {
  const errors = [];
  if (manifest.schema_version !== 1 || !manifest.suite_version) errors.push("schema");
  const seen = new Set();
  for (const task of manifest.tasks ?? []) {
    if (seen.has(task.task_id)) errors.push(`duplicate:${task.task_id}`);
    seen.add(task.task_id);
    for (const field of ["task_id", "tier", "type", "objective", "fixture", "verification", "expected_agent", "gates"]) if (!(field in task)) errors.push(`missing:${task.task_id}:${field}`);
    if (!TIERS.includes(task.tier)) errors.push(`tier:${task.task_id}`);
    if (!Array.isArray(task.verification) || !task.verification.length) errors.push(`verification:${task.task_id}`);
    if (!Array.isArray(task.gates)) errors.push(`gates:${task.task_id}`);
  }
  for (const tier of TIERS) if ((manifest.tiers?.[tier] ?? []).length !== (manifest.tasks ?? []).filter((task) => task.tier === tier).length) errors.push(`tier-count:${tier}`);
  return errors;
}

export function createIsolatedRunRoot(prefix = "opencode-daily-benchmark-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const name of ["config", "data", "state", "cache", "runtime", "worktrees", "logs"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

export function prepareTasks(manifest, profile, selected = manifest.tasks) {
  const root = createIsolatedRunRoot();
  const tasks = selected.map((task) => {
    const worktree = join(root, "worktrees", task.task_id, profile);
    cpSync(join(ROOT, "benchmarks/daily/fixtures"), worktree, { recursive: true });
    return { task_id: task.task_id, tier: task.tier, objective: task.objective, verification: task.verification, profile, fixture: task.fixture, worktree, start_timestamp: null, end_timestamp: null, status: "prepared", raw_metrics: null };
  });
  const metadata = { schema_version: 1, suite_version: manifest.suite_version, package_version: manifest.package_version, profile, root, homes: { config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), cache: join(root, "cache"), runtime: join(root, "runtime") }, tasks };
  writeFileSync(join(root, "benchmark.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return metadata;
}

export function normalizeResult(result = {}) {
  const normalized = {};
  for (const name of numeric) normalized[name] = Number.isFinite(result[name]) && result[name] >= 0 ? result[name] : null;
  for (const name of ["success", "tester_required", "tester_launched", "review_required", "gate_order_correct", "final_success_only_after_required_gates"]) normalized[name] = typeof result[name] === "boolean" ? result[name] : null;
  for (const name of ["objective_classification", "profile", "codex_profile", "codex_primary_model", "reviewer_type", "tester_result", "review_result", "error_code", "tester_skip_classification", "review_skip_classification", "premature_finalization_classification"]) normalized[name] = typeof result[name] === "string" ? result[name] : null;
  normalized.subagent_types_used = Array.isArray(result.subagent_types_used) ? result.subagent_types_used.filter((name) => typeof name === "string" && name !== "title" && name !== "undefined") : [];
  normalized.model_mix = result.model_mix && typeof result.model_mix === "object" ? Object.fromEntries(["Luna", "Terra", "Sol", "other"].map((model) => [model, Number.isFinite(result.model_mix[model]) && result.model_mix[model] >= 0 ? result.model_mix[model] : 0])) : { Luna: 0, Terra: 0, Sol: 0, other: 0 };
  normalized.successful_subagents = Number.isSafeInteger(result.successful_subagents) ? result.successful_subagents : null;
  normalized.failed_subagents = Number.isSafeInteger(result.failed_subagents) ? result.failed_subagents : null;
  normalized.retried_subagents = Number.isSafeInteger(result.retried_subagents) ? result.retried_subagents : null;
  normalized.quality = result.quality && typeof result.quality === "object" ? result.quality : {};
  return normalized;
}

const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
export function aggregate(results) {
  const rows = results.map(normalizeResult);
  const quality = { pass: rows.filter((row) => row.success === true).length, partial: rows.filter((row) => row.success === null || row.success === undefined).length, fail: rows.filter((row) => row.success === false).length };
  const value = (name) => rows.map((row) => row[name]).filter(Number.isFinite);
  return { count: rows.length, quality, wall_clock_ms: { median: percentile(value("wall_clock_ms"), 0.5), p95: percentile(value("wall_clock_ms"), 0.95) }, totals: Object.fromEntries(numeric.filter((name) => name !== "wall_clock_ms").map((name) => [name, value(name).length ? value(name).reduce((a, b) => a + b, 0) : null])), missing_metrics: numeric.filter((name) => value(name).length !== rows.length), model_calls: Object.fromEntries(["Luna", "Terra", "Sol", "other"].map((model) => [model, rows.reduce((count, row) => count + (row.model_mix[model] ?? 0), 0)])), gates: { tester_required: rows.filter((row) => row.tester_required === true).length, tester_pass: rows.filter((row) => row.tester_result === "PASS").length, tester_fail: rows.filter((row) => row.tester_result === "FAIL").length, tester_skipped_incorrectly: rows.filter((row) => row.tester_skip_classification === "REAL_TESTER_SKIP").length, unknown_tester_launch: rows.filter((row) => row.tester_required === true && row.tester_launched === null).length, review_required: rows.filter((row) => row.review_required === true).length, review_pass: rows.filter((row) => row.review_result === "PASS").length, review_reject: rows.filter((row) => row.review_result === "REJECT").length, review_skipped_incorrectly: rows.filter((row) => row.review_skip_classification === "REAL_REVIEW_SKIP").length, final_success_before_gate: rows.filter((row) => row.premature_finalization_classification === "REAL_PREMATURE_FINALIZATION").length, unknown_finalization: rows.filter((row) => row.final_success_only_after_required_gates === null).length } };
}

function fixturePath(root, path) {
  const resolvedRoot = realpathSync(root);
  const candidate = resolve(root, path);
  const resolvedCandidate = realpathSync(candidate);
  const escaped = relative(resolvedRoot, resolvedCandidate).startsWith("..") || isAbsolute(relative(resolvedRoot, resolvedCandidate));
  if (escaped) throw new Error(`symlink_escape:${path}`);
  return resolvedCandidate;
}

function fixtureEntries(root, current = "") {
  const directory = join(root, current);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    const absolute = join(root, path);
    if (entry.isDirectory()) return fixtureEntries(root, path);
    const stat = lstatSync(absolute);
    if (entry.isSymbolicLink()) fixturePath(root, path);
    const content = stat.isFile() ? readFileSync(absolute) : Buffer.from(`${stat.mode}:${entry.isSymbolicLink() ? realpathSync(absolute) : "special"}`);
    return [{ path, type: entry.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "special", sha256: createHash("sha256").update(content).digest("hex"), mode: stat.mode & 0o7777 }];
  });
}

export function captureFixtureState(root) {
  const resolvedRoot = realpathSync(root);
  return { root: resolvedRoot, files: Object.fromEntries(fixtureEntries(resolvedRoot).map((entry) => [entry.path, entry])) };
}

export function compareFixtureState(baseline, root) {
  const current = captureFixtureState(root);
  const before = baseline.files;
  const after = current.files;
  const changed = Object.keys(after).filter((path) => before[path] && (before[path].sha256 !== after[path].sha256 || before[path].mode !== after[path].mode)).sort();
  const added = Object.keys(after).filter((path) => !before[path]).sort();
  const deleted = Object.keys(before).filter((path) => !after[path]).sort();
  return { changed, added, deleted, outside_fixture: [] };
}

export function establishTaskBaselines(metadata) {
  const tasks = metadata.tasks.map((task) => ({ ...task, fixture_baseline: captureFixtureState(task.worktree) }));
  const updated = { ...metadata, tasks };
  writeFileSync(join(metadata.root, "benchmark.json"), `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return updated;
}

export function scoreTaskFixture(task) {
  if (!task.fixture_baseline) throw new Error(`missing_fixture_baseline:${task.task_id}`);
  return compareFixtureState(task.fixture_baseline, task.worktree);
}

export function groupResults(results, field) {
  return Object.fromEntries([...new Set(results.map((result) => result[field]).filter(Boolean))].sort().map((value) => [value, aggregate(results.filter((result) => result[field] === value))]));
}

export function externalEvidenceStatus(path = process.env.OPENAI_DAILY_BENCHMARK_RESULTS) {
  if (!path) return { status: "BLOCKED", reason: "missing_OPENAI_DAILY_BENCHMARK_RESULTS", path: null };
  if (!existsSync(path)) return { status: "BLOCKED", reason: "external_results_file_missing", path };
  return { status: "AVAILABLE_UNVALIDATED", reason: null, path: resolve(path) };
}

export function buildReport({ manifest = loadManifest(), results = [], profile = "daily", evidence = externalEvidenceStatus() } = {}) {
  const contract = verifyDailyContract();
  const telemetryRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  const packetDirectory = telemetryRoot ? join(telemetryRoot, "work-packets") : null;
  const packetFiles = packetDirectory && existsSync(packetDirectory) ? readdirSync(packetDirectory).filter((name) => name.endsWith(".json")) : [];
  const packets = packetFiles.flatMap((name) => { try { return [JSON.parse(readFileSync(join(packetDirectory, name), "utf8"))]; } catch { return []; } });
  return { schema_version: 1, suite_version: manifest.suite_version, package_version: manifest.package_version, generated_at: new Date().toISOString(), environment: { os: process.platform, arch: process.arch, node: process.version, opencode: process.env.OPENCODE_VERSION ?? null, omo: process.env.OMO_VERSION ?? null, codex: process.env.CODEX_VERSION ?? null, git_commit: process.env.BENCHMARK_GIT_COMMIT ?? null, home: homedir() }, contracts: { daily: { ...DAILY_CONTRACT, verified: contract }, openai: OPENAI_CONTRACT }, profile, tasks_defined: manifest.tasks.length, task_results: results.map((result) => ({ ...result, raw_metrics: normalizeResult(result) })), aggregates: { overall: aggregate(results), by_tier: groupResults(results, "tier"), by_profile: groupResults(results, "profile") }, comparison: { daily: aggregate(results.filter((result) => result.profile === "daily")), openai: aggregate(results.filter((result) => result.profile === "openai")) }, telemetry: { source: packetDirectory, packet_count: packets.length, daily_report: packets.length ? summarizeDailyPackets(packets) : null }, external_evidence: { ...evidence, gate: { required_env: "OPENAI_DAILY_BENCHMARK_RESULTS", required_schema_version: 1, required_variants: ["control", "treatment"], required_decision: "accept" } }, certification: evidence.status === "BLOCKED" ? "BLOCKED_EXTERNAL_EVIDENCE" : "UNASSESSED" };
}

export function renderMarkdown(report) {
  const lines = [`# DAILY Benchmark Certification`, ``, `- Suite: ${report.suite_version}`, `- Package: ${report.package_version}`, `- Profile: ${report.profile}`, `- Tasks defined: ${report.tasks_defined}`, `- Certification: ${report.certification}`, `- External evidence: ${report.external_evidence.status}`, ``, `## Aggregate`, ``, "```json", JSON.stringify(report.aggregates, null, 2), "```", ``, `## DAILY vs OPENAI`, ``, "```json", JSON.stringify(report.comparison, null, 2), "```", ``, `## Telemetry`, ``, `- Existing daily-report packet count: ${report.telemetry.packet_count}`, `- Existing daily-report source: ${report.telemetry.source ?? "unavailable"}`, ``, `## Contract`, ``, `- DAILY verified: ${report.contracts.daily.verified.passed}`, `- Contract fingerprint: ${report.contracts.daily.verified.fingerprint}`, `- External evidence path: ${report.external_evidence.path ?? "unavailable"}`, ``];
  return `${lines.join("\n")}\n`;
}

function selectTasks(manifest, args) { return manifest.tasks.filter((task) => (!args.tier || task.tier === args.tier.toUpperCase()) && (!args.task || task.task_id === args.task)); }
function parseArgs(argv) { const args = { command: argv[0] ?? "validate" }; const flags = new Set(["markdown"]); for (let i = 1; i < argv.length; i += 1) { const [key, inline] = argv[i].split("=", 2); if (key.startsWith("--")) { const name = key.slice(2).replaceAll("-", "_"); args[name] = flags.has(name) ? true : inline ?? argv[++i]; } } return args; }
function main(argv) { const args = parseArgs(argv), manifest = loadManifest(args.manifest); if (args.command === "list") return process.stdout.write(`${manifest.tasks.map((task) => `${task.tier}\t${task.task_id}\t${task.type}`).join("\n")}\n`); const errors = [...validateManifest(manifest), ...(!verifyDailyContract().passed ? ["daily-contract"] : [])]; if (args.command === "validate") { if (errors.length) throw new Error(errors.join(",")); return process.stdout.write(`DAILY BENCHMARK HARNESS VALID\nTASKS=${manifest.tasks.length}\nMAX_COMPARATIVE_RUNS=${manifest.tasks.length * 2}\n`); } if (args.command === "prepare") { const selected = selectTasks(manifest, args); const metadata = prepareTasks(manifest, args.profile ?? "daily", selected); return process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`); } if (args.command === "report") { const report = buildReport({ manifest, profile: args.profile ?? "daily", results: args.input ? JSON.parse(readFileSync(args.input, "utf8")) : [] }); const output = args.output ?? "-"; if (output === "-") return process.stdout.write(args.markdown ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`); writeFileSync(output, args.markdown ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); return; } throw new Error("usage: daily-benchmark list|validate|prepare|report"); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) { try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; } }
