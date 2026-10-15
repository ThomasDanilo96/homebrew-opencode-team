import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("BEST-ECC has an isolated profile and only opts the BEST router in at runtime", () => {
  const runtime = read("teams/best-ecc/team-runtime.conf.template");
  assert.match(runtime, /^TEAM_NAME=best-ecc$/m);
  assert.match(runtime, /^SANDBOX=@DATA_ROOT@\/best-ecc$/m);
  assert.match(runtime, /^OMO_PROFILE=best-ecc$/m);
  assert.match(runtime, /^CLAUDE_CONFIG_DIR_OVERRIDE=@CONFIG_ROOT@\/best-ecc\/claude-config$/m);
  const claudeSettings = JSON.parse(read("teams/best-ecc/claude-config/settings.json.template").replaceAll("@PACKAGE_ROOT@", "/tmp/opencode-team"));
  assert.equal(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command, "bash /tmp/opencode-team/teams/best/router-classify.sh");
  assert.match(read("teams/best-ecc/runtime-env.sh"), /export BEST_ECC_MODE=1/);
  assert.match(read("teams/best-ecc/runtime-env.sh"), /OPENCODE_DISABLE_EXTERNAL_SKILLS=1 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1/);
  assert.match(read("teams/best/best-router-plugin.js"), /process\.env\.BEST_ECC_MODE === "1" \? \["ecc-tdd-guide"\]/);
});

test("BEST-ECC OpenCode and OmO templates are valid after runtime substitution", () => {
  const values = {
    "@OMO_PLUGIN@": "/tmp/omo-plugin.js",
    "@PACKAGE_ROOT@": "/tmp/opencode-team",
    "@ECC_SOURCE@": "/tmp/ecc",
    "@SERENA_BIN@": "/tmp/serena",
  };
  const opencodeTemplate = read("teams/best-ecc/opencode.jsonc.template");
  const rendered = opencodeTemplate.replace(/@[A-Z_]+@/g, (token) => values[token] ?? `/tmp/${token.slice(1, -1).toLowerCase()}`);
  const config = JSON.parse(rendered);
  assert.equal(config.default_agent, "OpenCode-Builder");
  assert.ok(config.enabled_providers.includes("openai"));
  assert.equal(config.agent["OpenCode-Builder"].model, "openai/gpt-6-luna");
  assert.equal(config.provider.openai.options.timeout, 300000);
  assert.ok(config.skills.paths.includes("/tmp/ecc/skills"));
  assert.ok(config.plugin.includes("/tmp/ecc/.opencode/plugins/ecc-hooks.ts"));
  assert.equal(config.agent["ecc-tdd-guide"].permission.edit, "deny");
  assert.equal(config.agent["openai-coder-1"].permission.bash, "deny");

  const omo = JSON.parse(read("teams/best-ecc/omo.jsonc.template"));
  assert.equal(omo.profiles["best-ecc"]["[opencode]"].background_task.defaultConcurrency, 8);
  assert.equal(omo.profiles["best-ecc"]["[opencode]"].background_task.maxDepth, 2);
});

test("ECC setup pins upstream and checks out only the curated skills and prompts", () => {
  const pin = read("teams/best-ecc/ecc.lock").trim();
  assert.match(pin, /^[0-9a-f]{40}$/);
  const installer = read("teams/best-ecc/setup-ecc.sh");
  assert.match(installer, /configure_sparse_checkout "\$checkout"/);
  assert.match(installer, /sparse-checkout set --skip-checks/);
  assert.match(installer, /skills\/tdd-workflow/);
  assert.match(installer, /skills\/verification-loop/);
  assert.match(installer, /skills\/agent-harness-construction/);
  assert.match(installer, /Refusing to replace an unexpected ECC source path/);
  assert.match(installer, /Refusing to update locally modified ECC source/);
  assert.match(installer, /https:\/\/github\.com\/affaan-m\/ECC\.git/);
});

test("ECC assets always resolve inside the isolated BEST-ECC data root", () => {
  const cli = read("bin/opencode-team");
  assert.match(cli, /"@ECC_SOURCE@": os\.path\.join\(os\.environ\["DATA_ROOT"\], "best-ecc", "ecc"\)/);
  assert.doesNotMatch(cli, /os\.environ\.get\("ECC_SOURCE"/);
  assert.match(cli, /setup-ecc\.sh" "\$DATA_ROOT\/best-ecc" \|\| return 1/);
  assert.match(read("core/lib/core.sh"), /TEAM_NAME:-.*best-ecc.*HOME\/\.local\/share\/opencode\/auth\.json/s);
});
