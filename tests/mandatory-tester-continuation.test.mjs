import test from "node:test";
import assert from "node:assert/strict";
import { driveMandatoryTesterContinuation } from "../teams/openai/config/opencode/openai-team-tools.js";
import { isInternalContinuation } from "../teams/openai/config/opencode/openai-guardrails.js";

const root = "root-session";
const packetID = "a".repeat(64);
const task = { task_fingerprint: "task", state: "PENDING_VERIFICATION", attempt: 1, lease_id: "lease", parent_session_id: root };
const gate = () => ({ packet_id: packetID, parent_session_id: root, task_fingerprint: "task", attempt: 1, task_lease_id: "lease", tester_required: true, tester_status: "pending", codex_outcome: "success", outcome: "pending", phase: "pending_verification" });
const depsFor = (packets, extra = {}) => ({
  listWorkPackets: async () => packets,
  readTask: async () => task,
  updateWorkPacketByIDIfCurrent: async (_id, expected, fields) => {
    const current = packets.find((packet) => packet.packet_id === packetID);
    const matched = Object.entries(expected).every(([key, value]) => (Array.isArray(value) ? value.includes(current[key]) : current[key] === value));
    if (matched) Object.assign(current, fields);
    return { matched, packet: current };
  },
  ...extra,
});

test("mandatory continuation enqueues once in the canonical root", async () => {
  const packets = [gate()];
  const prompts = [];
  const result = await driveMandatoryTesterContinuation(root, depsFor(packets, { enqueue: async (_id, text) => prompts.push(text) }));
  assert.equal(result.status, "requested");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /<!-- OMO_INTERNAL_INITIATOR -->/);
  assert.match(prompts[0], new RegExp(`MANDATORY_TESTER_GATE.*test_task_id=${packetID}`));
  assert.equal(isInternalContinuation(prompts[0]), true);
});

test("existing tester admission suppresses continuation", async () => {
  const packets = [gate(), { parent_session_id: root, agent: "tester", test_task_id: packetID, outcome: "running" }];
  let prompts = 0;
  const result = await driveMandatoryTesterContinuation(root, depsFor(packets, { enqueue: async () => prompts++ }));
  assert.equal(result.status, "existing");
  assert.equal(prompts, 0);
});

test("requested dispatch fails once without looping", async () => {
  const packet = { ...gate(), tester_dispatch_state: "requested" };
  const packets = [packet];
  let failures = 0;
  const deps = depsFor(packets, { fail: async () => { failures++; } });
  await driveMandatoryTesterContinuation(root, deps);
  await driveMandatoryTesterContinuation(root, deps);
  assert.equal(failures, 1);
});

test("tester admission and PASS keep later idle a no-op", async () => {
  const packet = gate();
  const packets = [packet];
  let prompts = 0;
  const deps = depsFor(packets, { enqueue: async () => prompts++ });
  await driveMandatoryTesterContinuation(root, deps);
  packets.push({ parent_session_id: root, agent: "tester", test_task_id: packetID, outcome: "completed", tester_status: "passed", verification_status: "completed" });
  Object.assign(packet, { outcome: "completed", phase: "foreground_completion", tester_status: "passed", verification_status: "completed" });
  const result = await driveMandatoryTesterContinuation(root, deps);
  assert.equal(result.status, "noop");
  assert.equal(prompts, 1);
  assert.equal(packets[1].tester_status, "passed");
});
