import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const OPEN_SESSION = fileURLToPath(new URL("./open-session.mjs", import.meta.url));

export function isRootSessionIdleEvent(event, rootSessionID) {
  if (event?.type !== "session.idle" || typeof rootSessionID !== "string" || !rootSessionID) return false;
  const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
  return sessionID === rootSessionID;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function notificationArgs({ teamName, runID, sessionID, sessionTitle, runStateDir, tmuxPrefix, tmuxBin, nodePath = process.execPath, handlerPath = OPEN_SESSION }) {
  const shortID = String(sessionID).split("_").at(-1).slice(-8);
  const clickCommand = [
    nodePath,
    handlerPath,
    "--run-id", runID,
    "--session-id", sessionID,
    "--run-state-dir", runStateDir,
    "--tmux-prefix", tmuxPrefix,
    "--tmux-bin", tmuxBin,
  ].map(shellQuote).join(" ");

  return [
    "-title", `OpenCode Team · ${teamName}`,
    "-subtitle", sessionTitle || `Chat ${shortID}`,
    "-message", "La risposta è pronta. Clicca per riaprire questa chat.",
    "-group", `${teamName}-${sessionID}`,
    "-execute", clickCommand,
  ];
}

function executableNodePath(env) {
  if (env.OPENCODE_TEAM_NODE) return env.OPENCODE_TEAM_NODE;
  for (const directory of String(env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return process.execPath;
}

function cleanSessionTitle(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 88);
}

async function sessionTitleForNotification(event, sessionID, runStateDir, env) {
  const eventInfo = event?.properties?.info;
  const eventTitle = cleanSessionTitle(eventInfo?.title);
  if (eventInfo?.id === sessionID && eventTitle && eventTitle !== "New session") return eventTitle;

  try {
    const cached = cleanSessionTitle(readFileSync(join(runStateDir, "session_title"), "utf8"));
    if (cached && cached !== "New session") return cached;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (env.OPENCODE_SERVER_URL) {
    try {
      const response = await fetch(`${env.OPENCODE_SERVER_URL}/session/${encodeURIComponent(sessionID)}`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const info = await response.json();
        const title = cleanSessionTitle(info?.title);
        if (title && title !== "New session") return title;
      }
    } catch {}
  }
  return `Chat ${sessionID.slice(-8)}`;
}

function notify(args, spawnProcess = spawn, notifierPath = process.env.OPENCODE_TEAM_TERMINAL_NOTIFIER || "terminal-notifier") {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(notifierPath, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`terminal-notifier exited with ${code}`)));
  });
}

export function createMacNotificationPlugin({ env = process.env, spawnProcess = spawn, logger = console } = {}) {
  return {
    event: async ({ event }) => {
      const runStateDir = env.RUNTIME_RUN_STATE_DIR;
      if (!runStateDir) return;
      let rootSessionID;
      try {
        rootSessionID = readFileSync(join(runStateDir, "parent_session_id"), "utf8").trim();
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (!isRootSessionIdleEvent(event, rootSessionID)) return;

      const { TEAM_NAME: teamName, RUN_ID: runID, TMUX_PREFIX: tmuxPrefix, TMUX_BIN: tmuxBin } = env;
      if (!teamName || !runID || !tmuxPrefix || !tmuxBin || !/^[A-Za-z0-9]+$/.test(runID)) {
        throw new Error("macOS notification runtime identity is incomplete");
      }

      try {
        const sessionTitle = await sessionTitleForNotification(event, rootSessionID, runStateDir, env);
        await notify(notificationArgs({ teamName, runID, sessionID: rootSessionID, sessionTitle, runStateDir, tmuxPrefix, tmuxBin, nodePath: executableNodePath(env) }), spawnProcess, env.OPENCODE_TEAM_TERMINAL_NOTIFIER || "terminal-notifier");
      } catch (error) {
        logger.error(`[mac-notifications] ${error.message}`);
      }
    },
  };
}

export default async function macNotificationPlugin() {
  return createMacNotificationPlugin();
}
