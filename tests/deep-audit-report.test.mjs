import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("Deep Audit report tool validates and persists a complete bundle outside the project", {
  skip: !process.env.OPENCODE_TEAM_DEEP_AUDIT_REPORT_PLUGIN && "requires the rendered profile plugin from clean-room setup",
}, async () => {
  const pluginPath = process.env.OPENCODE_TEAM_DEEP_AUDIT_REPORT_PLUGIN;
  assert.ok(pluginPath, "OPENCODE_TEAM_DEEP_AUDIT_REPORT_PLUGIN must point at the rendered plugin");
  const root = await mkdtemp(join(tmpdir(), "deep-audit-report-test."));
  const project = join(root, "target");
  const reports = join(root, "reports");
  await mkdir(project);
  process.env.DEEP_AUDIT_REPORT_ROOT = reports;
  process.env.DEEP_AUDIT_TARGET_ROOT = project;
  try {
    const plugin = await import(pathToFileURL(pluginPath).href);
    const hooks = await plugin.default({});
    const reportTool = hooks.tool.deep_audit_save_report;
    const report = {
      schema_version: 1,
      scope: { requested: project, examined: ["src/app.py"], excluded: [] },
      inventory: { stack: ["Python"], structure: ["src/app.py"], components: ["credential loader: src/app.py"], entry_points: ["application entry point not identified"], dependencies: ["No dependency manifest examined"], test_suites: ["No test suite executed"], boundaries: ["Temporary fixture only; no deployment scope"] },
       method: { phases_completed: ["inventory", "security", "independent_review"], checks: [{ kind: "Serena", target: "src/app.py", result: "read-only inspection", command: null, exit_code: null }] },
      execution: { target_commit: null, models_used: [{ agent: "audit-security", configured_model_id: "openai/gpt-6-astra", model_id: "openai/gpt-6-astra", reasoning: "xhigh", identity_source: "session_database", provider_attested: false }], tool_versions: { Serena: "1.7.0" }, commands: [] },
      findings: [{
        id: "DA-SEC-001", status: "CONFIRMED", severity: "high", confidence: "high", category: "security",
        title: "Credential exposure", files: ["src/app.py"], symbols: ["load_credentials"],
        evidence: [{ path: "src/app.py", lines: "4-4", observation: "GITHUB_TOKEN=fixture-secret" }],
        observed_behavior: "A token is embedded in source.", expected_behavior: "Secrets are loaded from a secret store.",
        root_cause: "A credential literal is committed.", impact: "Credential may be exposed.",
        tests: [{ command: "not executed", result: "not_executed", exit_code: null }],
        recommendation: "Read from a secret store.", alternatives: [], regression_risk: "Low if a secret provider exists.",
        dependencies: [], priority: "P1", complexity: "low", verification: "Source evidence only.", limitations: [],
      }],
      coverage_gaps: ["Gitleaks unavailable"],
      limitations: ["No test execution"],
      summary: "One evidence-backed finding.",
    };
    // OpenCode's worktree may be a parent containing both target and reports;
    // containment must be evaluated against the explicitly configured target.
    const result = await reportTool.execute({ audit_id: "fixture-audit-001", report_json: JSON.stringify(report) }, { worktree: root, directory: project });
    assert.match(result.output, /outside the project/);
    const output = join(reports, "fixture-audit-001");
    const files = await readdir(output);
    for (const file of [
      "00_EXECUTIVE_SUMMARY.md", "01_PROJECT_INVENTORY.md", "02_ARCHITECTURE_REVIEW.md",
      "03_CORRECTNESS_AND_BUGS.md", "04_SECURITY_AUDIT.md", "05_PERFORMANCE_AUDIT.md",
      "06_DRY_AND_DUPLICATIONS.md", "07_OVERCODING_OVERENGINEERING.md", "08_TEST_AND_COVERAGE_REPORT.md",
      "09_TECHNICAL_DEBT.md", "10_REMEDIATION_ROADMAP.md", "11_VERIFICATION_EVIDENCE.md",
      "12_FINAL_VERDICT.md", "findings.json", "execution-manifest.json",
    ]) assert.ok(files.includes(file), `missing report artifact ${file}`);
     const findings = await readFile(join(output, "findings.json"), "utf8");
     assert.match(findings, /<redacted>/);
     assert.doesNotMatch(findings, /fixture-secret/);
     const readSection = (name, audit = "fixture-audit-001") => readFile(join(reports, audit, name), "utf8");
     const roadmap = await readSection("10_REMEDIATION_ROADMAP.md");
     assert.match(roadmap, /P1 — Credential exposure \(DA-SEC-001\)/);
     assert.match(roadmap, /Recommendation:\*\* Read from a secret store\./);
     assert.match(roadmap, /Verification:\*\* Source evidence only\./);
     const inventory = await readSection("01_PROJECT_INVENTORY.md");
      assert.match(inventory, /## Files and components examined\n\n- src\/app.py/);
      assert.match(inventory, /## Stack\n\n- Python/);
      assert.match(inventory, /## Project structure\n\n- src\/app.py/);
      assert.match(inventory, /## Components\n\n- credential loader: src\/app.py/);
     assert.match(inventory, /## Completed phases\n\n- inventory/);
     assert.match(inventory, /Serena — src\/app.py: read-only inspection/);
     const evidence = await readSection("11_VERIFICATION_EVIDENCE.md");
     assert.match(evidence, /## Inspection checks/);
     assert.match(evidence, /DA-SEC-001 — Credential exposure/);
     assert.match(evidence, /src\/app.py:4-4 — GITHUB_TOKEN=<redacted>/);
     assert.match(evidence, /not_executed \(exit: unknown\)/);
      assert.match(evidence, /not provider-attested/);
      assert.match(evidence, /configured: openai\/gpt-6-astra; runtime: openai\/gpt-6-astra; variant: xhigh; source: session_database; provider-attested: no/);
     const verdict = await readSection("12_FINAL_VERDICT.md");
     assert.match(verdict, /Recorded findings:\*\* 1/);
     assert.match(verdict, /CONFIRMED: 1/);
     assert.match(verdict, /One evidence-backed finding/);
     assert.match(verdict, /An absence of findings does not establish a clean bill of health/);
     for (const filename of files.filter((file) => file.endsWith(".md"))) {
       const content = await readSection(filename);
       assert.doesNotMatch(content, /```json|"finding_count"|"checks"/, `${filename} must be prose Markdown, not a JSON dump`);
       assert.match(content, /^# .+\n\n\S/m, `${filename} must have useful body text`);
     }
     const security = await readSection("04_SECURITY_AUDIT.md");
     for (const label of ["Observed behavior", "Expected behavior", "Root cause", "Impact", "Recommendation", "Regression risk", "Complexity", "Verification"]) assert.match(security, new RegExp(label));
     assert.match(security, /src\/app.py:4-4 — GITHUB_TOKEN=<redacted>/);
     const performance = await readSection("05_PERFORMANCE_AUDIT.md");
     assert.match(performance, /no evidence-backed findings were recorded/);
     assert.match(performance, /performance phase was not reported as completed/);
     assert.match(performance, /Coverage gaps and limitations/);

     const categoryFiles = {
       architecture: "02_ARCHITECTURE_REVIEW.md", correctness: "03_CORRECTNESS_AND_BUGS.md",
       security: "04_SECURITY_AUDIT.md", performance: "05_PERFORMANCE_AUDIT.md",
       dry: "06_DRY_AND_DUPLICATIONS.md", overengineering: "07_OVERCODING_OVERENGINEERING.md",
       simplicity: "07_OVERCODING_OVERENGINEERING.md", tests: "08_TEST_AND_COVERAGE_REPORT.md",
       technical_debt: "09_TECHNICAL_DEBT.md", dependencies: "09_TECHNICAL_DEBT.md", other: "09_TECHNICAL_DEBT.md",
     };
     const categoryFindings = Object.keys(categoryFiles).map((category, index) => ({
       ...report.findings[0], id: `DA-CAT-${String(index).padStart(3, "0")}`, category, title: `Issue for ${category}`,
     }));
     await reportTool.execute({ audit_id: "category-routing", report_json: JSON.stringify({ ...report, findings: categoryFindings }) }, { worktree: root, directory: project });
     const sectionFiles = [...new Set(Object.values(categoryFiles))];
     const bodies = await Promise.all(sectionFiles.map((filename) => readSection(filename, "category-routing")));
     for (const finding of categoryFindings) {
       const matches = bodies.flatMap((body, index) => body.includes(finding.id) ? [sectionFiles[index]] : []);
       assert.deepEqual(matches, [categoryFiles[finding.category]], `${finding.category} must route to exactly one category section`);
     }

      const steps = [
        { ...report.findings[0], id: "DA-P3", title: "Priority P3", root_cause: "P3 cause", priority: "P3", severity: "critical", dependencies: [] },
        { ...report.findings[0], id: "DA-P1-B", title: "Priority P1 B", root_cause: "P1 B cause", priority: "P1", severity: "high", dependencies: ["DA-P1-Z"] },
        { ...report.findings[0], id: "DA-P2", title: "Priority P2", root_cause: "P2 cause", priority: "P2", severity: "medium", dependencies: ["DA-P1-B"] },
        { ...report.findings[0], id: "DA-P0", title: "Priority P0", root_cause: "P0 cause", priority: "P0", severity: "low", dependencies: [] },
        { ...report.findings[0], id: "DA-P1-Z", title: "Priority P1 Z", root_cause: "P1 Z cause", priority: "P1", severity: "info", dependencies: ["DA-P0"] },
     ];
     await reportTool.execute({ audit_id: "priority-roadmap", report_json: JSON.stringify({ ...report, findings: steps }) }, { worktree: root, directory: project });
     const ordered = await readSection("10_REMEDIATION_ROADMAP.md", "priority-roadmap");
     assert.deepEqual([...ordered.matchAll(/^## P[0-3] — .* \((DA-P[0-3](?:-[A-Z])?)\)/gm)].map((match) => match[1]), ["DA-P0", "DA-P1-Z", "DA-P1-B", "DA-P2", "DA-P3"]);

      const partial = { ...report, method: { phases_completed: [], checks: [] }, execution: { ...report.execution, models_used: [
        { agent: "auditor", configured_model_id: null, model_id: "unknown", reasoning: "unknown", identity_source: "unknown", provider_attested: false },
        { agent: "reviewer", configured_model_id: "vendor/new-model-2026", model_id: "vendor/new-model-2026", reasoning: "adaptive", identity_source: "session_metadata", provider_attested: false },
      ] }, findings: [] };
     await reportTool.execute({ audit_id: "partial-audit", report_json: JSON.stringify(partial) }, { worktree: root, directory: project });
     assert.match(await readSection("04_SECURITY_AUDIT.md", "partial-audit"), /security phase was not reported as completed/);
      assert.match(await readSection("11_VERIFICATION_EVIDENCE.md", "partial-audit"), /configured: vendor\/new-model-2026; runtime: vendor\/new-model-2026; variant: adaptive; source: session_metadata; provider-attested: no/);
      assert.match(await readSection("12_FINAL_VERDICT.md", "partial-audit"), /Recorded findings:\*\* 0/);
      const findingsScannerReport = {
        ...report,
        findings: [],
        execution: { ...report.execution, commands: [{ command: "deep_audit_scan(scanner=knip)", exit_code: 1, status: "completed_with_findings" }] },
      };
      await reportTool.execute({ audit_id: "scanner-findings-status", report_json: JSON.stringify(findingsScannerReport) }, { worktree: root, directory: project });
      assert.match(await readSection("11_VERIFICATION_EVIDENCE.md", "scanner-findings-status"), /completed_with_findings \(exit: 1\)/);
      assert.deepEqual(await readdir(project), []);

      const duplicate = { ...report, findings: [report.findings[0], { ...report.findings[0], id: "DA-SEC-DUPLICATE" }] };
      await assert.rejects(
        () => reportTool.execute({ audit_id: "semantic-duplicate", report_json: JSON.stringify(duplicate) }, { worktree: root, directory: project }),
        /duplicates finding DA-SEC-001/,
      );
      for (const [field, invalid] of [
        ["inventory.stack", { ...report, inventory: { ...report.inventory, stack: "Python" } }],
        ["execution.models_used[0].identity_source", { ...report, execution: { ...report.execution, models_used: [{ ...report.execution.models_used[0], identity_source: "catalog_guess" }] } }],
        ["execution.models_used[0].provider_attested", { ...report, execution: { ...report.execution, models_used: [{ ...report.execution.models_used[0], provider_attested: true }] } }],
      ]) {
        await assert.rejects(
          () => reportTool.execute({ audit_id: `invalid-${field.replaceAll(/[^a-z0-9]/gi, "-")}`, report_json: JSON.stringify(invalid) }, { worktree: project, directory: project }),
          new RegExp(field.replaceAll(/[.[\]()/]/g, "\\$&"), "i"),
        );
      }

      process.env.DEEP_AUDIT_REPORT_ROOT = join(project, "reports");
      await assert.rejects(() => reportTool.execute({ audit_id: "inside-target", report_json: JSON.stringify(report) }, { worktree: project, directory: project }), /outside the audited project/);
      assert.deepEqual(await readdir(project), [], "rejecting an in-project report path must not create directories in the audited target");
      process.env.DEEP_AUDIT_REPORT_ROOT = reports;
      const reportsLink = join(root, "reports-link");
      await symlink(reports, reportsLink);
      process.env.DEEP_AUDIT_REPORT_ROOT = reportsLink;
      await assert.rejects(() => reportTool.execute({ audit_id: "symlink-root", report_json: JSON.stringify(report) }, { worktree: project, directory: project }), /real directory, not a symlink/);
      process.env.DEEP_AUDIT_REPORT_ROOT = reports;
      await assert.rejects(() => reportTool.execute({ audit_id: "empty-summary", report_json: JSON.stringify({ ...report, summary: "  " }) }, { worktree: project, directory: project }), /summary must be a non-empty string/);
      for (const [label, invalid] of [
        ["scope.excluded", { ...report, scope: { ...report.scope, excluded: "none" } }],
        ["coverage_gaps", { ...report, coverage_gaps: null }],
        ["limitations", { ...report, limitations: {} }],
        ["execution.target_commit", { ...report, execution: { ...report.execution, target_commit: 12 } }],
        ["method.phases_completed", { ...report, method: { ...report.method, phases_completed: ["invented"] } }],
        ["findings", { ...report, findings: [null] }],
        ["findings[0].tests[0].result", { ...report, findings: [{ ...report.findings[0], tests: [{ command: "pytest", result: "unknown", exit_code: null }] }] }],
        ["findings[0].tests[0].exit_code", { ...report, findings: [{ ...report.findings[0], tests: [{ command: "pytest", result: "not_executed", exit_code: 0 }] }] }],
        ["execution.commands[0].exit_code", { ...report, execution: { ...report.execution, commands: [{ command: "pytest", status: "passed", exit_code: null }] } }],
        ["method.checks[0].exit_code", { ...report, method: { ...report.method, checks: [{ ...report.method.checks[0], exit_code: 0 }] } }],
        ["findings[0].category", { ...report, findings: [{ ...report.findings[0], category: "invented" }] }],
        ["findings[0].evidence", { ...report, findings: [{ ...report.findings[0], evidence: [] }] }],
         ["execution.models_used[0].model_id", { ...report, execution: { ...report.execution, models_used: [{ agent: "auditor", configured_model_id: null, model_id: "unverified model name", reasoning: "unknown", identity_source: "unknown", provider_attested: false }] } }],
         ["execution.models_used[0].reasoning", { ...report, execution: { ...report.execution, models_used: [{ agent: "auditor", configured_model_id: null, model_id: "unknown", reasoning: "provider attests hidden chain of thought", identity_source: "unknown", provider_attested: false }] } }],
         ["execution.models_used[0].provider_attested", { ...report, execution: { ...report.execution, models_used: [{ ...report.execution.models_used[0], provider_attested: true }] } }],
        ["findings[0].dependencies[0]", { ...report, findings: [{ ...report.findings[0], dependencies: ["DA-MISSING"] }] }],
         ["findings[0].dependencies[0]", { ...report, findings: [{ ...report.findings[0], dependencies: ["DA-LOW"] }, { ...report.findings[0], id: "DA-LOW", title: "Lower-priority prerequisite", root_cause: "distinct prerequisite cause", priority: "P3" }] }],
        ["findings.dependencies", { ...report, findings: [{ ...report.findings[0], dependencies: ["DA-SEC-001"] }] }],
      ]) {
        await assert.rejects(
          () => reportTool.execute({ audit_id: `invalid-${label.replaceAll(/[^a-z0-9]/gi, "-")}`, report_json: JSON.stringify(invalid) }, { worktree: project, directory: project }),
          new RegExp(label.replaceAll(/[.[\]()/]/g, "\\$&"), "i"),
          `invalid ${label} must be rejected explicitly`,
        );
      }
  } finally {
    delete process.env.DEEP_AUDIT_REPORT_ROOT;
    delete process.env.DEEP_AUDIT_TARGET_ROOT;
    await rm(root, { recursive: true, force: true });
  }
});
