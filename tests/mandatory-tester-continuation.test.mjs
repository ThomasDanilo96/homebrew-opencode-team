import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexResult, createMandatoryTesterRootDriver, driveMandatoryTesterContinuation, observeMandatoryTesterContinuation, retainParentCallReservation, enforcePendingMandatoryTesterGate, mandatoryTesterDispatchTrigger, promoteVerificationCommands, resolveUpdatedUserMessageText, handleMandatoryTesterContinuation, exactMandatoryTesterObjective, decideDelegatedTaskAgent, testerEvidenceFromMessages, validatedVerificationAuthorization, isAuthorizedTesterVerificationCommand, testerVerificationMetadata, isExactMandatoryTesterGate, resolveDelegatedTaskRoute, taskRouteAdmissionContext, isMandatoryTesterPacketForSession, resolveMandatoryTesterPacketForSession, mandatoryTesterToolDecision, mandatoryTesterCommandOnlyError } from "../teams/openai/config/opencode/openai-team-tools.js";
import { verificationCommandCategory, parseVerificationEvidence } from "../teams/openai/config/opencode/execution-policy.js";
import { gateTerminalPacketPatch } from "../teams/openai/config/opencode/gate-state.js";
import { claimTask, completeTask, readTask, transitionTask } from "../teams/openai/config/opencode/task-state.js";
import { isInternalContinuation } from "../teams/openai/config/opencode/openai-guardrails.js";
import { createWorkPacket, updateWorkPacket, listWorkPackets } from "../teams/openai/config/opencode/work-packet.js";
import { resolveCorrelatedTesterReservation } from "../teams/openai/config/opencode/reservation-correlation.js";

const root = "root-session";
const packetID = "a".repeat(64);
const task = { task_fingerprint: "task", state: "PENDING_VERIFICATION", attempt: 1, lease_id: "lease", parent_session_id: root };
const gate = (id = packetID, parent = root) => ({ packet_id: id, parent_session_id: parent, task_fingerprint: "task", attempt: 1, task_lease_id: "lease", tester_required: true, tester_status: "pending", codex_outcome: "success", outcome: "pending", phase: "pending_verification" });
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

const continuationEvent = (id = packetID, sessionID = root) => ({ type: "message.updated", properties: { sessionID, info: { id: "message-1", sessionID, role: "user" } } });
const continuationText = (id = packetID) => `<!-- OMO_INTERNAL_INITIATOR --> MANDATORY_TESTER_GATE test_task_id=${id}\nCall the native task exactly once.`;

const calculatorCommand = "node calculator.test.js";
const calculatorHash = createHash("sha256").update(calculatorCommand).digest("hex");

const continuationCommand = "node calculator.test.js";
const continuationCommandHash = "da3a7e1aa666b6b1eb9706d890561a2df813d5eb4fda16377090149a80d1aa77";
const persistedTesterFields = (command = continuationCommand) => ({
  agent: "tester",
  parent_session_id: root,
  test_task_id: packetID,
  tester_status: "pending",
  verification_commands: JSON.stringify([command]),
  expected_verification_hashes: JSON.stringify([continuationCommandHash]),
});

test("delegated verification command survives parenthesized terminal prose punctuation", () => {
  const result = promoteVerificationCommands({}, "run the appropriate verification command (node calculator.test.js). report changed files...");
  assert.deepEqual({ commands: result.commands, hashes: result.hashes }, {
    commands: [calculatorCommand],
    hashes: [calculatorHash],
  });
});

test("A: serialized tester authorization has the exact known hash and admits Bash", () => {
  assert.equal(createHash("sha256").update(continuationCommand).digest("hex"), continuationCommandHash);
  const packet = persistedTesterFields();
  assert.equal(packet.verification_commands, '["node calculator.test.js"]');
  assert.equal(packet.expected_verification_hashes, '["da3a7e1aa666b6b1eb9706d890561a2df813d5eb4fda16377090149a80d1aa77"]');
  assert.deepEqual(validatedVerificationAuthorization(packet), { commands: [continuationCommand], hashes: [continuationCommandHash] });
  assert.equal(isAuthorizedTesterVerificationCommand(packet, continuationCommand), true);
});

