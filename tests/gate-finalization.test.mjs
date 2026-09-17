import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createWorkPacket, readWorkPacketByID, updateWorkPacketByID } from "../teams/openai/config/opencode/work-packet.js";
import { claimTask, transitionTask } from "../teams/openai/config/opencode/task-state.js";
import { gateTerminalPacketPatch, lifecycleCleanupOptions } from "../teams/openai/config/opencode/gate-state.js";
import { beginRequestCycle, createGuardrailState, recoverRootRequestState, settleVerificationGateState, verificationGateDecision } from "../teams/openai/config/opencode/openai-guardrails.js";
import { enforcePendingMandatoryTesterGate, findPendingMandatoryTesterGate } from "../teams/openai/config/opencode/openai-team-tools.js";

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

const durableGateFixture = async (rootSessionID = "R", resolve = true) => {
  const rawCallID = `durable-gate-${Math.random()}`;
  const taskFingerprint = createHash("sha256").update(`task-${rootSessionID}-${rawCallID}`).digest("hex");
  const packet = await createWorkPacket(rawCallID, {
    parent_session_id: rootSessionID, tester_required: true, tester_status: "pending",
    task_fingerprint: taskFingerprint, codex_outcome: "success",
  });
  const claim = await claimTask({ task_fingerprint: taskFingerprint, objective_sha256: "e".repeat(64), parent_session_id: rootSessionID, agent: "codex_executor", first_call_id: rawCallID, packet_id: rawCallID });
  const task = await transitionTask(taskFingerprint, {
    expectedVersion: claim.record.version, expectedAttempt: claim.record.attempt, expectedLease: claim.record.lease_id,
    leaseId: claim.record.lease_id, expectedStates: ["CLAIMED"], patch: { state: "PENDING_VERIFICATION" },
  });
  await updateWorkPacketByID(packet.packet_id, { phase: "PENDING_VERIFICATION", outcome: "pending", codex_outcome: "success", attempt: task.attempt, task_lease_id: task.lease_id });
  return { packet: resolve ? await findPendingMandatoryTesterGate(rootSessionID) : await readWorkPacketByID(packet.packet_id), task };
};

test("durable pending tester gate is found without a latch and enforces production task policy", async () => {
  const state = await mkdtemp(join(tmpdir(), "durable-gate-"));
  process.env.OPENAI_TEAM_STATE_ROOT = state;
  try {
    const { packet } = await durableGateFixture("durable-root");
    assert.ok(packet);
    assert.equal(enforcePendingMandatoryTesterGate(packet, { tool: "bash", agent: "openai_orchestrator", prompt: "printf ok" }).reason, "MANDATORY_TESTER_GATE");
    const injected = enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", prompt: "run verification" });
    assert.equal(injected.allowed, true);
    assert.match(injected.prompt, new RegExp(`test_task_id=${packet.packet_id}`));
    assert.equal(enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", prompt: `test_task_id=${"f".repeat(64)}` }).reason, "MANDATORY_TESTER_GATE");
    assert.equal(enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "specialist", prompt: "run verification" }).reason, "MANDATORY_TESTER_GATE");
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("two durable pending tester gates are ambiguous", async () => {
  const state = await mkdtemp(join(tmpdir(), "durable-ambiguous-"));
  process.env.OPENAI_TEAM_STATE_ROOT = state;
  try {
    await durableGateFixture("ambiguous-root");
    await durableGateFixture("ambiguous-root", false);
    await assert.rejects(() => findPendingMandatoryTesterGate("ambiguous-root"), (error) => error.code === "OPENAI_GUARDRAIL_AMBIGUOUS_MANDATORY_TESTER_GATE");
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("terminal tester PASS and FAIL remove the durable gate", async () => {
  const state = await mkdtemp(join(tmpdir(), "durable-terminal-"));
  process.env.OPENAI_TEAM_STATE_ROOT = state;
  try {
    const pass = await durableGateFixture("pass-root");
    const passPatch = gateTerminalPacketPatch({ tester_status: "pending", review_status: "approved" }, true);
    await updateWorkPacketByID(pass.packet.packet_id, passPatch);
    await transitionTask(pass.task.task_fingerprint, { expectedVersion: pass.task.version, expectedAttempt: pass.task.attempt, expectedLease: pass.task.lease_id, leaseId: pass.task.lease_id, expectedStates: ["PENDING_VERIFICATION"], patch: { state: "COMPLETED" } });
    assert.equal(await findPendingMandatoryTesterGate("pass-root"), null);
    assert.equal(verificationGateDecision(createGuardrailState(), "bash", "openai_orchestrator", "printf ok").allowed, true);

    const fail = await durableGateFixture("fail-root");
    const failPatch = gateTerminalPacketPatch({ tester_status: "failed" }, false);
    const failedPacket = await updateWorkPacketByID(fail.packet.packet_id, failPatch);
    await transitionTask(fail.task.task_fingerprint, { expectedVersion: fail.task.version, expectedAttempt: fail.task.attempt, expectedLease: fail.task.lease_id, leaseId: fail.task.lease_id, expectedStates: ["PENDING_VERIFICATION"], patch: { state: "FAILED" } });
    assert.equal(await findPendingMandatoryTesterGate("fail-root"), null);
    assert.equal(failedPacket.outcome, "failed");
    assert.notEqual(failedPacket.outcome, "completed");
  } finally { await rm(state, { recursive: true, force: true }); }
});
