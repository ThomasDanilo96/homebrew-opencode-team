import test from "node:test";
import assert from "node:assert/strict";
import { createMandatoryTesterRootDriver, driveMandatoryTesterContinuation, observeMandatoryTesterContinuation, retainParentCallReservation, enforcePendingMandatoryTesterGate, mandatoryTesterDispatchTrigger } from "../teams/openai/config/opencode/openai-team-tools.js";
import { isInternalContinuation } from "../teams/openai/config/opencode/openai-guardrails.js";

const root = "root-session";
const packetID = "a".repeat(64);
const task = { task_fingerprint: "task", state: "PENDING_VERIFICATION", attempt: 1, lease_id: "lease", parent_session_id: root };
const gate = (id = packetID, parent = root) => ({ packet_id: id, test_task_id: id, parent_session_id: parent, task_fingerprint: "task", attempt: 1, task_lease_id: "lease", tester_required: true, tester_status: "pending", codex_outcome: "success", outcome: "pending", phase: "pending_verification" });
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

test("pending Codex retains only the exact parent call alias after terminal cleanup", async () => {
  const reservations = new Map();
  const reservation = { task_call_id: "parent-call", child_session_id: "child-session", token: "released-token", role: "codex_executor" };
  reservations.set(reservation.task_call_id, reservation);
  reservations.set(reservation.child_session_id, reservation);
  reservations.delete(reservation.task_call_id);
  reservations.delete(reservation.child_session_id);
  assert.equal(reservations.get(reservation.task_call_id), undefined, "missing reservation would early-return before the parent after-hook");
  assert.equal(retainParentCallReservation(reservations, reservation, "success", true), true);
  assert.deepEqual(reservations.get(reservation.task_call_id), { ...reservation, token: null });
  assert.equal(reservations.get(reservation.task_call_id).child_session_id, "child-session");
});

