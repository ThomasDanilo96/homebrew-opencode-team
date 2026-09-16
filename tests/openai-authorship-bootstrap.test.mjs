import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapCodexPolicy, CODEX_BOOTSTRAP_REASONS } from "../teams/openai/config/opencode/openai-authorship-guard.js";
import { claimTask, transitionTask } from "../teams/openai/config/opencode/task-state.js";

const child = "child-session";
const parent = "parent-session";
const prompt = "run the requested task";
const sessions = {
  session: { data: { id: child, parentID: parent } },
  parent: { data: { id: parent } },
};
const client = {
  session: {
    get: async ({ path: { id } }) => id === child ? sessions.session : sessions.parent,
    messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: prompt }] }] }),
  },
};
const baseInput = () => ({ client, listWorkPackets: async () => [] });

test("Codex bootstrap reports a valid success without changing policy admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-bootstrap-"));
  const previous = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_TEAM_STATE_ROOT = root;
  try {
    const objective_sha256 = createHash("sha256").update(prompt).digest("hex");
    const claimed = await claimTask({ task_fingerprint: "bootstrap-task", objective_sha256, parent_session_id: parent, agent: "codex_executor" });
    const task = await transitionTask(claimed.record.task_fingerprint, { expectedVersion: claimed.record.version, expectedStates: ["CLAIMED"], leaseId: claimed.record.lease_id, expectedAttempt: claimed.record.attempt, expectedLease: claimed.record.lease_id, patch: { state: "ADMITTED" } });
    const packet = { agent: "codex_executor", parent_session_id: parent, objective_sha256, phase: "admitted", outcome: "pending", child_session_id: null, task_fingerprint: task.task_fingerprint, task_lease_id: task.lease_id, attempt: task.attempt, packet_id: task.packet_id, task_call_id: "call-1" };
    const result = await bootstrapCodexPolicy({ ...baseInput(), listWorkPackets: async () => [packet], updateWorkPacketByID: async () => ({ ...packet, child_session_id: child }), }, child, "codex_executor");
    assert.equal(result.reason, null);
    assert.equal(result.policy.status, "CODEX_REQUIRED");
    assert.equal(result.policy.session_id, child);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex bootstrap reports representative fail-closed reason codes", async () => {
  assert.equal((await bootstrapCodexPolicy(baseInput(), child, "openai_orchestrator")).reason, CODEX_BOOTSTRAP_REASONS.AGENT_SESSION);
  assert.equal((await bootstrapCodexPolicy(baseInput(), child, "codex_executor")).reason, CODEX_BOOTSTRAP_REASONS.CANDIDATE_COUNT);
  const noPrompt = { ...baseInput(), client: { session: { get: async () => sessions.session, messages: async () => ({ data: [] }) } } };
  assert.equal((await bootstrapCodexPolicy(noPrompt, child, "codex_executor")).reason, CODEX_BOOTSTRAP_REASONS.PROMPT);
  const root = await mkdtemp(join(tmpdir(), "openai-bootstrap-missing-"));
  const previous = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_TEAM_STATE_ROOT = root;
  try {
    const taskMissing = { ...baseInput(), readTask: async () => null, listWorkPackets: async () => [{ agent: "codex_executor", parent_session_id: parent, objective_sha256: createHash("sha256").update(prompt).digest("hex").toString(), phase: "admitted", outcome: "pending", task_fingerprint: "missing" }] };
    assert.equal((await bootstrapCodexPolicy(taskMissing, child, "codex_executor")).reason, CODEX_BOOTSTRAP_REASONS.TASK_MISSING);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex bootstrap waits for a durably visible first-child packet", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-bootstrap-race-"));
  const previousRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  const previousWait = process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS;
  const previousPoll = process.env.OPENAI_CODEX_CANDIDATE_POLL_MS;
  process.env.OPENAI_TEAM_STATE_ROOT = root;
  process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS = "50";
  process.env.OPENAI_CODEX_CANDIDATE_POLL_MS = "10";
  try {
    const objective_sha256 = createHash("sha256").update(prompt).digest("hex");
    const claimed = await claimTask({ task_fingerprint: "race-task", objective_sha256, parent_session_id: parent, agent: "codex_executor" });
    const task = await transitionTask(claimed.record.task_fingerprint, { expectedVersion: claimed.record.version, expectedStates: ["CLAIMED"], leaseId: claimed.record.lease_id, expectedAttempt: claimed.record.attempt, expectedLease: claimed.record.lease_id, patch: { state: "ADMITTED" } });
    const packet = { agent: "codex_executor", parent_session_id: parent, objective_sha256, phase: "admitted", outcome: "pending", child_session_id: null, task_fingerprint: task.task_fingerprint, task_lease_id: task.lease_id, attempt: task.attempt, packet_id: task.packet_id, task_call_id: "race-call" };
    let calls = 0;
    const result = await bootstrapCodexPolicy({ ...baseInput(), listWorkPackets: async () => calls++ === 0 ? [] : [packet], updateWorkPacketByID: async () => ({ ...packet, child_session_id: child }) }, child, "codex_executor");
    assert.equal(result.reason, null);
  } finally {
    if (previousRoot === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT; else process.env.OPENAI_TEAM_STATE_ROOT = previousRoot;
    if (previousWait === undefined) delete process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS; else process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS = previousWait;
    if (previousPoll === undefined) delete process.env.OPENAI_CODEX_CANDIDATE_POLL_MS; else process.env.OPENAI_CODEX_CANDIDATE_POLL_MS = previousPoll;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex bootstrap denies ambiguous candidates without waiting", async () => {
  const started = Date.now();
  const objective_sha256 = createHash("sha256").update(prompt).digest("hex");
  const candidates = [1, 2].map((id) => ({ agent: "codex_executor", parent_session_id: parent, objective_sha256, phase: "admitted", outcome: "pending", packet_id: `ambiguous-${id}` }));
  const result = await bootstrapCodexPolicy({ ...baseInput(), listWorkPackets: async () => candidates }, child, "codex_executor");
  assert.equal(result.reason, CODEX_BOOTSTRAP_REASONS.CANDIDATE_COUNT);
  assert.ok(Date.now() - started < 100);
});

test("Codex bootstrap denies when the candidate never becomes visible", async () => {
  const previousWait = process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS;
  const previousPoll = process.env.OPENAI_CODEX_CANDIDATE_POLL_MS;
  process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS = "10";
  process.env.OPENAI_CODEX_CANDIDATE_POLL_MS = "10";
  try {
    const result = await bootstrapCodexPolicy(baseInput(), child, "codex_executor");
    assert.equal(result.reason, CODEX_BOOTSTRAP_REASONS.CANDIDATE_COUNT);
  } finally {
    if (previousWait === undefined) delete process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS; else process.env.OPENAI_CODEX_CANDIDATE_WAIT_MS = previousWait;
    if (previousPoll === undefined) delete process.env.OPENAI_CODEX_CANDIDATE_POLL_MS; else process.env.OPENAI_CODEX_CANDIDATE_POLL_MS = previousPoll;
  }
});
