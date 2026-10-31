// tests/best-routing.test.mjs — deterministic, mock-only
import './guardrail/assert-isolated.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chooseRoute, metrics, appendRecord, readLedger,
} from '../shared/best-routing.mjs';

const CFG = {
  commands: {
    code: { model: 'opencode-go/minimax-m3', agent: 'general' },
    small: { model: 'opencode-go/minimax-m3.1-flash', agent: 'explore', variant: 'low' },
    scan: { model: 'opencode-go/mimo-v2.6-flash', agent: 'explore' },
    analyze: { model: 'opencode-go/qwen3.7-plus', agent: 'specialist' },
    architect: { model: 'openai/gpt-6.1-sol', agent: 'specialist', variant: 'medium' },
    debug: { model: 'openai/gpt-6.1-sol', agent: 'build' },
    reviewCritical: { model: 'openai/gpt-6.1-sol', agent: 'reviewer' },
    visual: { model: 'opencode-go/glm-5.3-flash', agent: 'general' },
    visualFallback: { model: 'opencode-go/minimax-m3', agent: 'general' },
    codeOpenai: { model: 'openai/gpt-6.1-sol', agent: 'build', variant: 'low' },
    codeComplex: { model: 'opencode-go/kimi-k2.7-code', agent: 'specialist' },
  },
  policies: [
    { action: 'provider.use', effect: 'deny', resource: '*' },
    { action: 'provider.use', effect: 'allow', resource: 'opencode-go' },
    { action: 'provider.use', effect: 'allow', resource: 'openai' },
  ],
};
const FULL = {
  connected: ['opencode-go', 'openai'],
  models: [
    'opencode-go/mimo-v2.6-flash', 'opencode-go/qwen3.7-plus',
    'opencode-go/minimax-m3', 'opencode-go/minimax-m3.1-flash',
    'opencode-go/glm-5.3-flash', 'opencode-go/kimi-k2.7-code',
    'openai/gpt-6.1-sol',
  ],
  unavailable: [],
  exhausted: [],
};
const entry = (id, kind, weight, provider, model, outcome, tokens, fallback, agent) => ({
  id, kind, weight, provider, model, outcome, duration_ms: 1000, agent: agent || 'general',
  ...(tokens ? { tokens } : {}), ...(fallback !== undefined ? { fallback } : {}),
});
const tmpFile = (t) => {
  const f = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'br-')), 'work.jsonl');
  t.after(() => fs.rmSync(path.dirname(f), { recursive: true, force: true }));
  return f;
};

test('Go-only kinds route to opencode-go; analysis falls back to scan', () => {
  const r = chooseRoute('scan', 1, CFG, FULL, []);
  assert.equal(r.provider, 'opencode-go');
  assert.equal(r.nativeCommand, 'scan');
  assert.equal(r.reason, 'go-only');
  assert.equal(r.fallback, false);
  assert.equal(r.quotaUnknown, true);
  assert.equal(chooseRoute('analysis', 3, CFG, FULL, []).nativeCommand, 'analyze');
  const fb = chooseRoute('analysis', 3, CFG, { ...FULL, unavailable: ['opencode-go/qwen3.7-plus'] }, []);
  assert.equal(fb.nativeCommand, 'scan');
  assert.equal(fb.fallback, true);
  assert.equal(fb.reason, 'go-fallback');
  const blocked = chooseRoute('scan', 1, CFG, { ...FULL, connected: ['openai'] }, []);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'no-available-candidate');
});

test('high-risk kinds force OpenAI; blocked when unavailable', () => {
  for (const k of ['architecture', 'debug', 'security', 'review']) {
    const r = chooseRoute(k, 5, CFG, FULL, []);
    assert.equal(r.provider, 'openai', `${k} must be openai`);
    assert.equal(r.reason, 'high-risk-forces-openai');
    assert.equal(r.fallback, false);
  }
  assert.equal(chooseRoute('architecture', 5, CFG, { ...FULL, connected: ['opencode-go'] }, []).blocked, true);
  assert.equal(chooseRoute('debug', 3, CFG, { ...FULL, exhausted: ['openai'] }, []).blocked, true);
  assert.equal(chooseRoute('security', 5, CFG, FULL, []).nativeCommand, 'architect');
});

