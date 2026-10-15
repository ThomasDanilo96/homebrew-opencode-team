#!/usr/bin/env bash
set -euo pipefail

: "${OPENCODE_TEAM_HOME:?run setup first with OPENCODE_TEAM_HOME}"
ROOT="${OPENCODE_TEAM_PACKAGE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

node - "$OPENCODE_TEAM_HOME" "$ROOT" "${OPENCODE_TEAM_DEPENDENCY_ROOT:-$OPENCODE_TEAM_HOME/data/dependencies}" <<'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const [home, root, dependencyRoot] = process.argv.slice(2);
const read = (team) => JSON.parse(fs.readFileSync(path.join(home, "config", team, "opencode.jsonc"), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, label) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} mismatch: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
const tuiTeams = fs.readdirSync(path.join(root, "teams"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((team) => fs.existsSync(path.join(root, "teams", team, "tui.json.template")));

const best = read("best");
const bestOmo = JSON.parse(fs.readFileSync(path.join(home, "config", "best", "xdg-config", "opencode", "oh-my-openagent.jsonc"), "utf8"));
const bestOmoModels = JSON.parse(fs.readFileSync(path.join(home, "data", "best", ".omo", "omo.jsonc"), "utf8"));
const bestOmoNativeAgents = bestOmoModels.profiles["best-native"]["[native]"].agents;
const assertSkillMcp = (team, agent) => {
  const env = {
    ...process.env,
    OPENCODE_CONFIG: path.join(home, "config", team, "opencode.jsonc"),
    OPENCODE_CONFIG_DIR: path.join(home, "config", team),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config", team, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "data", team, "data"),
    XDG_CACHE_HOME: path.join(home, "cache", team),
    XDG_STATE_HOME: path.join(home, "state", team),
  };
  const resolved = spawnSync("opencode", ["debug", "agent", agent], { cwd: root, env, encoding: "utf8" });
  assert(resolved.status === 0, `${team}/${agent} runtime config rejected: ${resolved.stderr}`);
  const effective = JSON.parse(resolved.stdout);
  const allowed = Array.isArray(effective.permission)
    ? effective.permission.some((entry) => entry.permission === "skill_mcp" && entry.action === "allow")
    : effective.permission?.skill_mcp === "allow";
  assert(allowed, `${team}/${agent} effective skill_mcp capability missing`);
};
same(best.model, "openai/gpt-6-luna", "BEST model");
same(best.small_model, "opencode-go/mimo-v2.5", "BEST small_model");
same(best.default_agent, "OpenCode-Builder", "BEST default_agent");
same(best.tools.call_omo_agent, false, "BEST profile legacy delegation tool");
same(Object.keys(best.agent).sort(), ["OpenCode-Builder", "explore", "librarian", "openai-architect", "openai-coder-1", "openai-coder-2", "openai-reviewer"], "BEST agents");
same(best.agent["OpenCode-Builder"].permission.task, "allow", "BEST Builder permission");
same(best.agent["OpenCode-Builder"].permission.call_omo_agent, "deny", "BEST Builder legacy delegation permission");
for (const [coder, model, omoModel] of [["openai-coder-1", "openai/gpt-6-sol", "chatgpt-subscription/gpt-6-sol"], ["openai-coder-2", "openai/gpt-6-luna", "chatgpt-subscription/gpt-6-luna"]]) {
  same(best.agent[coder].model, model, `BEST ${coder} model`);
  same(bestOmoNativeAgents[coder].models, [omoModel], `BEST OMO ${coder} model`);
  same(best.agent[coder].permission.edit, "allow", `BEST ${coder} edit permission`);
  same(best.agent[coder].permission.write, "allow", `BEST ${coder} write permission`);
  same(best.agent[coder].permission.task, "deny", `BEST ${coder} nested-task permission`);
  same(best.agent[coder].permission.bash, "deny", `BEST ${coder} shell permission`);
  same(bestOmo.agents[coder].tools.edit, true, `BEST OMO ${coder} edit tool`);
  same(bestOmo.agents[coder].tools.write, true, `BEST OMO ${coder} write tool`);
  same(bestOmo.agents[coder].tools.task, false, `BEST OMO ${coder} nested-task tool`);
}
same(best.agent["openai-architect"].permission.edit, "deny", "BEST architect remains read-only");
same(best.agent["openai-reviewer"].permission.edit, "deny", "BEST reviewer remains read-only");
same(best.agent["OpenCode-Builder"].tools.call_omo_agent, false, "BEST Builder legacy delegation tool");
same(bestOmo.sisyphus_agent.default_builder_enabled, true, "BEST OMO default Builder");
same(bestOmo.agents["OpenCode-Builder"].mode, "primary", "BEST OMO Builder mode");
same(bestOmo.agents["OpenCode-Builder"].permission.call_omo_agent, "deny", "BEST OMO Builder legacy delegation permission");
same(bestOmo.agents["OpenCode-Builder"].tools.call_omo_agent, false, "BEST OMO Builder legacy delegation tool");
same(bestOmoModels.profiles["best-native"]["[native]"].task.provider_concurrency["chatgpt-subscription"], 2, "BEST subscription coder fanout concurrency");
same(best.agent.explore.model, "opencode-go/qwen3.7-plus", "BEST explore model");
same(best.agent.librarian.model, "opencode-go/qwen3.7-plus", "BEST librarian model");
same(best.enabled_providers, ["openai", "opencode-go"], "BEST provider set");
same(best.agent["OpenCode-Builder"].model, "openai/gpt-6-luna", "BEST Builder model");
same(best.provider.openai.options.timeout, 300000, "BEST OpenAI provider availability");
same(best.compaction, { auto: true, prune: true, reserved: 10000 }, "BEST compaction");
assert(bestOmo.browser_automation_engine?.provider === "playwright", "BEST Playwright provider missing");
assert(bestOmo.browser_automation_engine?.playwright_mcp_args?.includes("--isolated"), "BEST Playwright isolation missing");
assert(bestOmo.browser_automation_engine?.playwright_mcp_args?.some((value) => value.endsWith("/best/playwright/output")), "BEST Playwright output path missing");
assert(best.mcp?.serena?.enabled === true, "BEST Serena MCP missing");
assert(path.isAbsolute(best.mcp.serena.command[0]) && (best.mcp.serena.command[0].startsWith(path.join(home, "data")) || best.mcp.serena.command[0].startsWith(dependencyRoot)), "BEST Serena path invalid");
assert(best.provider?.["opencode-go"]?.options?.timeout === 300000, "BEST provider options missing");
assert(best.plugin.length === 3 && path.isAbsolute(best.plugin[0]), "BEST plugin order/path invalid");

const bestFree = read("free");
same(bestFree.model, "opencode/step-5-preview-free", "BEST FREE model");
same(bestFree.small_model, "opencode/mimo-v2.6-flash-free", "BEST FREE small_model");
same(bestFree.default_agent, "OpenCode-Builder", "BEST FREE default_agent");
same(bestFree.enabled_providers, ["opencode"], "BEST FREE enabled providers");
same(bestFree.agent.explore.model, "opencode/ling-3.1-flash-free", "BEST FREE explore model");
same(bestFree.agent.librarian.model, "opencode/ling-3.1-flash-free", "BEST FREE librarian model");
same(bestFree.agent["openai-architect"].model, "opencode/nemotron-3-ultra-free", "BEST FREE architect model");
same(bestFree.agent["openai-reviewer"].model, "opencode/nemotron-3-ultra-free", "BEST FREE reviewer model");
assert(bestFree.disabled_providers.includes("opencode-go"), "BEST FREE paid OpenCode Go provider enabled");
assert(bestFree.disabled_providers.includes("openai"), "BEST FREE OpenAI provider enabled");
assert(bestFree.plugin.some((plugin) => plugin.endsWith("/teams/best/best-router-plugin.js")), "BEST FREE router plugin missing");
assertSkillMcp("free", "OpenCode-Builder");

const go = read("go");
same(go.model, "opencode-go/mimo-v2.5", "GO model");
same(go.small_model, "opencode-go/mimo-v2.5", "GO small_model");
same(go.default_agent, "OpenCode-Builder", "GO default_agent");
same(go.agent.explore.mode, "subagent", "GO Explore subagent mode");
same(go.agent.explore.model, "opencode-go/qwen3.7-plus", "GO Explore subscription model");
same(go.agent.librarian.mode, "subagent", "GO Librarian subagent mode");
same(go.agent.librarian.model, "opencode-go/qwen3.7-plus", "GO Librarian subscription model");
same(go.agent.explore.permission.task, "deny", "GO Explore nested-task denial");
same(go.agent.librarian.permission.task, "deny", "GO Librarian nested-task denial");
assert(go.agent.explore.prompt.includes("GO subscription model") && go.agent.librarian.prompt.includes("GO subscription model"), "GO Explore/Librarian subscription prompts missing");
same(go.compaction, { auto: true, prune: true, reserved: 10000 }, "GO compaction");
const goOmo = JSON.parse(fs.readFileSync(path.join(home, "config", "go", "xdg-config", "opencode", "oh-my-openagent.jsonc"), "utf8"));
assert(goOmo.browser_automation_engine?.provider === "playwright", "GO Playwright provider missing");
assert(goOmo.browser_automation_engine?.playwright_mcp_args?.some((value) => value.endsWith("/go/playwright/output")), "GO Playwright output path missing");
const goNativeProfile = goOmo.profiles?.["go-team-v2-visible"]?.["[native]"];
assert(goNativeProfile, "GO runtime OMO_PROFILE is not defined by its generated config");
same(goNativeProfile.model_profile, "opencode-go/mimo-v2.5", "GO OMO model profile");
same(goNativeProfile.task.provider_concurrency["opencode-go"], 2, "GO subscription worker concurrency");
for (const agent of ["explore", "librarian"]) same(goNativeProfile.agents[agent].models, ["opencode-go/qwen3.7-plus"], `GO ${agent} subscription worker model`);
assertSkillMcp("best", "OpenCode-Builder");
assert(go.permission?.skill_mcp === "allow" || go.permission?.["*"] === "allow", "GO skill_mcp permission missing");
assert(go.disabled_providers.includes("openai"), "GO provider policy missing");
assert(go.mcp?.serena?.enabled === true, "GO Serena MCP missing");
assert(path.isAbsolute(go.mcp.serena.command[0]) && (go.mcp.serena.command[0].startsWith(path.join(home, "data")) || go.mcp.serena.command[0].startsWith(dependencyRoot)), "GO Serena path invalid");
assert(go.provider?.["opencode-go"]?.options?.max_tokens === 32768, "GO provider options missing");
for (const name of ["explore", "librarian"]) {
  const agent = spawnSync("opencode", ["debug", "agent", name], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_CONFIG: path.join(home, "config", "go", "opencode.jsonc"),
      OPENCODE_CONFIG_DIR: path.join(home, "config", "go"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OMO_PROFILE: "go-team-v2-visible",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config", "go", "xdg-config"),
      XDG_DATA_HOME: path.join(home, "data", "go", "data"),
      XDG_CACHE_HOME: path.join(home, "cache", "go"),
      XDG_STATE_HOME: path.join(home, "state", "go"),
    },
    encoding: "utf8",
  });
  assert(agent.status === 0, `GO/${name} subscription subagent config rejected: ${agent.stderr}`);
  const effective = JSON.parse(agent.stdout);
  same(effective.mode, "subagent", `GO/${name} effective mode`);
  assert(effective.model?.providerID === "opencode-go", `GO/${name} effective model must use the Go subscription`);
}
assert(go.plugin.length === 2 && path.isAbsolute(go.plugin[0]), "GO plugin order/path invalid");

const openai = read("openai");
const openaiOmo = JSON.parse(fs.readFileSync(path.join(home, "config", "openai", "xdg-config", "opencode", "oh-my-openagent.jsonc"), "utf8"));
same(openai.model, "openai/gpt-6-sol", "OPENAI model");
same(openai.small_model, "openai/gpt-6-luna-fast", "OPENAI small_model");
same(openai.default_agent, "openai_orchestrator", "OPENAI default_agent");
same(Object.keys(openai.agent).sort(), ["codex_executor", "openai_explore", "openai_librarian", "openai_ops", "openai_orchestrator", "reviewer", "reviewer_critical", "specialist", "tester"], "OPENAI agents");
same(openai.enabled_providers, ["openai"], "OPENAI enabled providers");
same(openai.compaction, { auto: true, prune: true, reserved: 10000 }, "OPENAI compaction");
assert(openaiOmo.browser_automation_engine?.provider === "playwright", "OPENAI Playwright provider missing");
assert(openaiOmo.browser_automation_engine?.playwright_mcp_args?.some((value) => value.endsWith("/openai/playwright/output")), "OPENAI Playwright output path missing");
assert(openai.mcp?.serena?.enabled === true, "OPENAI Serena MCP missing");
assert(path.isAbsolute(openai.mcp.serena.command[0]) && (openai.mcp.serena.command[0].startsWith(path.join(home, "data")) || openai.mcp.serena.command[0].startsWith(dependencyRoot)), "OPENAI Serena path invalid");
assert(openai.plugin.length === 4 && openai.plugin.every(path.isAbsolute), "OPENAI plugin paths invalid");
assert(openai.agent.openai_orchestrator.prompt_append.includes("Repository inspection is unrestricted through read, glob, grep, LSP, Serena") && openai.agent.openai_orchestrator.prompt_append.includes("filesystem-write/network sandbox") && openai.agent.openai_orchestrator.prompt_append.includes("All repository writes must be delegated to codex_executor"), "OPENAI orchestrator must allow direct reads and delegate writes through a sandbox");
assert(openai.agent.openai_explore.prompt_append.includes("filesystem-write and network sandbox") && openai.agent.openai_explore.prompt_append.includes("without a command allowlist"), "OPENAI Explorer shell policy must be sandboxed rather than command-allowlisted");
assert(["read", "glob", "grep", "lsp_*", "serena_*", "webfetch", "websearch"].every((tool) => openai.agent.openai_orchestrator.tools?.[tool] === true), "OPENAI orchestrator direct read tools are missing");
assert(["edit", "write", "apply_patch", "interactive_bash"].every((tool) => openai.agent.openai_orchestrator.tools?.[tool] === false), "OPENAI orchestrator native write/persistent shell tools must remain disabled");

const daily = read("daily");
const dailyOmo = JSON.parse(fs.readFileSync(path.join(home, "config", "daily", "xdg-config", "opencode", "oh-my-openagent.jsonc"), "utf8"));
same(daily.model, "openai/gpt-6-luna", "OPENAI DAILY model");
same(daily.small_model, "openai/gpt-6-luna", "OPENAI DAILY small_model");
same(daily.default_agent, "openai_orchestrator", "OPENAI DAILY default_agent");
same(Object.keys(daily.agent).sort(), ["codex_executor", "openai_explore", "openai_librarian", "openai_ops", "openai_orchestrator", "reviewer", "reviewer_critical", "specialist", "tester"], "OPENAI DAILY agents");
same(daily.enabled_providers, ["openai"], "OPENAI DAILY enabled providers");
same(daily.compaction, { auto: true, prune: true, reserved: 24000 }, "OPENAI DAILY compaction");
assert(dailyOmo.browser_automation_engine?.provider === "playwright", "DAILY Playwright provider missing");
assert(dailyOmo.browser_automation_engine?.playwright_mcp_args?.some((value) => value.endsWith("/daily/playwright/output")), "DAILY Playwright output path missing");
assert(daily.mcp?.serena?.enabled === true, "OPENAI DAILY Serena MCP missing");
assert(path.isAbsolute(daily.mcp.serena.command[0]) && (daily.mcp.serena.command[0].startsWith(path.join(home, "data")) || daily.mcp.serena.command[0].startsWith(dependencyRoot)), "OPENAI DAILY Serena path invalid");
assert(daily.plugin.length === 4 && daily.plugin.every(path.isAbsolute), "OPENAI DAILY plugin paths invalid");
assert(daily.plugin[1].endsWith("/teams/openai/config/opencode/openai-team-tools.js"), "OPENAI DAILY shared tools path invalid");
assert(!daily.plugin.some((plugin) => plugin.endsWith("/teams/best/best-router-plugin.js")), "OPENAI DAILY must not load the BEST route plugin");
assert(daily.agent.openai_orchestrator.description.includes("regardless of the launch directory"), "OPENAI DAILY orchestrator must accept repositories outside cwd");
const serenaMutationPatterns = ["serena_replace_*", "serena_insert_*", "serena_rename_*", "serena_delete_*", "serena_write_*", "serena_safe_delete_*", "serena_edit_*"];
const dailyOrchestrator = daily.agent.openai_orchestrator;
assert(["task", "bash", "read", "glob", "grep"].every((tool) => dailyOrchestrator.tools?.[tool] === true), "OPENAI DAILY orchestrator must expose delegation, shell and repository inspection tools");
assert(dailyOrchestrator.tools?.["serena_*"] === true && dailyOrchestrator.permission?.["serena_*"] === "allow", "OPENAI DAILY orchestrator must expose Serena tools");
assert(serenaMutationPatterns.every((pattern) => dailyOrchestrator.permission?.[pattern] === "deny"), "OPENAI DAILY orchestrator Serena mutation tools must remain denied");
assert(dailyOrchestrator.permission?.bash === "allow", "OPENAI DAILY orchestrator shell permission missing");
assert(dailyOrchestrator.prompt_append.includes("direct read-only access to repository files and discovery tools without tool-count, time, duplicate-search, or mandatory-explorer limits") && dailyOrchestrator.prompt_append.includes("read-only OS sandbox (no command allowlist)") && dailyOrchestrator.prompt_append.includes("Delegate every repository write to codex_executor"), "OPENAI DAILY orchestrator must state unbounded read access and delegated writes");
assert(daily.agent.openai_explore.prompt_append.includes("filesystem-write and network sandbox") && daily.agent.openai_explore.prompt_append.includes("without a command allowlist"), "OPENAI DAILY Explorer shell policy must be sandboxed rather than command-allowlisted");
assert(["read", "glob", "grep", "lsp_*", "serena_*", "webfetch", "websearch"].every((tool) => dailyOrchestrator.tools?.[tool] === true), "OPENAI DAILY orchestrator direct read tools are missing");
assert(["edit", "write", "apply_patch", "interactive_bash"].every((tool) => dailyOrchestrator.tools?.[tool] === false), "OPENAI DAILY orchestrator native write/persistent shell tools must remain disabled");
assert(!daily.agent.openai_orchestrator.prompt_append.includes("should be redirected to BEST") && daily.agent.openai_orchestrator.prompt_append.includes("Never redirect or hand off a Daily task to BEST"), "OPENAI DAILY orchestrator must not redirect tasks to BEST");
assert(daily.agent.openai_explore.prompt_append.includes("serena_activate_project"), "OPENAI DAILY explorer must activate the requested repository through Serena");

const serenaReadTools = ["serena_get_symbols_overview", "serena_find_symbol", "serena_find_declaration", "serena_find_implementations", "serena_find_referencing_symbols", "serena_get_diagnostics_for_file", "serena_search_for_pattern", "serena_read_memory", "serena_get_current_config", "serena_activate_project"];
for (const team of ["openai", "daily"]) {
  const config = read(team);
  for (const agent of ["openai_explore", "reviewer", "reviewer_critical", "specialist"]) {
    const permission = config.agent[agent]?.permission || {};
    assert(serenaMutationPatterns.every((pattern) => permission[pattern] === "deny"), `${team}/${agent} Serena mutation surface`);
    assert(permission["serena_*"] !== "deny", `${team}/${agent} read-only Serena access missing`);
  }
  const explore = config.agent.openai_explore.permission || {};
  assert(serenaReadTools.every((tool) => explore[tool] !== "deny"), `${team}/openai_explore read-only Serena tools denied`);
  assert(!JSON.stringify(config).includes("codegraph_codegraph_explore"), `${team} unsupported codegraph tool exposed`);
  const env = {
    ...process.env,
    OPENCODE_CONFIG: path.join(home, "config", team, "opencode.jsonc"),
    OPENCODE_CONFIG_DIR: path.join(home, "config", team),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config", team, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "data", team, "data"),
    XDG_CACHE_HOME: path.join(home, "cache", team),
    XDG_STATE_HOME: path.join(home, "state", team),
  };
  for (const agent of ["openai_orchestrator", "openai_explore"]) {
    const resolved = spawnSync("opencode", ["debug", "agent", agent], { cwd: root, env, encoding: "utf8" });
    assert(resolved.status === 0, `${team}/${agent} runtime config rejected: ${resolved.stderr}`);
    const effective = JSON.parse(resolved.stdout);
    const permissionEntries = Array.isArray(effective.permission) ? effective.permission : [];
    const denied = new Set(permissionEntries.filter((entry) => entry.action === "deny").map((entry) => entry.permission));
    const allowsSkillMcp = permissionEntries.some((entry) => entry.permission === "skill_mcp" && entry.action === "allow");
    assert(allowsSkillMcp, `${team}/${agent} effective skill_mcp capability missing`);
    assert(denied.has("codegraph_*"), `${team}/${agent} effective codegraph surface`);
  }
  const codexResolved = spawnSync("opencode", ["debug", "agent", "codex_executor"], { cwd: root, env, encoding: "utf8" });
  assert(codexResolved.status === 0, `${team}/codex_executor runtime config rejected: ${codexResolved.stderr}`);
  const codexEffective = JSON.parse(codexResolved.stdout);
  same(codexEffective.mode, "subagent", `${team}/codex_executor effective mode`);
  assert(
    config.agent.codex_executor?.tools?.openai_run_codex === true,
    `${team}/codex_executor generated config missing openai_run_codex`,
  );

  const effectivePermissionAllowsCodex = Array.isArray(codexEffective.permission)
    ? codexEffective.permission.some(
        (entry) =>
          entry?.permission === "openai_run_codex"
          && entry?.action === "allow",
      )
    : codexEffective.permission?.openai_run_codex === "allow";

  assert(
    effectivePermissionAllowsCodex,
    `${team}/codex_executor effective openai_run_codex permission missing`,
  );
  const codexDenied = new Set((Array.isArray(codexEffective.permission) ? codexEffective.permission : []).filter((entry) => entry.action === "deny").map((entry) => entry.permission));
  assert(codexDenied.has("skill_mcp"), `${team}/codex_executor skill_mcp surface`);

  assert(
    codexEffective.tools?.openai_run_codex !== false,
    `${team}/codex_executor effective openai_run_codex explicitly disabled`,
  );
  for (const tool of ["read", "glob", "grep", "bash", "apply_patch", "edit", "write", "task", "skill", "shell", "command", "todowrite", "openai_remote_read"]) {
    assert([false, undefined].includes(codexEffective.tools?.[tool]), `${team}/codex_executor operational tool exposed: ${tool}`);
  }
}
{
  const env = {
    ...process.env,
    OPENCODE_CONFIG: path.join(home, "config", "best", "opencode.jsonc"),
    OPENCODE_CONFIG_DIR: path.join(home, "config", "best"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config", "best", "xdg-config"),
    XDG_DATA_HOME: path.join(home, "data", "best", "data"),
    XDG_CACHE_HOME: path.join(home, "cache", "best"),
    XDG_STATE_HOME: path.join(home, "state", "best"),
  };
  const resolved = spawnSync("opencode", ["debug", "agent", "OpenCode-Builder"], { cwd: root, env, encoding: "utf8" });
  assert(resolved.status === 0, `best/OpenCode-Builder runtime config rejected: ${resolved.stderr}`);
  const effective = JSON.parse(resolved.stdout);
  assert(["primary", "all"].includes(effective.mode), `BEST Builder mode invalid: ${effective.mode}`);
  assert(effective.hidden !== true, "BEST Builder hidden");
  if (effective.model !== undefined) {
    same(effective.model, { providerID: "openai", modelID: "gpt-6-luna" }, "BEST effective Builder model");
  }
  const effectiveCallOmoDenied = Array.isArray(effective.permission)
    ? effective.permission.some(
        (entry) =>
          entry?.permission === "call_omo_agent"
          && entry?.action === "deny",
      )
    : effective.permission?.call_omo_agent === "deny";

  assert(
    effectiveCallOmoDenied,
    "BEST effective Builder legacy delegation permission missing",
  );

  assert(
    effective.tools?.call_omo_agent !== true,
    "BEST effective Builder legacy delegation tool unexpectedly enabled",
  );
}

const bestEcc = read("best-ecc");
const bestEccAgentNames = [
  "OpenCode-Builder", "ecc-architect", "ecc-build-error-resolver", "ecc-code-reviewer",
  "ecc-go-build-resolver", "ecc-go-reviewer", "ecc-planner", "ecc-security-reviewer",
  "ecc-tdd-guide", "explore", "librarian", "openai-coder-1", "openai-coder-2", "openai-reviewer",
].sort();
same(bestEcc.model, "openai/gpt-6-luna", "BEST-ECC model");
same(bestEcc.enabled_providers, ["openai", "opencode-go"], "BEST-ECC explicit provider set");
same(bestEcc.default_agent, "OpenCode-Builder", "BEST-ECC default agent");
same(Object.keys(bestEcc.agent).sort(), bestEccAgentNames, "BEST-ECC agent catalog");
same(bestEcc.agent["OpenCode-Builder"].model, "openai/gpt-6-luna", "BEST-ECC Builder model");
same(bestEcc.provider.openai.options.timeout, 300000, "BEST-ECC OpenAI provider availability");
same(bestEcc.agent.explore.permission.task, "deny", "BEST-ECC explore nested-task permission");
same(bestEcc.agent.librarian.permission.task, "deny", "BEST-ECC librarian nested-task permission");
same(bestEcc.agent["ecc-tdd-guide"].permission.edit, "deny", "BEST-ECC TDD planner read-only policy");
same(bestEcc.agent["ecc-tdd-guide"].model, "opencode-go/qwen3.7-plus", "BEST-ECC economical TDD planner model");
same(bestEcc.skills.paths.map((skillPath) => path.resolve(skillPath)), [path.resolve(home, "data", "best-ecc", "ecc", "skills")], "BEST-ECC selected ECC skill root");
assert(bestEcc.plugin.some((plugin) => path.resolve(plugin) === path.resolve(home, "data", "best-ecc", "ecc", ".opencode", "plugins", "ecc-hooks.ts")), "BEST-ECC ECC hooks plugin path missing");
const bestEccOmo = JSON.parse(fs.readFileSync(path.join(home, "data", "best-ecc", ".omo", "omo.jsonc"), "utf8"));
const bestEccTasks = bestEccOmo.profiles["best-ecc"]["[opencode]"].background_task;
same(bestEccTasks.defaultConcurrency, 8, "BEST-ECC bounded concurrent task ceiling");
same(bestEccTasks.providerConcurrency, { openai: 4, "opencode-go": 4 }, "BEST-ECC provider concurrency");
same(bestEccTasks.maxDepth, 2, "BEST-ECC task graph depth");

for (const team of ["best", "best-ecc", "free", "go", "openai", "daily"]) {
  const config = read(team);
  const serialized = JSON.stringify(config);
  assert(config.plugin.some((plugin) => plugin === path.join(root, "shared", "mac-notifications", "plugin.js")), `${team} shared macOS notification plugin missing`);
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
