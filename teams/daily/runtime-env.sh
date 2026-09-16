#!/usr/bin/env bash
set -euo pipefail

DAILY_TEAM_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENAI_CODEX_QUICK_PRIMARY="${OPENAI_CODEX_QUICK_PRIMARY:-gpt-5.6-luna}"
OPENAI_CODEX_QUICK_FALLBACK="${OPENAI_CODEX_QUICK_FALLBACK:-gpt-5.6-terra}"
OPENAI_CODEX_STANDARD_PRIMARY="${OPENAI_CODEX_STANDARD_PRIMARY:-gpt-5.6-terra}"
OPENAI_CODEX_STANDARD_FALLBACK="${OPENAI_CODEX_STANDARD_FALLBACK:-gpt-5.6-sol}"
OPENAI_CODEX_COMPLEX_PRIMARY="${OPENAI_CODEX_COMPLEX_PRIMARY:-gpt-5.6-sol}"
OPENAI_CODEX_COMPLEX_FALLBACK="${OPENAI_CODEX_COMPLEX_FALLBACK:-gpt-5.6-terra}"
OPENAI_CODEX_REASONING_EFFORT="${OPENAI_CODEX_REASONING_EFFORT:-low}"
OPENAI_CODEX_COMPACT_TOKEN_LIMIT="${OPENAI_CODEX_COMPACT_TOKEN_LIMIT:-32000}"
OPENAI_TOKEN_WARN_ORCHESTRATOR_UNCACHED="${OPENAI_TOKEN_WARN_ORCHESTRATOR_UNCACHED:-12000}"
OPENAI_TOKEN_WARN_WRAPPER_UNCACHED="${OPENAI_TOKEN_WARN_WRAPPER_UNCACHED:-3000}"
OPENAI_TOKEN_WARN_CODEX_UNCACHED="${OPENAI_TOKEN_WARN_CODEX_UNCACHED:-24000}"
OPENAI_TOKEN_WARN_AGENT_UNCACHED="${OPENAI_TOKEN_WARN_AGENT_UNCACHED:-10000}"
OPENAI_DAILY_PROFILE=1

# Reuse the OpenAI runtime policy while keeping DAILY state under its own sandbox.
source "$DAILY_TEAM_ROOT/../openai/runtime-env.sh"
export OPENAI_DAILY_PROFILE

node --input-type=module <<'NODE'
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const stateHome = process.env.XDG_STATE_HOME;
if (!stateHome) throw new Error("XDG_STATE_HOME must be set for DAILY animation persistence");
const directory = join(stateHome, "opencode");
const file = join(directory, "kv.json");
let existing;
let mode;
try {
  existing = JSON.parse(await readFile(file, "utf8"));
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) throw new Error("kv.json must contain a JSON object");
  if (existing.animations_enabled === false) process.exit(0);
  mode = (await stat(file)).mode & 0o777;
} catch (error) {
  if (error.code === "ENOENT") existing = {};
  else throw error;
}

await mkdir(directory, { recursive: true });
const temporary = join(directory, `.kv.json.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
try {
  const contents = `${JSON.stringify({ ...existing, animations_enabled: false })}\n`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: mode ?? 0o644, flag: "wx" });
  if (mode !== undefined) await chmod(temporary, mode);
  const handle = await open(temporary, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}
NODE