test("Codex reservation retention is fail-closed for terminal, no-gate, and failure outcomes", () => {
  for (const [outcome, gatesPending] of [["success", false], ["failed", true], ["completed", true]]) {
    const reservations = new Map();
    const reservation = { task_call_id: "parent-call", child_session_id: "child-session", token: "released-token" };
    assert.equal(retainParentCallReservation(reservations, reservation, outcome, gatesPending), false);
    assert.equal(reservations.has("parent-call"), false);
  }
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

const durableDeps = (packets, transitions = [], extra = {}) => ({
  listWorkPackets: async () => packets,
  readTask: async () => ({ ...task, parent_session_id: packets[0]?.parent_session_id || root }),
  readWorkPacketByID: async (id) => packets.find((packet) => packet.packet_id === id) || null,
  updateWorkPacketByIDIfCurrent: async (_id, expected, fields) => {
    const current = packets.find((packet) => packet.packet_id === packets[0].packet_id);
    const matched = Object.entries(expected).every(([key, value]) => (Array.isArray(value) ? value.includes(current[key]) : current[key] === value));
    if (matched) { transitions.push([current.tester_dispatch_state, fields.tester_dispatch_state]); Object.assign(current, fields); }
    return { matched, packet: current };
  },
  ...extra,
});

for (const [label, response] of [["throw", null], ["explicit SDK error", { error: { status: 400 } }]]) {
  test(`enqueue ${label} is terminal and never requested`, async () => {
    const testRoot = `failure-${label}`, packet = gate(`${label === "throw" ? "b" : "c"}`.repeat(64), testRoot), packets = [packet], failures = [], transitions = [], prompts = [];
    const result = await driveMandatoryTesterContinuation(testRoot, durableDeps(packets, transitions, {
      enqueue: async () => { prompts.push(true); if (label === "throw") throw new Error("sdk failure"); return response; },
      fail: async (_gate, code) => failures.push(code),
    }));
    assert.equal(result.status, "failed");
    assert.equal(prompts.length, 1);
    assert.equal(packet.tester_dispatch_state, "pending");
    assert.notEqual(packet.tester_dispatch_state, "requested");
    assert.deepEqual(failures, ["MANDATORY_TESTER_ENQUEUE_FAILED"]);
    assert.equal(packets.filter((item) => item.agent === "tester").length, 0);
  });
}

test("successful enqueue durably records dispatching then requested exactly once", async () => {
  const testRoot = "success-root", packet = gate("d".repeat(64), testRoot), transitions = [], prompts = [];
  const result = await driveMandatoryTesterContinuation(testRoot, durableDeps([packet], transitions, {
    enqueue: async () => { prompts.push(true); return undefined; },
  }));
  assert.equal(result.status, "requested");
  assert.deepEqual(transitions, [[undefined, "dispatching"], ["dispatching", "requested"]]);
  assert.equal(prompts.length, 1);
});

for (const initial of ["dispatching", "requested"]) {
  test(`observation helper durably accepts ${initial} and preserves objective`, async () => {
    const testRoot = `observe-${initial}`, testPacketID = `${initial === "dispatching" ? "e" : "f"}`.repeat(64), packet = { ...gate(testPacketID, testRoot), tester_dispatch_state: initial, objective: "authoritative objective" }, packets = [packet], transitions = [];
    const result = await observeMandatoryTesterContinuation(testRoot, testPacketID, durableDeps(packets, transitions));
    assert.equal(result.matched, true);
    assert.equal(packet.tester_dispatch_state, "observed");
    assert.equal(packet.objective, "authoritative objective");
  });
}

test("observation helper rejects a packet rooted in another session", async () => {
  const testPacketID = "1".repeat(64), packet = { ...gate(testPacketID, "other-root"), tester_dispatch_state: "requested" }, transitions = [];
  const result = await observeMandatoryTesterContinuation(root, testPacketID, durableDeps([packet], transitions));
  assert.equal(result.matched, false);
  assert.equal(packet.tester_dispatch_state, "requested");
});

test("observed continuation admits exactly the required tester once", () => {
  const packet = { ...gate(), tester_dispatch_state: "observed" };
  assert.equal(enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", prompt: `test_task_id=${packetID}` }).allowed, true);
  assert.equal(enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", prompt: `test_task_id=${packetID}`, active: true }).allowed, false);
});

test("tester PASS terminal settlement is completed", () => {
  const packet = { ...gate(), tester_status: "passed", verification_status: "completed", phase: "foreground_completion", outcome: "completed" };
  assert.equal(packet.phase, "foreground_completion");
  assert.equal(packet.outcome, "completed");
  assert.equal(packet.tester_status, "passed");
  assert.equal(packet.verification_status, "completed");
});

test("idle dispatch is single-flight and requested does not watchdog-fail", async () => {
  const testRoot = "idle-root", testPacketID = "2".repeat(64), packet = gate(testPacketID, testRoot), packets = [packet], prompts = [], failures = [], transitions = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const deps = durableDeps(packets, transitions, {
    enqueue: async () => { prompts.push(true); await pending; },
    fail: async (_gate, code) => failures.push(code),
  });
  const first = driveMandatoryTesterContinuation(testRoot, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(packet.tester_dispatch_state, "dispatching");
  assert.equal((await driveMandatoryTesterContinuation(testRoot, deps)).status, "waiting");
  release();
  assert.equal((await first).status, "requested");
  assert.equal((await driveMandatoryTesterContinuation(testRoot, deps)).status, "waiting");
  assert.equal(prompts.length, 1);
  assert.deepEqual(failures, []);
  await observeMandatoryTesterContinuation(testRoot, testPacketID, deps);
  assert.equal((await driveMandatoryTesterContinuation(testRoot, deps)).status, "failed");
  assert.deepEqual(failures, ["MANDATORY_TESTER_NOT_DISPATCHED"]);
  assert.equal(prompts.length, 1);
});

test("Codex after-hook is not an initial mandatory-tester dispatch trigger", () => {
  assert.equal(mandatoryTesterDispatchTrigger("tool.execute.after"), false);
  assert.equal(mandatoryTesterDispatchTrigger("session.idle"), true);
});
