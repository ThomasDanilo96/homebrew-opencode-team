import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkPacket, updateWorkPacketByID } from "../teams/openai/config/opencode/work-packet.js";
import { gateTerminalPacketPatch, lifecycleCleanupOptions } from "../teams/openai/config/opencode/gate-state.js";
import { beginRequestCycle, createGuardrailState, recoverRootRequestState, settleVerificationGateState, verificationGateDecision } from "../teams/openai/config/opencode/openai-guardrails.js";

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

test("tester settlement clears the mandatory gate only after PASS or FAIL is terminal", () => {
  const packetID = "c".repeat(64);
  const pending = { ...createGuardrailState(), pendingVerificationPacketID: packetID, pendingTesterActive: true };
  const pass = gateTerminalPacketPatch({ review_status: "approved", tester_status: "pending" }, true);
  assert.equal(pass.outcome, "completed");
  assert.equal(pass.tester_status, "passed");
  assert.equal(settleVerificationGateState(pending, packetID, "RUNNING").pendingVerificationPacketID, packetID);
  assert.equal(settleVerificationGateState(pending, packetID, "COMPLETED").pendingVerificationPacketID, null);
  const fail = gateTerminalPacketPatch({ tester_status: "failed" }, false);
  assert.equal(fail.outcome, "failed");
  assert.equal(fail.codex_outcome, "failed");
  assert.equal(settleVerificationGateState(pending, packetID, "FAILED").pendingTesterActive, false);
});

test("recovered root preserves and enforces the Codex tester gate", () => {
  const rootSessionID = "R";
  const childSessionID = "C";
  const packetID = "p".repeat(64);
  const codexTerminal = {
    ...createGuardrailState(),
    objective: `Codex objective for ${rootSessionID}`,
    authoritativeObjective: `Codex objective for ${rootSessionID}`,
    pendingVerificationPacketID: packetID,
    pendingTesterActive: false,
    codex_outcome: "CODEX_SUCCESS",
    tester_required: true,
    child_session_id: childSessionID,
  };
  const recovered = recoverRootRequestState(codexTerminal, codexTerminal.objective, 2);

  assert.equal(recovered.pendingVerificationPacketID, packetID);
  assert.equal(recovered.pendingTesterActive, false);
  assert.equal(verificationGateDecision(recovered, "bash", "openai_orchestrator", "printf ok").reason, "MANDATORY_TESTER_GATE");
  assert.equal(verificationGateDecision(recovered, "task", "tester", `verify test_task_id=${packetID}`).allowed, true);
  assert.equal(verificationGateDecision({ ...recovered, pendingTesterActive: true }, "task", "tester", `verify test_task_id=${packetID}`).reason, "TESTER_ALREADY_ACTIVE");

  const settled = settleVerificationGateState(recovered, packetID, "COMPLETED");
  const completed = gateTerminalPacketPatch({ review_status: "approved", tester_status: "pending" }, true);
  assert.equal(settled.pendingVerificationPacketID, null);
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.tester_status, "passed");
  assert.equal(verificationGateDecision(settled, "bash", "openai_orchestrator", "printf ok").allowed, true);
  assert.equal(beginRequestCycle(settled, "new genuine request", 3).pendingVerificationPacketID, null);
});