test('balanced kinds: coding ties to Go, deficit routes to OpenAI', () => {
  const r = chooseRoute('coding', 5, CFG, FULL, []);
  assert.equal(r.provider, 'opencode-go');
  assert.equal(r.nativeCommand, 'code');
  assert.equal(r.reason, 'balanced');
  const heavy = [
    entry('h1', 'scan', 5, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'passed'),
    entry('h2', 'scan', 5, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'passed'),
    entry('h3', 'scan', 5, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'passed'),
  ];
  const d = chooseRoute('coding', 3, CFG, FULL, heavy);
  assert.equal(d.provider, 'openai');
  assert.equal(d.nativeCommand, 'codeOpenai');
  assert.equal(d.fallback, false, 'ordinary balancing is not provider/model failure');
});

test('complex prefers Kimi specialist; visual uses GLM and falls back to M3', () => {
  assert.equal(chooseRoute('complex', 5, CFG, FULL, []).model, 'opencode-go/kimi-k2.7-code');
  const v = chooseRoute('visual', 1, CFG, FULL, []);
  assert.equal(v.model, 'opencode-go/glm-5.3-flash');
  assert.deepEqual(v.skills, ['frontend-design', 'accessibility', 'make-interfaces-feel-better']);
  assert.equal(v.fallback, false);
  const vf = chooseRoute('visual', 1, CFG, { ...FULL, unavailable: ['opencode-go/glm-5.3-flash'] }, []);
  assert.equal(vf.model, 'opencode-go/minimax-m3');
  assert.equal(vf.nativeCommand, 'visualFallback');
  assert.equal(vf.fallback, true);
  assert.equal(chooseRoute('scan', 1, CFG, FULL, []).skills, undefined);
});

test('small uses minimax-m3.1-flash, falls back to code M3', () => {
  assert.equal(chooseRoute('small', 1, CFG, FULL, []).model, 'opencode-go/minimax-m3.1-flash');
  assert.equal(chooseRoute('small', 1, CFG, FULL, []).nativeCommand, 'small');
  const fb = chooseRoute('small', 1, CFG, { ...FULL, unavailable: ['opencode-go/minimax-m3.1-flash'] }, []);
  assert.equal(fb.model, 'opencode-go/minimax-m3');
  assert.equal(fb.nativeCommand, 'code');
  assert.equal(fb.fallback, true);
});

test('missing config commands and forbidden providers are blocked fail-closed', () => {
  assert.equal(chooseRoute('coding', 5, { commands: {}, policies: CFG.policies }, FULL, []).blocked, true);
  const forbidden = {
    commands: { architect: { model: 'anthropic/claude-sonnet', agent: 'x' } },
    policies: CFG.policies,
  };
  const b = chooseRoute('architecture', 5, forbidden, { ...FULL, connected: ['opencode-go', 'openai', 'anthropic'] }, []);
  assert.equal(b.blocked, true);
  assert.equal(chooseRoute('deploy', 3, CFG, FULL, []).blocked, true);
  assert.equal(chooseRoute('coding', 7, CFG, FULL, []).blocked, true);
});

test('variant stripping: #variant in model matched against base availability', () => {
  const cfg = { commands: { architect: { model: 'openai/gpt-6.1-sol#medium', agent: 'x' } }, policies: CFG.policies };
  assert.equal(chooseRoute('architecture', 5, cfg, FULL, []).provider, 'openai');
});

test('unknown catalog and unavailable providers fail closed, including variant quota errors', () => {
  assert.equal(chooseRoute('scan', 1, CFG, { ...FULL, models: [] }, []).blocked, true);
  assert.equal(chooseRoute('scan', 1, CFG, { ...FULL, unavailable: ['opencode-go'] }, []).blocked, true);
  assert.equal(chooseRoute('visual', 1, CFG, {
    ...FULL, exhausted: ['opencode-go/glm-5.3-flash#low'],
  }, []).nativeCommand, 'visualFallback');
});

