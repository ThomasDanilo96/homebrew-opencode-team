import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeGo, normalizeOpenAI, forecast, decideQuota, readQuotaState, updateQuotaState } from '../shared/best-quota.mjs';
import * as quota from '../shared/best-quota.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const iso = (at) => new Date(at).toISOString();
function go(used = 20, at = NOW, resets = {}) {
  return normalizeGo({ usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((key, i) =>
    [key, { percent: typeof used === 'number' ? used : used[key], resetsAt: iso(resets[key] ?? NOW + [4, 72, 240][i] * HOUR) }])) }, at);
}
function openai(used = 20, at = NOW, weekly = true) {
  return normalizeOpenAI({ rate_limit: {
    primary_window: { used_percent: typeof used === 'number' ? used : used.rolling, reset_at: (NOW + 4 * HOUR) / 1000, limit_window_seconds: 18000 },
    ...(weekly ? { secondary_window: { used_percent: typeof used === 'number' ? used : used.weekly, reset_at: (NOW + 72 * HOUR) / 1000, limit_window_seconds: 604800 } } : {}),
  } }, at);
}
const candidates = [
  { provider: 'opencode-go', model: 'opencode-go/qwen3.7-plus', agent: 'general' },
  { provider: 'openai', model: 'openai/gpt-6.1-sol', agent: 'specialist' },
];
const route = (history, extra = {}) => decideQuota({ kind: 'coding', candidates, forecast: forecast(history, NOW), now: NOW, ...extra });

test('Go normalization is strict, canonical and does not retain payload secrets', () => {
  const snapshot = go();
  assert.equal(snapshot.provider, 'opencode-go');
  assert.equal(snapshot.source, 'LIVE');
  assert.equal(snapshot.at, iso(NOW));
  assert.deepEqual(snapshot.windows.rolling, { used: 20, resetAt: iso(NOW + 4 * HOUR) });
  for (const bad of [null, {}, { usage: {} }]) assert.throws(() => normalizeGo(bad, NOW));
  for (const percent of [-1, 101, NaN, Infinity, '20', null]) {
    const payload = { usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map(k => [k, { percent, resetsAt: iso(NOW + HOUR) }])) };
    assert.throws(() => normalizeGo(payload, NOW));
  }
  for (const resetsAt of [0, null, 'tomorrow', '2026-11-05', '2026-02-30T12:00:00Z']) {
    assert.throws(() => normalizeGo({ usage: { rolling: { percent: 1, resetsAt }, weekly: {}, monthly: {} } }, NOW));
  }
});

test('66 percent monthly remainder projected to November 15 shifts compatible work off Go until November 30 renewal', () => {
  const renewal = Date.parse('2026-11-30T09:39:27+01:00');
  const exhaustion = Date.parse('2026-11-15T12:00:00Z');
  const rate = 66 / ((exhaustion - NOW) / HOUR);
  const older = go({ rolling: 20, weekly: 20, monthly: 34 - rate }, NOW - HOUR, { monthly: renewal });
  const latest = go({ rolling: 20, weekly: 20, monthly: 34 }, NOW, { monthly: renewal });
  const prediction = forecast([older, latest, openai()], NOW);
  const month = prediction.providers['opencode-go'].windows.monthly;
  assert.equal(month.remaining, 66);
  assert.equal(month.resetAt, '2026-11-30T08:39:27.000Z');
  assert.equal(month.state, 'CRITICAL');
  assert.ok(Math.abs(Date.parse(month.exhaustsAt) - exhaustion) <= 1);
  assert.equal(decideQuota({ kind: 'coding', candidates, forecast: prediction, now: NOW }).candidate.provider, 'openai');
});

test('OpenAI uses actual durations, includes other constraints, never invents a week', () => {
  assert.deepEqual(Object.keys(openai(20, NOW, false).windows), ['rolling']);
  const incomplete = forecast([openai(20, NOW, false)], NOW).providers.openai;
  assert.equal(incomplete.state, 'UNKNOWN');
  assert.ok(incomplete.anomalies.includes('missing-weekly-window'));
  assert.equal(route([openai(20, NOW, false)], { kind: 'complex' }).blocked, true);
  const payload = { rate_limit: {
    primary_window: { used_percent: 98, reset_at: (NOW + HOUR) / 1000, limit_window_seconds: 86400 },
    secondary_window: { used_percent: 10, reset_at: (NOW + 72 * HOUR) / 1000, limit_window_seconds: 604800 },
  } };
  const snapshot = normalizeOpenAI(payload, NOW);
  assert.equal(snapshot.windows.primary_window.used, 98);
  assert.equal(snapshot.windows.weekly.used, 10);
  assert.equal(forecast([snapshot], NOW).providers.openai.state, 'CRITICAL');
  for (const value of ['98', -1, 101]) {
    assert.throws(() => normalizeOpenAI({ rate_limit: { primary_window: { ...payload.rate_limit.primary_window, used_percent: value } } }, NOW));
  }
  for (const value of [null, {}, { rate_limit: {} }, { rate_limit: { primary_window: { used_percent: 1, reset_at: '123', limit_window_seconds: 18000 } } }]) {
    assert.throws(() => normalizeOpenAI(value, NOW));
  }
});

test('explicit OpenAI limit flags constrain admission even below 100 percent', () => {
  for (const flag of [{ allowed: false }, { limit_reached: true }]) {
    const snapshot = normalizeOpenAI({ rate_limit: { ...flag,
      primary_window: { used_percent: 10, reset_at: (NOW + HOUR) / 1000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 10, reset_at: (NOW + 72 * HOUR) / 1000, limit_window_seconds: 604800 },
    } }, NOW);
    assert.equal(forecast([snapshot], NOW).providers.openai.state, 'EXHAUSTED');
    assert.equal(route([go(), snapshot], { kind: 'complex' }).blocked, true);
  }
});