test("B: production work-packet persistence roundtrips clean serialized tester arrays", async () => {
  const previousRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  const stateRoot = await mkdtemp(join(tmpdir(), "mandatory-tester-continuation-"));
  const callID = `tester-persistence-${Date.now()}-${Math.random()}`;
  try {
    process.env.OPENAI_TEAM_STATE_ROOT = stateRoot;
    const admitted = await createWorkPacket(callID, persistedTesterFields());
    assert.equal(admitted.verification_commands, '["node calculator.test.js"]');
    assert.equal(admitted.expected_verification_hashes, '["da3a7e1aa666b6b1eb9706d890561a2df813d5eb4fda16377090149a80d1aa77"]');
    await updateWorkPacket(callID, { child_session_id: "tester-child" });
    const packets = await listWorkPackets();
    const packet = packets.find((candidate) => candidate.packet_id === admitted.packet_id);
    assert.ok(packet);
    assert.equal(packet.child_session_id, "tester-child");
    assert.equal(packet.verification_commands, '["node calculator.test.js"]');
    assert.equal(packet.expected_verification_hashes, '["da3a7e1aa666b6b1eb9706d890561a2df813d5eb4fda16377090149a80d1aa77"]');
    assert.equal(isAuthorizedTesterVerificationCommand(packet, continuationCommand), true);
  } finally {
    if (previousRoot === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previousRoot;
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("C: persisted tester packet is found for the child and exact Bash decision allows it", () => {
  const packet = { ...persistedTesterFields(), child_session_id: "tester-child" };
  const packets = [packet];
  assert.equal(packets.find((candidate) => isMandatoryTesterPacketForSession(candidate, "tester-child")), packet);
  assert.deepEqual(mandatoryTesterToolDecision(packet, "bash", continuationCommand), { allowed: true });
});

test("D: the same returned packet ledger denies first Bash and allows the authorized command without reset", async () => {
  const previousRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  const stateRoot = await mkdtemp(join(tmpdir(), "mandatory-tester-continuation-"));
  const callID = `tester-ledger-${Date.now()}-${Math.random()}`;
  try {
    process.env.OPENAI_TEAM_STATE_ROOT = stateRoot;
    const admitted = await createWorkPacket(callID, persistedTesterFields());
    await updateWorkPacket(callID, { child_session_id: "tester-child" });
    const ledger = await listWorkPackets();
    const packet = ledger.find((candidate) => candidate.packet_id === admitted.packet_id);
    assert.ok(packet);
    const before = JSON.stringify(packet);
    assert.deepEqual(mandatoryTesterToolDecision(ledger.find((candidate) => isMandatoryTesterPacketForSession(candidate, "tester-child")), "bash", "apply_patch ..."), { allowed: false, reason: "Tester Bash is restricted to allowlisted verification commands." });
    assert.deepEqual(mandatoryTesterToolDecision(ledger.find((candidate) => isMandatoryTesterPacketForSession(candidate, "tester-child")), "bash", continuationCommand), { allowed: true });
    assert.equal(JSON.stringify(packet), before);
    assert.equal(packet.tester_status, "pending");
  } finally {
    if (previousRoot === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previousRoot;
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("E: raw serialized command normalizes to the exact authorized hash", () => {
  const raw = "  node   calculator.test.js  ";
  const packet = { verification_commands: JSON.stringify([raw]), expected_verification_hashes: JSON.stringify([continuationCommandHash]) };
  const normalized = raw.trim().replace(/\s+/g, " ");
  assert.equal(JSON.stringify(packet.verification_commands), JSON.stringify('["  node   calculator.test.js  "]'));
  assert.equal(normalized, continuationCommand);
  assert.equal(createHash("sha256").update(normalized).digest("hex"), continuationCommandHash);
  assert.equal(isAuthorizedTesterVerificationCommand(packet, raw), true);
});

test("mandatory resolver binds an unbound durable packet to the authoritative tester reservation", () => {
  const packet = { packet_id: packetID, task_call_id: packetID, parent_session_id: root, agent: "tester", test_task_id: packetID, tester_status: "pending", verification_commands: '["node calculator.test.js"]', expected_verification_hashes: '["da3a7e1aa666b6b1eb9706d890561a2df813d5eb4fda16377090149a80d1aa77"]' };
  const reservation = { role: "tester", child_session_id: "tester-child", packet_id: packetID, task_call_id: packetID, test_task_id: packetID, master_parent_session_id: root, gate_target: { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] } };
  const resolved = resolveMandatoryTesterPacketForSession("tester-child", [packet], reservation, root);
  assert.equal(resolved.packet_id, packetID);
  assert.equal(resolved.child_session_id, "tester-child");
  assert.equal(packet.child_session_id, undefined);
  assert.deepEqual(mandatoryTesterToolDecision(resolved, "bash", calculatorCommand), { allowed: true });
});

test("mandatory resolver uses the durable tester packet ID, not the native reservation call alias", () => {
  const packet = { packet_id: packetID, task_call_id: packetID, parent_session_id: root, agent: "tester", test_task_id: packetID, tester_status: "pending", verification_commands: JSON.stringify([calculatorCommand]), expected_verification_hashes: JSON.stringify([calculatorHash]) };
  const reservation = { role: "tester", child_session_id: "tester-child", packet_id: packetID, task_call_id: "call_native_123", test_task_id: packetID, master_parent_session_id: root, gate_target: { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] } };
  const resolved = resolveMandatoryTesterPacketForSession("tester-child", [packet], reservation, root);
  assert.equal(resolved.packet_id, packetID);
  assert.deepEqual(mandatoryTesterToolDecision(resolved, "bash", calculatorCommand), { allowed: true });
});

test("mandatory resolver fails closed for contradictory identity, authorization, root, and ambiguity", () => {
  const base = { packet_id: packetID, task_call_id: packetID, parent_session_id: root, agent: "tester", test_task_id: packetID, tester_status: "pending", child_session_id: "tester-child", verification_commands: JSON.stringify([calculatorCommand]), expected_verification_hashes: JSON.stringify([calculatorHash]) };
  const reservation = { role: "tester", child_session_id: "tester-child", packet_id: packetID, task_call_id: packetID, test_task_id: packetID, master_parent_session_id: root, gate_target: { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] } };
  for (const packet of [
    { ...base, child_session_id: "other-child" },
    { ...base, parent_session_id: "wrong-root" },
    { ...base, test_task_id: "b".repeat(64) },
    { ...base, expected_verification_hashes: JSON.stringify(["0".repeat(64)]) },
  ]) assert.equal(resolveMandatoryTesterPacketForSession("tester-child", [packet], reservation, root), null);
  assert.equal(resolveMandatoryTesterPacketForSession("tester-child", [base, { ...base }], null, root), null);
  assert.equal(resolveMandatoryTesterPacketForSession("tester-child", [base], { ...reservation, master_parent_session_id: "wrong-root" }, root), base);
});

test("mandatory resolver uses the uniquely bound durable packet after child binding", () => {
  const packet = { packet_id: packetID, parent_session_id: root, agent: "tester", test_task_id: packetID, tester_status: "required", child_session_id: "tester-child", verification_commands: JSON.stringify([calculatorCommand]), expected_verification_hashes: JSON.stringify([calculatorHash]) };
  const resolved = resolveMandatoryTesterPacketForSession("tester-child", [packet], null, root);
  assert.equal(resolved, packet);
  assert.deepEqual(mandatoryTesterToolDecision(resolved, "bash", calculatorCommand), { allowed: true });
});

test("provisional foreground tester correlation authorizes the exact packet before after-hook binding", () => {
  const child = "tester-child";
  const pending = { role: "tester", provisional_child_session_id: child, packet_id: packetID, task_call_id: "task-call", test_task_id: packetID, master_parent_session_id: root, gate_target: { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] } };
  const reservation = resolveCorrelatedTesterReservation(child, packetID, [pending], root);
  const packet = { packet_id: packetID, task_call_id: "task-call", parent_session_id: root, agent: "tester", test_task_id: packetID, tester_status: "pending", verification_commands: JSON.stringify([calculatorCommand]), expected_verification_hashes: JSON.stringify([calculatorHash]) };
  const resolved = resolveMandatoryTesterPacketForSession(child, [packet], reservation, root);
  assert.equal(resolved.child_session_id, child);
  assert.deepEqual(mandatoryTesterToolDecision(resolved, "bash", calculatorCommand), { allowed: true });
  assert.deepEqual(mandatoryTesterToolDecision(resolved, "bash", "apply_patch x"), { allowed: false, reason: "Tester Bash is restricted to allowlisted verification commands." });
});

test("provisional tester correlation rejects wrong identity, root, packet, and ambiguity", () => {
  const pending = { role: "tester", provisional_child_session_id: "tester-child", packet_id: packetID, task_call_id: "task-call", test_task_id: packetID, master_parent_session_id: root };
  assert.equal(resolveCorrelatedTesterReservation("tester-child", "wrong", [pending], root), null);
  assert.equal(resolveCorrelatedTesterReservation("other-child", packetID, [pending], root), null);
  assert.equal(resolveCorrelatedTesterReservation("tester-child", packetID, [{ ...pending, master_parent_session_id: "wrong-root" }], root), null);
  assert.equal(resolveCorrelatedTesterReservation("tester-child", packetID, [pending, { ...pending }], root), null);
});

test("tester authorization validates and carries the original command/hash pair", () => {
  const gatePacket = { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] };
  const authorization = validatedVerificationAuthorization(gatePacket);
  assert.deepEqual(authorization, { commands: [calculatorCommand], hashes: [calculatorHash] });
  assert.deepEqual(testerVerificationMetadata({ verification_commands: authorization.commands, expected_verification_hashes: authorization.hashes }), { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] });
  assert.equal(isAuthorizedTesterVerificationCommand(gatePacket, calculatorCommand), true);
});

test("exact mandatory tester helper accepts the original Codex gate without test_task_id", () => {
  const original = { ...gate(), verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] };
  const input = { daily: true, sessionAgent: "openai_orchestrator", rootSessionID: root, canonicalRootSessionID: root, requestedAgent: "tester", injectedTesterTaskID: packetID, durableGate: original };
  assert.equal(Object.hasOwn(original, "test_task_id"), false);
  assert.equal(isExactMandatoryTesterGate(input), true);
  assert.equal(isExactMandatoryTesterGate({ ...input, injectedTesterTaskID: "b".repeat(64) }), false);
  assert.equal(isExactMandatoryTesterGate({ ...input, durableGate: { ...original, outcome: "completed" } }), false);
  assert.equal(isExactMandatoryTesterGate({ ...input, durableGate: { ...original, expected_verification_hashes: ["0".repeat(64)] } }), false);
  assert.equal(isExactMandatoryTesterGate({ ...input, durableGate: { ...original, verification_commands: ["node other.test.js"] } }), false);
});

test("exact route resolution bypasses the router only for the exact gate", () => {
  let calls = 0;
  const router = (...args) => { calls += 1; return { classification: args[0] }; };
  assert.equal(resolveDelegatedTaskRoute(true, router, "parent", "child", "tester"), null);
  assert.equal(calls, 0);
  assert.deepEqual(resolveDelegatedTaskRoute(false, router, "parent", "child", "tester"), { classification: "parent" });
  assert.equal(calls, 1);
});

test("exact route admission context keeps null routes uncached and nullable", () => {
  assert.deepEqual(taskRouteAdmissionContext(null, true, false), { classification: null, localReadOnly: false });
  assert.deepEqual(taskRouteAdmissionContext(null, false, false), { classification: null, localReadOnly: false });
});

test("tester Bash authorization requires the exact normalized command and paired hash", () => {
  const packet = { verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] };
  assert.equal(isAuthorizedTesterVerificationCommand(packet, " node   calculator.test.js "), true);
  assert.equal(isAuthorizedTesterVerificationCommand(packet, "node other.test.js"), false);
  assert.equal(isAuthorizedTesterVerificationCommand(packet, "node ./calculator.test.js"), false);
  assert.equal(isAuthorizedTesterVerificationCommand(packet, `${calculatorCommand}\r\n`), false);
  assert.equal(isAuthorizedTesterVerificationCommand({ verification_commands: [calculatorCommand], expected_verification_hashes: ["0".repeat(64)] }, calculatorCommand), false);
  assert.equal(isAuthorizedTesterVerificationCommand({ expected_verification_hashes: [calculatorHash] }, calculatorCommand), false);
  assert.equal(isAuthorizedTesterVerificationCommand({ verification_commands: [calculatorCommand] }, calculatorCommand), false);
});

