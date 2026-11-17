import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateQuotaState, readQuotaState } from '../shared/best-quota.mjs';
import { goExtraUsageSafety } from '../shared/best-quota-sources.mjs';
import { nativeUsageReport, quotaCLI, runtimeCoverage } from '../shared/best-quota-cli.mjs';

test('BEST quota commands dispatch without inference or touching FREE', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, OPENCODE_TEAM_HOME: dir };
  for (const args of [['status'], ['forecast'], ['doctor'], ['report', '--days', '7']]) {
    const result = spawnSync('bash', ['bin/opencode-team', 'best', 'quota', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(['MONITOR ONLY', 'BLOCKED'].includes(report.operational));
    assert.ok(report.providers['opencode-go']);
    assert.ok(report.providers.openai);
  }
  assert.equal(fs.existsSync(path.join(dir, 'config/free')), false);
});

test('install extends only active BEST, is idempotent and keeps an exact native rollback backup', t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const best = path.join(dir, 'config/best/opencode.jsonc'), free = path.join(dir, 'config/free/opencode.jsonc');
  fs.mkdirSync(path.dirname(best), { recursive: true });
  fs.mkdirSync(path.dirname(free), { recursive: true });
  const oldPlugin = path.join(dir, 'previous/shared/best-quota-plugin');
  fs.mkdirSync(oldPlugin, { recursive: true });
  fs.writeFileSync(path.join(oldPlugin, 'package.json'), '{"name":"opencode-team-best-quota"}');
  const original = JSON.stringify({ model: 'openai/user-current', plugins: ['user-plugin',
    { package: oldPlugin, options: { stateFile: path.join(dir, 'existing-quota/state.json') } }],
    agents: { general: { model: 'opencode-go/qwen3.7-plus' } }, custom: { keep: true } }) + '\n';
  fs.writeFileSync(best, original);
  fs.writeFileSync(free, 'FREE-UNCHANGED\n');
  const env = { ...process.env, OPENCODE_TEAM_HOME: dir };
  const run = (...args) => spawnSync('bash', ['bin/opencode-team', ...args], { env, encoding: 'utf8' });
  const installed = run('best', 'quota', 'install');
  assert.equal(installed.status, 0, installed.stderr);
  const backup = installed.stdout.match(/Configuration backup: ([^\n]+)/)?.[1];
  assert.ok(backup);
  const config = JSON.parse(fs.readFileSync(best));
  assert.equal(config.model, 'openai/user-current');
  assert.deepEqual(config.custom, { keep: true });
  assert.equal(config.plugins[0], 'user-plugin');
  assert.equal(config.plugins.length, 2);
  assert.equal(config.plugins[1].package, path.resolve('shared/best-quota-plugin'));
  assert.equal(config.plugins[1].options.stateFile, path.join(dir, 'existing-quota/state.json'));
  assert.equal(run('best', 'quota', 'install').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(best)).plugins.length, 2);
  assert.equal(run('rollback', backup).status, 0);
  assert.equal(fs.readFileSync(best, 'utf8'), original);
  assert.equal(fs.readFileSync(free, 'utf8'), 'FREE-UNCHANGED\n');
});

