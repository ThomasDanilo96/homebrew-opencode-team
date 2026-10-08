import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMacNotificationPlugin,
  isRootSessionIdleEvent,
  notificationArgs,
} from "../shared/mac-notifications/plugin.js";
import {
  findTerminalBundle,
  openChatFromNotification,
  parseTmuxClients,
} from "../shared/mac-notifications/open-session.mjs";

test("macOS completion notifications are limited to the run's root session", () => {
  assert.equal(isRootSessionIdleEvent({ type: "session.idle", properties: { sessionID: "ses_root" } }, "ses_root"), true);
  assert.equal(isRootSessionIdleEvent({ type: "session.idle", properties: { sessionID: "ses_child" } }, "ses_root"), false);
  assert.equal(isRootSessionIdleEvent({ type: "session.created", properties: { sessionID: "ses_root" } }, "ses_root"), false);
});

test("completion hook sends a clickable notification only for the root chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-notification-"));
  const stateDir = join(directory, "run state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "parent_session_id"), "ses_root123\n");
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  const plugin = createMacNotificationPlugin({
    env: { RUNTIME_RUN_STATE_DIR: stateDir, TEAM_NAME: "best", RUN_ID: "a1b2c3d4", TMUX_PREFIX: "oc-best", TMUX_BIN: "/opt/homebrew/bin/tmux" },
    spawnProcess,
    logger: { error: (message) => assert.fail(message) },
  });

  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } });
  assert.equal(calls.length, 0);
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root123" } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "terminal-notifier");
  assert.ok(calls[0].args.includes("-execute"));
  assert.ok(calls[0].args.at(-1).includes(`'${stateDir}'`));
  rmSync(directory, { recursive: true, force: true });
});

test("tmux client lookup and process ancestry support arbitrary terminal app bundles", () => {
  const clients = parseTmuxClients("oc-best-a1b2c3d4|120|/dev/ttys004\nother|122|/dev/ttys005", "oc-best-a1b2c3d4");
  assert.deepEqual(clients, [{ session: "oc-best-a1b2c3d4", pid: 120, tty: "/dev/ttys004" }]);

  const bundle = findTerminalBundle(120, (command, args) => {
    assert.equal(command, "/bin/ps");
    assert.deepEqual(args.slice(0, 2), ["-p", "120"]);
    return "1 /Applications/Example Terminal.app/Contents/MacOS/terminal";
  });
  assert.equal(bundle, "/Applications/Example Terminal.app");
});

test("notification click opens the matching tmux client and rejects stale sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-notification-run-"));
  writeFileSync(join(directory, "run_id"), "a1b2c3d4\n");
  writeFileSync(join(directory, "parent_session_id"), "ses_root123\n");
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, args]);
    if (command === "/opt/homebrew/bin/tmux" && args[0] === "list-clients") return "oc-best-a1b2c3d4|120|/dev/ttys004\n";
    if (command === "/bin/ps") return "1 /Applications/iTerm.app/Contents/MacOS/iTerm2";
    return "";
  };
  openChatFromNotification({ runID: "a1b2c3d4", sessionID: "ses_root123", runStateDir: directory, tmuxPrefix: "oc-best", tmuxBin: "/opt/homebrew/bin/tmux" }, runCommand);
  assert.deepEqual(calls.map(([command]) => command), ["/opt/homebrew/bin/tmux", "/bin/ps", "/usr/bin/open", "/opt/homebrew/bin/tmux"]);
  assert.deepEqual(calls.at(-1)[1], ["switch-client", "-c", "/dev/ttys004", "-t", "oc-best-a1b2c3d4"]);
  assert.throws(() => openChatFromNotification({ runID: "a1b2c3d4", sessionID: "ses_other", runStateDir: directory, tmuxPrefix: "oc-best", tmuxBin: "/opt/homebrew/bin/tmux" }, runCommand), /no longer matches/);
  rmSync(directory, { recursive: true, force: true });
});

test("each profile loads the shared macOS notification plugin", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const team of ["best", "go", "openai", "daily"]) {
    const config = await readFile(new URL(`../teams/${team}/opencode.jsonc.template`, import.meta.url), "utf8");
    assert.ok(config.includes("@PACKAGE_ROOT@/shared/mac-notifications/plugin.js"), team);
  }
});

test("clickable notification uses a shell-quoted handler command", () => {
  const args = notificationArgs({
    teamName: "best",
    runID: "a1b2c3d4",
    sessionID: "ses_root123",
    runStateDir: "/tmp/team state",
    tmuxPrefix: "oc-best",
    nodePath: "/opt/node/bin/node",
    handlerPath: "/opt/team root/open-session.mjs",
    tmuxBin: "/opt/homebrew/bin/tmux",
  });
  const command = args[args.indexOf("-execute") + 1];
  assert.match(command, /'\/tmp\/team state'/);
  assert.match(command, /'\/opt\/team root\/open-session\.mjs'/);
  assert.match(command, /'\/opt\/homebrew\/bin\/tmux'/);
});
