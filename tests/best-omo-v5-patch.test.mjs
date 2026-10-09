import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const sourceBundle = process.env.BEST_OMO_V5_FIXTURE;
const scripts = [
  ["bash", join(root, "teams/best/patch-omo-hook-timeout.sh")],
  ["python3", join(root, "teams/best/patch-omo-core.py")],
  ["bash", join(root, "teams/best/patch-omo-isolation.sh")],
  ["bash", join(root, "teams/best/verify-omo.sh")],
];

test("BEST OMO 5.1.27 patches are complete, fail-closed and idempotent", { skip: !sourceBundle }, () => {
  const temp = mkdtempSync(join(tmpdir(), "best-omo-v5-patch-"));
  const dist = join(temp, "dist");
  const target = join(dist, "index.js");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(temp, "package.json"), '{"name":"oh-my-openagent","version":"5.1.27"}\n');
  const pristine = readFileSync(sourceBundle, "utf8");
  writeFileSync(target, pristine);
  const env = { ...process.env, OPENCODE_TEAM_PYTHON: process.env.OPENCODE_TEAM_PYTHON || "python3" };

  try {
    for (const [runtime, script] of scripts) {
      const result = spawnSync(runtime, [script, target], { encoding: "utf8", env });
      assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
    }

    const patched = readFileSync(target, "utf8");
    for (const marker of [
      "_GO_NATIVE_UI_NO_ATTACH_PATCH_V1",
      "_GO_TASK_NATIVE_UI_NO_ATTACH_PATCH_V1",
      "_GO_TASK_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1",
      "_GO_CALL_OMO_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1",
      "_GO_CALL_OMO_FG_ONLY_V1",
      "_GO_BUILDER_TASK_ALLOW_V1",
      "_BEST_CONFIGURED_AGENT_NO_FALLBACK_V1",
      "_BEST_DELEGATE_NO_FALLBACK_V1",
      "_BEST_MODEL_FALLBACK_CONTROLLER_GUARD_V1",
      "_BEST_TEAM_SANDBOX_OVERRIDE_V1",
      "_BEST_TEAM_OMO_MIGRATION_ISOLATION_V1",
      "_BEST_TEAM_OMO_HOME_OVERRIDE_V1",
    ]) {
      assert.equal(patched.split(marker).length - 1, 1, marker);
    }
    assert.doesNotMatch(patched, /startupMigration \?\?= deps\.runOpenCodeStartupMigration\(\{ cwd: input\.directory \}\)/);
    assert.doesNotMatch(patched, /deps\.migrateLegacyWorkspaceDirectory\(input\.directory\)/);

    for (const [runtime, script] of scripts) {
      const result = spawnSync(runtime, [script, target], { encoding: "utf8", env });
      assert.equal(result.status, 0, `${script} second pass: ${result.stdout}${result.stderr}`);
    }
    assert.equal(readFileSync(target, "utf8"), patched);

    const refused = join(dist, "refused.js");
    const unknown = pristine.replace(
      "async function executeSync(args, toolContext, ctx, deps = defaultDeps6,",
      "async function executeSync_CHANGED(args, toolContext, ctx, deps = defaultDeps6,",
    );
    writeFileSync(refused, unknown);
    const result = spawnSync("python3", [join(root, "teams/best/patch-omo-core.py"), refused], { encoding: "utf8", env });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /REFUSED|anchor matched/);
    assert.equal(readFileSync(refused, "utf8"), unknown);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