test('records cannot pretend to persist or contain prompt/credential fields', (t) => {
  const valid = entry('safe', 'coding', 3, 'opencode-go', 'opencode-go/minimax-m3', 'passed');
  assert.equal(appendRecord(null, valid).ok, false);
  assert.equal(appendRecord(tmpFile(t), { ...valid, prompt: 'fixture-sensitive-content' }).ok, false);
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ ...valid, weight: -3 }) + '\n');
  assert.throws(() => readLedger(file));
});

test('routing requires explicit provider policy and ledger rejects nested unknown fields', (t) => {
  assert.equal(chooseRoute('scan', 1, { ...CFG, policies: [] }, FULL, []).blocked, true);
  const valid = entry('nested', 'coding', 3, 'opencode-go', 'opencode-go/minimax-m3', 'passed');
  assert.equal(appendRecord(tmpFile(t), { ...valid, tokens: { secret: 'fixture-only' } }).ok, false);
  const data = metrics([{ ...valid, agent: '__proto__' }]);
  assert.equal(data.perAgent['__proto__'].jobs, 1);
});

test('weighted balance stays within ±5 over 40+ mixed jobs', (t) => {
  const f = tmpFile(t);
  let maxDeficit = 0;
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push({ kind: ['scan', 'analysis', 'visual'][i % 3], weight: 1 });
    jobs.push({ kind: i % 2 === 0 ? 'coding' : 'complex', weight: 3 });
  }
  assert.ok(jobs.length >= 40);
  for (let i = 0; i < jobs.length; i++) {
    const r = chooseRoute(jobs[i].kind, jobs[i].weight, CFG, FULL, readLedger(f));
    assert.ok(!r.blocked);
    appendRecord(f, entry(`j${i}`, jobs[i].kind, jobs[i].weight, r.provider, r.model, 'passed', null, r.fallback));
    const def = readLedger(f).reduce((a, e) => a + (e.outcome === 'passed' && e.provider === 'opencode-go' ? e.weight : 0), 0)
      - readLedger(f).reduce((a, e) => a + (e.outcome === 'passed' && e.provider === 'openai' ? e.weight : 0), 0);
    maxDeficit = Math.max(maxDeficit, Math.abs(def));
  }
  assert.ok(maxDeficit <= 5, `deficit ${maxDeficit} exceeded ±5`);
});

test('40 weighted jobs include mandatory high-risk work without trading safety for balance', () => {
  const work = [];
  const cycle = [['scan', 1], ['architecture', 5], ['coding', 3], ['visual', 1],
    ['small', 1], ['debug', 5], ['complex', 3], ['analysis', 1]];
  for (let repeat = 0; repeat < 5; repeat++) {
    for (const [kind, weight] of cycle) {
      const route = chooseRoute(kind, weight, CFG, FULL, work);
      assert.equal(route.blocked, undefined);
      if (['architecture', 'debug'].includes(kind)) assert.equal(route.provider, 'openai');
      work.push({ ...entry(`mixed-${work.length}`, kind, weight, route.provider, route.model, 'passed'),
        agent: route.agent });
    }
  }
  const report = metrics(work);
  assert.equal(report.totals.jobs, 40);
  assert.ok(Math.abs(report.perProvider.openai.weightedSharePct - 50) <= 5);
  console.log('SIMULATED_WEIGHTED_BALANCE', JSON.stringify({ jobs: work.length,
    openai: report.perProvider.openai.weightedSharePct,
    go: report.perProvider['opencode-go'].weightedSharePct, weight: report.totals.passedWeight }));
});

