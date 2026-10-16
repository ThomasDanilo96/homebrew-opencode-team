import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = join(packageRoot, "bin/opencode-team");
const launcher = await readFile(launcherPath, "utf8");

function extractFunction(name) {
  const header = new RegExp(`^${name}\\(\\) \\{`, "m");
  const match = header.exec(launcher);
  assert.ok(match, `missing shell function ${name}`);
  const start = match.index;
  const next = /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/gm;
  next.lastIndex = start + match[0].length;
  const following = next.exec(launcher);
  return launcher.slice(start, following ? following.index : launcher.length).trimEnd();
}

function runBash(script, { env = {}, cwd = packageRoot } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.OPENCODE_BIN;
  return spawnSync("/bin/bash", ["-c", script], {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
}

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), "launcher-regression."));
}

async function fakeOpenCode(root, version = "1.18.32") {
  const bin = join(root, "bin");
  const prefix = join(root, "brew-prefix");
  await mkdir(bin, { recursive: true });
  await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(join(bin, "brew"), "#!/bin/sh\nprintf '%s\\n' \"$FAKE_BREW_PREFIX\"\n");
  await writeFile(join(prefix, "bin/opencode"), `#!/bin/sh
case "${"$"}{1:-}" in
  --version) printf '%s\\n' '${version}' ;;
  models) printf '%s\\n' 'openai/gpt-6-astra' 'openai/gpt-6.1-sol' ;;
  debug) cat "${"$"}FAKE_DEBUG_CONFIG" ;;
  *) exit 64 ;;
esac
`);
  await chmod(join(bin, "brew"), 0o755);
  await chmod(join(prefix, "bin/opencode"), 0o755);
  return { bin, prefix, executable: join(prefix, "bin/opencode") };
}

const resolverFunctions = [
  "resolve_opencode",
  "opencode_version_supported",
  "validate_opencode",
  "load_opencode",
  "ensure_opencode_loaded",
].map(extractFunction).join("\n");

