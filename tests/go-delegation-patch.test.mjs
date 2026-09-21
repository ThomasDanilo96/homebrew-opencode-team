import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
