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
  // The installed BEST dependency is mutable: setup may have migrated it
  // already. Build a deterministic migration fixture by preserving unrelated
  // native BEST patches while restoring every model-routing surface from the
  // pristine OMO dependency.
  const pristine = readFileSync(pristineInstalled, "utf8");
  let native = sourceFixture;

  for (const sentinel of sentinels) {
    native = native.replace(`${sentinel}\n`, "");
  }

  const restoreFunction = (signature) => {
    const current = extractFunction(native, signature);
    const baseline = extractFunction(pristine, signature);

    assert.notEqual(
      current.length,
      0,
      `installed fixture missing ${signature}`,
    );

    assert.notEqual(
      baseline.length,
      0,
      `pristine fixture missing ${signature}`,
    );

    native = native.replace(current, baseline);
  };

  restoreFunction(
    "async function resolveSubagentModel(agentToUse, matchedAgent, executorCtx)",
  );

  restoreFunction(
    "function createModelFallbackStateController(input)",
  );

  const anchor = "var AGENT_MODEL_REQUIREMENTS = {";

  const pristineStart = pristine.indexOf(anchor);
  const nativeStart = native.indexOf(anchor);

  assert.notEqual(
    pristineStart,
    -1,
    "pristine fixture missing AGENT_MODEL_REQUIREMENTS",
  );

  assert.notEqual(
    nativeStart,
    -1,
    "installed fixture missing AGENT_MODEL_REQUIREMENTS",
  );

  const pristineEnd = pristine.indexOf("\n};", pristineStart) + 3;
  const nativeEnd = native.indexOf("\n};", nativeStart) + 3;

  assert.ok(
    pristineEnd > pristineStart,
    "invalid pristine requirement object",
  );

  assert.ok(
    nativeEnd > nativeStart,
    "invalid installed requirement object",
  );

  const pristineRequirements = pristine.slice(
    pristineStart,
    pristineEnd,
  );

  native =
    native.slice(0, nativeStart)
    + pristineRequirements
    + native.slice(nativeEnd);

  // The resulting fixture must contain no BEST-owned model fallback
  // protection before the patcher is invoked.
  for (const sentinel of sentinels) {
    assert.equal(
      native.includes(sentinel),
      false,
      `fixture retained ${sentinel}`,
    );
  }

  assert.equal(
    native.includes(
      'const _bestNoDelegateFallback = agentConfigKey === "sisyphus"'
    ),
    false,
  );

  assert.equal(
    native.includes(
      'const _bestNoDelegateFallback = agentConfigKey === "explore"'
    ),
    false,
  );

  assert.equal(
    native.includes(
      'BEST fail-closed: no authorized fallback for agent'
    ),
    false,
  );

  return native;
}

