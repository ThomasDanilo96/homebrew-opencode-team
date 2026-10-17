import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cli = await readFile(new URL("../bin/opencode-team", import.meta.url), "utf8");
const core = await readFile(new URL("../core/lib/core.sh", import.meta.url), "utf8");
const lifecycle = await readFile(new URL("../core/lib/runtime-lifecycle.mjs", import.meta.url), "utf8");
const gc = await readFile(new URL("../shared/maintenance/playwright-gc.mjs", import.meta.url), "utf8");
const config = JSON.parse(await readFile(new URL("../teams/deep-audit/opencode.jsonc.template", import.meta.url), "utf8"));
const policy = await readFile(new URL("../teams/deep-audit/audit-policy.md", import.meta.url), "utf8");

test("deep-audit has start, resume-compatible, setup, doctor and report commands", () => {
  assert.match(cli, /opencode-team deep-audit \[--resume SESSION\]/);
  assert.match(cli, /opencode-team start <[^>]*deep-audit/);
  assert.match(cli, /deep-audit\)\s+shift\s+start_deep_audit/);
  assert.match(cli, /deep-audit-setup\)/);
  assert.match(cli, /deep-audit-doctor\)/);
  assert.match(cli, /deep-audit-report\)/);
});

test("deep-audit reports are written outside a requested target project", () => {
  assert.match(cli, /DEEP_AUDIT_REPORT_ROOT="\$DATA_ROOT\/deep-audit\/reports"/);
});

test("deep-audit is registered for runtime resume, readiness/history and GC", () => {
  assert.match(core, /best\|best-ecc\|deep-audit\|go\|openai/);
  assert.match(lifecycle, /\["best", "best-ecc", "deep-audit"/);
  assert.match(gc, /\["best", "best-ecc", "deep-audit"/);
});

test("deep-audit startup uses its isolated profile rather than an existing profile", () => {
  assert.match(cli, /deep-audit\|free\|go\|openai\|daily/);
  assert.match(cli, /start_team deep-audit/);
  assert.match(cli, /setup_deep_audit_profile \|\| return 1/);
  assert.match(cli, /DEEP_AUDIT_TARGET_ROOT="\$target"/);
  assert.match(cli, /DEEP_AUDIT_ECC_SOURCE/);
  assert.match(cli, /DEEP_AUDIT_REPORT_ROOT/);
});

test("Deep Audit doctor distinguishes installed assets from proven runtime availability", () => {
  assert.match(cli, /runtime-resolved profile/);
  assert.match(cli, /INSTALLED \+ CONFIGURED/);
  assert.match(cli, /UNAVAILABLE \(not installed and referenced by resolved config\)/);
  assert.match(cli, /UNPROVEN \(runtime diagnostics unavailable; failing closed\)/);
  assert.match(cli, /VERIFIED \(plugin tools invoked via audit-orchestrator; Serena MCP connected\/read-only call executed; no model request\)[\s\S]*"Runtime tool state"/);
  assert.match(cli, /CONFIGURED \(model-mediated agent use is verified only during a real audit\)[\s\S]*"Serena agent binding"/);
});

test("Deep Audit pins exact models, denies project mutation and omits OmO hooks", () => {
  assert.equal(config.model, "openai/gpt-6-astra");
  assert.equal(config.agent["audit-orchestrator"].variant, "xhigh");
  assert.equal(config.agent["audit-reviewer"].variant, "max");
  assert.equal(config.agent["audit-performance"].model, "openai/gpt-6.1-sol");
  assert.equal(config.enabled_providers.includes("openai"), true);
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.permission.external_directory["*"], "deny");
  assert.equal(config.permission.external_directory["@REPORT_ROOT@/**"], "allow");
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.write, "deny");
  assert.equal(config.tools.bash, false);
  assert.equal(config.tools.edit, false);
  assert.equal(config.provider.openai.options.timeout, 600000);
  assert.equal(config.agent["audit-security"].model, "openai/gpt-6-astra");
  assert.equal(config.agent["audit-correctness"].model, "openai/gpt-6-astra");
  assert.equal(config.agent["audit-tests"].model, "openai/gpt-6.1-sol");
  assert.equal(config.agent["audit-reviewer"].permission.task, "deny");
  assert.equal(config.permission.deep_audit_save_report, "allow");
  assert.equal(config.tools.deep_audit_save_report, true);
  assert.equal(config.plugin.length, 3);
  assert.equal(config.plugin.some((plugin) => String(plugin).includes("oh-my-openagent")), false);
  assert.equal(config.tools.deep_audit_test_discover, true);
  assert.equal(config.tools.deep_audit_test_run, true);
  assert.equal(config.agent["audit-orchestrator"].tools.deep_audit_save_report, true);
  assert.equal(config.agent["audit-orchestrator"].tools.deep_audit_scan, true);
  assert.equal(config.agent["audit-orchestrator"].tools.deep_audit_test_discover, true);
  assert.equal(config.agent["audit-orchestrator"].tools.deep_audit_test_run, true);
  assert.equal(config.agent["audit-orchestrator"].tools.serena_search_for_pattern, true);
  assert.equal(config.agent["audit-orchestrator"].tools.serena_replace_content, undefined);
  assert.match(policy, /macOS Seatbelt profile protects the canonical project/);
  assert.match(policy, /never invoke a test\/build command directly against the audited project/);
});
