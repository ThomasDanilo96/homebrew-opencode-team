import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("profile scanner tool runs pinned scanners on a disposable read-only fixture only", {
  skip: !process.env.OPENCODE_TEAM_DEEP_AUDIT_SCANNER_PLUGIN && "requires the rendered Deep Audit scanner plugin from clean-room setup",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "deep-audit-scanner-test."));
  const targetPath = join(root, "target");
  const reports = join(root, "reports");
  await mkdir(targetPath);
  const target = await realpath(targetPath);
  await mkdir(reports, { mode: 0o700 });
  const syntheticToken = ["ghp_Yp4Ns8Qz1Lm5V", "r2Xc9Jw3Ta7Kb6Hd", "0Fq8Se"].join("");
  await writeFile(join(target, "app.py"), [
    "import os",
    "import subprocess",
    "def run(user_input):",
    "    return subprocess.run(user_input, shell=True)",
    "def _unused_helper(value):",
    "    return value",
  ].join("\n"));
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "audit-fixture", version: "1.0.0", main: "duplicate-a.js", dependencies: { lodash: "4.17.15" } }));
  await writeFile(join(target, "GITHUB_TOKEN.txt"), `GITHUB_TOKEN=${syntheticToken}\n`);
  await writeFile(join(target, "bad.sql"), "select * from users\n");
  const duplicateBlock = [
    "export function duplicateReport(input) {",
    "  const selected = input.filter((item) => item.active === true);",
    "  const normalized = selected.map((item) => ({ id: item.id, label: item.label.trim().toLowerCase(), value: Number(item.value) }));",
    "  const nonEmpty = normalized.filter((item) => item.id !== null && item.value > 0);",
    "  const total = nonEmpty.reduce((sum, item) => sum + item.value, 0);",
    "  const weighted = nonEmpty.map((item) => ({ ...item, weight: item.value / Math.max(total, 1) }));",
    "  return weighted.sort((left, right) => left.label.localeCompare(right.label));",
    "}",
  ].join("\n");
  await writeFile(join(target, "duplicate-a.js"), duplicateBlock);
  await writeFile(join(target, "duplicate-b.js"), duplicateBlock);
  await chmod(target, 0o555);
  for (const name of ["app.py", "package.json", "GITHUB_TOKEN.txt", "bad.sql", "duplicate-a.js", "duplicate-b.js"]) await chmod(join(target, name), 0o444);

  try {
    process.env.DEEP_AUDIT_TARGET_ROOT = target;
    process.env.DEEP_AUDIT_REPORT_ROOT = reports;
    process.env.DEEP_AUDIT_SCANNER_ROOT = process.env.OPENCODE_TEAM_DEEP_AUDIT_SCANNER_ROOT;
    process.env.DEEP_AUDIT_RULES_ROOT = process.env.OPENCODE_TEAM_DEEP_AUDIT_RULES_ROOT;
    assert.ok(process.env.DEEP_AUDIT_SCANNER_ROOT);
    assert.ok(process.env.DEEP_AUDIT_RULES_ROOT);
    const plugin = await import(pathToFileURL(process.env.OPENCODE_TEAM_DEEP_AUDIT_SCANNER_PLUGIN).href);
    const hooks = await plugin.default({});
    const scan = hooks.tool.deep_audit_scan;
    const taskBefore = hooks["tool.execute.before"];
    const taskAfter = hooks["tool.execute.after"];
    const firstTask = { args: { subagent_type: "audit-inventory", run_in_background: true } };
    await taskBefore({ tool: "task", sessionID: "fixture-session", callID: "task-1" }, firstTask);
    assert.equal(firstTask.args.run_in_background, false, "Deep Audit forces foreground serial delegation");
    await assert.rejects(
      () => taskBefore({ tool: "task", sessionID: "fixture-session", callID: "task-2" }, { args: { subagent_type: "audit-security" } }),
      /active foreground audit task/,
    );
    await taskAfter({ tool: "task", sessionID: "fixture-session", callID: "task-1" });
    await taskBefore({ tool: "task", sessionID: "fixture-session", callID: "task-3" }, { args: { subagent_type: "audit-security" } });
    await taskAfter({ tool: "task", sessionID: "fixture-session", callID: "task-3" });
    await assert.rejects(
      () => taskBefore({ tool: "task", sessionID: "fixture-session", callID: "task-4" }, { args: { subagent_type: "general" } }),
      /not allowlisted/,
    );
    const context = { directory: target, worktree: target, sessionID: "fixture-session" };
    for (const scanner of ["ruff", "vulture", "bandit", "sqlfluff", "knip", "semgrep", "gitleaks", "jscpd", "ast-grep"]) {
      const result = await scan.execute({ scanner, sql_dialect: "ansi" }, context);
      assert.match(result.title, new RegExp(`^${scanner} `));
      assert.match(result.output, /scanner-results/);
      const evidencePath = result.output.match(/Scan evidence saved outside the target: ([^\n]+)/)?.[1];
      assert.ok(evidencePath, `${scanner} did not persist structured evidence`);
      const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(evidencePath, "utf8"));
      assert.ok(["completed", "completed_with_findings"].includes(evidence.status), `${scanner} must resolve its required runtime tools: ${JSON.stringify(evidence.analysis)}`);
      assert.ok(evidence.analysis_scope.command.length > 1);
      if (scanner === "semgrep") {
        assert.ok(evidence.analysis.findings.some((item) => item.rule_id.endsWith("python.subprocess-shell-true")), `Semgrep positive fixture must produce its configured rule: ${JSON.stringify(evidence.analysis)}`);
        assert.doesNotMatch(JSON.stringify(evidence), /subprocess\.run\(user_input/, "scanner evidence must omit raw source snippets");
      }
      if (scanner === "ast-grep") {
        assert.equal(evidence.analysis.result_count, 1, `ast-grep must summarize its positive JSON finding: ${JSON.stringify(evidence.analysis)}`);
        assert.equal(evidence.analysis.findings[0].rule_id, "python-subprocess-shell-true");
        assert.equal(evidence.analysis.findings[0].path, "app.py");
        assert.equal(evidence.analysis.findings[0].start_line, 4);
      }
      if (scanner === "jscpd") assert.ok(evidence.analysis.duplicate_count > 0, "jscpd positive fixture must detect the duplicated JavaScript block");
      if (scanner === "gitleaks") {
        assert.ok(evidence.analysis.finding_count > 0, `Gitleaks positive fixture must identify the synthetic token: ${JSON.stringify(evidence.analysis)}`);
        assert.doesNotMatch(JSON.stringify(evidence), new RegExp(syntheticToken), "secret matches must not be persisted into scanner evidence");
      }
      if (scanner === "ruff") assert.ok(evidence.analysis.findings.some((item) => item.id === "F401"), `Ruff positive fixture must report the unused import: ${JSON.stringify(evidence.analysis)}`);
      if (scanner === "vulture") assert.ok(evidence.analysis.findings.length > 0, `Vulture positive fixture must report a high-confidence unused item: ${JSON.stringify(evidence.analysis)}`);
      if (scanner === "bandit") assert.ok(evidence.analysis.findings.some((item) => /shell=True/i.test(item.message)), `Bandit positive fixture must report shell=True: ${JSON.stringify(evidence.analysis)}`);
      if (scanner === "sqlfluff") assert.ok(evidence.analysis.result_count > 0, `SQLFluff positive fixture must report SQL issues: ${JSON.stringify(evidence.analysis)}`);
      if (scanner === "knip") assert.ok(evidence.analysis.findings.some((item) => item.unused_dependencies.includes("lodash")), `Knip positive fixture must report the unused dependency: ${JSON.stringify(evidence.analysis)}`);
    }
    const notApplicable = await scan.execute({ scanner: "osv-scanner", sql_dialect: "ansi" }, context);
    assert.match(notApplicable.title, /NOT_APPLICABLE/);
    assert.match(notApplicable.output, /NOT_EXECUTED/);
    const pythonNotApplicable = await scan.execute({ scanner: "pip-audit", sql_dialect: "ansi" }, context);
    assert.match(pythonNotApplicable.title, /NOT_APPLICABLE/);
    assert.match(pythonNotApplicable.output, /no supported requirements\*?\.txt/i);

    const cleanTarget = join(root, "clean-target");
    await mkdir(cleanTarget);
    await writeFile(join(cleanTarget, "app.py"), "def safe(value):\n    return value.strip()\n");
    await writeFile(join(cleanTarget, "single.js"), "export const safe = (value) => value.trim();\n");
    await writeFile(join(cleanTarget, "clean.sql"), "SELECT id\nFROM users;\n");
    await writeFile(join(cleanTarget, "package.json"), JSON.stringify({ name: "clean-fixture", version: "1.0.0", type: "module", main: "single.js" }));
    await chmod(cleanTarget, 0o555);
    await chmod(join(cleanTarget, "app.py"), 0o444);
    await chmod(join(cleanTarget, "single.js"), 0o444);
    await chmod(join(cleanTarget, "clean.sql"), 0o444);
    await chmod(join(cleanTarget, "package.json"), 0o444);
    process.env.DEEP_AUDIT_TARGET_ROOT = await realpath(cleanTarget);
    const cleanContext = { directory: process.env.DEEP_AUDIT_TARGET_ROOT, worktree: process.env.DEEP_AUDIT_TARGET_ROOT, sessionID: "fixture-negative" };
    for (const scanner of ["ruff", "vulture", "bandit", "sqlfluff", "knip", "semgrep", "ast-grep", "jscpd", "gitleaks"]) {
      const result = await scan.execute({ scanner, sql_dialect: "ansi" }, cleanContext);
      const evidencePath = result.output.match(/Scan evidence saved outside the target: ([^\n]+)/)?.[1];
      assert.ok(evidencePath);
      const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(evidencePath, "utf8"));
      assert.equal(evidence.exit_code, 0, `${scanner} negative fixture must complete cleanly: ${JSON.stringify(evidence.analysis)}`);
      if (scanner === "ruff") assert.equal(evidence.analysis.result_count, 0, "Ruff negative fixture must be clean");
      if (scanner === "vulture") assert.equal(evidence.analysis.result_count, 0, "Vulture negative fixture must be clean");
      if (scanner === "bandit") assert.equal(evidence.analysis.findings.length, 0, "Bandit negative fixture must be clean");
      if (scanner === "sqlfluff") assert.equal(evidence.analysis.result_count, 0, `SQLFluff negative fixture must be clean: ${JSON.stringify(evidence.analysis)}`);
      if (scanner === "knip") assert.equal(evidence.analysis.result_count, 0, "Knip negative fixture must have no unused items");
      if (scanner === "semgrep") assert.equal(evidence.analysis.findings.length, 0, "Semgrep negative fixture must be clean");
      if (scanner === "ast-grep") {
        assert.equal(evidence.analysis.result_count, 0, `ast-grep negative fixture must produce a structured empty result: ${JSON.stringify(evidence.analysis)}`);
        assert.deepEqual(evidence.analysis.findings, []);
      }
      if (scanner === "jscpd") assert.equal(evidence.analysis.duplicate_count, 0, "jscpd negative fixture must have no clones");
      if (scanner === "gitleaks") assert.equal(evidence.analysis.finding_count, 0, "Gitleaks negative fixture must contain no leaks");
    }
    assert.deepEqual((await readdir(target)).sort(), ["GITHUB_TOKEN.txt", "app.py", "bad.sql", "duplicate-a.js", "duplicate-b.js", "package.json"]);
    assert.deepEqual((await readdir(cleanTarget)).sort(), ["app.py", "clean.sql", "package.json", "single.js"]);
    assert.ok((await readdir(join(reports, "scanner-results", "fixture-session"))).length >= 5);
    assert.deepEqual((await readdir(reports)).sort(), ["scanner-results"], "per-invocation scanner HOME/cache/TMPDIR data must be cleaned up");
  } finally {
    delete process.env.DEEP_AUDIT_TARGET_ROOT;
    delete process.env.DEEP_AUDIT_REPORT_ROOT;
    delete process.env.DEEP_AUDIT_SCANNER_ROOT;
    delete process.env.DEEP_AUDIT_RULES_ROOT;
    await chmod(target, 0o755).catch(() => {});
    await chmod(join(root, "clean-target"), 0o755).catch(() => {});
    for (const name of ["app.py", "package.json", "GITHUB_TOKEN.txt", "bad.sql", "duplicate-a.js", "duplicate-b.js"]) await chmod(join(target, name), 0o644).catch(() => {});
    for (const name of ["app.py", "single.js", "clean.sql", "package.json"]) await chmod(join(root, "clean-target", name), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
