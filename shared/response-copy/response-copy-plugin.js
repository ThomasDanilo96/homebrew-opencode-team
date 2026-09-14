import { exportLatestResponse } from "./exporter.js";
import { loadResponseGraph } from "./runtime-source.js";
import { spawn } from "node:child_process";

const COMMAND = "copy-response";

function writeMacClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy");
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`)));
    child.stdin.end(text);
  });
}

async function copyClipboard(api, text, {
  platform = process.platform,
  tmux = Boolean(process.env.TMUX),
  writeClipboard = writeMacClipboard,
} = {}) {
  const copied = await api.renderer.copyToClipboardOSC52(text);
  if (copied !== false && !(platform === "darwin" && tmux && copied === true)) return;
  if (platform !== "darwin") throw new Error("OSC52 clipboard transport failed");
  await writeClipboard(text);
}

async function copyResponse(api) {
  const sessionID = api.route.current.name === "session" ? api.route.current.params.sessionID : undefined;
  if (!sessionID) {
    api.ui.toast({ variant: "info", message: "Nothing to copy yet" });
    return;
  }
  const graph = await loadResponseGraph(api, sessionID);
  const parentSession = graph.parentSession;
  if (!parentSession) {
    api.ui.toast({ variant: "info", message: "Nothing to copy yet" });
    return;
  }
  const parentStatus = graph.statuses.get(sessionID);
  if (parentStatus?.type === "busy" || parentStatus?.type === "retry") {
    api.ui.toast({ variant: "info", message: "Response is still running" });
    return;
  }
  const result = exportLatestResponse({
    parentSession,
    messages: graph.messages,
    parts: graph.parts,
    sessions: graph.sessions,
    statuses: graph.statuses,
  });
  if (result.status === "busy") {
    api.ui.toast({ variant: "info", message: "Response is still running" });
    return;
  }
  if (result.status !== "ready") {
    api.ui.toast({ variant: "info", message: "Nothing to copy yet" });
    return;
  }
  await copyClipboard(api, result.text);
  api.ui.toast({ variant: "success", message: "Copied full response" });
}

function createCopyControl(api, solid) {
  const button = solid.createElement("box");
  solid.setProp(button, "flexDirection", "row");
  solid.setProp(button, "onMouseUp", () => {
    return copyResponse(api);
  });
  const label = solid.createElement("text");
  solid.insert(label, "⧉ Copy full response");
  solid.insert(button, label);
  return button;
}

function registerCopySlot(api, solid) {
  api.slots.register({
    order: 900,
    slots: {
      session_prompt_right: (_context, props) => {
        if (api.route.current.name !== "session" || !props.session_id) return null;
        return createCopyControl(api, solid);
      },
    },
  });
}

export default {
  id: "shared-response-copy",
  tui: async (api) => {
    const solid = await import("@opentui/solid");
    registerCopySlot(api, solid);
  },
};

export { COMMAND, copyResponse, createCopyControl, registerCopySlot, copyClipboard };