test('manual emergency, configurable budgets, activation prerequisites and disabling are explicit', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-controls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, OPENCODE_TEAM_HOME: dir };
  const run = (args, input) => spawnSync('bash', ['bin/opencode-team', 'best', 'quota', ...args], { env, input, encoding: 'utf8' });
  assert.equal(run(['activate']).status, 1);
  assert.equal(run(['configure'], JSON.stringify({ safetyMarginPercent: 8, expectedPercentByKind: { coding: { openai: 1 } } })).status, 0);
  assert.equal(run(['configure'], '{"mode":"active"}').status, 1);
  assert.equal(run(['configure'], '{"unknown":1}').status, 1);
  const malformed = run(['manual', 'openai'], '{"secret-token-not-JSON');
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr.includes('secret-token'), false);
  assert.equal(run(['manual', 'openai'], '{}').status, 1);
  const now = Date.now(), at = new Date(now).toISOString();
  const go = { observedAt: at, usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map(k =>
    [k, { percent: 10, resetsAt: new Date(now + 86400000).toISOString() }])) };
  const ai = { observedAt: at, rate_limit: { secondary_window: { used_percent: 10, reset_at: Math.floor(now / 1000) + 604800, limit_window_seconds: 604800 } } };
  const file = path.join(dir, 'state/best/quota/state.json');
  await updateQuotaState(file, state => ({ ...state, sources: {
    openai: { status: 'LIVE', connection: 'a'.repeat(64), at },
    'opencode-go': { status: 'LIVE', connection: 'b'.repeat(64), at },
  }, runtime: { version: '2.2.5', loadedAt: at, verifiedAt: at, hookVerified: true } }));
  for (const [provider, payload] of [['opencode-go', go], ['openai', ai]]) {
    const result = run(['manual', provider], JSON.stringify(payload));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).providers[provider].source, 'MANUAL');
  }
  const activation = run(['activate']);
  assert.equal(activation.status, 1);
  assert.ok(activation.stderr.includes('GO_EXTRA_USAGE_UNVERIFIED'));
  const disabled = run(['disable']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).mode, 'disabled');
  assert.equal(run(['report', '--days', '0']).status, 1);
  assert.equal(run(['status', 'unexpected']).status, 1);
  assert.equal(run(['nonsense']).status, 1);
});

test('native historical reports keep aggregates, never raw metadata or monetary API limits', () => {
  const tokens = { input: 1, output: 2, cache: { read: 3, write: 4 } };
  const report = nativeUsageReport({ data: { range: { from: 1000, to: 2000 }, sessions: 1, subagents: 2,
    prompts: 3, steps: 4, tokens, cost: 999, secret: 'do-not-export',
    tools: { totals: { calls: 5, failed: 1, unfinished: 0 } },
    models: [{ model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' }, steps: 4, tokens }],
  } });
  assert.equal(report.status, 'LIVE');
  assert.equal(report.models[0].model, 'openai/gpt-6.1-sol#low');
  assert.equal(JSON.stringify(report).includes('do-not-export'), false);
  assert.equal(report.cost, undefined);
  assert.throws(() => nativeUsageReport({ data: { models: [] } }));
});

test('global activation fails closed without authoritative Go Extra usage proof even with a native test receipt', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-billing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'), at = new Date().toISOString();
  await updateQuotaState(file, state => ({ ...state, policy: { mode: 'monitor' },
    runtime: { version: '2.2.5', loadedAt: at, hookVerified: true, verifiedAt: at } }));
  const report = await quotaCLI(['doctor'], file);
  assert.equal(report.activation.status, 'BLOCKED');
  assert.ok(report.activation.blockers.includes('GO_EXTRA_USAGE_UNVERIFIED'));
  assert.equal(report.activation.blockers.includes('ACTIVITY_CALIBRATION_INCOMPLETE'), false,
    'optional class cost estimates must not prevent enforcing verified account windows');
  assert.ok(report.activation.warnings.includes('ACTIVITY_COST_ESTIMATES_INCOMPLETE'));
  await assert.rejects(quotaCLI(['activate'], file), /GO_EXTRA_USAGE_UNVERIFIED/);
});

test('MiMo alone remains UNKNOWN and automatically excluded, not an independent calibration activation blocker', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-mimo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'), now = Date.now(), connection = 'a'.repeat(64);
  await updateQuotaState(file, state => ({ ...state, policy: { mode: 'monitor' },
    snapshots: ['opencode-go', 'openai'].flatMap(provider => [now - 60000, now].map((at, index) => ({
      provider, connection, source: 'LIVE', at: new Date(at).toISOString(), windows: Object.fromEntries(
        (provider === 'opencode-go' ? ['rolling', 'weekly', 'monthly'] : ['weekly']).map(name => [name, {
          used: 10 + index, resetAt: new Date(now + 604800000).toISOString(),
          ...(provider === 'openai' ? { limitWindowSeconds: 604800 } : {}),
        }])) }))),
    usage: [
      ['opencode-go', 'qwen3.7-plus'], ['opencode-go', 'glm-5.3-flash'],
      ['openai', 'gpt-6.1-sol', 'low'], ['openai', 'gpt-6.1-sol', 'medium'],
    ].map(([provider, model, variant]) => ({ provider, model: `${provider}/${model}`, connection,
      ...(variant ? { variant } : {}), at: new Date(now - 30000).toISOString(), requests: 1 })),
  }));
  const report = await quotaCLI(['doctor'], file);
  assert.deepEqual(report.activation.uncalibratedClasses, ['discovery-mimo']);
  assert.deepEqual(report.activation.automaticallyExcludedClasses, ['discovery-mimo']);
  assert.equal(report.activation.blockers.includes('ACTIVITY_CALIBRATION_INCOMPLETE'), false);
  assert.ok(report.activation.blockers.includes('GO_EXTRA_USAGE_UNVERIFIED'));
  assert.ok(report.activation.blockers.includes('EXISTING_LIVE_SESSION_COVERAGE_UNVERIFIED'));
});