test('additional wham limits have stable identities and all constrain admission', () => {
  const window = (used, seconds) => ({ used_percent: used, reset_at: (NOW + HOUR) / 1000, limit_window_seconds: seconds });
  const payload = { rate_limit: { primary_window: window(10, 18000), secondary_window: window(10, 604800) }, additional_rate_limits: [
    { limit_name: 'GPT-6 quota', metered_feature: 'gpt-6', rate_limit: { primary_window: window(98, 3600) } },
    { limit_name: 'Other quota', metered_feature: 'other', rate_limit: { primary_window: window(20, 7200) } },
  ] };
  const snapshot = normalizeOpenAI(payload, NOW);
  const reversed = normalizeOpenAI({ ...payload, additional_rate_limits: [...payload.additional_rate_limits].reverse() }, NOW);
  assert.deepEqual(snapshot.windows, reversed.windows);
  const extra = Object.entries(snapshot.windows).filter(([name]) => !['rolling', 'weekly'].includes(name));
  assert.equal(extra.length, 2);
  assert.deepEqual(extra.map(([, value]) => value.limitWindowSeconds).sort((a, b) => a - b), [3600, 7200]);
  const predicted = forecast([snapshot], NOW).providers.openai;
  assert.equal(predicted.state, 'CRITICAL');
  for (const [name, value] of extra) assert.equal(predicted.windows[name].limitWindowSeconds, value.limitWindowSeconds);
  // A critical-but-funded WHAM limit keeps admitting; regulation, not prohibition.
  assert.equal(route([snapshot], { kind: 'complex' }).blocked, false);
  // Any single limit reaching 100 percent stops the provider, whatever the
  // other windows' headroom is.
  const exhausted = normalizeOpenAI({ ...payload, additional_rate_limits: [
    { limit_name: 'GPT-6 quota', metered_feature: 'gpt-6', rate_limit: { primary_window: window(100, 3600) } },
    payload.additional_rate_limits[1],
  ] }, NOW);
  assert.equal(route([exhausted], { kind: 'complex' }).blocked, true);
  for (const additional_rate_limits of [{}, [null], [{ limit_name: 'broken', rate_limit: {} }], [payload.additional_rate_limits[0], payload.additional_rate_limits[0]]]) {
    assert.throws(() => normalizeOpenAI({ ...payload, additional_rate_limits }, NOW));
  }
  const denied = normalizeOpenAI({ ...payload, additional_rate_limits: [
    { limit_name: 'Denied', rate_limit: { allowed: false, primary_window: window(10, 3600) } },
  ] }, NOW);
  assert.equal(forecast([denied], NOW).providers.openai.state, 'EXHAUSTED');
});

test('manual snapshots remain explicitly manual, usable while fresh, and expire normally', async (t) => {
  const manual = { ...go(), source: 'MANUAL' };
  const f = forecast([manual], NOW);
  assert.equal(f.providers['opencode-go'].source, 'MANUAL');
  assert.equal(f.providers['opencode-go'].windows.rolling.source, 'MANUAL');
  assert.equal(f.providers['opencode-go'].freshness, 'FRESH');
  assert.equal(route([manual]).blocked, false);
  assert.equal(forecast([manual], NOW + HOUR).providers['opencode-go'].state, 'UNKNOWN');
  const { file } = fixture(t);
  const current = { ...go(20, Date.now()), source: 'MANUAL' };
  await updateQuotaState(file, state => {
    state.snapshots.push(current);
    state.sources['opencode-go'] = { status: 'MANUAL', at: current.at };
    return state;
  });
  const state = await readQuotaState(file);
  assert.equal(state.snapshots[0].source, 'MANUAL');
  assert.equal(state.sources['opencode-go'].status, 'MANUAL');
});

test('connection fingerprints bind forecasts and persistence without crossing account rate histories', async (t) => {
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  const previous = { ...go(10, NOW - HOUR), connection: first };
  const latest = { ...go(30), connection: second };
  const provider = forecast([previous, latest], NOW).providers['opencode-go'];
  assert.equal(provider.connection, second);
  assert.equal(provider.windows.rolling.observedPerHour, null);
  assert.equal(forecast([{ ...previous, connection: second }, latest], NOW).providers['opencode-go'].windows.rolling.observedPerHour, 20);
  const { file } = fixture(t);
  const snapshot = { ...go(20, Date.now()), connection: first };
  await updateQuotaState(file, state => {
    state.snapshots.push(snapshot);
    state.sources['opencode-go'] = { status: 'LIVE', connection: first };
    return state;
  });
  const saved = await readQuotaState(file);
  assert.equal(saved.snapshots[0].connection, first);
  assert.equal(saved.sources['opencode-go'].connection, first);
  for (const connection of ['', 'a'.repeat(63), 'g'.repeat(64), 123, null]) {
    await assert.rejects(updateQuotaState(file, state => { state.snapshots.push({ ...snapshot, connection }); return state; }), /connection/);
    await assert.rejects(updateQuotaState(file, state => { state.sources['opencode-go'].connection = connection; return state; }), /connection/);
  }
  assert.deepEqual(await readQuotaState(file), saved);
});

test('each of three Go constraints and the OpenAI week can independently constrain routing', () => {
  for (const name of ['rolling', 'weekly', 'monthly']) {
    const constrained = go({ rolling: 10, weekly: 10, monthly: 10, [name]: 98 });
    const f = forecast([constrained, openai()], NOW);
    assert.equal(f.providers['opencode-go'].state, 'CRITICAL');
    assert.equal(f.providers['opencode-go'].limitingWindow, name);
    assert.equal(route([constrained, openai()]).candidate.provider, 'openai');
  }
  assert.equal(route([go(), openai({ rolling: 10, weekly: 99 })]).candidate.provider, 'opencode-go');
  // Critical windows on both providers still admit funded work; only an
  // exhausted window removes its provider from routing.
  assert.equal(route([go(98), openai({ rolling: 10, weekly: 99 })]).blocked, false);
  assert.equal(route([go(), openai({ rolling: 10, weekly: 100 })]).candidate.provider, 'opencode-go');
  assert.equal(forecast([go(100)], NOW).providers['opencode-go'].state, 'EXHAUSTED');
});

test('four independent resets expire only their actual windows, never replenish by assumption', () => {
  const history = [go(20, NOW, { rolling: NOW + HOUR, weekly: NOW + 2 * HOUR, monthly: NOW + 4 * HOUR }), openai()];
  for (const [key, offset] of [['rolling', 1], ['weekly', 2], ['monthly', 4]]) {
    const f = forecast(history, NOW + offset * HOUR, { staleAfterMs: 10 * HOUR });
    assert.equal(f.providers['opencode-go'].windows[key].state, 'UNKNOWN');
    assert.ok(f.providers['opencode-go'].windows[key].anomalies.includes('reset-expired'));
  }
  assert.equal(forecast(history, NOW + 72 * HOUR, { staleAfterMs: 100 * HOUR }).providers.openai.windows.weekly.state, 'UNKNOWN');
});

