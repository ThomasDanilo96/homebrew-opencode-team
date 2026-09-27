import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("memory circuit blocks fanout but allows root chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "best-memory-circuit-"));
  const previous = Object.fromEntries(["RUNTIME_RUN_STATE_DIR", "BEST_MEMORY_LIVE_RSS_BYTES", "BEST_MEMORY_BLOCK_RSS_BYTES", "BEST_MEMORY_PRESSURE_MAX_AGE_MS"].map((key) => [key, process.env[key]]));
  process.env.RUNTIME_RUN_STATE_DIR = root;
  process.env.BEST_MEMORY_LIVE_RSS_BYTES = "1";
  process.env.BEST_MEMORY_BLOCK_RSS_BYTES = "1610612736";
  process.env.BEST_MEMORY_PRESSURE_MAX_AGE_MS = "300000";
  await writeFile(join(root, "memory-pressure.json"), JSON.stringify({ result: "BLOCK_FANOUT", checked_at: new Date().toISOString() }));
  try {
    const { default: createPlugin } = await import(`../teams/best/best-router-plugin.js?test=${Date.now()}`);
    const hooks = await createPlugin({ directory: root });
    await assert.doesNotReject(() => hooks["chat.message"]({ agent: "child", sessionID: "root" }, { message: {}, parts: [] }));
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: "task", sessionID: "root" }, { args: { subagent_type: "explore" } }),
      /BEST MEMORY SAFETY: fanout paused/
    );
    await writeFile(join(root, "memory-pressure.json"), JSON.stringify({ result: "SAFE", checked_at: new Date().toISOString() }));
    process.env.BEST_MEMORY_LIVE_RSS_BYTES = "2147483648";
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: "task", sessionID: "root" }, { args: { subagent_type: "explore" } }),
      /BEST MEMORY SAFETY: fanout paused/
    );
    process.env.BEST_MEMORY_LIVE_RSS_BYTES = "1";
    await writeFile(join(root, "memory-pressure.json"), JSON.stringify({ result: "BLOCK_FANOUT", checked_at: new Date(Date.now() - 600000).toISOString() }));
    await assert.doesNotReject(() => hooks["tool.execute.before"]({ tool: "task", sessionID: "root" }, { args: { subagent_type: "explore" } }));
    await writeFile(join(root, "memory-pressure.json"), JSON.stringify({ result: "BLOCK_FANOUT", checked_at: new Date().toISOString() }));
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: "task", sessionID: "root" }, { args: { subagent_type: "explore" } }),
      /BEST MEMORY SAFETY: fanout paused/
    );
    await writeFile(join(root, "memory-pressure.json"), JSON.stringify({ result: "SAFE", checked_at: new Date().toISOString() }));
    await assert.doesNotReject(() => hooks["tool.execute.before"]({ tool: "task", sessionID: "root" }, { args: { subagent_type: "explore" } }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
