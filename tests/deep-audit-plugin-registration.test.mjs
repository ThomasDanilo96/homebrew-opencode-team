import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
  "OPENCODE_TEAM_DEEP_AUDIT_CONFIG",
  "OPENCODE_TEAM_DEEP_AUDIT_LAUNCHER",
  "OPENCODE_TEAM_DEEP_AUDIT_SANDBOX",
  "OPENCODE_TEAM_DEEP_AUDIT_CONFIG_DIR",
  "OPENCODE_TEAM_DEEP_AUDIT_XDG_CONFIG",
  "OPENCODE_TEAM_DEEP_AUDIT_DEPENDENCY_ROOT",
  "OPENCODE_TEAM_DEEP_AUDIT_SERENA_BIN",
  "OPENCODE_TEAM_DEEP_AUDIT_REAL_BINARY",
  "OPENCODE_TEAM_DEEP_AUDIT_PYTHON",
  "OPENCODE_TEAM_DEEP_AUDIT_TEST_RUNNER_IMAGES",
  "OPENCODE_TEAM_DEEP_AUDIT_DOCKER_BIN",
];
const missing = required.filter((name) => !process.env[name]);

function invoke(launcher, args, cwd, env, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1200).unref();
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, output: `${stdout}\n${stderr}` });
    });
  });
}

function treeDigest(root) {
  const hash = createHash("sha256");
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const relative = file.slice(root.length + 1);
      const info = lstatSync(file);
      hash.update(relative).update("\0");
      if (info.isDirectory()) walk(file);
      else if (info.isFile()) hash.update(readFileSync(file));
      else if (info.isSymbolicLink()) hash.update(readlinkSync(file));
      hash.update("\0");
    }
  }
  walk(root);
  return hash.digest("hex");
}

