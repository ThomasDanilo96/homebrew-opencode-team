import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { fingerprint } from "../teams/deep-audit/test-runner-integrity.mjs";

const required = [
  "OPENCODE_TEAM_DEEP_AUDIT_TEST_PLUGIN",
  "OPENCODE_TEAM_DEEP_AUDIT_TEST_RUNNER_IMAGES",
  "OPENCODE_TEAM_DEEP_AUDIT_TEST_DOCKER_BIN",
];
const missing = required.filter((key) => !process.env[key]);

async function treeHash(root) {
  const hash = createHash("sha256");
  async function walk(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      const info = await import("node:fs/promises").then(({ lstat }) => lstat(path));
      hash.update(rel).update("\0");
      if (info.isDirectory()) await walk(path, prefix);
      else if (info.isFile()) hash.update(await readFile(path));
      else if (info.isSymbolicLink()) hash.update(await import("node:fs/promises").then(({ readlink }) => readlink(path)));
      hash.update("\0");
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function parseEvidence(result) {
  const match = result.output.match(/^Evidence: ([^\n]+)/);
  assert.ok(match, "runner must return an external evidence file path");
  const evidencePath = await realpath(match[1]);
  return { evidencePath, evidence: JSON.parse(await readFile(evidencePath, "utf8")) };
}

test("Deep Audit executes Python, Django, PHPUnit and npm only in isolated disposable containers", {
  skip: missing.length ? `requires a rendered test plugin and pinned Docker images (${missing.join(", ")})` : false,
}, async () => {
  const fixtureRoot = await realpath(new URL("./fixtures/deep-audit-test-runner/", import.meta.url).pathname);
  const temp = await mkdtemp(join(tmpdir(), "deep-audit-runner-e2e."));
  const reports = join(temp, "reports");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(reports));
  const pluginModule = await import(pathToFileURL(process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_PLUGIN).href);
  const plugin = await pluginModule.default({});
  const original = process.env.DEEP_AUDIT_TARGET_ROOT;
  const originalReports = process.env.DEEP_AUDIT_REPORT_ROOT;
  const originalImages = process.env.DEEP_AUDIT_TEST_RUNNER_IMAGES;
  const originalDocker = process.env.DEEP_AUDIT_DOCKER_BIN;
  const originalTimeout = process.env.DEEP_AUDIT_TEST_TIMEOUT_MS;

  try {
    for (const [fixture, suiteId] of [["python", "pytest"], ["django", "django-test"], ["php", "phpunit"], ["javascript", "npm-test"]]) {
      const target = join(temp, fixture);
      await cp(join(fixtureRoot, fixture), target, { recursive: true, dereference: false, preserveTimestamps: true });
      if (fixture === "javascript") {
        const hostSecret = join(temp, "host-secret.txt");
        await writeFile(hostSecret, "host-only-secret-must-not-enter-snapshot");
        await symlink(hostSecret, join(target, "host-secret-link"));
      }
      const before = await treeHash(target);
      process.env.DEEP_AUDIT_TARGET_ROOT = await realpath(target);
      process.env.DEEP_AUDIT_REPORT_ROOT = reports;
      process.env.DEEP_AUDIT_TEST_RUNNER_IMAGES = process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_RUNNER_IMAGES;
      process.env.DEEP_AUDIT_DOCKER_BIN = process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_DOCKER_BIN;
      delete process.env.DEEP_AUDIT_TEST_TIMEOUT_MS;

      const context = { directory: process.env.DEEP_AUDIT_TARGET_ROOT, worktree: process.env.DEEP_AUDIT_TARGET_ROOT, sessionID: `fixture-${fixture}` };
      const discovery = await plugin.tool.deep_audit_test_discover.execute({}, context);
      const discoveryResult = JSON.parse(discovery.output);
      const suites = discoveryResult.suites;
      const suite = suites.find((item) => item.id === suiteId);
      assert.ok(suite?.available, `${fixture} suite must be discovered and available: ${JSON.stringify(suites)}`);
      if (fixture === "javascript") {
        assert.equal(discoveryResult.coverage.test_files, 1, "JavaScript test-file discovery must report the test file");
        assert.ok(discoveryResult.excluded_symlinks.some((item) => item.path === "host-secret-link"), "test discovery must report ignored symlinks");
      }

      const result = await plugin.tool.deep_audit_test_run.execute({ suite_id: suiteId }, context);
      const { evidencePath, evidence } = await parseEvidence(result);
      assert.match(result.title, /: failed$/, `intentional defect must produce a nonzero test result; runner status=${evidence.status}; stderr=${evidence.stderr}; stdout=${evidence.stdout}`);
      assert.equal(evidence.status, "failed");
      assert.ok(evidence.exit_code !== 0);
      if (fixture === "javascript") assert.deepEqual(evidence.test_counts, { discovered: 5, executed: 5, passed: 4, failed: 1, skipped: 0, cancelled: 0, source: "Node TAP summary" });
      assert.equal(evidence.isolation.network, "none");
      assert.equal(evidence.isolation.root_filesystem, "read-only");
      assert.equal(evidence.isolation.capabilities, "all dropped");
      assert.equal(evidence.secret_scan.status, "clean");
      assert.equal(evidence.output_truncated, false);
      if (fixture !== "php") assert.equal(evidence.coverage.status, "collected");
      if (fixture === "php") assert.equal(evidence.coverage.status, "unavailable");
      assert.ok(relative(target, evidencePath).startsWith(".."), "evidence must be outside the original project");
      assert.ok(evidence.snapshot.excluded.some((entry) => entry.path === ".env"), "credential-style env files must be excluded from the snapshot");
      if (fixture === "javascript") assert.ok(evidence.snapshot.excluded.some((entry) => entry.path === "host-secret-link"), "external symlinks must be excluded");
      assert.equal(await treeHash(target), before, `${fixture} original repository must remain byte-identical`);
      assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret|production\.example\.invalid/);

      if (fixture === "django") {
        assert.match(evidence.stdout + evidence.stderr, /test_database_is_temporary_sqlite/);
        assert.match(evidence.stdout + evidence.stderr, /sqlite3/);
        assert.equal(evidence.coverage.database.configured_backend, "SQLite");
        assert.deepEqual(evidence.coverage.database.backend_specific_verification.map((item) => [item.backend, item.status]), [["PostgreSQL", "NOT_EXECUTED"], ["MySQL", "NOT_EXECUTED"]]);
        assert.match(evidence.isolation.databases, /PostgreSQL\/MySQL-specific behavior is NOT_EXECUTED/);
      }
      if (fixture === "python") {
        assert.match(evidence.stdout + evidence.stderr, /test_container_network_denied/);
        assert.match(evidence.stdout + evidence.stderr, /test_container_filesystem_boundary/);
      }
      if (fixture === "django") assert.match(evidence.stdout + evidence.stderr, /Verified disposable database engine=.*sqlite3/);
      if (fixture === "php") assert.match(evidence.stdout + evidence.stderr, /Container network denied/);
      if (fixture === "javascript") {
        assert.match(evidence.stdout + evidence.stderr, /container network is disabled/);
        assert.match(evidence.stdout + evidence.stderr, /container process limit stops excess child processes/);
        assert.match(evidence.stdout + evidence.stderr, /container security limits and privilege restrictions are active/);
      }
    }

    const timeoutTarget = join(temp, "timeout");
    await cp(join(fixtureRoot, "javascript"), timeoutTarget, { recursive: true, dereference: false });
    await writeFile(join(timeoutTarget, "package.json"), JSON.stringify({ name: "timeout-fixture", version: "1.0.0", scripts: { test: "node -e 'setInterval(() => {}, 1000)'" } }));
    const timeoutBefore = await treeHash(timeoutTarget);
    process.env.DEEP_AUDIT_TARGET_ROOT = await realpath(timeoutTarget);
    process.env.DEEP_AUDIT_TEST_TIMEOUT_MS = "5000";
    const context = { directory: process.env.DEEP_AUDIT_TARGET_ROOT, worktree: process.env.DEEP_AUDIT_TARGET_ROOT, sessionID: "fixture-timeout" };
    const timed = await plugin.tool.deep_audit_test_run.execute({ suite_id: "npm-test" }, context);
    assert.match(timed.title, /: timed_out$/);
    const { evidence: timedEvidence } = await parseEvidence(timed);
    assert.equal(timedEvidence.timed_out, true);
    assert.equal(timedEvidence.isolation.timeout_ms, 5000);
    assert.equal(await treeHash(timeoutTarget), timeoutBefore, "timed-out test must not modify its original project");
    const docker = process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_DOCKER_BIN;
    const staleContainers = (await import("node:child_process")).spawnSync(docker, ["ps", "-aq", "--filter", "label=org.opencode-team.deep-audit-test=true"], { encoding: "utf8" });
    assert.equal(staleContainers.status, 0);
    assert.equal(staleContainers.stdout.trim(), "", "isolated test containers must be removed after completion/timeout");

    await assert.rejects(
      () => plugin.tool.deep_audit_test_run.execute({ suite_id: "../../arbitrary-command" }, { directory: process.env.DEEP_AUDIT_TARGET_ROOT, worktree: process.env.DEEP_AUDIT_TARGET_ROOT, sessionID: "fixture-invalid" }),
      /not discovered/,
    );

    const markerPath = process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_RUNNER_MARKER;
    if (markerPath) {
      const manifestPath = process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_RUNNER_IMAGES;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const packageRoot = await realpath(new URL("../", import.meta.url).pathname);
      const renderedPlugin = process.env.OPENCODE_TEAM_DEEP_AUDIT_TEST_PLUGIN;
      const validationFingerprint = await fingerprint({ packageRoot, renderedPlugin, imagesManifest: manifestPath });
      const images = Object.fromEntries(["node", "python", "php"].map((name) => [name, manifest[name].image_id]));
      await writeFile(markerPath, `${JSON.stringify({ schema_version: 1, validated_at: new Date().toISOString(), fingerprint: validationFingerprint, images }, null, 2)}\n`, { mode: 0o600 });
    }
  } finally {
    for (const [key, value] of Object.entries({
      DEEP_AUDIT_TARGET_ROOT: original,
      DEEP_AUDIT_REPORT_ROOT: originalReports,
      DEEP_AUDIT_TEST_RUNNER_IMAGES: originalImages,
      DEEP_AUDIT_DOCKER_BIN: originalDocker,
      DEEP_AUDIT_TEST_TIMEOUT_MS: originalTimeout,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