test('stale, future, unknown and invalid samples fail closed without destroying a valid observation', () => {
  assert.equal(route([]).blocked, true);
  assert.equal(forecast([go(10, NOW - HOUR)], NOW).providers['opencode-go'].state, 'UNKNOWN');
  assert.equal(forecast([go(10, NOW + HOUR)], NOW).providers['opencode-go'].state, 'UNKNOWN');
  const valid = go();
  const f = forecast([valid, { provider: 'opencode-go', at: iso(NOW + 1), windows: {}, source: 'ERROR' }], NOW);
  assert.equal(f.providers['opencode-go'].windows.weekly.used, 20);
  assert.equal(f.providers['opencode-go'].state, 'NORMAL');
  assert.ok(f.providers['opencode-go'].anomalies.includes('invalid-snapshot'));
});

test('same-cycle rates expose sustainable budgets, spikes and independent reset boundaries', () => {
  const previous = go(10, NOW - HOUR);
  const current = go(30);
  const f = forecast([previous, current], NOW);
  const window = f.providers['opencode-go'].windows.rolling;
  assert.equal(window.observedPerHour, 20);
  assert.equal(window.remaining, 70);
  assert.equal(window.timeRemainingMs, 4 * HOUR);
  // 15% safety margin: usable = 100 - 30 used - 15 margin = 55 over 4h.
  assert.equal(window.sustainablePerHour, 55 / 4);
  assert.equal(window.sustainablePerDay, 55 * 6);
  assert.equal(window.exhaustsAt, iso(NOW + 70 / 20 * HOUR));
  assert.equal(window.state, 'CRITICAL');
  // Pacing pressure ranks providers; it does not stop work that still fits
  // the real remaining budget.
  assert.equal(route([previous, current, openai(10, NOW - HOUR), openai(30)]).blocked, false);
  const reset = go(5, NOW, { rolling: NOW + 5 * HOUR });
  assert.equal(forecast([previous, reset], NOW).providers['opencode-go'].windows.rolling.observedPerHour, null);
  const custom = forecast([go(90)], NOW, { safetyMarginPercent: 15 });
  assert.equal(custom.providers['opencode-go'].state, 'CRITICAL');
});

test('rolling smoothing retains bursts despite releases and is deterministic in input order', () => {
  const history = [go(5, NOW - HOUR), go(35, NOW - HOUR / 2), go(30)];
  const f = forecast(history, NOW);
  assert.ok(f.providers['opencode-go'].windows.rolling.observedPerHour > 0);
  assert.ok(f.providers['opencode-go'].windows.rolling.anomalies.includes('rolling-release'));
  assert.deepEqual(forecast([...history].reverse(), NOW), f);
  const fixedDrop = forecast([go(40, NOW - HOUR), go(10)], NOW);
  assert.equal(fixedDrop.providers['opencode-go'].windows.weekly.state, 'UNKNOWN');
});

test('routing considers sustainable pace, not only nominal remaining percentage', () => {
  // Previous rolling 5 → observed 15/h, which sits inside (13, 16.25] with the
  // 15% margin: CAUTION on pace while nominal remaining is still 80%.
  const history = [go({ rolling: 5, weekly: 20, monthly: 20 }, NOW - HOUR), go(20), openai(30)];
  assert.equal(forecast(history, NOW).providers['opencode-go'].state, 'CAUTION');
  assert.equal(route(history).candidate.provider, 'openai');
});

test('high-risk work stays OpenAI, visual stays Go GLM, paid fallbacks are impossible', () => {
  for (const kind of ['architecture', 'debug', 'security', 'review', 'complex']) {
    assert.equal(route([go(), openai()], { kind }).candidate.provider, 'openai');
    assert.equal(route([go(), openai(100)], { kind }).blocked, true);
  }
  const visual = { provider: 'opencode-go', model: 'opencode-go/glm-5.3-flash', agent: 'visual-designer' };
  assert.equal(route([go(), openai()], { kind: 'visual', candidates: [...candidates, visual] }).candidate.model, visual.model);
  assert.equal(route([go(100), openai()], { kind: 'visual', candidates: [...candidates, visual] }).blocked, true);
  assert.equal(route([go(), openai()], { kind: 'visual' }).blocked, true);
  for (const candidate of [{ provider: 'anthropic', model: 'anthropic/paid' }, { provider: 'openai', model: 'anthropic/paid' }, { ...candidates[1], paid: true }]) {
    assert.equal(route([go(), openai()], { candidates: [candidate] }).blocked, true);
  }
  assert.equal(route([go(), openai()], { kind: 'visual', candidates: [{ ...visual, model: 'opencode-go/glm-4.7' }] }).blocked, true);
});

test('hysteresis respects cooldown but never keeps an exhausted provider', () => {
  const previous = { candidate: candidates[0], at: iso(NOW - 1000), switchedAt: iso(NOW - 1000) };
  assert.equal(route([go(40), openai(10)], { previous }).candidate.provider, 'opencode-go');
  assert.equal(route([go(40), openai(10)], { previous, options: { cooldownMs: 0 } }).candidate.provider, 'openai');
  // The incumbent is only kept while it remains admissible: an exhausted
  // provider drops out of the candidate set entirely.
  assert.equal(route([go(100), openai(10)], { previous }).candidate.provider, 'openai');
  const old = { ...previous, switchedAt: iso(NOW - HOUR) };
  assert.equal(route([go(22), openai(20)], { previous: old }).candidate.provider, 'opencode-go');
  assert.equal(route([go(), openai()], { kind: 'nonexistent' }).blocked, true);
});

