// tests/hybrid-evidence.test.mjs
//
// Deterministic, mock-only evidence tests for the static tiny Python fixture
// under tests/fixtures/hybrid/. No external services, no session/runtime
// schema, no credentials, no network, no database, no git.
//
// Goals proven here:
//   1. The fixture copies cleanly to a temp directory (TASK.md, alpha.py,
//      beta.py, test_alpha.py, test_beta.py survive the round-trip).
//   2. Against the SHIPPED (buggy) source, the frozen tests are RED — both
//      test files produce non-zero exit and report failures.
//   3. Against an EXPECTED CORRECTED implementation (inlined canonical
//      patch), the same frozen tests are GREEN — both test files produce
//      exit 0 with no failures.
//
// Run:
//   node --test tests/hybrid-evidence.test.mjs

import './guardrail/assert-isolated.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'hybrid');

const REQUIRED_FILES = [
  'TASK.md',
  'alpha.py',
  'beta.py',
  'test_alpha.py',
  'test_beta.py',
];

// Canonical expected-correct implementations, inlined as plain strings so
// the proof lives inside the test file. Workers are not required to use this
// exact text — any implementation that turns the frozen tests GREEN counts.
const CORRECT_ALPHA = `"""alpha.py — canonical correct implementation bundled by the test."""
def add(a, b):
    return a + b
`;

const CORRECT_BETA = `"""beta.py — canonical correct implementation bundled by the test."""
import re


def normalize_slug(s):
    folded = s.lower()
    sub = re.sub(r"[^a-z0-9]+", "-", folded)
    return sub.strip("-")
`;

function makeTempFixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hybrid-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of REQUIRED_FILES) {
    const src = path.join(fixtureDir, name);
    const dst = path.join(dir, name);
    fs.writeFileSync(dst, fs.readFileSync(src));
  }
  return dir;
}