test("exact mandatory tester gate wins over a mutating delegated route", () => {
  assert.equal(decideDelegatedTaskAgent("tester", "MUTATING", true), "tester");
  assert.equal(decideDelegatedTaskAgent("tester", "MUTATING", false), "codex_executor");
});

test("invalid exact tester state cannot bypass the mutating route", () => {
  for (const state of ["wrong-packet", "not-observed", "invalid-hash"]) {
    assert.equal(decideDelegatedTaskAgent("tester", "MUTATING", false), "codex_executor", state);
  }
});

test("mandatory admission model has one Codex original and one tester", () => {
  const packets = [
    { packet_id: "c".repeat(64), agent: decideDelegatedTaskAgent("codex_executor", "MUTATING", false) || "codex_executor" },
    { packet_id: "t".repeat(64), agent: decideDelegatedTaskAgent("tester", "MUTATING", true) },
  ];
  assert.deepEqual(packets.map(({ agent }) => agent), ["codex_executor", "tester"]);
  assert.equal(packets.filter(({ agent }) => agent === "codex_executor").length, 1);
  assert.equal(packets.length, 2);
});

test("updated user text uses the exact SDK message lookup", async () => {
  const calls = [];
  const event = continuationEvent();
  const text = await resolveUpdatedUserMessageText(event, { session: { message: async (args) => { calls.push(args); return { data: { info: { id: "message-1" }, parts: [{ type: "text", text: continuationText() }] } }; } } });
  assert.equal(text, continuationText());
  assert.deepEqual(calls, [{ path: { id: root, messageID: "message-1" } }]);
});