test("BEST migration protects Builder, Explore and Librarian and is idempotent", () => {
  const first = runPatcher(migratedFixture());
  assert.equal(first.status, 0, first.output);
  for (const sentinel of sentinels) assert.equal(first.patched.split(sentinel).length - 1, 1);
  assert.match(first.patched, /  sisyphus: \{\n    fallbackChain: \[\]/);
  assert.match(first.patched, /  explore: \{\n    fallbackChain: \[\]\n  \},/);
  assert.match(first.patched, /  librarian: \{\n    fallbackChain: \[\]\n  \},/);
  assert.match(first.output, /PATCHED|MIGRATED|ALREADY_PATCHED/);

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

  const unknown = source.replace("var AGENT_MODEL_REQUIREMENTS = {", "var UNKNOWN_AGENT_MODEL_REQUIREMENTS = {");
  const unknownResult = runPatcher(unknown);
  assert.notEqual(unknownResult.status, 0);
  assert.match(unknownResult.output, /REFUSED/);
  assert.equal(unknownResult.patched, unknown);
});

test("BEST requirements and fallback controller fail closed for Builder, Explore and Librarian", () => {
  const patched = runPatcher(migratedFixture());
  assert.equal(patched.status, 0, patched.output);
  const reqStart = patched.patched.indexOf("var AGENT_MODEL_REQUIREMENTS = {");
  const reqEnd = patched.patched.indexOf("\n};", reqStart) + 3;
  const requirements = new Function(`return (${patched.patched.slice(reqStart).match(/var AGENT_MODEL_REQUIREMENTS = ([\s\S]*?\n};)/)[1].replace(/\n};$/, "\n}" )})`)();
  assert.equal(requirements.sisyphus.fallbackChain.length, 0);
  assert.equal(requirements.explore.fallbackChain.length, 0);
  assert.equal(requirements.librarian.fallbackChain.length, 0);
  assert.ok(reqEnd > reqStart);

  const body = extractFunction(patched.patched, "function createModelFallbackStateController(input)");
  const factory = new Function("getAgentConfigKey", "AGENT_MODEL_REQUIREMENTS", "log2", "getNextReachableFallback", "isSameFailedModel", `${body}; return createModelFallbackStateController;`)(
    (name) => name.toLowerCase(), requirements, () => {}, (_id, state) => state.fallbackChain[state.attemptCount] ?? null, () => false
  );
  const controller = factory({ pendingModelFallbacks: new Map(), lastToastKey: new Map(), sessionFallbackChains: new Map() });
  for (const agent of ["sisyphus", "explore", "librarian"]) {
    const session = `ses-${agent}`;
    controller.setSessionFallbackChain(
      session,
      ["deepseek-v4-flash", "fallback-model"],
    );

    assert.equal(
      controller.setPendingModelFallback(
        session,
        agent,
        agent === "sisyphus" ? "openai" : "opencode-go",
        agent === "sisyphus" ? "gpt-6-luna" : "qwen3.7-plus",
      ),
      false,
    );

    assert.equal(controller.getNextFallback(session), null);
  }
});

test("BEST delegate resolver discards configured fallbacks while preserving its primary model", async () => {
  const patched = runPatcher(migratedFixture());
  assert.equal(patched.status, 0, patched.output);
  const body = extractFunction(patched.patched, "async function resolveSubagentModel(agentToUse, matchedAgent, executorCtx)");
  const resolve = new Function(
    "getAgentConfigKey", "findAgentOverride2", "AGENT_MODEL_REQUIREMENTS", "normalizeFallbackModels", "getAvailableModelsForDelegateTask", "normalizeModelFormat", "resolveModelForDelegateTask2", "flattenToFallbackModelStrings", "buildFallbackChainFromModels", "resolveEffectiveFallbackEntry", "applyFallbackEntrySettings", "applyCategoryParams", "fuzzyMatchModel2", "log2",
    `${body}; return resolveSubagentModel;`
  )(
    (name) => name.toLowerCase(), (overrides, key) => overrides[key], { sisyphus: { fallbackChain: [] }, explore: { fallbackChain: [] }, librarian: { fallbackChain: [] } }, (models) => models ?? [], async () => new Set(), (model) => typeof model === "string" ? { providerID: model.split("/")[0], modelID: model.split("/")[1] } : model,
    ({ userModel }) => ({ model: userModel }), (models) => models, (models) => models?.length ? models : undefined, () => undefined, (model) => model, (model) => model, () => true, () => {}
  );
  for (const agent of ["sisyphus", "explore", "librarian"]) {
    const primary = agent === "sisyphus"
      ? "openai/gpt-6-luna"
      : "opencode-go/qwen3.7-plus";

    const result = await resolve(agent, { model: primary }, {
      agentOverrides: {
        [agent]: {
          model: primary,
          fallback_models: [
            "deepseek/deepseek-v4-flash",
            "opencode-go/minimax-m3",
          ],
        },
      },
      userCategories: {},
      client: {},
    });

    assert.deepEqual(
      result.categoryModel,
      agent === "sisyphus"
        ? { providerID: "openai", modelID: "gpt-6-luna" }
        : { providerID: "opencode-go", modelID: "qwen3.7-plus" },
    );

    assert.deepEqual(result.fallbackChain, []);
  }
});

test("BEST primary failure makes no alternate model attempts", () => {
  for (const agent of ["sisyphus", "explore", "librarian"]) {
    const primary = agent === "sisyphus"
      ? "openai/gpt-6-luna"
      : "opencode-go/qwen3.7-plus";

    const attempts = [];

    const invokePrimary = () => {
      attempts.push(primary);
      throw new Error("primary unavailable");
    };

    assert.throws(invokePrimary, /primary unavailable/);
    assert.deepEqual(attempts, [primary]);
  }
});

test("BEST safe root inspection allows bounded diagnosis and denies broad or mutating tools", async () => {
  const routeDir = mkdtempSync(join(tmpdir(), "best-router-route-"));
  const routeScript = join(routeDir, "route.sh");
  writeFileSync(routeScript, 'input=$(cat); if printf "%s" "$input" | grep -q direct; then printf "%s\\n" "DIRECT"; elif printf "%s" "$input" | grep -q four; then printf "%s\\n" "<BEST_ROUTER_ROUTE>FOUR</BEST_ROUTER_ROUTE>"; elif printf "%s" "$input" | grep -q both; then printf "%s\\n" "<BEST_ROUTER_ROUTE>BOTH</BEST_ROUTER_ROUTE>"; elif printf "%s" "$input" | grep -q official; then printf "%s\\n" "<BEST_ROUTER_ROUTE>LIBRARIAN</BEST_ROUTER_ROUTE>"; else printf "%s\\n" "<BEST_ROUTER_ROUTE>EXPLORE</BEST_ROUTER_ROUTE>"; fi\n');
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
    const before = async (tool, args = {}, callID = `${sessionID}-${tool}`) => {
      const output = { args };
      await hooks["tool.execute.before"]({ sessionID, tool, callID }, output);
      return output;
    };
    const after = (callID, success = true) => hooks["tool.execute.after"]({ sessionID, tool: "task", callID }, { metadata: { success } });
    return { hooks, output, before, after };
  };

  const direct = await routeSession("ses-direct", "direct request");
  await direct.before("serena_initial_instructions", {});
  await direct.before("serena_get_current_config", {});
  await assert.rejects(() => direct.before("call_omo_agent", { subagent_type: "explore", run_in_background: false }), /BEST ROUTING POLICY: call_omo_agent is disabled/);

  const explore = await routeSession("ses-explore", "Inspect repository implementation");
  assert.match(explore.output.parts.at(-1).text, /exactly one native task\(subagent_type="explore", run_in_background=true\)/);
  assert.match(explore.output.parts.at(-1).text, /Do not attempt call_omo_agent/i);
  await explore.before("serena_initial_instructions", {});
  await explore.before("serena_get_current_config", {});
  for (const background of [false, true]) {
    await assert.rejects(() => explore.before("call_omo_agent", { subagent_type: "explore", run_in_background: background }), /BEST ROUTING POLICY: call_omo_agent is disabled/);
  }
  for (const [tool, args] of [["bash", { command: "git status" }], ["bash", { command: "git diff --check" }], ["read", { filePath: "teams/best/patch-omo-core.py" }], ["grep", { pattern: "fallbackChain", path: "teams/best" }], ["glob", { pattern: "*.js", path: "teams/best" }]]) await explore.before(tool, args);
  for (const [tool, args] of [["glob", { pattern: "**/*", path: "." }], ["grep", { pattern: "x", path: "." }], ["serena_find_symbol", {}], ["serena_search_for_pattern", {}], ["task", { subagent_type: "librarian", run_in_background: true }]]) await assert.rejects(() => explore.before(tool, args), /BEST ROUTING GATE/);
  await assert.rejects(() => explore.before("bash", { command: "git add ." }), /BEST ROUTING GATE/);
  await explore.before("task", { subagent_type: "explore", run_in_background: true }, "explore-task");
  await assert.rejects(() => explore.before("task", { subagent_type: "explore", run_in_background: true }, "explore-duplicate"), /BEST ROUTING GATE/);
  await explore.after("explore-task");
  await explore.before("bash", { command: "git status" });

  const omittedExplore = await routeSession("ses-explore-omitted", "Inspect repository implementation");
  const omittedArgs = { subagent_type: "explore" };
  await omittedExplore.before("task", omittedArgs, "explore-omitted");
  assert.equal(omittedArgs.run_in_background, true);
  await omittedExplore.after("explore-omitted");

  const falseExplore = await routeSession("ses-explore-false", "Inspect repository implementation");
  const falseArgs = { subagent_type: "explore", run_in_background: false };
  await falseExplore.before("task", falseArgs, "explore-false");
  assert.equal(falseArgs.run_in_background, true);
  await falseExplore.after("explore-false");

  const librarian = await routeSession("ses-librarian", "Find official documentation");
  assert.match(librarian.output.parts.at(-1).text, /exactly one native task\(subagent_type="librarian", run_in_background=true\)/);
  await librarian.before("serena_initial_instructions", {});
  await librarian.before("serena_get_current_config", {});
  for (const background of [false, true]) {
    await assert.rejects(() => librarian.before("call_omo_agent", { subagent_type: "librarian", run_in_background: background }), /BEST ROUTING POLICY: call_omo_agent is disabled/);
  }
  await assert.rejects(() => librarian.before("webfetch", { url: "https://example.com" }), /BEST ROUTING GATE/);
  const librarianArgs = { subagent_type: "librarian", run_in_background: false };
  await librarian.before("task", librarianArgs, "librarian-task");
  assert.equal(librarianArgs.run_in_background, true);
  await librarian.after("librarian-task");
  await librarian.before("webfetch", { url: "https://example.com" });

  const both = await routeSession("ses-both", "both code analysis and official documentation");
  assert.match(both.output.parts.at(-1).text, /one task\(subagent_type="explore", run_in_background=true\).*one task\(subagent_type="librarian", run_in_background=true\)/s);
  await both.before("task", { subagent_type: "explore", run_in_background: true }, "both-explore");
  await both.after("both-explore");
  await both.before("bash", { command: "git status" });
  await assert.rejects(() => both.before("serena_find_symbol", {}), /BEST ROUTING GATE/);
  await both.before("task", { subagent_type: "librarian", run_in_background: true }, "both-librarian");
  await both.after("both-librarian");
  await both.before("bash", { command: "git status" });
  await both.before("serena_find_symbol", {});

  const four = await routeSession("ses-four", "four complex implementation tasks across modules");
  assert.match(four.output.parts.at(-1).text, /exactly four native tasks in parallel/);
  const fourAgents = ["explore", "librarian", "openai-architect", "openai-reviewer"];
  for (const agent of fourAgents) {
    await four.before("task", { subagent_type: agent, run_in_background: true }, `four-${agent}`);
  }
  await assert.rejects(() => four.before("task", { subagent_type: "explore", run_in_background: true }, "four-duplicate"), /BEST ROUTING GATE/);
  for (const agent of fourAgents) await four.after(`four-${agent}`);
  await four.before("serena_find_symbol", {});

  rmSync(routeDir, { recursive: true, force: true });
});

test("BEST source config enables the primary Builder through OMO and denies legacy delegation", () => {
  const template = readFileSync(join(root, "teams/best/oh-my-openagent.jsonc.template"), "utf8");
  assert.match(template, /"default_builder_enabled": true/);
  assert.match(template, /"OpenCode-Builder": \{[\s\S]*"mode": "primary"/);
  assert.match(template, /"call_omo_agent": "deny"/);
  assert.match(template, /"tools": \{[\s\S]*"call_omo_agent": false/);
  const opencodeTemplate = readFileSync(join(root, "teams/best/opencode.jsonc.template"), "utf8");
  assert.match(opencodeTemplate, /"tools": \{\s*"call_omo_agent": false\s*\}/);
  assert.match(opencodeTemplate, /"OpenCode-Builder": \{[\s\S]*"tools": \{[\s\S]*"call_omo_agent": false/);
});
