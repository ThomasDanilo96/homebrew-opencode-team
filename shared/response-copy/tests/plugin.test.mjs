import test from "node:test";
import assert from "node:assert/strict";
import { copyResponse, createCopyControl, registerCopySlot, copyClipboard } from "../response-copy-plugin.js";
import { exportLatestResponse } from "../exporter.js";

const parent = { id: "parent", agent: "orchestrator", model: { providerID: "test", id: "model" } };
const user = { id: "user", role: "user", sessionID: "parent", prompt: "USER_PROMPT_PLUGIN_7F2A", time: { created: 1 } };
const assistant = { id: "assistant", role: "assistant", sessionID: "parent", parentID: "user", agent: "orchestrator", providerID: "test", modelID: "model", time: { created: 2 } };
const assistantPart = { id: "text", messageID: "assistant", sessionID: "parent", type: "text", text: "ASSISTANT_PLUGIN_7F2A" };

async function harness({ messages = [user, assistant], parts = { assistant: [assistantPart] }, status = { type: "idle" }, routeName = "session" } = {}) {
  let clipboard;
  const toasts = [];
  let slotRegistration;
  const api = {
    route: { current: { name: routeName, params: { sessionID: "parent" } } },
    state: {
      session: {
        get: (id) => id === "parent" ? parent : undefined,
        messages: (id) => id === "parent" ? messages : [],
        status: () => status,
      },
      part: (id) => parts[id] ?? [],
    },
    client: {
      session: {
        get: async () => ({ data: parent }),
        messages: async () => ({ data: messages.map((info) => ({ info, parts: parts[info.id] ?? [] })) }),
        status: async () => ({ data: { parent: status } }),
      },
    },
    renderer: { copyToClipboardOSC52: async (value) => { clipboard = value; } },
    ui: { toast: (toast) => toasts.push(toast) },
    slots: { register: (registration) => { slotRegistration = registration; return "response-copy-slot"; } },
  };
  const fakeSolid = {
    createElement: (kind) => ({ kind, props: {}, children: [] }),
    setProp: (node, name, value) => { node.props[name] = value; },
    insert: (node, child) => { node.children.push(child); },
  };
  registerCopySlot(api, fakeSolid);
  const control = routeName === "session"
    ? createCopyControl(api, fakeSolid)
    : slotRegistration.slots.session_prompt_right({}, { session_id: "parent" });
  return { api, slotRegistration, control, toasts, get clipboard() { return clipboard; } };
}

test("clicking the control copies the current assistant response", async () => {
  const testHarness = await harness();
  await testHarness.control.props.onMouseUp({});
  assert.equal(testHarness.clipboard, "=== FINAL RESPONSE ===\n\nASSISTANT_PLUGIN_7F2A");
  assert.ok(!testHarness.clipboard.includes("USER_PROMPT_PLUGIN_7F2A"));
  assert.equal(testHarness.toasts.at(-1).message, "Copied full response");
});

test("busy parent leaves clipboard untouched", async () => {
  const testHarness = await harness({ status: { type: "busy" } });
  await testHarness.control.props.onMouseUp({});
  assert.equal(testHarness.clipboard, undefined);
  assert.equal(testHarness.toasts.at(-1).message, "Response is still running");
});

test("empty response leaves clipboard untouched", async () => {
  const testHarness = await harness({ messages: [user] });
  await testHarness.control.props.onMouseUp({});
  assert.equal(testHarness.clipboard, undefined);
  assert.equal(testHarness.toasts.at(-1).message, "Nothing to copy yet");
});

test("registers the session prompt right slot", async () => {
  const testHarness = await harness();
  assert.equal(testHarness.slotRegistration.order, 900);
  assert.equal(typeof testHarness.slotRegistration.slots.session_prompt_right, "function");
  assert.equal(testHarness.control.kind, "box");
  assert.equal(testHarness.control.children[0].children[0], "⧉ Copy full response");
});

test("hides the control outside a session route", async () => {
  const testHarness = await harness({ routeName: "home" });
  assert.equal(testHarness.control, null);
});