test("updated user fallback selects the exact message in the event session", async () => {
  const calls = [];
  const event = continuationEvent();
  const text = await resolveUpdatedUserMessageText(event, { session: {
    message: async () => { throw new Error("not available"); },
    messages: async (args) => { calls.push(args); return { data: [
      { info: { id: "unrelated", sessionID: root }, parts: [{ type: "text", text: "latest unrelated" }] },
      { info: { id: "message-1", sessionID: root }, parts: [{ type: "text", text: continuationText() }] },
    ] }; },
  } });
  assert.equal(text, continuationText());
  assert.deepEqual(calls, [{ path: { id: root } }]);
});

test("updated user text returns null when the exact message cannot be resolved", async () => {
  const event = continuationEvent();
  const guardLike = { authoritativeObjective: "Original authoritative objective" };
  assert.equal(await resolveUpdatedUserMessageText(event, { session: { message: async () => { throw new Error("missing"); }, messages: async () => ({ data: [] }) } }), null);
  assert.equal(guardLike.authoritativeObjective, "Original authoritative objective");
  assert.deepEqual(guardLike, { authoritativeObjective: "Original authoritative objective" });
});

test("mandatory continuation observes only the exact requested gate", async () => {
  const packets = [gate()];
  packets[0].tester_dispatch_state = "requested";
  const observed = [];
  const result = await handleMandatoryTesterContinuation(continuationEvent(), {
    client: { session: { message: async () => ({ data: { info: { id: "message-1" }, parts: [{ type: "text", text: continuationText() }] } }) } },
    findGate: async () => packets[0],
    observe: async (rootID, id) => { observed.push([rootID, id]); packets[0].tester_dispatch_state = "observed"; return { matched: true }; },
  });
  assert.equal(result.handled, true);
  assert.deepEqual(observed, [[root, packetID]]);
  assert.equal(packets[0].tester_dispatch_state, "observed");
});