test("Node check executes real Node.js and rejects shims and malformed versions", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const fake = join(bin, "node");
  await writeFile(fake, "#!/bin/sh\nprintf 'v26.0.0\\n'\n");
  await chmod(fake, 0o755);
  const functions = ["node_version_compatible", "check_node"].map(extractFunction).join("\n");
  const rejected = runBash(`set -euo pipefail\n${functions}\nif check_node; then exit 99; fi\nif node_version_compatible v26.not-a-version.0; then exit 98; fi`, {
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.match(rejected.stdout, /INVALID/);
  const accepted = runBash(`set -euo pipefail\n${functions}\ncheck_node`, {
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
  });
  if (Number(process.versions.node.split(".")[0]) >= 26) {
    assert.equal(accepted.status, 0, accepted.stderr);
  }
});

test("ambient OpenCode cannot replace the Homebrew binary", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeOpenCode(root);
  const impostor = join(root, "impostor");
  await writeFile(impostor, "#!/bin/sh\nprintf '1.18.32\\n'\n");
  await chmod(impostor, 0o755);
  const result = runBash(`set -euo pipefail\n${resolverFunctions}\nOPENCODE_BIN="$IMPOSTOR"\nensure_opencode_loaded\nprintf '%s\\n' "$OPENCODE_BIN"`, {
    env: { PATH: `${fake.bin}:${process.env.PATH}`, FAKE_BREW_PREFIX: fake.prefix, IMPOSTOR: impostor, OPENCODE_MIN_VERSION: "1.18.30" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fake.executable);
});

test("the centralized resolver rejects unsupported Homebrew OpenCode versions", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeOpenCode(root, "1.17.99");
  const result = runBash(`set -euo pipefail\n${resolverFunctions}\nif load_opencode; then exit 99; fi\nprintf 'unsupported-version-rejected\\n'`, {
    env: {
      PATH: `${fake.bin}:${process.env.PATH}`,
      FAKE_BREW_PREFIX: fake.prefix,
      OPENCODE_MIN_VERSION: "1.18.30",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unsupported-version-rejected/);
});

test("Homebrew OpenCode version parser accepts the product-prefixed CLI format", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeOpenCode(root, "opencode 2.0.30");
  const functions = ["opencode_version_supported", "validate_opencode"].map(extractFunction).join("\n");
  const result = runBash(`set -euo pipefail\n${functions}\nOPENCODE_MIN_VERSION=1.18.30\nvalidate_opencode "$SELECTED"\nprintf '%s\\n' "$OPENCODE_VERSION"`, {
    env: { SELECTED: fake.executable },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "2.0.30");
});

const debugConfig = {
  model: "openai/gpt-6-astra",
  agent: {
    "audit-orchestrator": { model: "openai/gpt-6-astra", variant: "xhigh" },
    "audit-reviewer": { model: "openai/gpt-6-astra", variant: "max" },
    "audit-performance": { model: "openai/gpt-6.1-sol", variant: "high" },
    "audit-inventory": { model: "openai/gpt-6-luna", variant: "high" },
  },
};

test("BEST and Deep Audit start paths resolve and export OpenCode when OPENCODE_BIN is unset", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeOpenCode(root);
  const pkg = join(root, "package");
  const teamHome = join(root, "team-home");
  const target = join(root, "fixture-project");
  await mkdir(join(pkg, "core/bin"), { recursive: true });
  await mkdir(join(teamHome, "config/best"), { recursive: true });
  await mkdir(join(teamHome, "config/deep-audit"), { recursive: true });
  await mkdir(join(teamHome, "data/opencode"), { recursive: true });
  await mkdir(target);
  const canonicalTarget = await realpath(target);
  const debugConfigFile = join(root, "debug-config.json");
  await writeFile(debugConfigFile, JSON.stringify(debugConfig));
  const runtimeStub = join(pkg, "core/bin/team-runtime");
  await writeFile(runtimeStub, `#!/bin/sh
printf 'RUNTIME_OPENCODE_BIN=%s\\n' "${"$"}OPENCODE_BIN"
printf 'RUNTIME_CONFIG=%s\\n' "${"$"}2"
if [ -n "${"$"}2" ] && [ -f "${"$"}2" ]; then
  awk -F= '/^OPENCODE_BIN=/{print "PROFILE_OPENCODE_BIN=" $2; exit}' "${"$"}2"
fi
printf 'RUNTIME_TARGET=%s\\n' "${"$"}DEEP_AUDIT_TARGET_ROOT"
printf 'RUNTIME_ARGS=%s\\n' "${"$"}*"
`);
  await chmod(runtimeStub, 0o755);
  const readonlyWrapper = join(root, "readonly-opencode.sh");
  await writeFile(readonlyWrapper, "#!/bin/sh\nexit 0\n");
  await chmod(readonlyWrapper, 0o755);
  const bestConfig = join(teamHome, "config/best/team-runtime.conf");
  const auditConfig = join(teamHome, "config/deep-audit/team-runtime.conf");
  await writeFile(bestConfig, "TEAM_NAME=best\nOPENCODE_BIN=/unused\n");
  await writeFile(auditConfig, `TEAM_NAME=deep-audit\nOPENCODE_BIN=${readonlyWrapper}\n`);

  const env = {
    PATH: `${fake.bin}:${process.env.PATH}`,
    FAKE_BREW_PREFIX: fake.prefix,
    FAKE_DEBUG_CONFIG: debugConfigFile,
    OPENCODE_MIN_VERSION: "1.18.30",
    PACKAGE_ROOT: pkg,
    TEAM_HOME: teamHome,
    TARGET: target,
    PYTHON_BIN: process.execPath,
    OPENCODE_TEAM_PYTHON: process.execPath,
    HOME: join(root, "home"),
    OPENCODE_TEAM_TEST_SHARED_AUTH: "fixture-profile-token",
  };
  await mkdir(join(env.HOME, ".local/share/opencode"), { recursive: true });
  await writeFile(join(env.HOME, ".local/share/opencode/auth.json"), env.OPENCODE_TEAM_TEST_SHARED_AUTH);

  const setupStubs = `
setup_roots() {
  CONFIG_ROOT="$TEAM_HOME/config"; DATA_ROOT="$TEAM_HOME/data"; STATE_ROOT="$TEAM_HOME/state"
  CACHE_ROOT="$TEAM_HOME/cache"; RUNTIME_ROOT="$CACHE_ROOT/runtime"; DEPENDENCY_ROOT="$TEAM_HOME/dependencies"
  export PACKAGE_ROOT CONFIG_ROOT DATA_ROOT STATE_ROOT CACHE_ROOT RUNTIME_ROOT DEPENDENCY_ROOT
}
ensure_profile_roots() { mkdir -p "$CONFIG_ROOT/$1"; }
ensure_generated_config_current() { return 0; }
managed_python_healthy() { return 0; }
verify_deep_audit_ecc() { return 0; }
verify_deep_audit_sandbox() { return 0; }
`;

  const common = [
    "opencode_version_supported",
    "validate_opencode",
    "resolve_opencode",
    "load_opencode",
    "ensure_opencode_loaded",
    "start_team",
  ].map(extractFunction).join("\n");
  const best = runBash(`set -euo pipefail\n${common}\n${setupStubs}\nstart_team best --resume fixture-session`, { env });
  assert.equal(best.status, 0, best.stderr);
  assert.match(best.stdout, new RegExp(`RUNTIME_OPENCODE_BIN=${fake.executable.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.match(best.stdout, /RUNTIME_ARGS=--config .*team-runtime\.conf --resume fixture-session/);

  const auditFunctions = [
    "opencode_version_supported",
    "validate_opencode",
    "resolve_opencode",
    "load_opencode",
    "ensure_opencode_loaded",
    "deep_audit_model_check",
    "start_team",
    "start_deep_audit",
  ].map(extractFunction).join("\n");
  const audit = runBash(`set -euo pipefail\n${auditFunctions}\n${setupStubs}\nstart_deep_audit "$TARGET"`, { env });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, new RegExp(`RUNTIME_OPENCODE_BIN=${fake.executable.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.match(audit.stdout, new RegExp(`PROFILE_OPENCODE_BIN=${readonlyWrapper.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.ok(audit.stdout.includes(`RUNTIME_TARGET=${canonicalTarget}`));
  assert.match(audit.stderr, /profile-local OAuth\. Start once to connect with \/connect openai/);
  assert.equal(await readFile(join(env.HOME, ".local/share/opencode/auth.json"), "utf8"), env.OPENCODE_TEAM_TEST_SHARED_AUTH);
  await assert.rejects(() => readFile(join(teamHome, "data/deep-audit/data/opencode/auth.json")));
});

test("stale detection reports genuine filesystem paths but ignores JSONC comments, prompts, globs and escaped prose", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = join(root, "config");
  const teamRoot = join(configRoot, "best");
  await mkdir(teamRoot, { recursive: true });
  const packagePath = join(packageRoot, "teams/best/best-router-plugin.js");
  const stalePath = "/opt/homebrew/Cellar/brew-opencode-team/0.1.62/share/brew-opencode-team/teams/best/best-router-plugin.js";
  const escapedStalePath = String.raw`/opt/homebrew/Cellar/brew-opencode-team/0.1.62/share/brew-opencode-team/teams/best/escaped\"name.js`;
  const jsonc = `{
    // ${stalePath}
    "plugin": [${JSON.stringify(packagePath)}, ${JSON.stringify(stalePath)}],
    "permission": {"external_directory": {"/opt/homebrew/Cellar/brew-opencode-team/0.1.62/**": "allow"}},
    "agent": {"audit": {"prompt": ${JSON.stringify(`Review the string \\\"${stalePath}\\\" and do not treat it as a path.`)}}},
    "escaped_prose": ${JSON.stringify(`The quoted string is \\\"${stalePath}\\\".`)},
    "escaped_path": ${JSON.stringify(escapedStalePath)},
    "trailing": true,
  }`;
  await writeFile(join(teamRoot, "opencode.jsonc"), jsonc);
  await writeFile(join(teamRoot, "team-runtime.conf"), `OPENCODE_BIN=${stalePath}\nRUNTIME_ROOT=${join(root, "runtime")}\n`);
  const functionCode = extractFunction("stale_generated_package_paths");
  const result = runBash(`set -euo pipefail\n${functionCode}\nstale_generated_package_paths`, {
    env: {
      PYTHON_BIN: process.env.PYTHON_BIN || "/usr/bin/python3",
      CONFIG_ROOT: configRoot,
      PACKAGE_ROOT: packageRoot,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /opencode\.jsonc: \/opt\/homebrew\/Cellar\/brew-opencode-team\/0\.1\.62\/share\/brew-opencode-team\/teams\/best\/best-router-plugin\.js/);
  assert.match(result.stdout, /team-runtime\.conf: \/opt\/homebrew\/Cellar\/brew-opencode-team\/0\.1\.62\/share\/brew-opencode-team\/teams\/best\/best-router-plugin\.js/);
  assert.ok(result.stdout.includes(escapedStalePath), "a real stale path containing escaped JSON characters should remain discoverable");
  assert.doesNotMatch(result.stdout, /\*\*|Review the string|quoted string/);

  const currentOnly = `{
    "plugin": [${JSON.stringify(packagePath)}],
    "unrelated_path": "/projects/opencode-team/user-notes/missing.txt",
    "permission": {"external_directory": {"${stalePath}/**": "allow"}},
    "agent": {"audit": {"prompt": ${JSON.stringify(`Review ${stalePath}`)}}},
    "escaped_prose": ${JSON.stringify(`The path ${stalePath} is prose.`)},
  }`;
  await writeFile(join(teamRoot, "opencode.jsonc"), currentOnly);
  await writeFile(join(teamRoot, "team-runtime.conf"), `OPENCODE_BIN=${packageRoot}/bin/opencode-team\nRUNTIME_ROOT=${join(root, "runtime")}\n`);
  const clean = runBash(`set -euo pipefail\n${functionCode}\nstale_generated_package_paths`, {
    env: {
      PYTHON_BIN: process.env.PYTHON_BIN || "/usr/bin/python3",
      CONFIG_ROOT: configRoot,
      PACKAGE_ROOT: packageRoot,
    },
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), "");
});

test("renderer is atomic on success, missing variables, Python errors, and comparison errors", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeOpenCode(root);
  const fakeConfig = join(root, "debug-config.json");
  await writeFile(fakeConfig, JSON.stringify(debugConfig));
  const fakeBin = join(root, "bin");
  const destination = join(root, "generated.conf");
  const template = join(root, "template.conf");
  await writeFile(template, "OPENCODE=@OPENCODE_BIN@\nROOT=@PACKAGE_ROOT@\nSERENA=@SERENA_BIN@\n");
  const functionCode = ["resolve_opencode", "opencode_version_supported", "validate_opencode", "load_opencode", "ensure_opencode_loaded", "render_template"].map(extractFunction).join("\n");
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_BREW_PREFIX: fake.prefix,
    FAKE_DEBUG_CONFIG: fakeConfig,
    OPENCODE_MIN_VERSION: "1.18.30",
    PACKAGE_ROOT: packageRoot,
    PYTHON_BIN: process.env.PYTHON_BIN || "/usr/bin/python3",
    CONFIG_ROOT: join(root, "config"),
    DATA_ROOT: join(root, "data"),
    STATE_ROOT: join(root, "state"),
    CACHE_ROOT: join(root, "cache"),
    RUNTIME_ROOT: join(root, "cache/runtime"),
    DEPENDENCY_ROOT: join(root, "dependencies"),
    SERENA_BIN: "/profile/serena",
  };
  const render = () => runBash(`set -euo pipefail\n${functionCode}\nrender_template "$TEMPLATE" "$DESTINATION"`, {
    env: { ...env, TEMPLATE: template, DESTINATION: destination },
  });

  await writeFile(destination, "old-valid-config\n");
  const success = render();
  assert.equal(success.status, 0, success.stderr);
  const expected = `OPENCODE=${fake.executable}\nROOT=${packageRoot}\nSERENA=/profile/serena\n`;
  assert.equal(await readFile(destination, "utf8"), expected);
  const firstMtime = (await stat(destination, { bigint: true })).mtimeNs;
  assert.equal(render().status, 0);
  assert.equal((await stat(destination, { bigint: true })).mtimeNs, firstMtime, "unchanged templates must not be rewritten");

  await writeFile(destination, "must-survive-missing-variable\n");
  const missing = runBash(`set -euo pipefail\n${functionCode}\nunset SERENA_BIN\nrender_template "$TEMPLATE" "$DESTINATION"`, {
    env: { ...env, TEMPLATE: template, DESTINATION: destination },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /KeyError: 'SERENA_BIN'/);
  assert.equal(await readFile(destination, "utf8"), "must-survive-missing-variable\n");

  const failPython = join(fakeBin, "failing-python");
  await writeFile(failPython, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(process.argv.at(-1), 'partial output');\nprocess.stderr.write('renderer-original-error\\n');\nprocess.exit(37);\n`);
  await chmod(failPython, 0o755);
  await writeFile(destination, "must-survive-python-error\n");
  const failed = runBash(`set -euo pipefail\n${functionCode}\nrender_template "$TEMPLATE" "$DESTINATION"`, {
    env: { ...env, PYTHON_BIN: failPython, TEMPLATE: template, DESTINATION: destination },
  });
  assert.equal(failed.status, 37);
  assert.match(failed.stderr, /renderer-original-error/);
  assert.equal(await readFile(destination, "utf8"), "must-survive-python-error\n");
  assert.equal((await readdir(root)).some((name) => name.startsWith("generated.conf.tmp.")), false, "only the failed render's owned temp should be removed");

  const cmpBin = join(root, "cmp-bin");
  await mkdir(cmpBin);
  const cmp = join(cmpBin, "cmp");
  await writeFile(cmp, "#!/bin/sh\nexit 7\n");
  await chmod(cmp, 0o755);
  await writeFile(destination, "must-survive-comparison-error\n");
  const comparisonError = runBash(`set -euo pipefail\n${functionCode}\nrender_template "$TEMPLATE" "$DESTINATION"`, {
    env: { ...env, PATH: `${cmpBin}:${fakeBin}:${process.env.PATH}`, TEMPLATE: template, DESTINATION: destination },
  });
  assert.equal(comparisonError.status, 7);
  assert.equal(await readFile(destination, "utf8"), "must-survive-comparison-error\n");
  assert.equal((await readdir(root)).some((name) => name.startsWith("generated.conf.tmp.")), false);
});

test("renderer does not remove a replacement when its owned temporary vanished", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeOpenCode(root);
  const destination = join(root, "rendered");
  const template = join(root, "template");
  await writeFile(template, "hello\n");
  const python = join(root, "remove-own-temp");
  await writeFile(python, "#!/bin/sh\nrm -f -- \"$3\"\nexit 0\n");
  await chmod(python, 0o755);
  const functions = ["resolve_opencode", "opencode_version_supported", "validate_opencode", "load_opencode", "ensure_opencode_loaded", "render_template"].map(extractFunction).join("\n");
  const result = runBash(`set -euo pipefail\n${functions}\nrender_template "$TEMPLATE" "$DESTINATION"`, {
    env: { PATH: `${fake.bin}:${process.env.PATH}`, FAKE_BREW_PREFIX: fake.prefix, OPENCODE_MIN_VERSION: "1.18.30", PYTHON_BIN: python, TEMPLATE: template, DESTINATION: destination },
  });
  assert.equal(result.status, 1);
  await assert.rejects(() => readFile(destination));
});
