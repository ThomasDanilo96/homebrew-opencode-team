import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reconcileRepositoryRecovery } from "../teams/openai/config/opencode/codex-recovery-reconcile.js";
import { readRecovery, reconcileRecovery, saveRecovery } from "../teams/openai/config/opencode/codex-recovery.js";

const evidenceRun = ({ unsafe = false } = {}) => async (_file, args) => {
  const command = args.join(" ");
  if (command === "rev-parse --show-toplevel") return { status: 0, stdout: "/fixture\n" };
  if (command === "rev-parse HEAD") return { status: 0, stdout: "abc123\n" };
  if (command.startsWith("status ")) return { status: 0, stdout: " M calculator.js\n?? calculator.test.js\n" };
  if (command.startsWith("diff --name-status")) return { status: 0, stdout: "M\tcalculator.js\nA\tcalculator.test.js\n" };
  if (command.startsWith("diff --check")) return { status: unsafe ? 1 : 0, stdout: "", stderr: unsafe ? "whitespace" : "" };
  throw new Error(`unexpected git command: ${command}`);
};

test("recovery evidence distinguishes verified completion from continuation", async () => {
  const common = {
    repository: "/fixture",
    baselineHead: "abc123",
    baselineDirty: false,
    expectedRepository: "/fixture",
    journalIncomplete: true,
    mutationCount: 2,
    journalCommandHashes: ["b".repeat(64)],
    run: evidenceRun(),
  };
  assert.equal((await reconcileRepositoryRecovery({ ...common, implementationComplete: true })).state, "RECOVERY_VERIFIED_COMPLETE");
  assert.equal((await reconcileRepositoryRecovery({ ...common, implementationComplete: false })).state, "RECOVERY_CONTINUATION_REQUIRED");
});

test("recovery blocks ambiguous baseline, missing journal, and unsafe evidence", async () => {
  const base = { repository: "/fixture", run: evidenceRun() };
  assert.equal((await reconcileRepositoryRecovery({ ...base, baselineHead: null })).state, "RECOVERY_BLOCKED_UNSAFE");
  assert.equal((await reconcileRepositoryRecovery({ ...base, baselineHead: "abc123", journalIncomplete: true, journalCommandHashes: [] })).reason, "journal_commands_missing");
  assert.equal((await reconcileRepositoryRecovery({ ...base, baselineHead: "abc123", journalIncomplete: true, journalCommandHashes: ["not-a-hash"] })).reason, "journal_hashes_invalid");
  assert.equal((await reconcileRepositoryRecovery({ ...base, baselineHead: "abc123", journalIncomplete: false, journalCommandHashes: ["b".repeat(64)], run: evidenceRun({ unsafe: true }) })).reason, "git_diff_check_failed");
});

test("recovery record reconciliation is authoritative and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-recovery-record-"));
  const previous = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_TEAM_STATE_ROOT = root;
  const fingerprint = "a".repeat(64);
  try {
    const initial = await saveRecovery(fingerprint, {
      attempt: 1, thread_id: "thread-1", codex_run_id: "run-1", task_lease_id: "lease-1",
      journal_incomplete: true, command_journal: ["b".repeat(64)], state: "interrupted",
    });
    const reconciled = await reconcileRecovery(fingerprint, { expectedVersion: initial.version, reason: "RECOVERY_CONTINUATION_REQUIRED" });
    assert.equal(reconciled.journal_incomplete, false);
    assert.deepEqual(reconciled.command_journal, []);
    const replay = await reconcileRecovery(fingerprint, { expectedVersion: reconciled.version, reason: "RECOVERY_CONTINUATION_REQUIRED" });
    assert.equal(replay.version, reconciled.version);
    assert.equal((await readRecovery(fingerprint)).state, "RECOVERY_CONTINUATION_REQUIRED");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