test('appendRecord: append valid, reject duplicate and invalid', (t) => {
  const f = tmpFile(t);
  assert.deepEqual(appendRecord(f, entry('a', 'scan', 1, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'passed')), { ok: true });
  assert.deepEqual(appendRecord(f, entry('a', 'scan', 1, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'passed')), { ok: false, error: 'duplicate-id' });
  assert.equal(appendRecord(f, entry('', 'scan', 1, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'passed')).error, 'missing-id');
  assert.equal(appendRecord(f, entry('b', 'bad', 1, 'opencode-go', 'opencode-go/m', 'passed')).error, 'invalid-kind');
  assert.equal(appendRecord(f, entry('b', 'scan', 7, 'opencode-go', 'opencode-go/m', 'passed')).error, 'invalid-weight');
  assert.equal(appendRecord(f, entry('b', 'scan', 1, 'evil', 'evil/x', 'passed')).error, 'invalid-provider');
  assert.equal(appendRecord(f, entry('b', 'scan', 1, 'opencode-go', 'openai/m', 'passed')).error, 'invalid-model');
  assert.equal(appendRecord(f, entry('b', 'scan', 1, 'opencode-go', 'opencode-go/m', 'passed', null, 'yes')).error, 'invalid-fallback');
  assert.equal(appendRecord(f, entry('b', 'scan', NaN, 'opencode-go', 'opencode-go/m', 'passed')).error, 'invalid-weight');
  assert.equal(appendRecord(f, entry('b', 'scan', 1, 'opencode-go', 'opencode-go/m', 'passed', { input: -1 })).error, 'invalid-tokens-input');
  assert.equal(readLedger(f).length, 1);
});

test('readLedger: ENOENT empty, throws on malformed', (t) => {
  assert.deepEqual(readLedger('/nope/x.jsonl'), []);
  const f = tmpFile(t);
  fs.writeFileSync(f, '{"id":"a","kind":"scan","weight":1,"provider":"opencode-go","model":"opencode-go/m","outcome":"passed","duration_ms":1}\nnot-json\n');
  assert.throws(() => readLedger(f));
});

test('ledger appends preserve a valid final record without a newline', (t) => {
  const file = tmpFile(t);
  const first = entry('first', 'coding', 3, 'opencode-go', 'opencode-go/minimax-m3', 'passed');
  fs.writeFileSync(file, JSON.stringify(first));
  assert.equal(appendRecord(file, { ...first, id: 'second' }).ok, true);
  assert.equal(readLedger(file).length, 2);
});

test('ledger rejects concurrent writer lock and symlink without altering records', (t) => {
  const file = tmpFile(t);
  const valid = entry('one', 'coding', 3, 'opencode-go', 'opencode-go/minimax-m3', 'passed');
  fs.writeFileSync(file + '.lock', 'fixture-owner');
  assert.equal(appendRecord(file, valid).error, 'locked');
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'fixture-owner');
  fs.unlinkSync(file + '.lock');
  const target = file + '.target';
  fs.writeFileSync(target, 'unchanged');
  fs.symlinkSync(target, file);
  assert.equal(appendRecord(file, valid).error, 'symlink-rejected');
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});

test('metrics: sum passed weights, count all, tokens null when missing', () => {
  const lg = [
    entry('m1', 'coding', 5, 'opencode-go', 'opencode-go/minimax-m3', 'passed', { input: 800, output: 400 }),
    entry('m2', 'architecture', 5, 'openai', 'openai/gpt-6.1-sol', 'passed', { input: 1200 }),
    entry('m3', 'scan', 1, 'opencode-go', 'opencode-go/mimo-v2.6-flash', 'failed'),
    entry('m4', 'coding', 5, 'opencode-go', 'opencode-go/minimax-m3', 'passed', null, true),
  ];
  const m = metrics(lg);
  assert.equal(m.totals.jobs, 4);
  assert.equal(m.totals.passed, 3);
  assert.equal(m.totals.passedWeight, 15);
  assert.equal(m.totals.fallback, 1);
  assert.ok(Math.abs(m.totals.completionPct - 75) < 0.01);
  assert.equal(m.totals.input, 2000);
  assert.equal(m.totals.output, 400);
  assert.equal(m.perProvider['opencode-go'].jobs, 3);
  assert.equal(m.perProvider['opencode-go'].passedWeight, 10);
  assert.equal(m.perProvider['openai'].passedWeight, 5);
  assert.equal(m.perModel['opencode-go/mimo-v2.6-flash'].input, null);
  assert.equal(m.perModel['opencode-go/minimax-m3'].fallback, 1);
});
