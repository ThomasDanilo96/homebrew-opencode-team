import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkForNewRelease, compareVersions, newestReleaseTag, parseVersion, versionNotificationArgs } from "../shared/maintenance/version-check.mjs";

test("release tags are sorted semantically rather than lexically", () => {
  assert.deepEqual(parseVersion("v0.1.44"), [0, 1, 44]);
  assert.equal(compareVersions("v0.1.100", "v0.1.99"), 1);
  assert.equal(compareVersions("v0.2.0", "v0.1.99"), 1);
  assert.equal(compareVersions("invalid", "v0.1.0"), null);
  assert.equal(parseVersion("v0.1.45-rc.1"), null);
  assert.equal(newestReleaseTag([{ name: "v0.1.9" }, { name: "v0.1.44" }, { name: "not-a-release" }]), "v0.1.44");
});

test("a new Homebrew tag sends one notification and records it for deduplication", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-team-version-check-"));
  const packageRoot = join(root, "package"), stateRoot = join(root, "state");
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "VERSION"), "0.1.44\n");
  const calls = [];
  const spawnProcess = (executable, args) => {
    calls.push({ executable, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  const fetchImpl = async (url, options) => {
    assert.match(url, /repos\/ThomasDanilo96\/homebrew-opencode-team\/tags/);
    assert.equal(options.headers["User-Agent"], "opencode-team-update-check");
    return { ok: true, json: async () => [{ name: "v0.1.9" }, { name: "v0.1.45" }] };
  };
  const options = { packageRoot, stateRoot, env: { HOME: "/Users/test", OPENCODE_TEAM_TERMINAL_NOTIFIER: "/Applications/terminal-notifier" }, fetchImpl, spawnProcess, logger: { warn: assert.fail, error: assert.fail } };

  try {
    assert.deepEqual(await checkForNewRelease(options), { status: "notified", currentVersion: "0.1.44", latestTag: "v0.1.45" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "/Applications/terminal-notifier");
    assert.ok(calls[0].args.some((value) => value.includes("brew upgrade ThomasDanilo96/opencode-team/opencode-team && opencode-team setup")));
    assert.ok(calls[0].args.includes("https://github.com/ThomasDanilo96/homebrew-opencode-team/releases/tag/v0.1.45"));
    assert.equal(readFileSync(join(stateRoot, "updates", "last-notified-release"), "utf8").trim(), "v0.1.45");
    assert.deepEqual(await checkForNewRelease(options), { status: "already-notified", currentVersion: "0.1.44", latestTag: "v0.1.45" });
    assert.equal(calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current or unreachable tags do not trigger notifications", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-team-version-current-"));
  const packageRoot = join(root, "package");
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "VERSION"), "0.1.44\n");
  let spawns = 0;
  const options = {
    packageRoot,
    stateRoot: join(root, "state"),
    fetchImpl: async () => ({ ok: true, json: async () => [{ name: "v0.1.44" }, { name: "v0.1.9" }] }),
    spawnProcess: () => { spawns += 1; },
    logger: { warn: assert.fail, error: assert.fail },
  };
  try {
    assert.deepEqual(await checkForNewRelease(options), { status: "current", currentVersion: "0.1.44", latestTag: "v0.1.44" });
    options.fetchImpl = async () => { throw new Error("offline"); };
    options.logger = { warn: () => {}, error: assert.fail };
    assert.deepEqual(await checkForNewRelease(options), { status: "offline" });
    assert.equal(spawns, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release notification offers the update command and release page", () => {
  const args = versionNotificationArgs("v0.1.45");
  assert.ok(args.includes("-open"));
  assert.ok(args.includes("-group"));
  assert.ok(args.some((value) => value.includes("brew upgrade ThomasDanilo96/opencode-team/opencode-team")));
});