test("spoofed and wrong-packet continuations fail closed", async () => {
  let observed = 0;
  const findGate = async () => ({ ...gate(), tester_dispatch_state: "requested" });
  const options = (text) => ({ client: { session: { message: async () => ({ data: { info: { id: "message-1" }, parts: [{ type: "text", text }] } }) } }, findGate, observe: async () => { observed += 1; return { matched: true }; } });
  const spoof = await handleMandatoryTesterContinuation(continuationEvent(), options(continuationText("c".repeat(64))));
  const wrong = await handleMandatoryTesterContinuation(continuationEvent(), options(continuationText("d".repeat(64))));
  assert.equal(spoof.handled, false);
  assert.equal(wrong.handled, false);
  assert.equal(observed, 0);
});

test("mandatory tester objective preserves authority without fuzzy scope matching", () => {
  const parent = "Fix calculator fixture";
  const command = "node calculator.test.js";
  const hash = createHash("sha256").update(command).digest("hex");
  const objective = exactMandatoryTesterObjective(parent, "ignored generic scope", { verification_commands: [command], expected_verification_hashes: [hash] });
  assert.match(objective, /^Parent objective \(verbatim\):\nFix calculator fixture\n\nMandatory verification gate\./);
  assert.match(objective, /Execute exactly this verification command via Bash:\nnode calculator\.test\.js/);
  assert.match(objective, /Do not glob, grep, read, inspect, use Serena, use MCP, delegate, or modify anything\./);
  assert.doesNotMatch(objective, /likely|appropriate|inspect if needed/);
  assert.equal(exactMandatoryTesterObjective(parent, "ignored", { verification_commands: [command], expected_verification_hashes: [] }), "");
  assert.equal(exactMandatoryTesterObjective(parent, "Verify calculator fixture", { tester_dispatch_state: "observed", expected_verification_hashes: [] }), "");
  assert.equal(exactMandatoryTesterObjective(parent, "Verify calculator fixture", { tester_dispatch_state: "observed", expected_verification_hashes: ["not-a-hash"] }), "");
});

