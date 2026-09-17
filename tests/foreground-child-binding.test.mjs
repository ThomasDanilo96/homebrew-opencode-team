import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bindExactChildReservation, childSessionIdFromAfter, foregroundChildSessionID, resolveTesterChildSessionID, reservationEligibleForSessionCreated, sessionCreatedCorrelationDecision } from "../teams/openai/config/opencode/reservation-correlation.js";
import { testerEvidenceFromMessages } from "../teams/openai/config/opencode/openai-team-tools.js";

const reservation = () => ({
  task_call_id: "call-1", task_fingerprint: "task-1", task_state_version: 7,
  task_lease_id: "lease-1", attempt: 2, packet_id: "packet-1", role: "codex_executor", master_parent_session_id: "parent-1", child_session_id: null,
});

test("foreground exact child binding is fenced, packet-persistent, and idempotent", async () => {
  const pending = reservation();
  const transitions = [];
  const packets = [];
  const order = [];
  const result = await bindExactChildReservation(pending, "child-1", {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async (value, state, patch) => {
      order.push("task");
      transitions.push({ value, state, patch });
      value.task_state_version += 1;
      return { ...value, state, version: value.task_state_version, child_session_id: patch.child_session_id };
    },
    updateWorkPacket: async (callID, patch) => { order.push("packet"); packets.push({ callID, patch }); return { callID, patch }; },
  });

  assert.equal(result.child_session_id, "child-1");
  assert.equal(pending.child_session_id, "child-1");
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0].patch, { child_session_id: "child-1" });
  assert.equal(transitions[0].state, "BOUND");
  assert.deepEqual(packets, [{ callID: "call-1", patch: { child_session_id: "child-1" } }]);
  assert.deepEqual(order, ["task", "packet"]);

  const backgroundPacket = [];
  await bindExactChildReservation(reservation(), "child-2", {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {},
    updateWorkPacket: async (callID, patch) => { backgroundPacket.push(patch); return { packet_id: "packet-1" }; },
    packetPatch: { phase: "background_bound", outcome: "running" },
  });
  assert.deepEqual(backgroundPacket, [{ child_session_id: "child-2", phase: "background_bound", outcome: "running" }]);

  const fencedAgain = [];
  const again = await bindExactChildReservation(pending, "child-1", {
    readTask: async () => ({ state: "BOUND", version: 8, child_session_id: "child-1", agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => fencedAgain.push(true),
    updateWorkPacket: async () => ({ packet_id: "packet-1" }),
  });
  assert.equal(again.child_session_id, "child-1");
   assert.equal(fencedAgain.length, 0);

  await assert.rejects(() => bindExactChildReservation({ ...reservation(), child_session_id: "child-2" }, "child-1", {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => {},
  }), /CHILD_SESSION_ID_CONFLICT/);
  await assert.rejects(() => bindExactChildReservation(reservation(), "child-1", {
    readTask: async () => ({ state: "BOUND", version: 7, child_session_id: "child-2", agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => {},
  }), /CHILD_SESSION_ID_CONFLICT/);

  const failedTransition = reservation();
  await assert.rejects(() => bindExactChildReservation(failedTransition, "child-1", {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => { throw new Error("fenced transition failed"); }, updateWorkPacket: async () => {},
  }), /fenced transition failed/);
  assert.equal(failedTransition.child_session_id, null);

  const failedPacket = reservation();
  await assert.rejects(() => bindExactChildReservation(failedPacket, "child-1", {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => { throw new Error("packet update failed"); },
  }), /packet update failed/);
  assert.equal(failedPacket.child_session_id, null);
  const nullPacket = reservation();
  await assert.rejects(() => bindExactChildReservation(nullPacket, "child-1", {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => null,
  }), /BINDING_PACKET_UPDATE_FAILED/);
  assert.equal(nullPacket.child_session_id, null);
  assert.equal(childSessionIdFromAfter({}), null);
  await assert.rejects(() => bindExactChildReservation(reservation(), childSessionIdFromAfter({}), {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => {},
  }), /BINDING_MISSING_CHILD/);
});

test("session.created correlation only treats authoritative identifiers as durable", () => {
  assert.equal(sessionCreatedCorrelationDecision({ background: false, candidateCallIDs: ["call-1"] }), "provisional");
  assert.equal(sessionCreatedCorrelationDecision({ background: false, explicitCallID: "call-1", candidateCallIDs: ["call-1"] }), "durable");
  assert.equal(sessionCreatedCorrelationDecision({ background: true, candidateCallIDs: ["call-1"] }), "durable");
  assert.equal(sessionCreatedCorrelationDecision({ background: true, explicitCallID: "other", candidateCallIDs: ["call-1"] }), "rejected");
  const provisional = { task_call_id: "call-1", provisional_child_session_id: "child-1" };
  assert.equal(reservationEligibleForSessionCreated(provisional), false);
  assert.equal(sessionCreatedCorrelationDecision({ background: false, candidateCallIDs: reservationEligibleForSessionCreated(provisional) ? ["call-1"] : [] }), "none");
});

test("tester finalization uses the durable child when after metadata is absent", () => {
  const pending = { child_session_id: "child-1", started_at: 1, verification_commands: ["node --test"] };
  assert.equal(foregroundChildSessionID({ ...pending, role: "tester" }, undefined), "child-1");
  assert.equal(resolveTesterChildSessionID(pending, undefined), "child-1");
  const command = "node --test";
  const evidence = testerEvidenceFromMessages([{ info: { sessionID: "child-1", role: "assistant", agent: "tester", created: 2 }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command }, metadata: { exit_code: 0 } } }] }], pending);
  assert.equal(evidence.summary.status, "passed");
  assert.throws(() => resolveTesterChildSessionID(pending, { sessionId: "other-child" }), /TEST_CHILD_SESSION_MISMATCH/);
  assert.throws(() => foregroundChildSessionID({ ...pending, role: "tester" }, { sessionId: "child-1", session_id: "other-child" }), /TEST_CHILD_SESSION_MISMATCH/);
});

