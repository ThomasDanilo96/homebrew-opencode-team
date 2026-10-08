import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || typeof value !== "string" || values.has(key)) {
      throw new Error("invalid notification click arguments");
    }
    values.set(key, value);
  }
  const result = {
    runID: values.get("--run-id"),
    sessionID: values.get("--session-id"),
    runStateDir: values.get("--run-state-dir"),
    tmuxPrefix: values.get("--tmux-prefix"),
    tmuxBin: values.get("--tmux-bin"),
  };
  if (!/^[A-Za-z0-9]+$/.test(result.runID ?? "")
    || !/^ses_[A-Za-z0-9]+$/.test(result.sessionID ?? "")
    || !result.runStateDir
    || !/^[A-Za-z0-9._-]+$/.test(result.tmuxPrefix ?? "")
    || !result.tmuxBin?.startsWith("/")) {
    throw new Error("invalid notification click identity");
  }
  return result;
}

export function parseTmuxClients(output, sessionName) {
  return output.split("\n").map((line) => {
    const [session, pid, tty] = line.split("|");
    return { session, pid: Number(pid), tty };
  }).filter((client) => client.session === sessionName && Number.isInteger(client.pid) && client.pid > 0 && client.tty?.startsWith("/dev/"));
}

export function findTerminalBundle(clientPID, run = execFileSync) {
  let pid = clientPID;
  const visited = new Set();
  while (pid > 1 && !visited.has(pid)) {
    visited.add(pid);
    const output = run("/bin/ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], { encoding: "utf8" }).trim();
    const match = output.match(/^(\d+)\s+(.+)$/);
    if (!match) break;
    const [, parent, command] = match;
    const bundle = command.match(/(.+?\.app)(?:\/|$)/)?.[1];
    if (bundle) return bundle;
    pid = Number(parent);
  }
  throw new Error("could not identify the terminal application for the tmux client");
}

function run(command, args, runCommand) {
  runCommand(command, args, { stdio: "ignore" });
}

export function openChatFromNotification(args, runCommand = execFileSync) {
  const { runID, sessionID, runStateDir, tmuxPrefix } = args;
  if (readFileSync(join(runStateDir, "run_id"), "utf8").trim() !== runID
    || readFileSync(join(runStateDir, "parent_session_id"), "utf8").trim() !== sessionID) {
    throw new Error("notification no longer matches its runtime session");
  }

  const sessionName = `${tmuxPrefix}-${runID}`;
  const clientsOutput = runCommand(args.tmuxBin, ["list-clients", "-F", "#{session_name}|#{client_pid}|#{client_tty}"], { encoding: "utf8" });
  const client = parseTmuxClients(clientsOutput, sessionName)[0];
  if (!client) throw new Error(`no attached terminal client for ${sessionName}`);

  const terminalBundle = findTerminalBundle(client.pid, runCommand);
  run("/usr/bin/open", ["-a", terminalBundle], runCommand);
  run(args.tmuxBin, ["switch-client", "-c", client.tty, "-t", sessionName], runCommand);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    openChatFromNotification(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`[mac-notifications] ${error.message}`);
    process.exitCode = 1;
  }
}
