import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRuntimeStatus } from "../teams/openai/config/opencode/openai-team-tools.js";

test("runtime status writer records authoritative child binding and fences stale terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-runtime-status-"));
  const runtimeRoot = join(root, "runtime");
  const runDir = join(runtimeRoot, "runs", "abcdef12");
  await mkdir(runDir, { recursive: true });
  const previousRoot = process.env.RUNTIME_ROOT;
  const previousRun = process.env.RUNTIME_RUN_STATE_DIR;
  process.env.RUNTIME_ROOT = runtimeRoot;
  process.env.RUNTIME_RUN_STATE_DIR = runDir;
  try {
    assert.equal(await writeRuntimeStatus({ status: "WAITING_CHILD", stage: "codex_executor", active_child_session_id: "ses_child_1", active_child_agent: "codex_executor" }), true);
    assert.equal(await readFile(join(runDir, "active_child_session_id"), "utf8").then((value) => value.trim()), "ses_child_1");
    assert.equal(await writeRuntimeStatus({ status: "RUNNING", stage: "root_processing", active_child_session_id: null, active_child_agent: null }, { expectedChildSessionID: "ses_stale" }), false);
    assert.equal(await readFile(join(runDir, "active_child_session_id"), "utf8").then((value) => value.trim()), "ses_child_1");
    assert.equal(await writeRuntimeStatus({ status: "RUNNING", stage: "root_processing", active_child_session_id: null, active_child_agent: null }, { expectedChildSessionID: "ses_child_1" }), true);
    assert.equal(await writeRuntimeStatus({ status: "WAITING_CHILD", stage: "codex_executor", active_child_session_id: "ses_child_1", active_child_agent: "codex_executor" }), false);
  } finally {
    if (previousRoot === undefined) delete process.env.RUNTIME_ROOT; else process.env.RUNTIME_ROOT = previousRoot;
    if (previousRun === undefined) delete process.env.RUNTIME_RUN_STATE_DIR; else process.env.RUNTIME_RUN_STATE_DIR = previousRun;
    await rm(root, { recursive: true, force: true });
  }
});
