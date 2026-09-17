import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkPacket, updateWorkPacketByID } from "../teams/openai/config/opencode/work-packet.js";
import { gateTerminalPacketPatch, lifecycleCleanupOptions } from "../teams/openai/config/opencode/gate-state.js";

test("idle cleanup is packet/task neutral", () => {
  assert.deepEqual(lifecycleCleanupOptions("session.idle", { packet: true, taskAction: "complete", terminal: false }), {
    packet: false, taskAction: null, terminal: false,
  });
});

test("gate success preserves review and not-required tester status", () => {
  const patch = gateTerminalPacketPatch({ review_status: "approved", tester_status: "not_required" });
  assert.equal(patch.review_status, "approved");
  assert.equal(patch.tester_status, "not_required");
  assert.equal(patch.codex_outcome, "success");
});

test("gate success settles only an actually required tester", () => {
  assert.equal(gateTerminalPacketPatch({ review_status: "not_required", tester_status: "pending" }).tester_status, "passed");
  assert.equal(gateTerminalPacketPatch({ review_status: "pending", tester_status: "not_required" }).review_status, "approved");
});

test("canonical packet update does not double-hash packet ID", async () => {
  const state = await mkdtemp(join(tmpdir(), "gate-packet-"));
  process.env.OPENAI_TEAM_STATE_ROOT = state;
  try {
    const rawCall = "raw-call-id";
    const created = await createWorkPacket(rawCall, { agent: "codex_executor" });
    const updated = await updateWorkPacketByID(created.packet_id, { phase: "pending_verification", outcome: "pending", codex_outcome: "success" });
    assert.equal(updated.packet_id, created.packet_id);
    assert.equal(updated.outcome, "pending");
    assert.equal((await readdir(join(state, "work-packets"))).filter((name) => name === `${created.packet_id}.json`).length, 1);
    assert.equal(await readFile(join(state, "work-packets", `${created.packet_id}.json`), "utf8").then(JSON.parse).then((p) => p.codex_outcome), "success");
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("tester failure is terminal failure and never success", () => {
  const patch = gateTerminalPacketPatch({ tester_status: "failed" }, false);
  assert.equal(patch.outcome, "failed");
  assert.equal(patch.codex_outcome, "failed");
  assert.notEqual(patch.outcome, "completed");
});