test('manual_user_confirmed is audited, connection-bound and expires without bypassing native activation checks', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-confirmation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'), connection = 'a'.repeat(64);
  await updateQuotaState(file, state => ({ ...state, policy: { mode: 'monitor' },
    sources: { 'opencode-go': { connection, status: 'LIVE' } } }));
  const confirmedAt = new Date().toISOString();
  const report = await quotaCLI(['confirm-extra-usage-off', '--confirmed-by', 'requesting_user', '--confirmed-at', confirmedAt], file);
  assert.equal(report.activation.extraUsage.source, 'manual_user_confirmed');
  assert.equal(report.activation.extraUsage.status, 'OFF');
  assert.equal(report.activation.extraUsage.apiAttested, false);
  assert.equal(report.activation.blockers.includes('GO_EXTRA_USAGE_UNVERIFIED'), false);
  assert.ok(report.activation.blockers.includes('EXISTING_LIVE_SESSION_COVERAGE_UNVERIFIED'));
  const state = readQuotaState(file), entry = state.extraUsageConfirmations.at(-1);
  assert.equal(entry.confirmedBy, 'requesting_user');
  assert.equal(entry.connection, connection);
  assert.ok(entry.id);
  assert.equal(Date.parse(entry.expiresAt) - Date.parse(entry.confirmedAt), 3600000);
  assert.equal(goExtraUsageSafety(state, Date.parse(entry.expiresAt)).reason, 'GO_EXTRA_USAGE_CONFIRMATION_EXPIRED');
  assert.equal(goExtraUsageSafety(state, Date.parse(entry.confirmedAt) - 1).certified, false);
  assert.equal(goExtraUsageSafety(state, Date.now(), 'b'.repeat(64)).certified, false);
  await assert.rejects(quotaCLI(['activate'], file), /native pre-dispatch/);
  assert.equal(readQuotaState(file).policy.mode, 'monitor');
  await updateQuotaState(file, current => ({ ...current, runtime: { version: '2.2.5',
    loadedAt: confirmedAt, verifiedAt: confirmedAt, hookVerified: true } }));
  await assert.rejects(quotaCLI(['activate'], file), /EXISTING_LIVE_SESSION_COVERAGE_UNVERIFIED/);
  await assert.rejects(quotaCLI(['confirm-extra-usage-off', '--confirmed-by', 'requesting_user', '--confirmed-at',
    new Date(Date.now() - 3600001).toISOString()], file), /expired/);
  assert.equal(readQuotaState(file).extraUsageConfirmations.length, 1);
  await assert.rejects(updateQuotaState(file, current => {
    current.extraUsageConfirmations[0].expiresAt = new Date(Date.parse(confirmedAt) + 7200000).toISOString();
    return current;
  }), /confirmation/);
});