test('explicit task estimates must fit every residual budget', () => {
  assert.equal(route([go(), openai()]).estimatedTaskPercent, null);
  const options = { expectedPercentByKind: { coding: { 'opencode-go': 76, openai: 10 } } };
  const selected = route([go(), openai()], { options });
  // Both budgets fit their estimates; the stable tie keeps the first candidate.
  assert.equal(selected.candidate.provider, 'opencode-go');
  assert.equal(selected.estimatedTaskPercent, 76);
  // Estimates gate admission against the real remaining budget, without the
  // routing-only safety margin: 76 fits an 80 percent residual on both.
  assert.equal(route([go(), openai()], { options: { expectedPercentByKind: { coding: { 'opencode-go': 76, openai: 76 } } } }).blocked, false);
  // An estimate above every provider's real residual budget blocks instead of
  // spending past 0 percent.
  assert.equal(route([go(), openai()], { options: { expectedPercentByKind: { coding: { 'opencode-go': 90, openai: 90 } } } }).blocked, true);
  // With an 80 percent residual both 65 and 66 fit; the first candidate wins
  // the exact tie.
  assert.equal(route([go(), openai()], { options: { expectedPercentByKind: { coding: { 'opencode-go': 65, openai: 66 } } } }).candidate.provider, 'opencode-go');
  // Monthly residual 74 >= 70 and OpenAI 80 >= 76: both fit, so routing continues.
  assert.equal(route([go({ rolling: 20, weekly: 20, monthly: 26 }), openai()], {
    options: { expectedPercentByKind: { coding: { 'opencode-go': 70, openai: 76 } } },
  }).blocked, false);
  for (const expectedPercentByKind of [null, [], { coding: 20 }, { unknown: { openai: 20 } }, { coding: { paid: 2 } },
    ...[-1, 101, NaN, '10', null].map(value => ({ coding: { openai: value } }))]) {
    assert.throws(() => route([go(), openai()], { options: { expectedPercentByKind } }), /estimate|expectedPercent/);
  }
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'private', 'quota.json') };
}

test('atomic persistence is private, restart-safe and strips non-quota secrets', async (t) => {
  const { file } = fixture(t);
  assert.deepEqual(await readQuotaState(file), { version: 1, snapshots: [], sources: {}, decisions: [], usage: [] });
  const snapshot = go(20, Date.now());
  await updateQuotaState(file, state => {
    state.snapshots.push({ ...snapshot, prompt: 'secret' });
    state.sources['opencode-go'] = { status: 'ERROR', at: iso(Date.now()), error: 'OFFLINE', token: 'secret', headers: { authorization: 'secret' } };
    state.decisions.push({ at: iso(Date.now()), kind: 'coding', blocked: false, reason: 'quota-headroom', candidate: { ...candidates[0], prompt: 'secret' }, prompt: 'secret' });
    state.usage.push({ at: iso(Date.now()), provider: 'opencode-go', durationMs: 12, tokens: 'secret', prompt: 'secret' });
    state.credentials = 'secret';
    return state;
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
  const persisted = await readQuotaState(file);
  assert.equal(persisted.snapshots.length, 1);
  assert.equal(persisted.sources['opencode-go'].status, 'ERROR');
  const moduleUrl = new URL('../shared/best-quota.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {readQuotaState} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await readQuotaState(process.argv[1])));`, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), persisted);
});

test('concurrent updates do not lose records and failures leave the old state valid', async (t) => {
  const { file } = fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => updateQuotaState(file, state => {
    state.usage.push({ at: iso(Date.now()), provider: 'openai', durationMs: i });
    return state;
  })));
  const before = await readQuotaState(file);
  assert.equal(before.usage.length, 20);
  await assert.rejects(updateQuotaState(file, () => { throw new Error('callback-failed'); }), /callback-failed/);
  await assert.rejects(updateQuotaState(file, async state => state), /synchronous/);
  assert.deepEqual(await readQuotaState(file), before);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.writeFileSync(`${file}.lock`, '', { mode: 0o600 });
  await assert.rejects(updateQuotaState(file, state => state, { lockTimeoutMs: 20, retryMs: 5 }), /locked/);
  assert.equal(fs.existsSync(`${file}.lock`), true);
});

test('independent processes serialize updates through the same lock', async (t) => {
  const { file } = fixture(t);
  await updateQuotaState(file, state => state);
  const moduleUrl = new URL('../shared/best-quota.mjs', import.meta.url).href;
  const script = `import {updateQuotaState} from ${JSON.stringify(moduleUrl)};
    for (let i = 0; i < 8; i++) await updateQuotaState(process.argv[1], state => {
      const end = performance.now() + 2;
      while (performance.now() < end) {} // Hold the lock long enough to exercise contention.
      state.usage.push({at:new Date().toISOString(),provider:'openai',durationMs:i});
      return state;
    });`;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal((await readQuotaState(file)).usage.length, 48);
});

test('existing non-private state directories are rejected without changing permissions', async (t) => {
  const { dir } = fixture(t);
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir, { mode: 0o755 });
  fs.chmodSync(publicDir, 0o755);
  await assert.rejects(updateQuotaState(path.join(publicDir, 'quota.json'), state => state), /private|unsafe/);
  assert.equal(fs.statSync(publicDir).mode & 0o777, 0o755);
});

test('decision results can be persisted directly and retain cooldown after restart', async (t) => {
  const { file } = fixture(t);
  const now = Date.now();
  const snapshots = [go(20, now), openai(20, now)];
  const decision = decideQuota({ kind: 'coding', candidates, forecast: forecast(snapshots, now), now });
  await updateQuotaState(file, state => { state.decisions.push(decision); return state; });
  assert.deepEqual((await readQuotaState(file)).decisions[0], decision);
  const blocked = decideQuota({ kind: 'coding', candidates, forecast: forecast([], now), now });
  await updateQuotaState(file, state => { state.decisions.push(blocked); return state; });
  assert.deepEqual((await readQuotaState(file)).decisions[1], blocked);
});

test('decision scopes and existing enforcement flags survive independent persistence', async (t) => {
  const { file } = fixture(t);
  const at = iso(Date.now());
  const decisions = ['routing', 'admission'].map((scope, i) => ({ at, kind: 'coding', blocked: false, scope, enforced: i === 1 }));
  await updateQuotaState(file, state => { state.decisions.push(...decisions); return state; });
  assert.deepEqual((await readQuotaState(file)).decisions, decisions);
  for (const scope of ['unknown', null, 123]) {
    await assert.rejects(updateQuotaState(file, state => { state.decisions.push({ ...decisions[0], scope }); return state; }), /scope/);
  }
  assert.deepEqual((await readQuotaState(file)).decisions, decisions);
});

