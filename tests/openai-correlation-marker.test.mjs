import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendTaskPacketMarker, extractTaskPacketMarker, objectiveBeforeMarker } from "../teams/openai/config/opencode/correlation-marker.js";
import { beginRequestCycle, createGuardrailState } from "../teams/openai/config/opencode/openai-guardrails.js";

const id = (value) => createHash("sha256").update(value).digest("hex");

test("packet markers are exact, reject injection, and ignore decoration after the marker", () => {
  const packetID = id("packet-b");
  const objective = "Implement the bounded task";
  const marked = appendTaskPacketMarker(objective, packetID);
  const decorated = `${marked}\n\nOMO_INTERNAL_INITIATOR decoration`;
  assert.deepEqual(extractTaskPacketMarker(decorated), { present: true, valid: true, packetID, before: objective });
  assert.equal(objectiveBeforeMarker(decorated), objective);
  assert.throws(() => appendTaskPacketMarker(`${objective} ${marked}`, packetID), /TASK_PACKET_MARKER_INJECTED/);
  assert.equal(extractTaskPacketMarker(`${marked}\n${marked}`).valid, false);
  assert.equal(extractTaskPacketMarker(`<!-- OPENAI_TASK_PACKET:not-a-packet -->`).valid, false);
});

test("internal task cycles preserve a terminal Codex failure latch, genuine roots reset it", () => {
  const state = { ...createGuardrailState(), codexFailureTerminal: true };
  const internal = beginRequestCycle(state, "OMO_INTERNAL_INITIATOR retry", Date.now(), process.env, { preserveCodexFailureTerminal: true });
  assert.equal(internal.codexFailureTerminal, true);
  const genuine = beginRequestCycle(internal, "A genuinely new user request", Date.now(), process.env);
  assert.equal(genuine.codexFailureTerminal, false);
});

test("recovery continuation preserves the authoritative root cycle", () => {
  const state = { ...createGuardrailState(), authoritativeObjective: "Implement the calculator change", codexFailureTerminal: true };
  const continuation = beginRequestCycle(
    state,
    "Resume the authoritative recovery packet for this same objective. Do not start a new repository worker.",
    Date.now(),
    process.env,
    { preserveCodexFailureTerminal: true },
  );
  assert.equal(continuation, state);
});