test('runtime coverage requires every discovered process and location, rejects reused PIDs, expired callbacks and injected tests', () => {
  const now = Date.now(), at = new Date(now).toISOString(), file = '/isolated/state.json';
  const scope = { configFile: '/isolated/best.json', databaseDirectory: '/isolated/database' };
  const receipt = { instanceID: 'one', pid: 123, origin: 'NATIVE_RUNTIME', version: '2.2.5', loadedAt: at, registeredAt: at,
    configuration: { file: scope.configFile, stateFile: file, location: '/project' }, callbacks: {
      'model.request': { at, outcome: 'MONITOR_OBSERVED' },
      'http.request': { at, outcome: 'MONITOR_OBSERVED', liveSubscription: true },
    } };
  const state = { runtime: { instances: [receipt] } }, inventory = [{ pid: 123, startedAt: new Date(now - 1000).toISOString() }];
  assert.equal(runtimeCoverage(state, file, scope, inventory, now).status, 'PASS');
  const cases = [
    { runtime: { instances: [{ ...receipt, origin: 'INJECTED_TEST' }] } },
    { runtime: { instances: [{ ...receipt, unloadedAt: at }] } },
    { runtime: { instances: [receipt, { ...receipt, instanceID: 'two', configuration: { ...receipt.configuration, location: '/other' }, callbacks: {} }] } },
    { runtime: { instances: [receipt, { ...receipt, instanceID: 'retired-location',
      configuration: { ...receipt.configuration, location: '/retired' }, unloadedAt: at }] } },
  ];
  for (const value of cases) assert.equal(runtimeCoverage(value, file, scope, inventory, now).status, 'BLOCKED');
  assert.equal(runtimeCoverage(state, file, scope, [...inventory, { pid: 456, startedAt: at }], now).status, 'BLOCKED');
  assert.equal(runtimeCoverage(state, file, scope, [{ pid: 123, startedAt: new Date(now + 1).toISOString() }], now).status, 'BLOCKED');
  assert.equal(runtimeCoverage(state, file, scope, inventory, now + 900001).status, 'BLOCKED');
  assert.equal(runtimeCoverage(state, file, scope, [], now).status, 'BLOCKED');
  assert.equal(runtimeCoverage(state, file, undefined, inventory, now).status, 'BLOCKED');
});

test('runtime coverage admits an idle location through its heartbeat and never without liveness or transport proof', () => {
  const now = Date.now(), at = ms => new Date(ms).toISOString(), file = '/isolated/state.json';
  const scope = { configFile: '/isolated/best.json', databaseDirectory: '/isolated/database' };
  const started = now - 1010000, loaded = now - 1005000, registered = now - 1000000;
  const receipt = (callbacks, extra = {}) => ({ instanceID: '11111111-2222-3333-4444-555555555555',
    pid: 123, version: '2.2.7', origin: 'NATIVE_RUNTIME', loadedAt: at(loaded), registeredAt: at(registered),
    configuration: { file: scope.configFile, stateFile: file, location: '/project' }, callbacks, ...extra });
  const inventory = [{ pid: 123, startedAt: at(started) }];
  const coverage = callbacks => runtimeCoverage({ runtime: { instances: [receipt(callbacks)] } },
    file, scope, inventory, now).status;
  const beat = when => ({ at: when, outcome: 'PASSED', mode: 'active', liveSubscription: false });

  // An idle location that has never issued a request still proves liveness
  // with its heartbeat: there is no request sample that could have escaped
  // pre-dispatch, so the living, correctly-bound instance is the proof.
  assert.equal(coverage({ heartbeat: beat(at(now - 30000)) }), 'PASS');
  // With no callbacks at all there is neither liveness nor a request record.
  assert.equal(coverage({}), 'BLOCKED');
  // A heartbeat that stopped beating is stale liveness, not current proof.
  assert.equal(coverage({ heartbeat: beat(at(now - 900001)) }), 'BLOCKED');
  // A request that passed while its transport receipt says no live
  // subscription carried it is the injected-fixture case coverage rejects,
  // even though the instance is demonstrably alive.
  assert.equal(coverage({ heartbeat: beat(at(now - 30000)),
    'model.request': { at: at(now - 30000), outcome: 'PASSED', mode: 'active', liveSubscription: false },
    'http.request': { at: at(now - 30000), outcome: 'PASSED', mode: 'active', liveSubscription: false } }), 'BLOCKED');
  // A request the governor denied never left pre-dispatch: that is coverage.
  assert.equal(coverage({ 'model.request': { at: at(now - 30000), outcome: 'BLOCKED', mode: 'active',
    liveSubscription: false } }), 'PASS');
  // The normal active path: a fresh request whose final HTTP attempt was
  // proven against a live subscription.
  assert.equal(coverage({ 'model.request': { at: at(now - 30000), outcome: 'PASSED', mode: 'active',
    liveSubscription: false },
  'http.request': { at: at(now - 30000), outcome: 'PASSED', mode: 'active', liveSubscription: true } }), 'PASS');
});