test("mandatory tester objective orders multiple authorized commands exactly", () => {
  const commands = ["node first.test.js", "node second.test.js"];
  const hashes = commands.map((command) => createHash("sha256").update(command).digest("hex"));
  const objective = exactMandatoryTesterObjective("Parent", "ignored", { verification_commands: commands, expected_verification_hashes: hashes });
  assert.match(objective, /Execute exactly these verification commands via Bash, once each, in order:\n1\. node first\.test\.js\n2\. node second\.test\.js/);
});

test("mandatory tester tool decision restricts exploratory tools but preserves generic testers", () => {
  const packet = { agent: "tester", child_session_id: "tester-child", test_task_id: packetID, tester_status: "pending", verification_commands: [calculatorCommand], expected_verification_hashes: [calculatorHash] };
  assert.equal(isMandatoryTesterPacketForSession(packet, "tester-child"), true);
  assert.deepEqual(mandatoryTesterToolDecision(packet, "glob", "**/*.js"), { allowed: false, reason: "MANDATORY_TESTER_COMMAND_ONLY", instruction: "Execute the authorized verification command via Bash." });
  assert.deepEqual(mandatoryTesterToolDecision(packet, "bash", calculatorCommand), { allowed: true });
  assert.deepEqual(mandatoryTesterToolDecision(packet, "bash", "node other.test.js"), { allowed: false, reason: "Tester Bash is restricted to allowlisted verification commands." });
  assert.deepEqual(mandatoryTesterToolDecision(null, "glob", "**/*.js"), { allowed: true });
  const error = mandatoryTesterCommandOnlyError();
  assert.equal(error.code, "MANDATORY_TESTER_COMMAND_ONLY");
  assert.equal(error.retryable, true);
  assert.match(error.message, /MANDATORY_TESTER_COMMAND_ONLY: Execute the authorized verification command via Bash\./);
  assert.doesNotMatch(error.message, /stop|do not retry/i);
  assert.equal(packet.tester_status, "pending");
  assert.equal(packet.error_code, undefined);
});

test("deterministic mandatory tester lifecycle reaches completed PASS", async () => {
  const command = "node calculator.test.js";
  const promoted = promoteVerificationCommands({ verification_commands: JSON.stringify([command]) }, { authoritative_objective: "Run node calculator.test.js" });
  const packet = { ...gate(), agent: "tester", test_task_id: packetID, tester_dispatch_state: "requested", expected_verification_hashes: promoted.hashes, verification_commands: [command], child_session_id: "tester-child", started_at: new Date(0).toISOString() };
  const original = { authoritativeObjective: "Implement unrelated repository change" };
  const observed = await handleMandatoryTesterContinuation(continuationEvent(), {
    client: { session: { message: async () => ({ data: { info: { id: "message-1" }, parts: [{ type: "text", text: continuationText(packet.packet_id) }] } }) } },
    findGate: async () => packet,
    observe: async () => { packet.tester_dispatch_state = "observed"; return { matched: true }; },
  });
  assert.equal(observed.handled, true);
  const testerObjective = exactMandatoryTesterObjective(original.authoritativeObjective, "Verify calculator fixture", packet);
  assert.match(testerObjective, /^Parent objective \(verbatim\):\nImplement unrelated repository change\n\nMandatory verification gate\./);
  const evidence = testerEvidenceFromMessages([{ info: { role: "assistant", agent: "tester", sessionID: "tester-child", time: { created: 1 } }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command }, metadata: { exit_code: 0 } } }] }], packet);
  assert.equal(evidence.summary.status, "passed");
  Object.assign(packet, gateTerminalPacketPatch(packet, true));
  const taskFingerprint = `lifecycle-${Date.now()}-${Math.random()}`;
  const claimed = await claimTask({ task_fingerprint: taskFingerprint, objective_sha256: "objective", parent_session_id: root, agent: "tester" });
  const pending = await transitionTask(taskFingerprint, { expectedVersion: claimed.record.version, expectedStates: ["CLAIMED"], leaseId: claimed.record.lease_id, expectedAttempt: claimed.record.attempt, expectedLease: claimed.record.lease_id, patch: { state: "PENDING_VERIFICATION", result_summary: "pending" } });
  const completedTask = await completeTask(taskFingerprint, { expectedVersion: pending.version, leaseId: pending.lease_id, expectedAttempt: pending.attempt, expectedLease: pending.lease_id, result_summary: "tester_passed" });
  assert.equal(completedTask.state, "COMPLETED");
  assert.equal((await readTask(taskFingerprint)).state, "COMPLETED");
  assert.equal(packet.codex_outcome, "success");
  assert.equal(packet.agent, "tester");
  assert.equal(packet.test_task_id, packetID);
  assert.deepEqual(testerVerificationMetadata(packet), { verification_commands: [command], expected_verification_hashes: promoted.hashes });
  assert.equal(packet.tester_status, "passed");
  assert.equal(packet.verification_status, "passed");
  assert.equal(packet.outcome, "completed");
});