test("clipboard payload equals exporter output exactly", async () => {
  const testHarness = await harness();
  const expected = exportLatestResponse({ parentSession: parent, messages: { parent: [user, assistant] }, parts: { assistant: [assistantPart] }, sessions: new Map([[parent.id, parent]]), statuses: new Map([[parent.id, { type: "idle" }]]) }).text;
  await testHarness.control.props.onMouseUp({});
  assert.equal(testHarness.clipboard, expected);
});

test("falls back to macOS clipboard when OSC52 is rejected", async () => {
  let clipboard;
  const api = { renderer: { copyToClipboardOSC52: async () => false } };
  await copyClipboard(api, "OSC52_FALLBACK_PLUGIN_7F2A", {
    platform: "darwin",
    writeClipboard: async (value) => { clipboard = value; },
  });
  assert.equal(clipboard, "OSC52_FALLBACK_PLUGIN_7F2A");
});

test("uses macOS clipboard when tmux falsely reports OSC52 success", async () => {
  let clipboard;
  const api = { renderer: { copyToClipboardOSC52: async () => true } };
  await copyClipboard(api, "TMUX_FALLBACK_PLUGIN_7F2A", {
    platform: "darwin",
    tmux: true,
    writeClipboard: async (value) => { clipboard = value; },
  });
  assert.equal(clipboard, "TMUX_FALLBACK_PLUGIN_7F2A");
});

test("persisted client data supplies an unopened child", async () => {
  const child = { id: "child", parentID: "parent", agent: "librarian", model: { providerID: "test", id: "model" } };
  const childUser = { id: "child-user", role: "user", sessionID: "child", prompt: "CHILD_USER_PLUGIN_7F2A", time: { created: 3 } };
  const childAssistant = { id: "child-assistant", role: "assistant", sessionID: "child", parentID: "child-user", agent: "librarian", providerID: "test", modelID: "model", time: { created: 4 } };
  const childPart = { id: "child-text", messageID: "child-assistant", sessionID: "child", type: "text", text: "SUBAGENT_PLUGIN_7F2A" };
  const taskPart = { id: "task", messageID: "assistant", sessionID: "parent", type: "tool", tool: "task", state: { status: "completed", metadata: { sessionId: "child", parentSessionId: "parent" } } };
  const parentFinalPart = { id: "parent-final", messageID: "assistant", sessionID: "parent", type: "text", text: "PARENT_FINAL_PLUGIN_7F2A" };
  let clipboard;
  const toasts = [];
  const api = {
    route: { current: { name: "session", params: { sessionID: "parent" } } },
    state: {
      session: { get: (id) => id === "parent" ? parent : undefined, status: () => ({ type: "idle" }) },
    },
    client: {
      session: {
        get: async ({ sessionID }) => ({ data: sessionID === "parent" ? parent : child }),
        messages: async ({ sessionID }) => ({ data: sessionID === "parent"
          ? [{ info: user, parts: [] }, { info: assistant, parts: [taskPart, parentFinalPart] }]
          : [{ info: childUser, parts: [] }, { info: childAssistant, parts: [childPart] }] }),
        status: async () => ({ data: { parent: { type: "idle" }, child: { type: "idle" } } }),
      },
    },
    renderer: { copyToClipboardOSC52: async (value) => { clipboard = value; } },
    ui: { toast: (toast) => toasts.push(toast) },
  };
  await copyResponse(api);
  assert.match(clipboard, /=== SUBAGENT: librarian/);
  assert.match(clipboard, /SUBAGENT_PLUGIN_7F2A/);
  assert.match(clipboard, /=== FINAL RESPONSE ===/);
  assert.doesNotMatch(clipboard, /USER_PROMPT_PLUGIN_7F2A|CHILD_USER_PLUGIN_7F2A/);
  assert.doesNotMatch(clipboard, /raw task|reasoning|provider metadata/i);
  assert.equal(toasts.at(-1).message, "Copied full response");
});