test("real sandboxed OpenCode registers and executes the Deep Audit tools and Serena MCP", {
  skip: missing.length ? `requires a rendered profile and pinned dependencies (${missing.join(", ")})` : false,
  timeout: 300_000,
}, async (t) => {
  const configPath = await realpath(process.env.OPENCODE_TEAM_DEEP_AUDIT_CONFIG);
  const launcher = await realpath(process.env.OPENCODE_TEAM_DEEP_AUDIT_LAUNCHER);
  assert.equal(launcher, await realpath(join(packageRoot, "teams/deep-audit/bin/read-only-opencode.sh")), "all diagnostics must run through the profile Seatbelt wrapper");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const expectedPluginNames = ["report-plugin.mjs", "scanner-plugin.mjs", "test-runner-plugin.mjs"];
  assert.equal(config.plugin.length, expectedPluginNames.length);
  for (const [index, spec] of config.plugin.entries()) {
    assert.ok(spec.startsWith("file://"), `expected a profile-local plugin URL: ${spec}`);
    assert.equal((await realpath(fileURLURL(spec))).split("/").at(-1), expectedPluginNames[index]);
  }
  assert.deepEqual(Object.keys(config.mcp), ["serena"]);
  assert.equal(config.mcp.serena.enabled, true);
  for (const tool of ["serena_search_for_pattern", "serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols"]) {
    assert.equal(config.agent["audit-orchestrator"].tools[tool], true, `orchestrator must be allowed to use ${tool}`);
  }
  for (const tool of ["serena_replace_content", "serena_write_memory", "serena_delete_memory", "serena_execute_shell_command"]) {
    assert.notEqual(config.agent["audit-orchestrator"].tools[tool], true, `orchestrator must not be enabled for mutative ${tool}`);
  }

  // Keep the macOS /var temporary path spelling in this fixture. Serena uses
  // project_serena_folder_location relative to SERENA_HOME; canonicalizing the
  // root to /private/var and then resolving it again can produce /private/private/var.
  const root = await mkdtemp(join(tmpdir(), "deep-audit-runtime-tool-probe."));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "fixture project with spaces");
  const serenaTarget = join(root, "Serena read-only fixture");
  const reports = join(process.env.OPENCODE_TEAM_DEEP_AUDIT_SANDBOX, "reports");
  const xdgRoot = join(process.env.OPENCODE_TEAM_DEEP_AUDIT_SANDBOX, `runtime-tool-probe-${process.pid}`);
  const xdgData = join(xdgRoot, "xdg-data");
  const xdgCache = join(xdgRoot, "xdg-cache");
  const xdgState = join(xdgRoot, "xdg-state");
  const serenaHome = join(root, "serena-home");
  const runtime = join(root, "runtime");
  t.after(() => rm(xdgRoot, { recursive: true, force: true }));
  await Promise.all([target, serenaTarget, reports, xdgData, xdgCache, xdgState, serenaHome, runtime].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(serenaHome, "npmrc"), "", { mode: 0o600 });
  const profileSerenaHome = join(process.env.OPENCODE_TEAM_DEEP_AUDIT_SANDBOX, "serena");
  const profileSerenaConfig = (await readFile(join(profileSerenaHome, "serena_config.yml"), "utf8"))
    .replace("projects:\n  []", `projects:\n  - ${JSON.stringify(serenaTarget)}`)
    .replace("trusted_project_path_patterns:\n  []", `trusted_project_path_patterns:\n  - ${JSON.stringify(serenaTarget)}`)
    .replaceAll(profileSerenaHome, serenaHome);
  await writeFile(join(serenaHome, "serena_config.yml"), profileSerenaConfig, { mode: 0o600 });
  const languageServerSource = join(process.env.OPENCODE_TEAM_DEEP_AUDIT_SANDBOX, "serena/language_servers/ts-lsp");
  await mkdir(join(serenaHome, "language_servers"), { recursive: true, mode: 0o700 });
  await cp(languageServerSource, join(serenaHome, "language_servers/ts-lsp"), { recursive: true });
  const serenaProjectData = join(serenaHome, "projects", "Serena read-only fixture", ".serena");
  await mkdir(serenaProjectData, { recursive: true, mode: 0o700 });
  await writeFile(join(serenaProjectData, "project.yml"), "project_name: SerenaFixture\nlanguage_servers: [typescript]\nread_only: true\n", { mode: 0o600 });
  await writeFile(join(serenaProjectData, "project.local.yml"), "language_servers: [typescript]\nls_specific_settings:\n  typescript:\n    typescript_version: \"5.9.3\"\n    typescript_language_server_version: \"5.1.3\"\n", { mode: 0o600 });
  const fixtureRoot = await realpath(join(packageRoot, "tests/fixtures/deep-audit-test-runner/javascript"));
  for (const file of ["package.json", "calculator.js", "calculator.test.js"]) await cp(join(fixtureRoot, file), join(target, file));
  await writeFile(join(target, "scanner-fixture.py"), "import subprocess\ndef unsafe(command):\n    return subprocess.run(command, shell=True)\n", { mode: 0o444 });
  const git = spawnSync("git", ["init", "--quiet", target], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  await writeFile(join(serenaTarget, "README.md"), "The Serena-only fixture contains calculateTotal as plain text.\n");
  await mkdir(join(serenaTarget, "src"), { mode: 0o700 });
  await writeFile(join(serenaTarget, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src/**/*.ts"] }), { mode: 0o444 });
  await writeFile(join(serenaTarget, "src/math.ts"), "export function calculateTotal(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n", { mode: 0o444 });
  await writeFile(join(serenaTarget, "src/consumer.ts"), "import { calculateTotal } from \"./math\";\nexport const invoiceTotal = calculateTotal([2, 3]);\n", { mode: 0o444 });
  const serenaGit = spawnSync("git", ["init", "--quiet", serenaTarget], { encoding: "utf8" });
  assert.equal(serenaGit.status, 0, serenaGit.stderr);
  const originalTargetDigest = treeDigest(target);
  const originalSerenaDigest = treeDigest(serenaTarget);

  const env = {
    ...process.env,
    HOME: process.env.HOME,
    SANDBOX: process.env.OPENCODE_TEAM_DEEP_AUDIT_SANDBOX,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_TEAM_DEEP_AUDIT_CONFIG_DIR,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    XDG_CONFIG_HOME: process.env.OPENCODE_TEAM_DEEP_AUDIT_XDG_CONFIG,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    RUNTIME_ROOT: runtime,
    SERENA_HOME: serenaHome,
    npm_config_cache: join(serenaHome, "npm-cache"),
    npm_config_userconfig: join(serenaHome, "npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    DEEP_AUDIT_TARGET_ROOT: target,
    DEEP_AUDIT_REPORT_ROOT: reports,
    DEEP_AUDIT_SANDBOX_PROFILE: join(runtime, "readonly-project.sb"),
    DEEP_AUDIT_REAL_OPENCODE_BIN: process.env.OPENCODE_TEAM_DEEP_AUDIT_REAL_BINARY,
    DEEP_AUDIT_NODE_BIN: process.execPath,
    OPENCODE_TEAM_PYTHON: process.env.OPENCODE_TEAM_DEEP_AUDIT_PYTHON,
    DEEP_AUDIT_DEPENDENCY_ROOT: process.env.OPENCODE_TEAM_DEEP_AUDIT_DEPENDENCY_ROOT,
    DEEP_AUDIT_SERENA_BIN: process.env.OPENCODE_TEAM_DEEP_AUDIT_SERENA_BIN,
    DEEP_AUDIT_SCANNER_ROOT: join(process.env.OPENCODE_TEAM_DEEP_AUDIT_DEPENDENCY_ROOT, "deep-audit/scanners"),
    DEEP_AUDIT_RULES_ROOT: join(packageRoot, "teams/deep-audit/rules"),
    DEEP_AUDIT_TEST_RUNNER_IMAGES: process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_RUNNER_IMAGES,
    DEEP_AUDIT_DOCKER_BIN: process.env.OPENCODE_TEAM_DEEP_AUDIT_DOCKER_BIN,
    OPENCODE_PURE: undefined,
  };
  for (const name of [
    "OMO_PROFILE", "OPENCODE_PROFILE", "OPENCODE_BIN", "OPENCODE_PURE",
    "OPENCODE_TEAM_HOME", "OPENCODE_TEAM_DEPENDENCY_ROOT", "OPENCODE_TEAM_PACKAGE_ROOT",
    "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "OPENROUTER_API_KEY",
    "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  ]) delete env[name];
  delete env.OPENCODE_BIN;
  delete env.OPENCODE_PURE;

  const runTool = async (tool, params) => {
    const result = await invoke(launcher, [
      "debug", "agent", "audit-orchestrator", "--tool", tool, "--params", JSON.stringify(params),
    ], target, env);
    assert.equal(result.timedOut, false, `${tool} timed out: ${result.output}`);
    assert.equal(result.code, 0, `${tool} was not accessible to audit-orchestrator: ${result.output}`);
    return result.output;
  };
  const reviewerRead = async (filePath) => {
    const result = await invoke(launcher, [
      "debug", "agent", "audit-reviewer", "--tool", "read", "--params", JSON.stringify({ filePath }),
    ], target, env);
    assert.equal(result.timedOut, false, `audit-reviewer read timed out for ${filePath}: ${result.output}`);
    assert.equal(result.code, 0, `audit-reviewer could not read ${filePath}: ${result.output}`);
    return result.output;
  };

  const mcp = await invoke(launcher, ["mcp", "list"], target, env);
  assert.equal(mcp.timedOut, false, mcp.output);
  assert.equal(mcp.code, 0, mcp.output);
  assert.match(mcp.output, /serena/i);
  assert.match(mcp.output, /connected/i, `Serena MCP must be live: ${mcp.output}`);

  const discovery = await runTool("deep_audit_test_discover", {});
  let discoveryResult;
  try {
    discoveryResult = JSON.parse(discovery).result;
  } catch (error) {
    throw new Error(`deep_audit_test_discover returned non-JSON output: ${discovery.slice(0, 4000)}`, { cause: error });
  }
  assert.match(discoveryResult.output, /npm-test/, "test discovery did not return the fixture suite");
  assert.equal(JSON.parse(discoveryResult.output).coverage.test_files, 1, `JavaScript test discovery omitted the fixture's test file: ${discoveryResult.output}`);
  assert.equal(JSON.parse(discoveryResult.output).coverage.suite_counts.discovered, 1);

  for (const scanner of ["semgrep", "jscpd", "ast-grep"]) {
    const output = await runTool("deep_audit_scan", { scanner });
    const result = JSON.parse(output).result;
    assert.match(result.title, new RegExp(`${scanner} completed(?: with findings)? \\(exit 0\\)`), `${scanner} could not initialize with the restricted scanner PATH: ${output}`);
    const evidencePath = result.output.match(/Scan evidence saved outside the target: (.+)/)?.[1];
    assert.ok(evidencePath, `${scanner} did not return its evidence path`);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.scanner, scanner);
    assert.equal(evidence.exit_code, 0);
    assert.ok(evidence.analysis_scope?.command?.length > 1, "scanner evidence must state its analysis scope and invocation");
    const reviewerEvidence = await reviewerRead(evidencePath);
    assert.match(reviewerEvidence, /completed(?:_with_findings)?/, `reviewer did not receive ${scanner} evidence`);
    if (scanner === "ast-grep") {
      assert.equal(evidence.analysis.result_count, 1, `real OpenCode ast-grep invocation did not report its positive fixture: ${JSON.stringify(evidence.analysis)}`);
      assert.equal(evidence.analysis.findings[0].rule_id, "python-subprocess-shell-true");
      assert.equal(evidence.analysis.findings[0].path, "scanner-fixture.py");
    }
  }

  const scan = await runTool("deep_audit_scan", { scanner: "gitleaks" });
  const scanResult = JSON.parse(scan).result;
  assert.match(scanResult.title, /gitleaks completed \(exit 0\)/, `scanner did not execute cleanly: ${scan}`);
  const scannerEvidence = scanResult.output.match(/Scan evidence saved outside the target: (.+)/)?.[1];
  assert.ok(scannerEvidence, "scanner did not return its evidence path");
  assert.ok((await readFile(scannerEvidence, "utf8")).includes('"scanner": "gitleaks"'));

  const tests = await runTool("deep_audit_test_run", { suite_id: "npm-test" });
  const testResult = JSON.parse(tests).result;
  assert.match(testResult.title, /npm-test: failed/, "intentional fixture defect was not exercised inside the test runner");
  const testEvidence = JSON.parse(testResult.output.slice(testResult.output.indexOf("\n") + 1));
  assert.equal(testEvidence.isolation.network, "none", "test evidence omitted the enforced network boundary");
  assert.equal(testEvidence.exit_code, 1, "fixture's known defect did not produce its expected nonzero test status");
  assert.deepEqual(testEvidence.test_counts, { discovered: 5, executed: 5, passed: 4, failed: 1, skipped: 0, cancelled: 0, source: "Node TAP summary" });

  const report = {
    schema_version: 1,
    scope: { requested: target, examined: ["calculator.js"], excluded: [] },
    inventory: { stack: ["JavaScript"], structure: ["calculator.js", "calculator.test.js", "package.json"], components: ["calculator helper"], entry_points: ["package.json scripts.test"], dependencies: [], test_suites: ["npm-test"], boundaries: ["Disposable registration fixture"] },
    method: { phases_completed: [], checks: [] },
    execution: { target_commit: null, models_used: [], tool_versions: {}, commands: [] },
    findings: [],
    coverage_gaps: ["Runtime registration preflight only; no AI audit was run."],
    limitations: ["This report is a disposable tool-preflight artifact, not an audit result."],
    summary: "Runtime tool registration preflight only; no AI audit was run.",
  };
  const reportResult = await runTool("deep_audit_save_report", {
    audit_id: `registration-preflight-${Date.now()}`,
    report_json: JSON.stringify(report),
  });
  assert.match(JSON.parse(reportResult).result.output, /Validated report saved outside the project/);
  const reportDirectory = (await readdir(reports)).find((name) => name.startsWith("registration-preflight-"));
  assert.ok(reportDirectory, "report tool did not write the preflight bundle");
  const manifest = JSON.parse(await readFile(join(reports, reportDirectory, "execution-manifest.json"), "utf8"));
  assert.equal(manifest.model_usage_independently_verified, false);
  const reportSummary = await realpath(join(reports, reportDirectory, "00_EXECUTIVE_SUMMARY.md"));
  const reportRead = await reviewerRead(reportSummary);
  assert.match(reportRead, /Runtime tool registration preflight only/, "reviewer could not read the generated report bundle");

  const serenaExecutable = process.env.OPENCODE_TEAM_DEEP_AUDIT_SERENA_BIN;
  // Serena's MCP client dependency is installed in its profile-local uv tool
  // environment, not the separate managed scanner/runtime Python. Resolve the
  // interpreter from that owned tool root rather than shell-parsing a shebang
  // through the host PATH (which can select unrelated commands).
  const serenaPython = join(process.env.OPENCODE_TEAM_DEEP_AUDIT_DEPENDENCY_ROOT, "serena/serena-agent/bin/python");
  assert.ok(serenaPython.startsWith("/"), `Serena tool environment is unavailable: ${serenaPython}`);
  const pythonCheck = spawnSync(serenaPython, ["-c", "import mcp, sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(pythonCheck.status, 0, `Serena's profile-local Python cannot run its MCP client: ${pythonCheck.stderr}`);
  assert.equal(await realpath(pythonCheck.stdout.trim()), await realpath(serenaPython), "MCP client must use the profile-managed Python interpreter");
  const mcpProbe = join(root, "serena-mcp-probe.py");
  await writeFile(mcpProbe, `import asyncio, json, os, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    server, project = sys.argv[1:]
    os.chdir(project)
    parameters = StdioServerParameters(command=server, args=["start-mcp-server", "--context", "ide", "--project-from-cwd", "--open-web-dashboard", "false"], env=os.environ.copy())
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            if "search_for_pattern" not in names:
                raise RuntimeError("Serena MCP omitted search_for_pattern")
            result = await session.call_tool("search_for_pattern", {"substring_pattern": "calculateTotal", "relative_path": "README.md"})
            if result.isError:
                raise RuntimeError("Serena search_for_pattern returned an error")
            text = "\\n".join(getattr(item, "text", "") for item in result.content)
            if "calculateTotal" not in text:
                raise RuntimeError("Serena search did not return fixture evidence")
            definition = await session.call_tool("find_symbol", {"name_path_pattern": "calculateTotal", "relative_path": "src/math.ts", "include_body": True})
            definition_text = "\\n".join(getattr(item, "text", "") for item in definition.content)
            if definition.isError or "calculateTotal" not in definition_text:
                raise RuntimeError("Serena did not resolve the TypeScript definition")
            references = await session.call_tool("find_referencing_symbols", {"name_path": "calculateTotal", "relative_path": "src/math.ts"})
            references_text = "\\n".join(getattr(item, "text", "") for item in references.content)
            if references.isError or "consumer.ts" not in references_text:
                raise RuntimeError("Serena did not return the TypeScript reference from consumer.ts")
            print("SERENA_TOOLS=" + ",".join(sorted(names)))
            print("SERENA_SEARCH=" + text)
            print("SERENA_DEFINITION=" + definition_text)
            print("SERENA_REFERENCES=" + references_text)

asyncio.run(main())
`);
  const serena = await invoke(launcher, [mcpProbe, serenaExecutable, serenaTarget], serenaTarget, {
    ...env,
    DEEP_AUDIT_TARGET_ROOT: serenaTarget,
    SERENA_HOME: serenaHome,
    DEEP_AUDIT_REAL_OPENCODE_BIN: serenaPython,
  });
  assert.equal(serena.timedOut, false, serena.output);
  assert.equal(serena.code, 0, `real read-only Serena MCP tool call failed: ${serena.output}`);
  assert.match(serena.output, /SERENA_TOOLS=.*search_for_pattern/);
  assert.match(serena.output, /SERENA_SEARCH=.*calculateTotal/);
  assert.match(serena.output, /SERENA_DEFINITION=.*calculateTotal/, `Serena did not return the TypeScript definition: ${serena.output}`);
  assert.match(serena.output, /SERENA_REFERENCES=.*consumer\.ts/, `Serena did not return a cross-file TypeScript reference: ${serena.output}`);
  const semanticEvidence = serena.output.split(/\r?\n/).filter((line) => /SERENA_(?:DEFINITION|REFERENCES)=/.test(line));
  t.diagnostic(`Serena LSP 5.1.3 / TypeScript 5.9.3 via real MCP; definition and cross-file reference verified: ${semanticEvidence.join(" | ")}`);
  assert.equal(treeDigest(target), originalTargetDigest, "runtime tool diagnostics changed the fixture");
  assert.equal(treeDigest(serenaTarget), originalSerenaDigest, "Serena changed its read-only fixture");
});

function fileURLURL(value) {
  return new URL(value);
}