function runUnittest(dir, files) {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', '-v', ...files],
    { cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertBuildLow(parent, config) {
  assert.equal(config.agents.build.model, 'openai/gpt-6.1-sol#low');
  assert.equal(config.providers.openai.models['gpt-6.1-sol'].settings.reasoningEffort, 'low');
  const messages = parent.messages.filter((m) => m.type === 'assistant');
  assert.ok(messages.length > 0);
  assert.ok(messages.every((m) => m.agent === 'build' && m.model.providerID === 'openai'
    && m.model.id === 'gpt-6.1-sol' && (!m.model.variant || m.model.variant === 'low')));
}

function assertForegroundBatch(parent) {
  const batches = parent.messages.filter((m) => m.type === 'assistant')
    .map((m) => m.content.filter((p) => p.type === 'tool' && p.name === 'subagent'));
  const calls = batches.flat();
  assert.equal(calls.length, 5);
  assert.ok(calls.every((p) => !p.state.input.background), 'required delegations must be foreground');
  assert.ok(batches.some((batch) => batch.length === 4), 'four ready lanes share one native model response');
}

test('fixture ships every required file in tests/fixtures/hybrid', () => {
  for (const name of REQUIRED_FILES) {
    const p = path.join(fixtureDir, name);
    assert.ok(fs.existsSync(p), `missing fixture file: ${name}`);
    assert.ok(fs.statSync(p).size > 0, `empty fixture file: ${name}`);
  }
});

test('fixture copies intact to a fresh temp directory', (t) => {
  const dir = makeTempFixture(t);
  for (const name of REQUIRED_FILES) {
    const a = fs.readFileSync(path.join(fixtureDir, name), 'utf8');
    const b = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.equal(b, a, `round-trip mismatch for ${name}`);
  }
  assert.notEqual(fs.realpathSync(dir), fs.realpathSync(fixtureDir));
});

test('shipped alpha + beta keep both frozen test files RED', (t) => {
  const dir = makeTempFixture(t);
  const r1 = runUnittest(dir, ['test_alpha.py']);
  const r2 = runUnittest(dir, ['test_beta.py']);
  assert.notEqual(r1.status, 0, `expected test_alpha.py RED, got status=${r1.status}\n${r1.stdout}`);
  assert.notEqual(r2.status, 0, `expected test_beta.py RED, got status=${r2.status}\n${r2.stdout}`);

  const combined = runUnittest(dir, ['test_alpha.py', 'test_beta.py']);
  assert.notEqual(combined.status, 0, 'combined shipped run must be RED');
  assert.match(combined.stderr, /FAILED \(failures=\d+\)/, 'shipped run must report at least one failure');
});

test('expected canonical implementations turn both frozen test files GREEN', (t) => {
  const dir = makeTempFixture(t);
  fs.writeFileSync(path.join(dir, 'alpha.py'), CORRECT_ALPHA);
  fs.writeFileSync(path.join(dir, 'beta.py'), CORRECT_BETA);
  const r1 = runUnittest(dir, ['test_alpha.py']);
  const r2 = runUnittest(dir, ['test_beta.py']);
  assert.equal(r1.status, 0, `expected test_alpha.py GREEN\n${r1.stdout}${r1.stderr}`);
  assert.equal(r2.status, 0, `expected test_beta.py GREEN\n${r2.stdout}${r2.stderr}`);

  const combined = runUnittest(dir, ['test_alpha.py', 'test_beta.py']);
  assert.equal(combined.status, 0, 'combined canonical run must be GREEN');
  assert.match(combined.stderr, /Ran 14 tests[\s\S]*OK/, 'canonical run must report 14 passed');
});

test('each module is independently fixable — alpha patch alone does not turn beta GREEN', (t) => {
  const dir = makeTempFixture(t);
  // Patch only alpha.
  fs.writeFileSync(path.join(dir, 'alpha.py'), CORRECT_ALPHA);
  const alphaOnly = runUnittest(dir, ['test_alpha.py']);
  const betaAfter = runUnittest(dir, ['test_beta.py']);
  assert.equal(alphaOnly.status, 0, 'alpha alone must be GREEN after patch');
  assert.notEqual(betaAfter.status, 0, 'beta must stay RED while alpha is fixed alone');
});

// Optional: inspect real native exports, never a mock agent-name/config list.
test('native Hybrid exports prove four concurrent lanes, models, ownership and subsequent review', {
  skip: !process.env.OPENCODE_TEAM_HYBRID_EXPORT_PREFIX,
}, () => {
  const prefix = process.env.OPENCODE_TEAM_HYBRID_EXPORT_PREFIX;
  const parent = JSON.parse(fs.readFileSync(`${prefix}-export.json`, 'utf8'));
  const config = JSON.parse(fs.readFileSync(`${prefix}-config.json`, 'utf8'));
  assertBuildLow(parent, config);
  assertForegroundBatch(parent);
  // Negative controls use the actual export, not a fabricated agent roster.
  const high = structuredClone(parent);
  high.messages.find((m) => m.type === 'assistant').model.variant = 'high';
  assert.throws(() => assertBuildLow(high, config));
  const mediumDefault = structuredClone(config);
  mediumDefault.providers.openai.models['gpt-6.1-sol'].settings.reasoningEffort = 'medium';
  assert.throws(() => assertBuildLow(parent, mediumDefault));
  const background = structuredClone(parent);
  background.messages.flatMap((m) => m.content || []).find((p) => p.name === 'subagent').state.input.background = true;
  assert.throws(() => assertForegroundBatch(background));
  const children = fs.readdirSync(path.dirname(prefix))
    .filter((name) => name.startsWith(`${path.basename(prefix)}-ses_`) && name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(path.dirname(prefix), name), 'utf8')));
  assert.equal(children.length, 5);
  assert.equal(new Set(children.map((c) => c.info.id)).size, 5);
  assert.deepEqual(children.map((c) => c.info.agent).sort(), ['explore', 'general', 'general', 'reviewer', 'specialist']);
  const models = { explore: ['opencode-go', 'mimo-v2.6-flash'], general: ['opencode-go', 'longcat-2.0'],
    specialist: ['openai', 'gpt-6.1-sol'], reviewer: ['openai', 'gpt-6.1-sol'] };
  const mutations = new Set(['edit', 'write', 'patch', 'serena_replace_symbol_body', 'serena_replace_content']);
  const messages = (c) => c.messages.filter((m) => m.type === 'assistant');
  const end = (c) => Math.max(...messages(c).map((m) => m.time.completed));
  const owned = [];
  const location = parent.info.location.directory;
  for (const child of children) {
    assert.equal(child.info.parentID, parent.info.id);
    assert.equal(child.info.outcome, 'succeeded');
    const agent = child.info.agent;
    for (const message of messages(child)) {
      assert.deepEqual([message.model.providerID, message.model.id], models[agent]);
      if (['specialist', 'reviewer'].includes(agent)) assert.equal(message.model.variant, 'medium');
    }
    const tools = messages(child).flatMap((m) => m.content).filter((p) => p.type === 'tool');
    if (agent !== 'general') assert.ok(!tools.some((p) => mutations.has(p.name)), `${agent} must not write`);
    else {
      const writes = tools.filter((p) => mutations.has(p.name));
      assert.ok(writes.length > 0);
      const paths = new Set(writes.map((p) => path.relative(location,
        path.resolve(location, p.state.input.path || p.state.input.relative_path))));
      assert.equal(paths.size, 1, 'each writer owns exactly one module');
      owned.push(...paths);
    }
  }
  assert.deepEqual(owned.sort(), ['alpha.py', 'beta.py']);
  const lanes = children.filter((c) => c.info.agent !== 'reviewer');
  const latestStart = Math.max(...lanes.map((c) => Math.min(...messages(c).map((m) => m.time.created))));
  assert.ok(latestStart < Math.min(...lanes.map(end)), 'actual assistant execution intervals overlap');
  const reviewer = children.find((c) => c.info.agent === 'reviewer');
  assert.ok(reviewer.info.time.created > Math.max(...children.filter((c) => c.info.agent === 'general').map(end)));
  const build = messages(parent);
  assert.ok(build.every((m) => m.agent === 'build' && m.model.providerID === 'openai' && m.model.id === 'gpt-6.1-sol'));
  const events = fs.readFileSync(`${prefix}.jsonl`, 'utf8');
  assert.ok(!events.includes('Permission required'));
  for (const file of ['TASK.md', 'test_alpha.py', 'test_beta.py']) {
    assert.deepEqual(fs.readFileSync(path.join(location, file)), fs.readFileSync(path.join(fixtureDir, file)));
  }
  const final = runUnittest(location, ['test_alpha.py', 'test_beta.py']);
  assert.equal(final.status, 0, final.stderr);
  assert.match(final.stderr, /Ran 14 tests[\s\S]*OK/);
});