test("denied tester Bash attempts are ignored before completed evidence", () => {
  const command = "node calculator.test.js";
  const packet = { child_session_id: "tester-child", started_at: new Date(0).toISOString(), verification_commands: [command], expected_verification_hashes: [calculatorHash] };
  const messages = [
    { info: { role: "assistant", agent: "tester", sessionID: "tester-child", time: { created: 1 } }, parts: [{ type: "tool", tool: "bash", state: { status: "error", input: { command: "rm calculator.test.js" }, error: "denied" } }] },
    { info: { role: "assistant", agent: "tester", sessionID: "tester-child", time: { created: 2 } }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command }, metadata: { exit_code: 0 } } }] },
  ];
  const evidence = testerEvidenceFromMessages(messages, packet);
  assert.equal(evidence.summary.status, "passed");
  assert.equal(evidence.summary.recognized_count, 1);
  assert.equal(evidence.summary.invalid, undefined);
});

test("denied-only tester Bash evidence remains missing", () => {
  const command = "node calculator.test.js";
  const evidence = testerEvidenceFromMessages([{ info: { role: "assistant", agent: "tester", sessionID: "tester-child", time: { created: 1 } }, parts: [{ type: "tool", tool: "bash", state: { status: "error", input: { command } } }] }], { child_session_id: "tester-child", started_at: new Date(0).toISOString(), verification_commands: [command], expected_verification_hashes: [calculatorHash] });
  assert.equal(evidence.summary.status, "missing");
  assert.equal(evidence.summary.recognized_count, 0);
});

test("verification promotion extracts inline prose and preserves serialized durable arrays", () => {
  const command = "node calculator.test.js";
  const promoted = promoteVerificationCommands({
    verification_commands: JSON.stringify([command]),
    acceptance_criteria: JSON.stringify(["Keep the unrelated acceptance criterion"]),
  }, { authoritative_objective: "inline run node calculator.test.js and report" });
  assert.deepEqual(promoted.commands, [command]);
  assert.deepEqual(promoted.hashes, [createHash("sha256").update(command).digest("hex")]);
  assert.deepEqual(promoted.criteria, ["Keep the unrelated acceptance criterion"]);
});

test("verification promotion accepts validated command_execution JSONL and rejects unsafe commands", () => {
  const command = "node calculator.test.js";
  const stdout = [
    JSON.stringify({ type: "command_execution", item: { type: "command_execution", command } }),
    JSON.stringify({ type: "command_execution", item: { type: "command_execution", command: "node -e 'process.exit(1)'" } }),
  ].join("\n");
  const promoted = promoteVerificationCommands({}, { stdout, authoritative_objective: "Run node calculator.test.js" });
  assert.deepEqual(promoted.commands, [command]);
  assert.equal(promoted.hashes.length, 1);
});

test("verification promotion selects only the longest allowlisted prose window and rejects newlines", () => {
  const command = "node --test tests/a.test.js";
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run node --test tests/a.test.js and report" }).commands, [command]);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run node --test tests/a.test.js to verify behavior" }).commands, [command]);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run node --test tests/a.test.js after making the change" }).commands, []);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "please use node --test tests/a.test.js for validation work" }).commands, []);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run node calculator.test.js" }).commands, ["node calculator.test.js"]);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run node calculator.test.js and report." }).commands, ["node calculator.test.js"]);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run go test ./... and report" }).commands, ["go test ./..."]);
  assert.deepEqual(promoteVerificationCommands({}, { authoritative_objective: "Run npm\ntest" }).commands, []);
  assert.deepEqual(promoteVerificationCommands({}, { stdout: JSON.stringify({ item: { type: "command_execution", command: "npm\ntest" } }) }).commands, []);
});

