import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const TAGS_API = "https://api.github.com/repos/ThomasDanilo96/homebrew-opencode-team/tags?per_page=100";
const RELEASES_URL = "https://github.com/ThomasDanilo96/homebrew-opencode-team/releases/tag";
const RELEASE_GROUP = "opencode-team-release";
const INSTALL_COMMAND = "brew upgrade ThomasDanilo96/opencode-team/opencode-team && opencode-team setup";

export function parseVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function versionNotificationArgs(tag) {
  return [
    "-title", "OpenCode Team",
    "-subtitle", `Nuova versione disponibile · ${tag}`,
    "-message", `Aggiorna con: ${INSTALL_COMMAND}`,
    "-group", RELEASE_GROUP,
    "-open", `${RELEASES_URL}/${encodeURIComponent(tag)}`,
  ];
}

export function newestReleaseTag(tags) {
  if (!Array.isArray(tags)) return "";
  return tags.map((tag) => String(tag?.name ?? ""))
    .filter((tag) => parseVersion(tag))
    .sort((left, right) => compareVersions(right, left))
    .at(0) || "";
}

export function isDirectInvocation(moduleURL, scriptPath) {
  if (!scriptPath) return false;
  try {
    return moduleURL === pathToFileURL(realpathSync(resolve(scriptPath))).href;
  } catch {
    return false;
  }
}

function launchNotifier(args, spawnProcess, env) {
  const fallback = env.HOME ? join(env.HOME, "Applications", "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier") : "terminal-notifier";
  const executable = env.OPENCODE_TEAM_TERMINAL_NOTIFIER || fallback;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`terminal-notifier exited with ${code}`)));
  });
}

async function readText(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeTextAtomically(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => {});
    throw error;
  }
}

export async function checkForNewRelease({
  packageRoot,
  stateRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnProcess = spawn,
  logger = console,
} = {}) {
  if (!packageRoot || !stateRoot || typeof fetchImpl !== "function") throw new Error("version check configuration is incomplete");

  const currentVersion = await readText(join(packageRoot, "VERSION"));
  if (!parseVersion(currentVersion)) throw new Error("installed package version is invalid");

  let response;
  try {
    response = await fetchImpl(TAGS_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "opencode-team-update-check" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    logger.warn(`[version-check] release lookup failed: ${error.message}`);
    return { status: "offline" };
  }
  if (!response.ok) {
    logger.warn(`[version-check] GitHub returned HTTP ${response.status}`);
    return { status: "unavailable" };
  }

  const tags = await response.json();
  const latestTag = newestReleaseTag(tags);
  const comparison = compareVersions(latestTag, currentVersion);
  if (comparison == null) {
    logger.warn("[version-check] latest release tag is not a stable semantic version");
    return { status: "invalid-release" };
  }
  if (comparison <= 0) return { status: "current", currentVersion, latestTag };

  const updateRoot = join(stateRoot, "updates");
  const noticeFile = join(updateRoot, "last-notified-release");
  if (await readText(noticeFile) === latestTag) return { status: "already-notified", currentVersion, latestTag };

  try {
    await launchNotifier(versionNotificationArgs(latestTag), spawnProcess, env);
    await mkdir(updateRoot, { recursive: true, mode: 0o700 });
    await writeTextAtomically(noticeFile, latestTag);
    return { status: "notified", currentVersion, latestTag };
  } catch (error) {
    logger.error(`[version-check] notification failed: ${error.message}`);
    return { status: "notification-failed", currentVersion, latestTag };
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const { PACKAGE_ROOT, STATE_ROOT } = process.env;
  checkForNewRelease({ packageRoot: PACKAGE_ROOT, stateRoot: STATE_ROOT }).then((result) => {
    process.stdout.write(`${result.status}\n`);
  }).catch((error) => {
    console.error(`[version-check] ${error.message}`);
    process.exitCode = 1;
  });
}
