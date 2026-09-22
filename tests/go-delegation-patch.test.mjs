import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("GO delegation patch resolves the runtime-owned runs directory", () => {
  const source = readFileSync(new URL("../teams/go/patch-routing.py", import.meta.url), "utf8");
  assert.match(source, /const _goRuntimeRoot = process\.env\.RUNTIME_ROOT \|\| _path\.join\(_goSandbox, "state"\);/);
  assert.match(source, /const _runsDir = _path\.join\(_goRuntimeRoot, "runs"\);/);
});

test("BEST delegation patch resolves the runtime-owned runs directory", () => {
  const source = readFileSync(new URL("../teams/best/patch-omo-core.py", import.meta.url), "utf8");
  assert.match(source, /const _goRuntimeRoot = process\.env\.RUNTIME_ROOT \|\| _path\.join\(_goSandbox, "state"\);/);
  assert.match(source, /const _runsDir = _path\.join\(_goRuntimeRoot, "runs"\);/);
});

const isolationScript = new URL("../teams/best/patch-omo-isolation.sh", import.meta.url);
const anchor = 'var __require = typeof import.meta.require === "function" ? import.meta.require : __omoCreateRequire(import.meta.url);\n';
const legacy = 'const _goSandbox = _path.join(_os.homedir(), ".opencode-best-team");';
const coreAware = 'const _goSandbox = process.env.SANDBOX || _path.join(_os.homedir(), ".opencode-best-team");';
const canonical = 'const _goSandbox = _bestTeamSandboxRoot || _path.join(_os.homedir(), ".opencode-best-team");';
const patchEnv = {
  ...process.env,
  OPENCODE_TEAM_PYTHON: process.env.OPENCODE_TEAM_PYTHON || "python3",
};

function runIsolation(source) {
  const root = mkdtempSync(join(tmpdir(), "best-omo-isolation-test-"));
  const target = join(root, "index.js");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(target, `${anchor}${source}`);
  const result = spawnSync("bash", [isolationScript.pathname, target], { encoding: "utf8", env: patchEnv });
  const output = `${result.stdout}${result.stderr}`;
  const patched = readFileSync(target, "utf8");
  rmSync(root, { recursive: true, force: true });
  return { ...result, output, patched };
}

test("BEST isolation patch accepts patch-omo-core output and is idempotent", () => {
  const coreAwareSites = Array.from({ length: 4 }, (_, index) => `function site${index}() { ${coreAware} }`).join("\n");
  const first = runIsolation(coreAwareSites);
  assert.equal(first.status, 0, first.output);
  assert.equal((first.patched.match(/_BEST_TEAM_SANDBOX_OVERRIDE_V1/g) ?? []).length, 1);
  assert.equal((first.patched.match(new RegExp(canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 4);
  assert.equal(first.patched.includes(coreAware), false);

  const root = mkdtempSync(join(tmpdir(), "best-omo-isolation-idempotence-"));
  const target = join(root, "index.js");
  writeFileSync(target, first.patched);
  const second = spawnSync("bash", [isolationScript.pathname, target], { encoding: "utf8", env: patchEnv });
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  assert.match(`${second.stdout}${second.stderr}`, /ALREADY_PATCHED/);
  assert.equal(readFileSync(target, "utf8"), first.patched);
  rmSync(root, { recursive: true, force: true });
});

test("BEST isolation patch refuses unknown site counts", () => {
  for (const source of [legacy.repeat(2) + coreAware.repeat(2), legacy.repeat(3), ""]) {
    const result = runIsolation(source);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /REFUSED/);
  }
});