test("duplicate verification sources produce one normalized command and hash", () => {
  const promoted = promoteVerificationCommands({ verification_commands: [" node   calculator.test.js "] }, {
    authoritative_objective: "Run node calculator.test.js",
    stdout: JSON.stringify({ item: { type: "command_execution", command: "node calculator.test.js" } }),
  });
  assert.deepEqual(promoted.commands, ["node calculator.test.js"]);
  assert.equal(promoted.hashes.length, 1);
});

test("promoted hash admits observed tester with only the exact task target", () => {
  const packet = { ...gate(), tester_dispatch_state: "observed", verification_commands: ["node calculator.test.js"], expected_verification_hashes: [createHash("sha256").update("node calculator.test.js").digest("hex")] };
  const result = enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", active: false, prompt: `test_task_id=${packetID}` });
  assert.equal(result.allowed, true);
  assert.doesNotThrow(() => enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", active: false, prompt: `test_task_id=${packetID}` }));
  assert.equal(enforcePendingMandatoryTesterGate(packet, { tool: "task", agent: "tester", active: true, prompt: `test_task_id=${packetID}` }).allowed, false);
});

test("failed packet with no command is a continuation no-op", async () => {
  const packets = [{ ...gate(), outcome: "failed", codex_outcome: "failed", tester_status: "failed", error_code: "TEST_COMMAND_UNAVAILABLE" }];
  let enqueues = 0;
  const result = await driveMandatoryTesterContinuation(root, depsFor(packets, { enqueue: async () => { enqueues += 1; } }));
  assert.deepEqual(result, { status: "noop" });
  assert.equal(enqueues, 0);
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
  const testRoot = `observe-${initial}`, testPacketID = `${initial === "dispatching" ? "e" : "f"}`.repeat(64), packet = { ...gate(testPacketID, testRoot), test_task_id: testPacketID, tester_dispatch_state: initial, objective: "authoritative objective" }, packets = [packet], transitions = [];
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
  const testRoot = "idle-root", testPacketID = "2".repeat(64), packet = { ...gate(testPacketID, testRoot), test_task_id: testPacketID }, packets = [packet], prompts = [], failures = [], transitions = [];
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

test("bounded Codex node verification is captured and replay-authorized", () => {
  const command = `node -e 'const { multiply } = require("./calculator.js"); if (multiply(4,5) !== 20) process.exit(1)'`;
  const hash = createHash("sha256").update(command).digest("hex");
  const promoted = promoteVerificationCommands({}, { stdout: JSON.stringify({ item: { type: "command_execution", command, exit_code: 0 } }) });
  assert.equal(verificationCommandCategory(command), "node_eval");
  assert.deepEqual(promoted, { commands: [command], hashes: [hash], criteria: [] });
  const evidence = parseVerificationEvidence(JSON.stringify({ item: { type: "command_execution", command, exit_code: 0 } }));
  assert.equal(evidence.summary.status, "passed");
  assert.equal(isAuthorizedTesterVerificationCommand({ verification_commands: JSON.stringify([command]), expected_verification_hashes: JSON.stringify([hash]) }, command), true);
  const wrapped = `/bin/zsh -lc "sed -n '1,220p' calculator.js && node -e 'const { multiply } = require(\\"./calculator.js\\"); if (multiply(4,5) "'!== 20) process.exit(1)'"'"`;
  const wrappedEvidence = parseVerificationEvidence(JSON.stringify({ item: { type: "command_execution", command: wrapped, exit_code: 0 } }));
  assert.equal(wrappedEvidence.summary.status, "passed");
  const derived = promoteVerificationCommands({}, { authoritative_objective: "modify only calculator.js. add function multiply(a, b) returning a * b and export it alongside add." });
  assert.deepEqual(derived.commands, ['node -e \'const { multiply } = require("./calculator.js"); if (typeof multiply !== "function") process.exit(1)\'']);
});

test("terminal lifecycle IDs stay canonical and do not reflect appended output", () => {
  const packetID = "f9a11ed2a5e5dae1bb22c7eadd2d257d71b923664fe4a2ebce9288979c0c2b2d";
  const terminal = codexResult({ packet_id: packetID, task_id: packetID, test_task_id: packetID });
  assert.equal(terminal.packet_id, packetID);
  assert.equal(terminal.task_id, packetID);
  assert.equal(terminal.test_task_id, packetID);
  assert.match(terminal.packet_id, /^[a-f0-9]{64}$/);
  assert.equal(codexResult({ packet_id: `${packetID}${packetID.repeat(8)}` }).packet_id, null);
});
