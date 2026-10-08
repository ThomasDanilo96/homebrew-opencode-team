import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export function notificationArgs({ teamName, runID, sessionID, runStateDir, tmuxPrefix, tmuxBin, nodePath = process.execPath, handlerPath = OPEN_SESSION }) {
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
    "-message", `La chat ${sessionID.slice(-8)} ha terminato la risposta. Clicca per tornare alla chat.`,
    "-group", `${teamName}-${sessionID}`,
    "-execute", clickCommand,
  ];
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
        await notify(notificationArgs({ teamName, runID, sessionID: rootSessionID, runStateDir, tmuxPrefix, tmuxBin }), spawnProcess, env.OPENCODE_TEAM_TERMINAL_NOTIFIER || "terminal-notifier");
      } catch (error) {
        logger.error(`[mac-notifications] ${error.message}`);
      }
    },
  };
}

export default async function macNotificationPlugin() {
  return createMacNotificationPlugin();
}
