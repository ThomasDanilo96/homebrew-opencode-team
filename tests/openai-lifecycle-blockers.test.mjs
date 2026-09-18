import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claimTask, readTask } from "../teams/openai/config/opencode/task-state.js";
import { addWorkPacketTokensByID, createWorkPacket, incrementWorkPacketByID, listWorkPackets, updateWorkPacketByID } from "../teams/openai/config/opencode/work-packet.js";
import { ensurePolicy, readPolicy } from "../teams/openai/config/opencode/codex-authority.js";
import { OpenAIAuthorshipGuard } from "../teams/openai/config/opencode/openai-authorship-guard.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const withState = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), "openai-lifecycle-"));
  const previous = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_TEAM_STATE_ROOT = root;
  try { return await fn(root); } finally {
    if (previous === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
};

test("work packet lease round-trips and canonical ID updates the real packet", () => withState(async () => {
  const packet = await createWorkPacket("call-roundtrip", { task_lease_id: "lease-roundtrip", phase: "admitted" });
  assert.equal((await listWorkPackets()).find((entry) => entry.packet_id === packet.packet_id).task_lease_id, "lease-roundtrip");
  const updated = await updateWorkPacketByID(packet.packet_id, { phase: "codex_running" });
  assert.equal(updated.packet_id, packet.packet_id);
  assert.equal((await listWorkPackets()).find((entry) => entry.packet_id === packet.packet_id).phase, "codex_running");
  await incrementWorkPacketByID(packet.packet_id, { tool_call_count: 1 });
  await addWorkPacketTokensByID(packet.packet_id, "opencode", { input_tokens: 3 }, "a".repeat(64));
  const counted = (await listWorkPackets()).find((entry) => entry.packet_id === packet.packet_id);
  assert.equal(counted.tool_call_count, 1);
  assert.equal(counted.opencode_input_tokens, 3);
  assert.equal((await updateWorkPacketByID(packet.packet_id, { child_session_id: "child-1" })).child_session_id, "child-1");
  const command = 'node -e \'const { multiply } = require("./calculator.js"); if (typeof multiply !== "function") process.exit(1)\'';
  assert.deepEqual(JSON.parse((await updateWorkPacketByID(packet.packet_id, { verification_commands: [command] })).verification_commands), [command]);
  assert.equal((await updateWorkPacketByID(packet.packet_id, { packet_id: "f".repeat(64), task_call_id: "corrupt" })).packet_id, packet.packet_id);
  assert.equal((await listWorkPackets()).find((entry) => entry.packet_id === packet.packet_id).task_call_id, packet.task_call_id);
  assert.equal(await updateWorkPacketByID(packet.packet_id, { child_session_id: "child-2" }), null);
  assert.equal((await updateWorkPacketByID(packet.packet_id, { child_session_id: "child-1" })).child_session_id, "child-1");
}));

const lifecycleFixture = async (policyFields = {}) => {
  const prompt = "Implement the deterministic lifecycle fix.";
  const child = "child-session";
  const parent = "parent-session";
  const claimed = await claimTask({ task_fingerprint: "task-fingerprint", objective_sha256: hash(prompt), parent_session_id: parent, agent: "codex_executor", first_call_id: "call-lifecycle" });
  const packet = await createWorkPacket("call-lifecycle", { agent: "codex_executor", parent_session_id: parent, objective_sha256: hash(prompt), task_fingerprint: claimed.record.task_fingerprint, packet_id: claimed.record.packet_id, task_call_id: claimed.record.packet_id, attempt: claimed.record.attempt, task_lease_id: claimed.record.lease_id, phase: "admitted", outcome: "pending" });
  const client = {
    session: {
      get: async ({ path: { id } }) => ({ data: id === child ? { id: child, parentID: parent } : { id: parent } }),
      messages: async () => ({ data: [{ info: { role: "user", agent: "codex_executor" }, parts: [{ type: "text", text: prompt }] }] }),
    },
  };
  await ensurePolicy(child, { agent: "codex_executor", master_parent_session_id: parent, objective_sha256: packet.objective_sha256, ...policyFields });
  return { child, parent, packet, claimed, client };
};

test("matching provisional policy is repaired by exact binding and allowed", () => withState(async () => {
  const fixture = await lifecycleFixture({ objective_sha256: hash("Implement the deterministic lifecycle fix.") });
  const repaired = await ensurePolicy(fixture.child, {
    task_fingerprint: fixture.claimed.record.task_fingerprint, packet_id: fixture.packet.packet_id,
    task_call_id: fixture.packet.task_call_id, attempt: fixture.claimed.record.attempt,
    task_lease_id: fixture.claimed.record.lease_id,
  });
  assert.equal(repaired.task_lease_id, fixture.claimed.record.lease_id);
  assert.equal(repaired.packet_id, fixture.packet.packet_id);
  assert.equal((await readPolicy(fixture.child)).task_lease_id, fixture.claimed.record.lease_id);
}));

test("provisional policy with conflicting durable identity is denied", () => withState(async () => {
  const fixture = await lifecycleFixture({ packet_id: "wrong-packet" });
  const guard = await OpenAIAuthorshipGuard({ client: fixture.client });
  await assert.rejects(() => guard["tool.execute.before"]({ tool: "openai_run_codex", sessionID: fixture.child }, { args: {} }), /OPENAI AUTHORSHIP POLICY/);
  assert.equal((await readPolicy(fixture.child)).packet_id, "wrong-packet");
}));

test("tester verification uses persisted packet shapes and exact target outcome", async () => {
  const root = "a".repeat(64);
  const child = "b".repeat(64);
  const targetID = "c".repeat(64);
  const command = "node --test tests/openai-lifecycle-blockers.test.mjs";
  const commandHash = hash(command);
  const target = (tester_status = "pending", codex_outcome = "success") => ({
    packet_id: targetID,
    parent_session_id: root,
    phase: "pending_verification",
    outcome: "pending",
    codex_outcome,
    tester_required: true,
    tester_status,
    verification_commands: JSON.stringify([command]),
    expected_verification_hashes: JSON.stringify([commandHash]),
  });
  const tester = {
    packet_id: "d".repeat(64),
    parent_session_id: root,
    agent: "tester",
    tester_status: "required",
    child_session_id: null,
    test_task_id: targetID,
    verification_commands: JSON.stringify([command]),
    expected_verification_hashes: JSON.stringify([commandHash]),
  };
  const client = {
    session: {
      get: async ({ path: { id } }) => ({ data: id === child ? { id: child, parentID: root } : { id: root } }),
      messages: async () => ({ data: [{ info: { role: "assistant", agent: "tester" }, parts: [] }] }),
    },
  };
  for (const testerStatus of ["pending", "required"]) {
    const guard = await OpenAIAuthorshipGuard({ client, listWorkPackets: async () => [tester, target(testerStatus)] });
    await assert.doesNotReject(() => guard["tool.execute.before"]({ tool: "bash", sessionID: child }, { args: { command } }));
    await assert.rejects(() => guard["tool.execute.before"]({ tool: "bash", sessionID: child }, { args: { command: "node --test tests/not-authorized.mjs" } }), /OPENAI AUTHORSHIP POLICY/);
    await assert.rejects(() => guard["tool.execute.before"]({ tool: "apply_patch", sessionID: child }, { args: {} }), /OPENAI AUTHORSHIP POLICY/);
  }
  const guard = await OpenAIAuthorshipGuard({ client, listWorkPackets: async () => [tester, target("pending", "CODEX_SUCCESS")] });
  await assert.rejects(() => guard["tool.execute.before"]({ tool: "bash", sessionID: child }, { args: { command } }), /OPENAI AUTHORSHIP POLICY/);
});
