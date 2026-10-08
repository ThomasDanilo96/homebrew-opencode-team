import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const lane = join(process.cwd(), "teams/openai/bin/codex-lane.sh");

test("probe resolves compatible Node22 through exact zsh command and cleans", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-node-"));
  try {
    const env = { ...process.env, PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH}`, OPENAI_TEAM_STATE_ROOT: join(root, "state"), CODEX_HOME: join(root, "home"), OPENAI_CODEX_NODE_PROBE: "1" };
    const result = await run(lane, ["--probe-node"], { env });
    assert.match(result.stdout, /\/opt\/homebrew\/opt\/node@22\/bin\/node\nv22\.(?:2[2-9]|[3-9][0-9])\./);
    assert.deepEqual(await readdir(env.CODEX_HOME), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("early validation failure removes the already-created private zsh directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-node-fail-"));
  try {
    const env = { ...process.env, PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH}`, OPENAI_TEAM_STATE_ROOT: join(root, "state"), CODEX_HOME: join(root, "home"), OPENAI_CODEX_MODEL: "test-model", OPENAI_CODEX_NODE_PROBE: "0", OPENAI_CODEX_INVOCATION_ID: "not-a-uuid" };
    await assert.rejects(run(lane, ["objective"], { env }));
    assert.deepEqual(await readdir(env.CODEX_HOME), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mutation lane contract requires implementation before verification", async () => {
  const source = await readFile(lane, "utf8");
  assert.match(source, /Mutation intent is authoritative: make the requested file changes before verification\./);
  assert.match(source, /After completing mutations, run requested verification and provide a concise summary\./);
  assert.doesNotMatch(source, /Stop after requested verification and concise summary/);
});

test("resume lane invokes the native resume subcommand", async () => {
  const source = await readFile(lane, "utf8");
  assert.match(source, /codex_args=\(exec resume --model/);
  assert.match(source, /codex_args=\(exec --model/);
  assert.doesNotMatch(source, /codex_args=\(exec\)[\s\S]*?codex_args\+=\(resume/);
});
