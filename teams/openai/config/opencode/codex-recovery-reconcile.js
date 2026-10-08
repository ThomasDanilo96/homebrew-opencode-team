import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bounded = (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const hashPattern = /^[a-f0-9]{64}$/i;
const knownReasons = new Set(["rev_parse_toplevel_failed", "rev_parse_head_failed", "repository_identity_mismatch", "baseline_missing", "baseline_was_dirty", "git_status_failed", "git_diff_name_status_failed", "git_diff_check_failed", "head_advanced", "repository_delta_empty", "journal_commands_missing", "journal_hashes_invalid", "non_local_side_effect_evidence", "path_parse_failed"]);

const nativeRun = async (file, args, options = {}) => {
  try {
    const result = await execFileAsync(file, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { status: Number.isInteger(error?.status) ? error.status : 1, stdout: error?.stdout || "", stderr: error?.stderr || error?.message || "" };
  }
};

const git = async (run, repository, args, failureReason) => {
  const result = await run("git", args, { cwd: repository });
  if (!result || result.status !== 0) throw new Error(failureReason);
  return String(result.stdout || "");
};

export const reconcileRepositoryRecovery = async ({
  repository,
  baselineHead,
  baselineDirty = false,
  expectedRepository = null,
  journalIncomplete = false,
  mutationCount = 0,
  journalCommandHashes = [],
  implementationComplete = false,
  run = nativeRun,
} = {}) => {
  const fail = (reason) => ({ state: "RECOVERY_BLOCKED_UNSAFE", result: "blocked_unsafe", reason: bounded(reason) });
  if (typeof repository !== "string" || !repository) return fail("repository_missing");
  let realpath;
  try {
    realpath = (await git(run, repository, ["rev-parse", "--show-toplevel"], "rev_parse_toplevel_failed")).trim();
    if (!realpath) return fail("path_parse_failed");
    const currentHead = (await git(run, realpath, ["rev-parse", "HEAD"], "rev_parse_head_failed")).trim();
    if (expectedRepository && expectedRepository !== realpath) return fail("repository_identity_mismatch");
    if (!baselineHead || baselineDirty === true) return fail(!baselineHead ? "baseline_missing" : "baseline_was_dirty");
    if (currentHead !== baselineHead) return fail("head_advanced");
    const status = await git(run, realpath, ["status", "--porcelain=v1", "--untracked-files=all"], "git_status_failed");
    const names = await git(run, realpath, ["diff", "--name-status", baselineHead], "git_diff_name_status_failed");
    await git(run, realpath, ["diff", "--check", baselineHead], "git_diff_check_failed");
    if (!status.trim() || !names.trim()) return fail("repository_delta_empty");
    if (journalIncomplete && (!Array.isArray(journalCommandHashes) || journalCommandHashes.length === 0)) return fail("journal_commands_missing");
    if (journalCommandHashes.some((hash) => !hashPattern.test(String(hash)))) return fail("journal_hashes_invalid");
    const changedPaths = names.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 2) throw new Error("path_parse_failed");
      return fields.at(-1);
    }).filter(Boolean);
    if (changedPaths.length === 0) return fail("repository_delta_empty");
    return {
      state: implementationComplete ? "RECOVERY_VERIFIED_COMPLETE" : "RECOVERY_CONTINUATION_REQUIRED",
      result: implementationComplete ? "verified_complete" : "continuation_required",
      reason: implementationComplete ? "repository_delta_verified" : "repository_delta_requires_continuation",
      repository: realpath,
      baseline_head: baselineHead,
      current_head: currentHead,
      changed_paths: changedPaths.slice(0, 32),
      mutation_count: Math.max(0, Number(mutationCount) || 0),
      command_journal_representation: "hashes",
    };
  } catch (error) {
    const reason = String(error?.message || "unexpected_exception");
    return fail(knownReasons.has(reason) ? reason : `unexpected_exception:${bounded(error?.code || error?.name || "unknown", 64)}`);
  }
};
