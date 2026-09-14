import { basename, resolve } from "node:path";
import { lstat, rm } from "node:fs/promises";

export const handoffPathFromStdout = (stdout, stateRoot = process.env.OPENAI_TEAM_STATE_ROOT || "/tmp") => {
  const handoffRoot = resolve(stateRoot, "handoffs");
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.endsWith(".json") && resolve(line).startsWith(`${handoffRoot}/`)) || null;
};

export const removeConsumedArtifacts = async (handoffPath, stateRoot = process.env.OPENAI_TEAM_STATE_ROOT || "/tmp") => {
  if (typeof handoffPath !== "string") return false;
  const root = resolve(stateRoot), handoffs = resolve(root, "handoffs"), codex = resolve(root, "codex");
  const path = resolve(handoffPath);
  if (!path.startsWith(`${handoffs}/`) || !path.endsWith(".json")) return false;
  const run = basename(path, ".json");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(run)) return false;
  const targets = [path, ...["git-status", "git-diff", "git-cached-diff", "changed-files"].map((suffix) => resolve(handoffs, `${run}.${suffix}`)), resolve(codex, `${run}.jsonl`), resolve(codex, `${run}.stderr`)];
  for (const target of targets) {
    if (!(target === path || target.startsWith(`${handoffs}/`) || target.startsWith(`${codex}/`))) return false;
    try { const info = await lstat(target); if (info.isSymbolicLink() || !info.isFile()) continue; await rm(target, { force: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return true;
};

export const safeHandoffID = (handoff, path = null) => {
  const candidate = handoff?.codex_run_id || (path ? basename(path, ".json") : "");
  return typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(candidate) ? candidate : null;
};

const optionalString = (value) => value === null || typeof value === "string";
const safeIdentifier = (value, { nullable = false } = {}) => {
  if (nullable && value === null) return true;
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) &&
    !/(?:^|[\\/])(?:tmp|private|Users|home|var|workspace)(?:[\\/]|$)|(?:^|[\\/]).*(?:stderr|stdout|events?|git-(?:diff|status)|changed-files)(?:[.\\/_-]|$)/i.test(value);
};
const safeReason = (value) => value === null || (typeof value === "string" && /^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(value));
export const safeInvocationID = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const schema2Fields = new Set(["schema_version", "invocation_id", "codex_run_id", "thread_id", "parent_codex_run_id", "resume_count", "attempt", "exit_status", "reason", "provider_failure"]);
const schema3Fields = new Set(["schema_version", "invocation_id", "codex_run_id", "thread_id", "parent_codex_run_id", "model", "profile", "requested_model", "executed_model", "fallback_model", "fallback_reason", "fallback_count", "fallback_eligible", "cooldown_seconds", "resume_count", "attempt", "exit_status", "reason", "provider_failure", "mutation_count", "journal_incomplete", "termination_sealed", "journal_scan_complete", "sealed_run_id", "sealed_lease_id", "token_usage"]);
const tokenFields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"];
const validTokens = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === tokenFields.length && tokenFields.every((key) => Number.isInteger(value[key]) && value[key] >= 0));

export const validCodexHandoff = (handoff) => {
  const base = Boolean(handoff && [2, 3].includes(handoff.schema_version) &&
    typeof handoff.codex_run_id === "string" && handoff.codex_run_id.length > 0 &&
    Number.isInteger(handoff.exit_status) && typeof handoff.reason === "string" &&
    typeof handoff.provider_failure === "number" && (handoff.provider_failure === 0 || handoff.provider_failure === 1) &&
    optionalString(handoff.thread_id) && optionalString(handoff.parent_codex_run_id) &&
    Number.isInteger(handoff.resume_count) && handoff.resume_count >= 0 &&
    Number.isInteger(handoff.attempt) && handoff.attempt >= 1);
  if (!base) return false;
  const identifiersSafe = safeInvocationID(handoff.invocation_id) && safeIdentifier(handoff.codex_run_id) && safeIdentifier(handoff.thread_id, { nullable: true }) && safeIdentifier(handoff.parent_codex_run_id, { nullable: true }) && safeReason(handoff.reason);
  // Schema 2 is retained only for handoffs written by older lanes, with the
  // same boundary protection as current handoffs.
  if (handoff.schema_version === 2) return Object.keys(handoff).every((key) => schema2Fields.has(key)) && identifiersSafe;
  return Object.keys(handoff).every((key) => schema3Fields.has(key)) && identifiersSafe &&
    safeIdentifier(handoff.model) && safeIdentifier(handoff.profile) &&
    safeIdentifier(handoff.requested_model) && safeIdentifier(handoff.executed_model) &&
    safeIdentifier(handoff.fallback_model, { nullable: true }) && safeReason(handoff.fallback_reason) && safeReason(handoff.reason) &&
    Number.isInteger(handoff.fallback_count) && handoff.fallback_count >= 0 &&
    typeof handoff.fallback_eligible === "boolean" && Number.isInteger(handoff.cooldown_seconds) && handoff.cooldown_seconds >= 0 &&
    Number.isInteger(handoff.mutation_count) && handoff.mutation_count >= 0 && typeof handoff.journal_incomplete === "boolean" &&
    handoff.termination_sealed === true && typeof handoff.journal_scan_complete === "boolean" &&
    safeIdentifier(handoff.sealed_run_id) && handoff.sealed_run_id === handoff.codex_run_id &&
    safeIdentifier(handoff.sealed_lease_id, { nullable: true }) &&
    validTokens(handoff.token_usage);
};

// A syntactically valid handoff is not automatically evidence for this lane.
// Bind schema-three telemetry to the invocation that produced it before it can
// authorize either a fallback or a successful completion.  Schema two has no
// model telemetry, so retain it exclusively for old, non-fallback successes.
export const handoffMatchesInvocation = (handoff, invocation = {}) => {
  if (!validCodexHandoff(handoff)) return false;
  const fallbackCount = Number(invocation.fallback_count);
  const attempt = Number(invocation.attempt);
  if (!Number.isInteger(fallbackCount) || fallbackCount < 0 || !Number.isInteger(attempt) || attempt < 1) return false;
  if (handoff.schema_version !== 3 || !safeInvocationID(invocation.invocation_id)) return false;
  return handoff.invocation_id === invocation.invocation_id && handoff.profile === invocation.profile &&
    handoff.requested_model === invocation.requested_model &&
    handoff.model === invocation.executed_model &&
    handoff.executed_model === invocation.executed_model &&
    handoff.fallback_model === (invocation.fallback_model || null) &&
    handoff.fallback_count === fallbackCount && handoff.attempt === attempt;
};
