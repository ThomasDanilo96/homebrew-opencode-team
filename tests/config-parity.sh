#!/usr/bin/env bash
set -euo pipefail

: "${OPENCODE_TEAM_HOME:?run setup first with OPENCODE_TEAM_HOME}"
ROOT="${OPENCODE_TEAM_PACKAGE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

node - "$OPENCODE_TEAM_HOME" "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [home, root] = process.argv.slice(2);
const read = (team) => JSON.parse(fs.readFileSync(path.join(home, "config", team, "opencode.jsonc"), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, label) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} mismatch`);
const tuiTeams = fs.readdirSync(path.join(root, "teams"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((team) => fs.existsSync(path.join(root, "teams", team, "tui.json.template")));

const best = read("best");
same(best.model, "openai/gpt-5.6-luna", "BEST model");
same(best.small_model, "opencode-go/mimo-v2.5", "BEST small_model");
same(best.default_agent, "OpenCode-Builder", "BEST default_agent");
same(Object.keys(best.agent).sort(), ["OpenCode-Builder", "explore", "librarian"], "BEST agents");
same(best.agent["OpenCode-Builder"].permission.task, "allow", "BEST Builder permission");
same(best.agent.explore.model, "opencode-go/qwen3.7-plus", "BEST explore model");
same(best.agent.librarian.model, "opencode-go/qwen3.7-plus", "BEST librarian model");
same(best.compaction, { auto: true, prune: true, reserved: 10000 }, "BEST compaction");
assert(best.mcp?.serena?.enabled === true, "BEST Serena MCP missing");
assert(path.isAbsolute(best.mcp.serena.command[0]) && best.mcp.serena.command[0].startsWith(path.join(home, "data")), "BEST Serena path invalid");
assert(best.provider?.["opencode-go"]?.options?.timeout === 300000, "BEST provider options missing");
assert(best.plugin.length === 2 && path.isAbsolute(best.plugin[0]), "BEST plugin order/path invalid");

const go = read("go");
same(go.model, "opencode-go/mimo-v2.5", "GO model");
same(go.small_model, "opencode-go/mimo-v2.5", "GO small_model");
same(go.default_agent, "OpenCode-Builder", "GO default_agent");
same(go.compaction, { auto: true, prune: true, reserved: 10000 }, "GO compaction");
assert(go.disabled_providers.includes("openai"), "GO provider policy missing");
assert(go.mcp?.serena?.enabled === true, "GO Serena MCP missing");
assert(path.isAbsolute(go.mcp.serena.command[0]) && go.mcp.serena.command[0].startsWith(path.join(home, "data")), "GO Serena path invalid");
assert(go.provider?.["opencode-go"]?.options?.max_tokens === 32768, "GO provider options missing");
assert(go.plugin.length === 1 && path.isAbsolute(go.plugin[0]), "GO plugin order/path invalid");

const openai = read("openai");
same(openai.model, "openai/gpt-5.6-sol", "OPENAI model");
same(openai.small_model, "openai/gpt-5.6-luna-fast", "OPENAI small_model");
same(openai.default_agent, "openai_orchestrator", "OPENAI default_agent");
same(Object.keys(openai.agent).sort(), ["codex_executor", "openai_explore", "openai_librarian", "openai_ops", "openai_orchestrator", "reviewer", "reviewer_critical", "specialist", "tester"], "OPENAI agents");
same(openai.enabled_providers, ["openai"], "OPENAI enabled providers");
same(openai.compaction, { auto: true, prune: true, reserved: 10000 }, "OPENAI compaction");
assert(openai.mcp?.serena?.enabled === true, "OPENAI Serena MCP missing");
assert(path.isAbsolute(openai.mcp.serena.command[0]) && openai.mcp.serena.command[0].startsWith(path.join(home, "data")), "OPENAI Serena path invalid");
assert(openai.plugin.length === 3 && openai.plugin.every(path.isAbsolute), "OPENAI plugin paths invalid");

const daily = read("daily");
same(daily.model, "openai/gpt-5.6-luna", "OPENAI DAILY model");
same(daily.small_model, "openai/gpt-5.6-luna", "OPENAI DAILY small_model");
same(daily.default_agent, "openai_orchestrator", "OPENAI DAILY default_agent");
same(Object.keys(daily.agent).sort(), ["codex_executor", "openai_explore", "openai_librarian", "openai_ops", "openai_orchestrator", "reviewer", "reviewer_critical", "specialist", "tester"], "OPENAI DAILY agents");
same(daily.enabled_providers, ["openai"], "OPENAI DAILY enabled providers");
same(daily.compaction, { auto: true, prune: true, reserved: 24000 }, "OPENAI DAILY compaction");
assert(daily.mcp?.serena?.enabled === true, "OPENAI DAILY Serena MCP missing");
assert(path.isAbsolute(daily.mcp.serena.command[0]) && daily.mcp.serena.command[0].startsWith(path.join(home, "data")), "OPENAI DAILY Serena path invalid");
assert(daily.plugin.length === 3 && daily.plugin.every(path.isAbsolute), "OPENAI DAILY plugin paths invalid");
assert(daily.plugin[1].endsWith("/teams/openai/config/opencode/openai-team-tools.js"), "OPENAI DAILY shared tools path invalid");

for (const team of ["best", "go", "openai", "daily"]) {
  const config = read(team);
  const serialized = JSON.stringify(config);
  assert(!serialized.includes(".opencode-" + "team-staging"), `${team} staging fallback`);
  assert(!serialized.includes("go-" + "final-ux-v1"), `${team} historical fallback`);
}
for (const team of tuiTeams) {
  const tuiPath = path.join(home, "config", team, "xdg-config", "opencode", "tui.json");
  assert(fs.existsSync(tuiPath), `${team} TUI config missing`);
  const tui = JSON.parse(fs.readFileSync(tuiPath, "utf8"));
  const expectedPlugin = path.join(root, "shared", "response-copy");
  assert(Array.isArray(tui.plugin), `${team} TUI plugin list missing`);
  assert(tui.plugin.filter((plugin) => plugin === expectedPlugin).length === 1, `${team} response-copy plugin mismatch`);
  assert(path.isAbsolute(expectedPlugin) && fs.existsSync(expectedPlugin), `${team} response-copy plugin path invalid`);
  assert(!JSON.stringify(tui).includes(".opencode-" + "team-staging"), `${team} TUI staging fallback`);
}
assert(fs.existsSync(path.join(root, "teams", "best", "patch-omo-hook-timeout.sh")), "BEST hook missing");
console.log("CONFIG PARITY PASS");
NODE