test('status reports whether the OpenAI/Go routing choice was applied automatically', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const at = new Date().toISOString();
  const decision = (extra = {}) => ({ at, kind: 'coding', blocked: false, scope: 'routing', enforced: true,
    candidate: { agent: 'general', provider: 'openai', model: 'openai/gpt-6.1-sol#medium' }, ...extra });
  await updateQuotaState(file, state => ({ ...state, policy: { mode: 'active' },
    decisions: [decision({ applied: 'openai/gpt-6.1-sol#medium' })] }));
  let report = await quotaCLI(['status'], file);
  assert.equal(report.routing.automatic, 'PASS');
  assert.equal(report.routing.recommended, 'openai/gpt-6.1-sol#medium');
  assert.equal(report.routing.applied, 'openai/gpt-6.1-sol#medium');
  assert.equal(report.routing.enforced, true);
  assert.equal(report.routing.decisions, 1);
  // A recommendation that was recorded but never applied must not read as PASS.
  await updateQuotaState(file, state => { state.decisions.push(decision()); return state; });
  report = await quotaCLI(['status'], file);
  assert.equal(report.routing.automatic, 'FAIL');
  assert.equal(report.routing.applied, null, 'no model is claimed when none was applied');
  // Monitor mode never enforces, whatever the recorded decision says.
  await updateQuotaState(file, state => {
    state.decisions.push(decision({ applied: 'openai/gpt-6.1-sol#medium' }));
    state.policy = { mode: 'monitor' };
    return state;
  });
  report = await quotaCLI(['status'], file);
  assert.equal(report.routing.automatic, 'FAIL');
  assert.equal(report.routing.mode, 'monitor');
  assert.equal(report.routing.applied, 'openai/gpt-6.1-sol#medium', 'the record itself is still reported honestly');
});

test('heartbeat receipt survives state validation as liveness-only proof', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-heartbeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const now = Date.now(), at = ms => new Date(ms).toISOString();
  const scope = { configFile: path.join(dir, 'best.json'), databaseDirectory: path.join(dir, 'db') };
  const started = now - 120000, loaded = now - 115000, registered = now - 110000;
  const saved = await updateQuotaState(file, current => ({ ...current, runtime: { ...current.runtime,
    version: '2.2.7', loadedAt: at(loaded), verifiedAt: at(loaded), hookVerified: true,
    instances: [{ instanceID: '11111111-2222-3333-4444-555555555555', pid: process.pid, version: '2.2.7',
      origin: 'NATIVE_RUNTIME', loadedAt: at(loaded), at: at(now), registeredAt: at(registered),
      configuration: { file: scope.configFile, stateFile: file, location: '/project' },
      callbacks: {
        heartbeat: { at: at(now - 30000), outcome: 'PASSED', mode: 'active', liveSubscription: false },
        'http.request': { at: at(now - 60000), outcome: 'PASSED', mode: 'active', liveSubscription: true },
      } }] } }));
  const entry = saved.runtime.instances.at(-1);
  assert.deepEqual(entry.callbacks.heartbeat,
    { at: at(now - 30000), outcome: 'PASSED', mode: 'active', liveSubscription: false },
    'the heartbeat must round-trip through state validation');
  // Liveness only: a heartbeat must never be promoted into transport proof.
  assert.equal(entry.callbacks.heartbeat.liveSubscription, false);
  assert.equal(runtimeCoverage(saved, file, scope, [{ pid: process.pid, startedAt: at(started) }], now).status, 'PASS');
});