test("exact after binding must match a provisional child", async () => {
  const pending = { ...reservation(), provisional_child_session_id: "child-1" };
  const options = {
    readTask: async () => ({ state: "ADMITTED", version: 7, child_session_id: null, agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => ({ packet_id: "packet-1" }),
  };
  await assert.rejects(() => bindExactChildReservation(pending, "child-2", options), /PROVISIONAL_CHILD_SESSION_ID_CONFLICT/);
  await bindExactChildReservation(pending, childSessionIdFromAfter({ sessionId: "child-1" }), options);
  assert.equal(pending.child_session_id, "child-1");
  assert.equal(pending.provisional_child_session_id, undefined);
});

test("background exact-after sequence binds before policy and routing side effects", async () => {
  const source = await readFile(new URL("../teams/openai/config/opencode/openai-team-tools.js", import.meta.url), "utf8");
  const sequence = source.slice(source.indexOf('const childID = childSessionIdFromAfter(output.metadata)'), source.indexOf('} catch (error) {', source.indexOf('const childID = childSessionIdFromAfter(output.metadata)')));
  const bind = sequence.indexOf("await bindExactChildReservation");
  const policy = sequence.indexOf("await ensurePolicy");
  const mapping = sequence.indexOf("packetCallBySession.set");
  assert.ok(bind >= 0 && bind < policy && bind < mapping);
});

test("completed exact binding is idempotent and still fences identity", async () => {
  const pending = reservation();
  let updates = 0;
  await bindExactChildReservation(pending, "child-1", {
    readTask: async () => ({ state: "COMPLETED", child_session_id: "child-1", agent: "codex_executor", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => { throw new Error("must not transition completed task"); },
    updateWorkPacket: async () => { updates++; return { packet_id: "packet-1" }; },
  });
  assert.equal(updates, 1);
  await assert.rejects(() => bindExactChildReservation(pending, "child-1", {
    readTask: async () => ({ state: "COMPLETED", child_session_id: "child-1", agent: "other", parent_session_id: "parent-1", packet_id: "packet-1", attempt: 2, lease_id: "lease-1" }),
    advanceTask: async () => {}, updateWorkPacket: async () => ({ packet_id: "packet-1" }),
  }), /BINDING_TASK_IDENTITY_MISMATCH/);
});
