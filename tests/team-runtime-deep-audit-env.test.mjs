import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../core/bin/team-runtime", import.meta.url));
const core = fileURLToPath(new URL("../core/lib/core.sh", import.meta.url));
const deepAuditRuntimeEnv = fileURLToPath(new URL("../teams/deep-audit/runtime-env.sh", import.meta.url));

test("Deep Audit passes target and report to tmux explicitly, even with an existing server", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-runtime-deep-audit-"));
  try {
    const bin = join(root, "bin");
    const configDir = join(root, "config with spaces");
    const sandbox = join(root, "sandbox");
    const runtimeRoot = join(root, "runtime");
    const data = join(root, "data");
    const opencodeConfig = join(configDir, "opencode.json");
    const log = join(root, "tmux-calls.jsonl");
    await Promise.all([bin, configDir, sandbox, runtimeRoot, data].map((dir) => mkdir(dir)));
    await writeFile(opencodeConfig, "{}\n");
    const python = join(bin, "python");
    await writeFile(python, "#!/bin/sh\nprintf 'a1b2c3d4\\n'\n");
    await chmod(python, 0o755);

    // Stub a tmux server whose environment differs from the launching client.
    const tmux = join(bin, "tmux");
    await writeFile(tmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "new-session") {
  const paneEnv = {
    DEEP_AUDIT_TARGET_ROOT: process.env.TEST_SERVER_TARGET,
    DEEP_AUDIT_REPORT_ROOT: process.env.TEST_SERVER_REPORT,
    OPENCODE_TEAM_DEPENDENCY_ROOT: process.env.TEST_SERVER_DEPENDENCY,
  };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-e") {
      const assignment = args[++i];
      const equals = assignment.indexOf("=");
      paneEnv[assignment.slice(0, equals)] = assignment.slice(equals + 1);
    }
  }
  fs.appendFileSync(process.env.TEST_TMUX_LOG, JSON.stringify({ args, paneEnv }) + "\\n");
}
`);
    await chmod(tmux, 0o755);

    async function launch(team, auditEnv) {
      const config = join(configDir, `${team}.conf`);
      await writeFile(config, [
        `TEAM_NAME=${team}`,
        `OPENCODE_BIN=${python}`,
        `OPENCODE_TEAM_PYTHON=${python}`,
        `SANDBOX=${sandbox}`,
        `RUNTIME_ROOT=${runtimeRoot}`,
        `PERSISTENT_DATA_ROOT=${data}`,
        `TMUX_PREFIX=oc-${team}`,
        `OMO_PROFILE=${team}`,
        `OPENCODE_CONFIG=${opencodeConfig}`,
        "RESUME_ALLOWED_AGENTS=compaction",
        "BRIDGE_MODE=tmux",
        "",
      ].join("\n"));
      const env = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        TEST_TMUX_LOG: log,
        TEST_SERVER_TARGET: "/stale/server/target",
        TEST_SERVER_REPORT: "/stale/server/report",
        TEST_SERVER_DEPENDENCY: "/stale/server/dependencies",
        OPENCODE_TEAM_DEPENDENCY_ROOT: join(root, "shared dependencies"),
      };
      delete env.TMUX;
      delete env.TEAM_RUNTIME_INNER;
      delete env.DEEP_AUDIT_TARGET_ROOT;
      delete env.DEEP_AUDIT_REPORT_ROOT;
      Object.assign(env, auditEnv);
      const result = spawnSync("/bin/bash", [runtime, "--config", config], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      const call = calls.at(-1);
      assert.equal(call.args[0], "new-session");
      assert.ok(call.args.at(-1).includes(`--config '${config}'`));
      return call;
    }

    const target = join(root, "target project with spaces");
    const report = join(root, "report directory with spaces");
    const dependencyRoot = join(root, "shared dependencies");
    const auditEnv = { DEEP_AUDIT_TARGET_ROOT: target, DEEP_AUDIT_REPORT_ROOT: report };
    const audit = await launch("deep-audit", auditEnv);
    assert.equal(audit.paneEnv.DEEP_AUDIT_TARGET_ROOT, target);
    assert.equal(audit.paneEnv.DEEP_AUDIT_REPORT_ROOT, report);
    assert.deepEqual(audit.args.filter((arg) => arg.startsWith("DEEP_AUDIT_")), [
      `DEEP_AUDIT_TARGET_ROOT=${target}`,
      `DEEP_AUDIT_REPORT_ROOT=${report}`,
    ]);
    assert.equal(audit.paneEnv.OPENCODE_TEAM_DEPENDENCY_ROOT, dependencyRoot);
    assert.ok(audit.args.includes(`OPENCODE_TEAM_DEPENDENCY_ROOT=${dependencyRoot}`));
    const startDirectory = audit.args.indexOf("-c");
    assert.notEqual(startDirectory, -1);
    assert.equal(audit.args[startDirectory + 1], target);

    const other = await launch("best", auditEnv);
    assert.equal(other.paneEnv.DEEP_AUDIT_TARGET_ROOT, "/stale/server/target");
    assert.equal(other.paneEnv.DEEP_AUDIT_REPORT_ROOT, "/stale/server/report");
    assert.deepEqual(other.args.filter((arg) => arg.startsWith("DEEP_AUDIT_")), []);
    assert.equal(other.args.includes("-c"), false, "other profiles keep their existing tmux start-directory behavior");
    assert.equal(other.args.includes(`OPENCODE_TEAM_DEPENDENCY_ROOT=${dependencyRoot}`), true);
    assert.equal(other.paneEnv.OPENCODE_TEAM_DEPENDENCY_ROOT, dependencyRoot);

    const missing = await launch("deep-audit", {});
    assert.equal(missing.paneEnv.DEEP_AUDIT_TARGET_ROOT, "");
    assert.equal(missing.paneEnv.DEEP_AUDIT_REPORT_ROOT, "");
    assert.equal(missing.args.includes("-c"), false, "missing target must not fall back to an inherited directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume export uses the configured binary, not a PATH OpenCode or a quoted temp path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state");
  await Promise.all([mkdir(bin), mkdir(state)]);
  const selected = join(bin, "selected-opencode");
  const decoy = join(bin, "opencode");
  await writeFile(selected, '#!/bin/sh\nprintf \'{"info":{"directory":"/tmp"}}\\n\'\n');
  await writeFile(decoy, '#!/bin/sh\nexit 91\n');
  await Promise.all([chmod(selected, 0o755), chmod(decoy, 0o755)]);
  const result = spawnSync("/bin/bash", ["-c", 'source "$CORE"; RUN_STATE_DIR="$STATE"; SANDBOX="$STATE"; OPENCODE_CONFIG="$STATE/config"; OPENCODE_BIN="$SELECTED"; OPENCODE_TEAM_PYTHON="${PYTHON:-/usr/bin/python3}"; OMO_PROFILE=best; resolve_resume_dir ses_abc; cat "$RUN_STATE_DIR/session_directory"'], {
    env: { ...process.env, CORE: core, STATE: state, SELECTED: selected, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PYTHON: process.env.OPENCODE_TEAM_PYTHON ?? process.env.PYTHON_BIN ?? "/usr/bin/python3", TMPDIR: root },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "/tmp");
  assert.deepEqual(await readdir(root), ["bin", "state"], "export temp is removed after use");
});

test("Deep Audit initializes Serena only in its profile with a safe npm cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "deep-audit-serena-runtime-env."));
  const target = join(root, "read-only JavaScript target");
  const sandbox = join(root, "profile data");
  const dependencyRoot = join(root, "dependencies");
  const runtimeRoot = join(root, "runtime");
  await Promise.all([target, join(sandbox, "serena"), dependencyRoot, runtimeRoot].map((dir) => mkdir(dir, { recursive: true })));
  const source = join(target, "calculator.js");
  await writeFile(source, "export function calculateTotal() { return 6; }\n");
  const original = await readFile(source, "utf8");
  try {
    const python = process.env.OPENCODE_TEAM_PYTHON ?? process.env.PYTHON_BIN;
    assert.ok(python && python.startsWith("/"), "a managed Python interpreter is required");
    const result = spawnSync("/bin/bash", ["-c", 'source "$1"; printf "%s\\n%s\\n%s\\n" "$SERENA_HOME" "$npm_config_cache" "$DEEP_AUDIT_TARGET_ROOT"', "serena-runtime-env-test", deepAuditRuntimeEnv], {
      env: {
        ...process.env,
        SANDBOX: sandbox,
        RUNTIME_ROOT: runtimeRoot,
        OPENCODE_BIN: "/opt/homebrew/opt/opencode/bin/opencode",
        OPENCODE_TEAM_PYTHON: python,
        DEEP_AUDIT_TARGET_ROOT: target,
        OPENCODE_TEAM_DEPENDENCY_ROOT: dependencyRoot,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const [serenaHome, npmCache, reportedTarget] = result.stdout.trim().split(/\r?\n/);
    assert.equal(serenaHome, join(sandbox, "serena"));
    assert.equal(npmCache, join(serenaHome, "npm-cache"), "npm cache must not use shared ~/.npm");
    assert.equal(reportedTarget, target);
    const canonicalTarget = await realpath(target);
    const globalConfig = await readFile(join(serenaHome, "serena_config.yml"), "utf8");
    assert.match(globalConfig, /projects:\n  - /);
    assert.ok(globalConfig.includes(JSON.stringify(canonicalTarget)), "active project and trusted pattern must use the canonical target");
    assert.doesNotMatch(globalConfig, /trusted_project_path_patterns:\n  - "?\*\*"?/);
    const projectConfig = await readFile(join(serenaHome, "projects", pathBasename(target), ".serena", "project.local.yml"), "utf8");
    assert.match(projectConfig, /language_servers: \["typescript"\]/);
    assert.match(projectConfig, /typescript_version: "5\.9\.3"/);
    assert.match(projectConfig, /typescript_language_server_version: "5\.1\.3"/);
    assert.deepEqual(await readdir(target), ["calculator.js"]);
    assert.equal(await readFile(source, "utf8"), original, "Serena setup must not write project metadata into the target");
    assert.equal(await readdir(join(sandbox, "serena", "projects", pathBasename(target), ".serena")).then((files) => files.includes("project.local.yml")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function pathBasename(value) {
  return value.split(/[\\/]/).filter(Boolean).at(-1);
}
