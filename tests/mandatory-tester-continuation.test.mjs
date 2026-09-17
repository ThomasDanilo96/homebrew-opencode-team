import test from "node:test";
import assert from "node:assert/strict";
import { createMandatoryTesterRootDriver, driveMandatoryTesterContinuation, observeMandatoryTesterContinuation } from "../teams/openai/config/opencode/openai-team-tools.js";
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

const productionDriverFor = (packets, prompts, failures = []) => createMandatoryTesterRootDriver({
  pluginInput: {
    listWorkPackets: async () => packets,
    readTask: async () => task,
    updateWorkPacketByIDIfCurrent: depsFor(packets).updateWorkPacketByIDIfCurrent,
    client: { session: { promptAsync: async (request) => { prompts.push(request); } } },
  },
  updateWorkPacketByID: async (_id, fields) => Object.assign(packets[0], fields),
  reconcileGateTarget: async () => undefined,
  ...(failures ? { updateWorkPacketByID: async (_id, fields) => { failures.push(fields.error_code); Object.assign(packets[0], fields); } } : {}),
});

test("codex after-hook path immediately prompts the canonical root once with the exact task ID", async () => {
  const packets = [gate()];
  const prompts = [], driver = productionDriverFor(packets, prompts);
  const result = await driver(root, { failRequested: false });
  assert.equal(result.status, "requested");
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].path, { id: root });
  assert.equal(prompts[0].body.agent, "openai_orchestrator");
  const text = prompts[0].body.parts[0].text;
  assert.match(text, new RegExp(`MANDATORY_TESTER_GATE.*test_task_id=${packetID}`));
  assert.equal(isInternalContinuation(text), true);
});

test("duplicate after-hook calls are suppressed by the packet CAS", async () => {
  const packets = [gate()], prompts = [], driver = productionDriverFor(packets, prompts);
  await driver(root, { failRequested: false });
  await driver(root, { failRequested: false });
  assert.equal(prompts.length, 1);
});

test("existing tester admission suppresses continuation", async () => {
  const packets = [gate(), { parent_session_id: root, agent: "tester", test_task_id: packetID, outcome: "running" }];
  const prompts = [], driver = productionDriverFor(packets, prompts);
  const result = await driver(root, { failRequested: false });
  assert.equal(result.status, "existing");
  assert.equal(prompts.length, 0);
});

test("same-turn idle waits, then observed idle fails requested dispatch once without prompting again", async () => {
  const packet = { ...gate(), tester_dispatch_state: "requested" };
  const packets = [packet];
  const prompts = [], failures = [];
  const driver = createMandatoryTesterRootDriver({
    pluginInput: { ...depsFor(packets), client: { session: { promptAsync: async (request) => prompts.push(request) } } },
    updateWorkPacketByID: async (_id, fields) => { failures.push(fields.error_code); Object.assign(packet, fields); },
    reconcileGateTarget: async () => undefined,
  });
  const sameTurnIdle = await driver(root, { failRequested: false });
  assert.equal(sameTurnIdle.status, "waiting");
  assert.equal(prompts.length, 0);
  assert.equal(failures.length, 0);
  observeMandatoryTesterContinuation(root, packetID);
  const observedIdle = await driver(root, { failRequested: true });
  assert.equal(observedIdle.status, "failed");
  assert.equal(failures.length, 1);
  assert.equal(prompts.length, 0);
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

test("existing terminal tester PASS settles the gate without another prompt", async () => {
  const packet = gate();
  const packets = [packet, { parent_session_id: root, agent: "tester", test_task_id: packetID, outcome: "completed", tester_status: "passed", verification_status: "completed" }];
  const prompts = [], driver = productionDriverFor(packets, prompts);
  Object.assign(packet, { outcome: "completed", phase: "foreground_completion", tester_status: "passed", verification_status: "completed" });
  const result = await driver(root, { failRequested: true });
  assert.equal(result.status, "noop");
  assert.equal(prompts.length, 0);
  assert.equal(packet.tester_status, "passed");
});
