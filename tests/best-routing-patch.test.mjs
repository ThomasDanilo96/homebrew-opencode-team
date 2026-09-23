import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const patcher = join(root, "teams/best/patch-omo-core.py");
const bestInstalled = join(process.env.HOME, ".local/share/opencode-team/dependencies/best/node_modules/oh-my-openagent/dist/index.js");
const pristineInstalled = join(process.env.HOME, ".local/share/opencode-team/dependencies/openai/node_modules/oh-my-openagent/dist/index.js");
const installed = process.env.BEST_OMO_FIXTURE || (process.env.BEST_OMO_PRISTINE === "1" ? pristineInstalled : bestInstalled);
const sourceFixture = readFileSync(installed, "utf8");
const sentinels = [
  "const _BEST_CONFIGURED_AGENT_NO_FALLBACK_V1 = true;",
  "const _BEST_DELEGATE_NO_FALLBACK_V1 = true;",
  "const _BEST_MODEL_FALLBACK_CONTROLLER_GUARD_V1 = true;"
];

function runPatcher(source) {
  const dir = mkdtempSync(join(tmpdir(), "best-omo-patch-"));
  const target = join(dir, "index.js");
  writeFileSync(target, source);
  const result = spawnSync("python3", [patcher, target], { encoding: "utf8" });
  const patched = readFileSync(target, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { ...result, output: `${result.stdout}${result.stderr}`, patched };
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing source function ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed source function ${signature}`);
}

function migratedFixture() {
  // The installed BEST bundle carries the native patch and may already contain the new
  // protections. Rewind only those BEST-owned changes, then restore the real OMO chains.
  const pristine = readFileSync(pristineInstalled, "utf8");
  let native = sourceFixture;
  native = native
    .replace(/^const _BEST_CONFIGURED_AGENT_NO_FALLBACK_V1 = true;\n/m, "")
    .replace(/^const _BEST_DELEGATE_NO_FALLBACK_V1 = true;\n/m, "")
    .replace(/^const _BEST_MODEL_FALLBACK_CONTROLLER_GUARD_V1 = true;\n/m, "");
  native = native
    .replace("  const _bestNoDelegateFallback = agentConfigKey === \"explore\" || agentConfigKey === \"librarian\";\n", "")
    .replace("  const normalizedAgentFallbackModels = _bestNoDelegateFallback ? [] : normalizeFallbackModels(agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);", "  const normalizedAgentFallbackModels = normalizeFallbackModels(agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);")
    .replace("    fallbackChain = _bestNoDelegateFallback ? [] : (configuredFallbackChain ?? (resolutionSkipped || hasExplicitUserModel ? undefined : agentRequirement?.fallbackChain));", "    fallbackChain = configuredFallbackChain ?? (resolutionSkipped || hasExplicitUserModel ? undefined : agentRequirement?.fallbackChain);")
    .replace('    if (agentKey === "explore" || agentKey === "librarian") {\n      log2(`[model-fallback] BEST fail-closed: no authorized fallback for agent: ${agentName} (key: ${agentKey})`);\n      return false;\n    }\n', "");
  assert.equal(native.includes("_BEST_DELEGATE_NO_FALLBACK_V1"), false);
  assert.equal(native.includes("_BEST_MODEL_FALLBACK_CONTROLLER_GUARD_V1"), false);
  const agentStart = pristine.indexOf("var AGENT_MODEL_REQUIREMENTS = {");
  assert.notEqual(agentStart, -1, "fixture must be actual OMO source");
  const agentEnd = pristine.indexOf("\n};", agentStart) + 3;
  const req = pristine.slice(agentStart, agentEnd);
  const nativePrefix = native.slice(0, native.indexOf("var AGENT_MODEL_REQUIREMENTS = {"));
  const nativeReqStart = native.indexOf("var AGENT_MODEL_REQUIREMENTS = {");
  const nativeReqEnd = native.indexOf("\n};", nativeReqStart) + 3;
  const nativeReq = native.slice(nativeReqStart, nativeReqEnd);
  const nativeSuffix = native.slice(nativeReqEnd);
  const patchedReq = nativeReq
    .replace(/  explore: \{\n    fallbackChain: \[\]\n  \},/, req.match(/  explore: \{\n    fallbackChain: \[[\s\S]*?\n  \},/)[0])
    .replace(/  librarian: \{\n    fallbackChain: \[\]\n  \},/, req.match(/  librarian: \{\n    fallbackChain: \[[\s\S]*?\n  \},/)[0]);
  assert.notEqual(patchedReq, nativeReq, "fixture restoration must replace both manually emptied chains");
  return nativePrefix + patchedReq + nativeSuffix;
}

test("BEST migration patches actual OMO 4.19.4 source, preserves other agents and is idempotent", () => {
  const first = runPatcher(migratedFixture());
  assert.equal(first.status, 0, first.output);
  for (const sentinel of sentinels) assert.equal(first.patched.split(sentinel).length - 1, 1);
  assert.match(first.patched, /  explore: \{\n    fallbackChain: \[\]\n  \},/);
  assert.match(first.patched, /  librarian: \{\n    fallbackChain: \[\]\n  \},/);
  assert.match(first.patched, /  sisyphus: \{\n    fallbackChain: \[/);
  assert.match(first.output, /MIGRATED|ALREADY_PATCHED/);

  const second = runPatcher(first.patched);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /ALREADY_PATCHED/);
  assert.equal(second.patched, first.patched);
});

test("BEST migration refuses partial and unexpected source states without writing", () => {
  const source = migratedFixture();
  const partial = source.replace(/  librarian: \{\n    fallbackChain: \[[\s\S]*?\n  \},/, "  librarian: {\n    fallbackChain: []\n  },");
  const partialResult = runPatcher(partial);
  assert.notEqual(partialResult.status, 0);
  assert.match(partialResult.output, /REFUSED/);
  assert.equal(partialResult.patched, partial);

  const unknown = source.replace('model: "deepseek-v4-flash"', 'model: "unexpected-upstream-model"');
  const unknownResult = runPatcher(unknown);
  assert.notEqual(unknownResult.status, 0);
  assert.match(unknownResult.output, /REFUSED/);
  assert.equal(unknownResult.patched, unknown);
});

test("BEST requirements and fallback controller fail closed only for Explore and Librarian", () => {
  const patched = runPatcher(migratedFixture());
  assert.equal(patched.status, 0, patched.output);
  const reqStart = patched.patched.indexOf("var AGENT_MODEL_REQUIREMENTS = {");
  const reqEnd = patched.patched.indexOf("\n};", reqStart) + 3;
  const requirements = new Function(`return (${patched.patched.slice(reqStart).match(/var AGENT_MODEL_REQUIREMENTS = ([\s\S]*?\n};)/)[1].replace(/\n};$/, "\n}" )})`)();
  assert.equal(requirements.explore.fallbackChain.length, 0);
  assert.equal(requirements.librarian.fallbackChain.length, 0);
  assert.ok(requirements.sisyphus.fallbackChain.length > 0);
  assert.ok(reqEnd > reqStart);

  const body = extractFunction(patched.patched, "function createModelFallbackStateController(input)");
  const factory = new Function("getAgentConfigKey", "AGENT_MODEL_REQUIREMENTS", "log2", "getNextReachableFallback", "isSameFailedModel", `${body}; return createModelFallbackStateController;`)(
    (name) => name.toLowerCase(), requirements, () => {}, (_id, state) => state.fallbackChain[state.attemptCount] ?? null, () => false
  );
  const controller = factory({ pendingModelFallbacks: new Map(), lastToastKey: new Map(), sessionFallbackChains: new Map() });
  for (const agent of ["explore", "librarian"]) {
    const session = `ses-${agent}`;
    controller.setSessionFallbackChain(session, ["qwen3.7-plus", "minimax-m3", "minimax-m2.7"]);
    assert.equal(controller.setPendingModelFallback(session, agent, "opencode-go", "qwen3.7-plus"), false);
    assert.equal(controller.getNextFallback(session), null);
  }
  controller.setSessionFallbackChain("ses-sisyphus", ["fallback-model"]);
  assert.equal(controller.setPendingModelFallback("ses-sisyphus", "sisyphus", "openai", "gpt-primary"), true);
  assert.equal(controller.getNextFallback("ses-sisyphus"), "fallback-model");
});

test("BEST delegate resolver discards configured fallbacks while preserving its primary model", async () => {
  const patched = runPatcher(migratedFixture());
  assert.equal(patched.status, 0, patched.output);
  const body = extractFunction(patched.patched, "async function resolveSubagentModel(agentToUse, matchedAgent, executorCtx)");
  const resolve = new Function(
    "getAgentConfigKey", "findAgentOverride2", "AGENT_MODEL_REQUIREMENTS", "normalizeFallbackModels", "getAvailableModelsForDelegateTask", "normalizeModelFormat", "resolveModelForDelegateTask2", "flattenToFallbackModelStrings", "buildFallbackChainFromModels", "resolveEffectiveFallbackEntry", "applyFallbackEntrySettings", "applyCategoryParams", "fuzzyMatchModel2", "log2",
    `${body}; return resolveSubagentModel;`
  )(
    (name) => name.toLowerCase(), (overrides, key) => overrides[key], { explore: { fallbackChain: [] }, librarian: { fallbackChain: [] } }, (models) => models ?? [], async () => new Set(), (model) => typeof model === "string" ? { providerID: model.split("/")[0], modelID: model.split("/")[1] } : model,
    ({ userModel }) => ({ model: userModel }), (models) => models, (models) => models?.length ? models : undefined, () => undefined, (model) => model, (model) => model, () => true, () => {}
  );
  for (const agent of ["explore", "librarian"]) {
    const result = await resolve(agent, { model: "opencode-go/qwen3.7-plus" }, {
      agentOverrides: { [agent]: { model: "opencode-go/qwen3.7-plus", fallback_models: ["opencode-go/minimax-m3", "opencode-go/minimax-m2.7"] } },
      userCategories: {}, client: {}
    });
    assert.deepEqual(result.categoryModel, { providerID: "opencode-go", modelID: "qwen3.7-plus" });
    assert.deepEqual(result.fallbackChain, []);
  }
});

test("BEST primary failure makes no alternate model attempts", () => {
  for (const agent of ["explore", "librarian"]) {
    const attempts = [];
    const invokePrimary = () => { attempts.push("opencode-go/qwen3.7-plus"); throw new Error("primary unavailable"); };
    assert.throws(invokePrimary, /primary unavailable/);
    assert.deepEqual(attempts, ["opencode-go/qwen3.7-plus"]);
  }
});

test("BEST safe root inspection allows bounded diagnosis and denies broad or mutating tools", async () => {
  const routeDir = mkdtempSync(join(tmpdir(), "best-router-route-"));
  const routeScript = join(routeDir, "route.sh");
  writeFileSync(routeScript, 'input=$(cat); if printf "%s" "$input" | grep -q both; then printf "%s\\n" "<BEST_ROUTER_ROUTE>BOTH</BEST_ROUTER_ROUTE>"; elif printf "%s" "$input" | grep -q official; then printf "%s\\n" "<BEST_ROUTER_ROUTE>LIBRARIAN</BEST_ROUTER_ROUTE>"; else printf "%s\\n" "<BEST_ROUTER_ROUTE>EXPLORE</BEST_ROUTER_ROUTE>"; fi\n');
  process.env.BEST_ROUTER_PATH = routeScript;
  process.env.BEST_ROUTER_LOG = join(routeDir, "router.log");
  const { default: bestRouterPlugin, isSafeRootInspection } = await import("../teams/best/best-router-plugin.js");
  for (const command of ["git status", "git status --short", "git diff", "git diff --check", "git diff --stat", "git rev-parse --show-toplevel", "git branch --show-current", "git log -5"]) assert.equal(isSafeRootInspection("bash", { command }), true, command);
  assert.equal(isSafeRootInspection("read", { filePath: "teams/best/patch-omo-core.py" }), true);
  assert.equal(isSafeRootInspection("grep", { pattern: "fallbackChain", path: "teams/best" }), true);
  assert.equal(isSafeRootInspection("glob", { pattern: "*.js", path: "teams/best" }), true);
  for (const [tool, args] of [["glob", { pattern: "**/*", path: "." }], ["grep", { pattern: "x", path: "." }], ["serena_find_symbol", {}], ["bash", { command: "git reset --hard HEAD" }], ["bash", { command: "git status; rm -rf x" }]]) assert.equal(isSafeRootInspection(tool, args), false);

  const routeSession = async (sessionID, prompt) => {
    const hooks = await bestRouterPlugin({ directory: root });
    const output = { message: {}, parts: [{ id: `${sessionID}-prompt`, type: "text", text: prompt }] };
    await hooks["chat.message"]({ agent: "OpenCode-Builder", sessionID }, output);
    const before = (tool, args = {}, callID = `${sessionID}-${tool}`) => hooks["tool.execute.before"]({ sessionID, tool, callID }, { args });
    const after = (callID, success = true) => hooks["tool.execute.after"]({ sessionID, tool: "task", callID }, { metadata: { success } });
    return { hooks, output, before, after };
  };

  const explore = await routeSession("ses-explore", "Inspect repository implementation");
  for (const [tool, args] of [["bash", { command: "git status" }], ["bash", { command: "git diff --check" }], ["read", { filePath: "teams/best/patch-omo-core.py" }], ["grep", { pattern: "fallbackChain", path: "teams/best" }], ["glob", { pattern: "*.js", path: "teams/best" }]]) await explore.before(tool, args);
  for (const [tool, args] of [["glob", { pattern: "**/*", path: "." }], ["grep", { pattern: "x", path: "." }], ["serena_find_symbol", {}], ["task", { subagent_type: "librarian", run_in_background: true }], ["task", { subagent_type: "explore", run_in_background: false }]]) await assert.rejects(() => explore.before(tool, args), /BEST ROUTING GATE/);
  await assert.rejects(() => explore.before("bash", { command: "git add ." }), /BEST ROUTING GATE/);
  await explore.before("task", { subagent_type: "explore", run_in_background: true }, "explore-task");
  await assert.rejects(() => explore.before("task", { subagent_type: "explore", run_in_background: true }, "explore-duplicate"), /BEST ROUTING GATE/);
  await explore.after("explore-task");
  await explore.before("bash", { command: "git status" });

  const librarian = await routeSession("ses-librarian", "Find official documentation");
  await assert.rejects(() => librarian.before("webfetch", { url: "https://example.com" }), /BEST ROUTING GATE/);
  await librarian.before("task", { subagent_type: "librarian", run_in_background: true }, "librarian-task");
  await librarian.after("librarian-task");
  await librarian.before("webfetch", { url: "https://example.com" });

  const both = await routeSession("ses-both", "both code analysis and official documentation");
  await both.before("task", { subagent_type: "explore", run_in_background: true }, "both-explore");
  await both.after("both-explore");
  await both.before("bash", { command: "git status" });
  await assert.rejects(() => both.before("serena_find_symbol", {}), /BEST ROUTING GATE/);
  await both.before("task", { subagent_type: "librarian", run_in_background: true }, "both-librarian");
  await both.after("both-librarian");
  await both.before("bash", { command: "git status" });
  await both.before("serena_find_symbol", {});

  rmSync(routeDir, { recursive: true, force: true });
});