test('leases retain bounded quota metadata until verified completion, not merely expiry', async (t) => {
  const { file } = fixture(t);
  assert.equal((await readQuotaState(file)).leases, undefined);
  const active = { id: 'test-lease-1', provider: 'openai', expiresAt: iso(Date.now() + HOUR) };
  await updateQuotaState(file, state => {
    state.leases = [{ ...active, prompt: 'secret', sessionID: 'ses-lifetime-1', token: 'secret' }, { ...active, id: 'expired', expiresAt: iso(Date.now() - 1) }];
    return state;
  });
  assert.equal((await readQuotaState(file)).leases.length, 2);
  // sessionID is bounded lease metadata now (admission release), but free-form
  // prompt/token content must never persist.
  assert.deepEqual((await readQuotaState(file)).leases[0], { ...active, sessionID: 'ses-lifetime-1' });
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
  for (const lease of [{ ...active, id: 'a'.repeat(81) }, { ...active, id: '../unsafe' }, { ...active, provider: 'paid' }, { ...active, expiresAt: 'bad' }]) {
    await assert.rejects(updateQuotaState(file, state => { state.leases.push(lease); return state; }));
  }
  await updateQuotaState(file, state => {
    state.leases = Array.from({ length: 1000 }, (_, i) => ({ ...active, id: `lease-${i}` }));
    return state;
  });
  assert.equal((await readQuotaState(file)).leases.length, 1000);
  await assert.rejects(updateQuotaState(file, state => { state.leases.push({ ...active, id: 'overflow' }); return state; }), /leases/);
  assert.equal((await readQuotaState(file)).leases.length, 1000);
  const expiredState = await readQuotaState(file);
  expiredState.leases = [{ ...active, expiresAt: iso(Date.now() - 1) }];
  fs.writeFileSync(file, JSON.stringify(expiredState));
  assert.deepEqual((await readQuotaState(file)).leases, expiredState.leases);
});

test('policy, runtime verification, estimates and numeric usage aggregates survive persistence without secrets', async (t) => {
  const { file } = fixture(t);
  const now = Date.now();
  const policy = { mode: 'monitor', safetyMarginPercent: 8, staleAfterMs: 10000, smoothingMs: HOUR, cooldownMs: 500, hysteresisPercent: 3 };
  const runtime = { version: '2.0.32', loadedAt: iso(now), hookVerified: false };
  const usage = { at: iso(now), provider: 'openai', input: 10, output: 20, cacheRead: 3, cacheWrite: 0, requests: 2, retries: 1 };
  const decision = { ...route([go(50), openai()], { options: { expectedPercentByKind: { coding: { 'opencode-go': 76, openai: 10 } } } }), at: iso(now) };
  assert.equal(decision.estimatedTaskPercent, 10);
  await updateQuotaState(file, state => {
    state.policy = { ...policy, token: 'secret' };
    state.runtime = { ...runtime, token: 'secret' };
    state.usage.push({ ...usage, prompt: 'secret', token: 'secret' });
    state.decisions.push(decision);
    return state;
  });
  const saved = await readQuotaState(file);
  assert.deepEqual(saved.policy, policy);
  assert.deepEqual(saved.runtime, runtime);
  assert.deepEqual(saved.usage[0], usage);
  assert.deepEqual(saved.decisions[0], decision);
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
  for (const mode of ['active', 'disabled']) {
    await updateQuotaState(file, state => { state.policy = { mode }; return state; });
    assert.deepEqual((await readQuotaState(file)).policy, { mode });
  }
  await updateQuotaState(file, state => { state.runtime = { ...runtime, hookVerified: true, verifiedAt: iso(now) }; return state; });
  assert.equal((await readQuotaState(file)).runtime.verifiedAt, iso(now));
  const before = await readQuotaState(file);
  for (const policy of [{ mode: 'invalid' }, { mode: 'active', safetyMarginPercent: 100 }, { mode: 'active', smoothingMs: 0 }]) {
    await assert.rejects(updateQuotaState(file, state => { state.policy = policy; return state; }));
  }
  for (const runtime of [{ version: 'x', loadedAt: 'bad', hookVerified: false }, { version: 'x', loadedAt: iso(now), hookVerified: 'yes' }]) {
    await assert.rejects(updateQuotaState(file, state => { state.runtime = runtime; return state; }));
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests', 'retries']) {
    for (const value of [-1, Infinity, '1']) {
      await assert.rejects(updateQuotaState(file, state => { state.usage.push({ ...usage, [key]: value }); return state; }));
    }
  }
  assert.deepEqual(await readQuotaState(file), before);
});

test('symlink files, symlink ancestors, hardlinks and corrupt state fail closed', async (t) => {
  const { dir, file } = fixture(t);
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  const link = path.join(dir, 'linked');
  fs.symlinkSync(target, link);
  await assert.rejects(updateQuotaState(path.join(link, 'state.json'), state => state), /unsafe|symlink/);
  await assert.rejects(Promise.resolve().then(() => readQuotaState(path.join(link, 'state.json'))), /unsafe|symlink/);
  await updateQuotaState(file, state => state);
  const linkedFile = path.join(dir, 'link.json');
  fs.symlinkSync(file, linkedFile);
  await assert.rejects(updateQuotaState(linkedFile, state => state), /unsafe|symlink/);
  const hardlink = path.join(dir, 'hard.json');
  fs.linkSync(file, hardlink);
  await assert.rejects(updateQuotaState(file, state => state), /unsafe|hardlink/);
  fs.unlinkSync(hardlink);
  fs.writeFileSync(file, '{broken');
  await assert.rejects(updateQuotaState(file, state => state), /JSON|state/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('history retention is bounded to 35 days and a fixed maximum', async (t) => {
  const { file } = fixture(t);
  await updateQuotaState(file, state => {
    state.snapshots.push(go(20, Date.now() - 36 * 24 * HOUR));
    for (let i = 0; i < 5000; i++) state.usage.push({ at: iso(Date.now()), provider: 'openai', durationMs: i });
    return state;
  });
  const state = await readQuotaState(file);
  assert.equal(state.snapshots.length, 0);
  assert.ok(state.usage.length > 0 && state.usage.length <= 4096);
});

const CLASS_MODELS = {
  'discovery-mimo': ['opencode-go', 'opencode-go/mimo-v2.5'],
  'coding-qwen': ['opencode-go', 'opencode-go/qwen3.7-plus'],
  'visual-glm': ['opencode-go', 'opencode-go/glm-5.3-flash'],
  'coordination-sol-low': ['openai', 'openai/gpt-6.1-sol', 'low'],
  'analysis-review-sol-medium': ['openai', 'openai/gpt-6.1-sol', 'medium'],
};
function activity(activityClass, extra = {}) {
  const [provider, model, variant] = CLASS_MODELS[activityClass];
  return { at: iso(NOW - HOUR / 8), provider, model, requests: 1, ...(variant ? { variant } : {}), ...extra };
}
const calibrationState = (snapshots, usage, policy) => ({ snapshots, usage, ...(policy ? { policy } : {}) });

test('calibration distinguishes Sol variants, never deriving missing variants from coding kind', () => {
  const snapshots = [openai(10, NOW - HOUR / 4), openai(12)];
  const usage = [activity('coordination-sol-low'), activity('analysis-review-sol-medium'),
    activity('coordination-sol-low', { variant: undefined, kind: 'coding' })];
  const state = calibrationState(snapshots, usage);
  const report = quota.calibrateQuota(state, NOW);
  assert.equal(report.source, 'ESTIMATE');
  assert.equal(report.at, iso(NOW));
  for (const name of ['coordination-sol-low', 'analysis-review-sol-medium']) {
    assert.equal(report.classes[name].observations, 1);
    assert.equal(report.classes[name].windows.rolling.observedPercent, 2);
  }
  assert.equal(report.usage.unclassified, 1);
  const legacy = quota.calibrateQuota(calibrationState(snapshots, [usage[2]]), NOW);
  assert.equal(legacy.classes['coordination-sol-low'].state, 'UNKNOWN');
  assert.equal(legacy.classes['analysis-review-sol-medium'].state, 'UNKNOWN');
  assert.deepEqual(quota.calibrateQuota(calibrationState([...snapshots].reverse(), [...usage].reverse()), NOW), report);
});

test('concurrent classes each receive the entire window envelope without token/request weights', () => {
  const state = calibrationState([go(10, NOW - HOUR / 4), go({ rolling: 14, weekly: 12, monthly: 11 })],
    [activity('discovery-mimo', { input: 1000000, requests: 50 }), activity('coding-qwen', { input: 1 }), activity('visual-glm')]);
  const before = structuredClone(state);
  const report = quota.calibrateQuota(state, NOW);
  for (const name of ['discovery-mimo', 'coding-qwen', 'visual-glm']) {
    const entry = report.classes[name];
    assert.equal(entry.attribution, 'CONSERVATIVE_SHARED');
    assert.ok(entry.uncertainty.includes('external-usage-not-excludable'));
    assert.equal(entry.windows.rolling.observedPercent, 4);
    assert.equal(entry.windows.rolling.observedPerHour, 16);
    assert.equal(entry.windows.weekly.observedPerHour, 8);
    assert.equal(entry.windows.monthly.observedPerHour, 4);
    assert.equal(entry.windows.rolling.intervalMs, HOUR / 4);
  }
  assert.deepEqual(state, before);
  assert.equal(report.taskLength, 'UNKNOWN');
});

test('unseen and incompatible classes stay UNKNOWN even with large account consumption', () => {
  const report = quota.calibrateQuota(calibrationState([go(10, NOW - HOUR / 4), go(90)], [
    activity('coding-qwen', { activityClass: 'coordination-sol-low' }),
    activity('coordination-sol-low', { model: 'openai/other' }),
  ]), NOW);
  for (const entry of Object.values(report.classes)) {
    assert.equal(entry.state, 'UNKNOWN');
    assert.equal(entry.observations, 0);
  }
  assert.equal(quota.estimateQuotaCost(report, 'coding-qwen', HOUR).state, 'UNKNOWN');
});

test('integer and fractional zero deltas retain a one-point uncertainty per endpoint', () => {
  for (const used of [10, 10.25]) {
    const report = quota.calibrateQuota(calibrationState([go(used, NOW - HOUR / 4), go(used)], [activity('coding-qwen')]), NOW);
    const window = report.classes['coding-qwen'].windows.rolling;
    assert.equal(window.observedPerHour, 0);
    assert.equal(window.quantizationBoundPercent, 2);
    assert.equal(window.conservativePerHour, 8);
    assert.ok(report.classes['coding-qwen'].uncertainty.includes('one-percent-point-per-snapshot-including-fractional'));
  }
});

test('reset and decreasing windows are excluded independently rather than cancelling positive windows', () => {
  const previous = go({ rolling: 80, weekly: 30, monthly: 20 }, NOW - HOUR / 4);
  const latest = go({ rolling: 5, weekly: 29, monthly: 23 }, NOW, { rolling: NOW + 5 * HOUR });
  const report = quota.calibrateQuota(calibrationState([previous, latest], [activity('coding-qwen')]), NOW);
  const windows = report.classes['coding-qwen'].windows;
  assert.equal(windows.rolling.state, 'UNKNOWN');
  assert.equal(windows.weekly.state, 'UNKNOWN');
  assert.equal(windows.monthly.observedPercent, 3);
  assert.equal(report.excluded.resetChanges, 1);
  assert.equal(report.excluded.decreases, 1);
  assert.ok(report.anomalies.includes('unexpected-decrease'));
  assert.equal(quota.estimateQuotaCost(report, 'coding-qwen', HOUR).state, 'UNKNOWN');
});

test('calibration does not bridge observation gaps, connection changes or duplicate times', () => {
  const usage = [activity('coding-qwen')];
  const gap = quota.calibrateQuota(calibrationState([go(10, NOW - HOUR), go(20)], usage), NOW);
  assert.equal(gap.gaps.count, 1);
  assert.equal(gap.gaps.intervalMs, HOUR);
  assert.equal(gap.classes['coding-qwen'].state, 'UNKNOWN');
  const connection = quota.calibrateQuota(calibrationState([
    { ...go(10, NOW - HOUR / 4), connection: 'a'.repeat(64) }, { ...go(20), connection: 'b'.repeat(64) },
  ], usage), NOW);
  assert.equal(connection.excluded.connectionChanges, 1);
  assert.equal(connection.classes['coding-qwen'].observations, 0);
  const duplicate = quota.calibrateQuota(calibrationState([go(10), go(20)], usage), NOW);
  assert.equal(duplicate.excluded.nonPositiveIntervals, 1);
  assert.equal(duplicate.classes['coding-qwen'].state, 'UNKNOWN');
});

test('rolling calibration respects policy lookback, freshness, required windows and LIVE-only samples', () => {
  const pair = [go(10, NOW - HOUR / 4), go(20)];
  for (const snapshots of [[{ ...pair[0], source: 'MANUAL' }, pair[1]],
    pair.map(value => ({ ...value, source: 'MANUAL' })), [], [pair[0], { ...pair[1], at: iso(NOW + 1) }]]) {
    const report = quota.calibrateQuota(calibrationState(snapshots, [activity('coding-qwen')]), NOW);
    assert.equal(report.classes['coding-qwen'].state, 'UNKNOWN');
  }
  const stale = quota.calibrateQuota(calibrationState(pair, [activity('coding-qwen')]), NOW + HOUR);
  assert.equal(stale.classes['coding-qwen'].state, 'UNKNOWN');
  const short = quota.calibrateQuota(calibrationState(pair, [activity('coding-qwen')], { smoothingMs: HOUR / 8 }), NOW);
  assert.equal(short.classes['coding-qwen'].state, 'UNKNOWN');
  const old = [go(10, NOW - 7 * HOUR), go(20, NOW - 6.5 * HOUR)];
  const excluded = quota.calibrateQuota(calibrationState(old, [activity('coding-qwen', { at: iso(NOW - 6.75 * HOUR) })], { staleAfterMs: 8 * HOUR }), NOW);
  assert.equal(excluded.classes['coding-qwen'].observations, 0);
  assert.equal(excluded.excluded.outsideLookback, 2);
  const missing = quota.calibrateQuota(calibrationState([openai(10, NOW - HOUR / 4, false), openai(20, NOW, false)], [activity('coordination-sol-low')]), NOW);
  assert.equal(missing.classes['coordination-sol-low'].state, 'UNKNOWN');
  assert.equal(quota.estimateQuotaCost(missing, 'coordination-sol-low', HOUR).state, 'UNKNOWN');
});

test('caller-supplied horizon estimates remain per-window, uncapped, and never invent task length', () => {
  const report = quota.calibrateQuota(calibrationState([go(10, NOW - HOUR / 4), go({ rolling: 20, weekly: 15, monthly: 12 })], [activity('coding-qwen')]), NOW);
  const estimate = quota.estimateQuotaCost(report, 'coding-qwen', 10 * HOUR);
  assert.equal(estimate.source, 'ESTIMATE');
  assert.equal(estimate.horizonSource, 'CALLER_SUPPLIED');
  assert.equal(estimate.windows.rolling, 480);
  assert.equal(estimate.windows.weekly, 280);
  assert.equal(estimate.windows.monthly, 160);
  assert.equal(quota.estimateQuotaCost(report, 'coding-qwen').state, 'UNKNOWN');
});

test('usage class, variant and observed duration persist safely with strict validation', async (t) => {
  const { file } = fixture(t);
  const usage = activity('coordination-sol-low', { at: iso(Date.now()), activityClass: 'coordination-sol-low', durationMs: 123 });
  await updateQuotaState(file, state => {
    state.usage.push({ ...usage, prompt: 'secret', sourceCode: 'secret', auth: 'secret' });
    return state;
  });
  assert.deepEqual((await readQuotaState(file)).usage[0], usage);
  const before = await readQuotaState(file);
  for (const change of [{ activityClass: 'made-up' }, { activityClass: null }, { variant: 4 }, { variant: '' },
    { variant: 'a'.repeat(81) }, { variant: 'secret\nheader' }, { durationMs: -1 }]) {
    await assert.rejects(updateQuotaState(file, state => { state.usage.push({ ...usage, ...change }); return state; }));
  }
  assert.deepEqual(await readQuotaState(file), before);
  for (const activityClass of [...Object.keys(CLASS_MODELS), 'unclassified']) {
    await updateQuotaState(file, state => { state.usage.push({ ...usage, activityClass }); return state; });
  }
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
  const report = quota.calibrateQuota(calibrationState([openai(10, NOW - HOUR / 4), openai(20)], [
    activity('coordination-sol-low', { prompt: 'secret', auth: 'secret', sourceCode: 'secret' }),
  ]), NOW);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('calibration fails closed for a misnamed mandatory OpenAI week and malformed enum metadata', async (t) => {
  const snapshots = [openai(10, NOW - HOUR / 4), openai(20)];
  for (const sample of snapshots) sample.windows.weekly.limitWindowSeconds = 3600;
  const report = quota.calibrateQuota(calibrationState(snapshots, [activity('coordination-sol-low')]), NOW);
  assert.equal(report.classes['coordination-sol-low'].state, 'UNKNOWN');
  const { file } = fixture(t);
  await assert.rejects(updateQuotaState(file, state => {
    state.usage.push(activity('coding-qwen', { at: iso(Date.now()), activityClass: ['coding-qwen'] }));
    return state;
  }), /activityClass/);
});

test('calibration uses actual overlapping duration, time-weighted window intervals and fractional bounds', () => {
  const state = calibrationState([go(10, NOW - HOUR / 2), go(10.25, NOW - HOUR / 4), go(10.5)], [
    activity('coding-qwen', { at: iso(NOW), durationMs: HOUR / 2, input: 1, cacheRead: 999999, requests: 0 }),
  ]);
  const report = quota.calibrateQuota(state, NOW);
  const window = report.classes['coding-qwen'].windows.monthly;
  assert.equal(window.observations, 2);
  assert.equal(window.observedPercent, 0.5);
  assert.equal(window.intervalMs, HOUR / 2);
  assert.equal(window.observedPerHour, 1);
  assert.equal(window.quantizationBoundPercent, 2);
  assert.equal(window.segments, 1);
  assert.equal(window.conservativePerHour, 5);
  assert.equal(report.classes['coding-qwen'].observations, 2);
});

test('calibration never leaks valid prior-account intervals into a different current connection', () => {
  const snapshots = [
    { ...go(10, NOW - HOUR / 2), connection: 'a'.repeat(64) },
    { ...go(20, NOW - HOUR / 4), connection: 'a'.repeat(64) },
    { ...go(30), connection: 'b'.repeat(64) },
  ];
  const report = quota.calibrateQuota(calibrationState(snapshots, [activity('coding-qwen', { at: iso(NOW - HOUR / 3) })]), NOW);
  assert.equal(report.excluded.inactiveConnections, 1);
  assert.equal(report.classes['coding-qwen'].state, 'UNKNOWN');
});

test('classifyActivity is public, shared with calibration, and does not invent Sol variants', () => {
  for (const name of Object.keys(CLASS_MODELS)) assert.equal(quota.classifyActivity(activity(name)), name);
  for (const usage of [null, {}, activity('coordination-sol-low', { variant: undefined, kind: 'coding' }),
    activity('coordination-sol-low', { variant: 'high' }), activity('coordination-sol-low', { provider: 'other' }),
    activity('coordination-sol-low', { provider: undefined }), activity('coding-qwen', { activityClass: 'visual-glm' })]) {
    assert.equal(quota.classifyActivity(usage), 'unclassified');
  }
});

test('usage connection fingerprint persists, validates strictly and never retroactively fills legacy identity', async (t) => {
  const { file } = fixture(t);
  const entry = activity('coding-qwen', { at: iso(Date.now()), connection: 'a'.repeat(64) });
  await updateQuotaState(file, state => { state.usage.push(entry, { ...entry, connection: undefined }); return state; });
  const saved = await readQuotaState(file);
  assert.deepEqual(saved.usage[0], entry);
  assert.equal(Object.hasOwn(saved.usage[1], 'connection'), false);
  for (const connection of ['', null, 123, 'g'.repeat(64), 'a'.repeat(63)]) {
    await assert.rejects(updateQuotaState(file, state => { state.usage.push({ ...entry, connection }); return state; }), /connection/);
  }
  assert.deepEqual(await readQuotaState(file), saved);
});

test('event connection mismatch is excluded per interval while matching and legacy events remain distinguishable', () => {
  const snapshots = [go(10, NOW - HOUR / 4), go(12)].map(sample => ({ ...sample, connection: 'a'.repeat(64) }));
  const report = quota.calibrateQuota(calibrationState(snapshots, [
    activity('coding-qwen', { connection: 'b'.repeat(64) }),
    activity('visual-glm', { connection: 'a'.repeat(64) }),
    activity('discovery-mimo'),
  ]), NOW);
  assert.equal(report.classes['coding-qwen'].state, 'UNKNOWN');
  assert.equal(report.excluded.activityConnectionMismatches, 1);
  assert.equal(report.classes['visual-glm'].state, 'ESTIMATE');
  assert.equal(report.classes['visual-glm'].uncertainty.includes('legacy-activity-connection-unverified'), false);
  assert.ok(report.classes['discovery-mimo'].uncertainty.includes('legacy-activity-connection-unverified'));
  const unbound = quota.calibrateQuota(calibrationState([go(10, NOW - HOUR / 4), go(12)], [
    activity('coding-qwen', { connection: 'a'.repeat(64) }),
  ]), NOW);
  assert.equal(unbound.classes['coding-qwen'].state, 'UNKNOWN');
  assert.equal(unbound.excluded.activityConnectionMismatches, 1);
});

test('requests are starts, duration events are completions and token-only aggregates are not new activity', () => {
  const snapshots = [go(10, NOW - HOUR / 4), go(12)];
  for (const extra of [{ requests: 0, input: 999999, output: 10000 }, { requests: undefined, input: 1 },
    { requests: 0, retries: 5 }, { at: iso(NOW), requests: 1 }]) {
    const report = quota.calibrateQuota(calibrationState(snapshots, [activity('coding-qwen', extra)]), NOW);
    assert.equal(report.classes['coding-qwen'].observations, 0);
  }
  for (const extra of [{ at: iso(NOW - HOUR / 4) }, { requests: 0, at: iso(NOW), durationMs: HOUR / 8 }]) {
    const report = quota.calibrateQuota(calibrationState(snapshots, [activity('coding-qwen', extra)]), NOW);
    assert.equal(report.classes['coding-qwen'].observations, 1);
    assert.equal(report.classes['coding-qwen'].windows.rolling.observedPercent, 2);
    assert.equal(report.activitySemantics.requests, 'START_[before,after)');
    assert.equal(report.activitySemantics.completions, 'REQUESTS_0_WITH_DURATION_OVERLAP');
    assert.equal(report.activitySemantics.tokenOnly, 'IGNORED');
  }
  const ignored = quota.calibrateQuota(calibrationState(snapshots, [activity('coding-qwen', { requests: 0, input: 42 })]), NOW);
  assert.equal(ignored.usage.nonActivity, 1);
});

test('segment quantization is independent of snapshot frequency and does not merge disconnected class intervals', () => {
  const sparse = [go(10, NOW - HOUR / 2), go(11)];
  const dense = Array.from({ length: 7 }, (_, i) => go(10 + i / 6, NOW - HOUR / 2 + i * HOUR / 12));
  const usage = [activity('coding-qwen', { at: iso(NOW), requests: 0, durationMs: HOUR / 2 })];
  const first = quota.calibrateQuota(calibrationState(sparse, usage), NOW).classes['coding-qwen'].windows.monthly;
  const second = quota.calibrateQuota(calibrationState(dense, usage), NOW).classes['coding-qwen'].windows.monthly;
  assert.equal(first.quantizationBoundPercent, 2);
  assert.equal(second.quantizationBoundPercent, 2);
  assert.equal(first.conservativePerHour, second.conservativePerHour);
  const history = [go(10, NOW - 3 * HOUR / 4), go(11, NOW - HOUR / 2), go(12, NOW - HOUR / 4), go(13)];
  const disconnected = quota.calibrateQuota(calibrationState(history, [
    activity('coding-qwen', { at: iso(NOW - 5 * HOUR / 8) }), activity('coding-qwen'),
  ]), NOW).classes['coding-qwen'].windows.monthly;
  assert.equal(disconnected.segments, 2);
  assert.equal(disconnected.quantizationBoundPercent, 4);
  assert.equal(disconnected.intervalMs, HOUR / 2);
});

test('gaps and anomalous window intervals split quantization segments independently', () => {
  const history = [go(10, NOW - HOUR), go(11, NOW - 3 * HOUR / 4),
    go(12, NOW - HOUR / 4), go(13)];
  const usage = [activity('coding-qwen', { at: iso(NOW), requests: 0, durationMs: HOUR })];
  // The middle interval is a gap under this policy; both outer intervals remain observed.
  const gap = quota.calibrateQuota(calibrationState(history, usage, { staleAfterMs: HOUR / 5 }), NOW);
  assert.equal(gap.classes['coding-qwen'].windows.monthly.segments, 2);
  assert.equal(gap.classes['coding-qwen'].windows.monthly.quantizationBoundPercent, 4);
  assert.equal(gap.gaps.count, 1);
  const regular = [go(10, NOW - 3 * HOUR / 4), go(11, NOW - HOUR / 2),
    go({ rolling: 10, weekly: 12, monthly: 12 }, NOW - HOUR / 4), go(13)];
  const anomaly = quota.calibrateQuota(calibrationState(regular, usage), NOW).classes['coding-qwen'];
  assert.equal(anomaly.windows.rolling.segments, 2);
  assert.equal(anomaly.windows.rolling.quantizationBoundPercent, 4);
  assert.equal(anomaly.windows.monthly.segments, 1);
  assert.equal(anomaly.windows.monthly.quantizationBoundPercent, 2);
});
