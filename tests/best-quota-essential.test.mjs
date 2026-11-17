import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupGovernor } from '../shared/best-quota-runtime.mjs';
import { updateQuotaState, readQuotaState, forecast, reservedPercent } from '../shared/best-quota.mjs';

// The eight essential pre-dispatch qualifications. Every case is deterministic
// and simulated: no real Go/OpenAI request is ever made from these tests. The
// native loopback suite (tests/best-quota-native.test.mjs) proves the same
// gates against the real opencode binary with simulated local responses.

const AGENTS = {
  build: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' },
  general: { providerID: 'opencode-go', id: 'qwen3.7-plus' },
  specialist: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' },
  explore: { providerID: 'opencode-go', id: 'qwen3.7-plus' },
  'visual-designer': { providerID: 'opencode-go', id: 'glm-5.3-flash' },
};

async function quotaFile(t, { mode = 'active', go = {}, openai = 20 } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-essential-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const now = Date.now();
  const goWindows = { rolling: 10, weekly: 10, monthly: 10, ...go };
  await updateQuotaState(file, state => ({ ...state, policy: { mode }, snapshots: [
    { provider: 'opencode-go', connection: 'a'.repeat(64), source: 'LIVE', at: new Date(now).toISOString(),
      windows: Object.fromEntries(Object.entries(goWindows).map(([name, used]) =>
        [name, { used, resetAt: new Date(now + 86400000).toISOString() }])) },
    { provider: 'openai', connection: 'a'.repeat(64), source: 'LIVE', at: new Date(now).toISOString(),
      windows: { weekly: { used: openai, resetAt: new Date(now + 604800000).toISOString(), limitWindowSeconds: 604800 } } },
  ] }));
  return file;
}

// One BEST "terminal": its own governor instance over the shared state file.
async function governor(t, file, agents = AGENTS) {
  const hooks = {}, tools = {}, commands = {};
  const ctx = { app: { version: '2.2.5' }, options: { stateFile: file },
    agent: { get: async ({ agentID }) => ({ data: { model: agents[agentID] ?? agents.build } }) },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    tool: { hook: async (name, fn) => { tools[name] = fn; } },
    command: { transform: async fn => fn({ add: command => { commands[command.name] = command; } }) },
    model: { list: async () => ({ data: [
      { providerID: 'opencode-go', id: 'qwen3.7-plus' }, { providerID: 'opencode-go', id: 'glm-5.3-flash' },
      { providerID: 'openai', id: 'gpt-6.1-sol' },
    ] }) } };
  const binding = 'a'.repeat(64);
  const cleanup = await setupGovernor(ctx, {
    collect: async () => ({ snapshots: [], sources: {} }),
    subscription: async () => binding,
    goPaymentSafety: async () => ({ certified: true }),
    transportSafety: async () => true,
  });
  return { hooks, tools, commands, ctx, file, cleanup };
}

const goRequest = (sessionID = 'manual') => ({ sessionID, agent: 'general', kind: 'primary',
  model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } });
const openaiRequest = (sessionID = 'manual') => ({ sessionID, agent: 'build', kind: 'primary',
  model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } });
const delegation = (id, agent = 'general') => ({ tool: 'subagent', id, sessionID: 'parent',
  input: { agent, prompt: 'unchanged work' } });

test('essential 1: an exhausted Go monthly window authorizes no new paid Go request', async t => {
  const file = await quotaFile(t, { go: { monthly: 100 } });
  const f = await governor(t, file);
  // Manually selected / old-session Go model.
  await assert.rejects(f.hooks['model.request'](goRequest()), /BEST_QUOTA_BLOCKED/);
  await assert.rejects(f.hooks['model.request'](goRequest('continuation')), /BEST_QUOTA_BLOCKED/);
  // A new General delegation never dispatches Go work.
  const event = delegation('d1');
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(readQuotaState(file).decisions.at(-1).candidate.provider, 'openai');
  // A Go-only role (visual) cannot dispatch at all; no paid fallback exists.
  await assert.rejects(f.tools['execute.before'](delegation('v1', 'visual-designer')), /BEST_QUOTA_BLOCKED/);
  assert.equal((readQuotaState(file).leases ?? []).filter(l => l.provider === 'opencode-go').length, 0,
    'no Go reservation is ever taken while the month is exhausted');
  await f.cleanup();
});

test('essential 2: a critical monthly window regulates Go without blocking it while budget remains', async t => {
  const file = await quotaFile(t, { go: { rolling: 10, weekly: 10, monthly: 96 } });
  const state = readQuotaState(file);
  const prediction = forecast(state, Date.now(), state.policy);
  const go = prediction.providers['opencode-go'];
  assert.equal(go.windows.weekly.state, 'NORMAL', 'weekly headroom really exists');
  assert.equal(go.limitingWindow, 'monthly', 'the most restrictive window governs');
  assert.equal(go.state, 'CRITICAL');
  const f = await governor(t, file);
  // Regulation: a CRITICAL month with real remaining budget keeps admitting.
  await f.hooks['model.request'](goRequest());
  const decision = readQuotaState(file).decisions.at(-1);
  assert.equal(decision.scope, 'admission');
  assert.equal(decision.blocked, false);
  assert.equal(decision.enforced, true);
  // Only a fully exhausted month stops Go; a weekly reset never renews it.
  await updateQuotaState(file, s => {
    const snapshot = s.snapshots.find(v => v.provider === 'opencode-go');
    snapshot.at = new Date().toISOString();
    for (const window of Object.values(snapshot.windows)) window.used = 100;
    return s;
  });
  const leasesBefore = (readQuotaState(file).leases ?? []).filter(l => l.provider === 'opencode-go').length;
  await assert.rejects(f.hooks['model.request'](goRequest('exhausted')), /BEST_QUOTA_BLOCKED/);
  assert.equal((readQuotaState(file).leases ?? []).filter(l => l.provider === 'opencode-go').length, leasesBefore,
    'the exhausted month reserves nothing new');
  // After the reset the same request is admitted again.
  await updateQuotaState(file, s => {
    const snapshot = s.snapshots.find(v => v.provider === 'opencode-go');
    snapshot.at = new Date().toISOString();
    for (const window of Object.values(snapshot.windows)) window.used = 10;
    return s;
  });
  await f.hooks['model.request'](goRequest('after-reset'));
  await f.cleanup();
});

test('essential 3: sustainable OpenAI receives the compatible routed work while Go is unavailable', async t => {
  const file = await quotaFile(t, { go: { monthly: 100 } });
  const f = await governor(t, file);
  const event = delegation('d1');
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium', 'General reroutes to the specialist Sol');
  assert.equal(event.input.prompt, 'unchanged work', 'the task is never rewritten');
  assert.equal(readQuotaState(file).decisions.at(-1).candidate.provider, 'openai');
  // The routed child's own dispatch is admitted on OpenAI.
  await f.hooks['model.request']({ sessionID: 'child', agent: 'general', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } });
  // A direct Build request on OpenAI is admitted too.
  await f.hooks['model.request'](openaiRequest());
  await f.cleanup();
});

test('essential 4: pressure on both providers regulates to OpenAI, and a paid fallback stays impossible', async t => {
  const file = await quotaFile(t, { go: { monthly: 100 }, openai: 98 });
  const f = await governor(t, file);
  // Go's month is exhausted, but OpenAI at 98% still holds real budget:
  // the delegation is routed there instead of being blocked.
  const event = delegation('d1');
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(readQuotaState(file).decisions.at(-1).candidate.provider, 'openai');
  await f.hooks['model.request'](openaiRequest());
  // A paid fallback is denied regardless of pressure, and never reserves.
  await assert.rejects(f.hooks['model.request']({ sessionID: 'paid', agent: 'build', kind: 'primary',
    model: { providerID: 'paid-api', id: 'cheap' } }), /BEST_QUOTA_BLOCKED/);
  assert.equal((readQuotaState(file).leases ?? []).filter(l => l.provider === 'paid-api').length, 0,
    'no paid lease is ever taken');
  // Once OpenAI is truly exhausted there is nowhere left to route: safe block.
  await updateQuotaState(file, state => {
    const snapshot = state.snapshots.find(v => v.provider === 'openai');
    snapshot.at = new Date().toISOString();
    snapshot.windows.weekly.used = 100;
    return state;
  });
  await assert.rejects(f.tools['execute.before'](delegation('d2')), /BEST_QUOTA_BLOCKED/);
  await assert.rejects(f.hooks['model.request'](openaiRequest('exhausted')), /BEST_QUOTA_BLOCKED/);
  await assert.rejects(f.hooks['model.request']({ sessionID: 'paid2', agent: 'build', kind: 'primary',
    model: { providerID: 'paid-api', id: 'cheap' } }), /BEST_QUOTA_BLOCKED/);
  assert.equal((readQuotaState(file).leases ?? []).filter(l => l.provider === 'paid-api').length, 0,
    'a safe block takes no reservation');
  assert.equal(readQuotaState(file).decisions.at(-1).blocked, true);
  await f.cleanup();
});

test('essential 5: three concurrent BEST instances cannot overrun one shared budget', async t => {
  const file = await quotaFile(t, { openai: 20 });
  await updateQuotaState(file, state => ({
    ...state, policy: { ...state.policy, expectedPercentByKind: { coding: { openai: 30 } } } }));
  // Three independent governors = three terminals sharing the same state file.
  const instances = [0, 1, 2].map(() => null);
  for (let i = 0; i < instances.length; i++) instances[i] = await governor(t, file);
  const events = instances.map((_, i) => ({ ...openaiRequest(`s${i}`) }));
  const results = await Promise.allSettled(events.map((event, i) => instances[i].hooks['model.request'](event)));
  const admitted = results.filter(result => result.status === 'fulfilled');
  const denied = results.filter(result => result.status === 'rejected'
    && /BEST_QUOTA_BLOCKED/.test(result.reason.message));
  assert.equal(admitted.length, 2, 'headroom (80 − 15 margin) admits exactly two 30% tasks');
  assert.equal(denied.length, 1, 'the third concurrent instance is denied before transport');
  const held = reservedPercent(readQuotaState(file).leases ?? [], 'openai');
  assert.equal(held, 60);
  assert.ok(held <= 80 - 15, 'in-flight reservations never exceed remaining minus safety margin');
  // While those reservations are live, no instance may spend the rest twice.
  await assert.rejects(instances[0].hooks['model.request'](openaiRequest('s3')), /BEST_QUOTA_BLOCKED/);
  // The admission backstop: a reservation whose deadline passed is released at
  // the next admission even though the owning process is still alive.
  await updateQuotaState(file, state => ({ ...state,
    leases: (state.leases ?? []).map(lease => ({ ...lease, expiresAt: new Date(Date.now() - 1).toISOString() })) }));
  await instances[0].hooks['model.request'](openaiRequest('after-expiry'));
  assert.equal(reservedPercent(readQuotaState(file).leases ?? [], 'openai'), 30, 'expired reservations are replaced by the new one');
  await Promise.allSettled(instances.map(instance => instance.cleanup()));
});

test('essential 6: a pre-existing session is gated at its next continuation', async t => {
  const file = await quotaFile(t, { mode: 'monitor' });
  const f = await governor(t, file);
  const event = goRequest('legacy');
  // The session ran before activation; monitor mode never blocked it.
  await f.hooks['model.request'](event);
  assert.equal(readQuotaState(file).usage.length, 1, 'monitor observes without enforcing');
  assert.equal((readQuotaState(file).leases ?? []).length, 0, 'monitor takes no reservation');
  // Activation plus an exhausted month: the very same session is gated.
  await updateQuotaState(file, state => {
    state.policy = { ...state.policy, mode: 'active' };
    const snapshot = state.snapshots.find(v => v.provider === 'opencode-go');
    snapshot.at = new Date().toISOString();
    for (const window of Object.values(snapshot.windows)) window.used = 100;
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
  assert.equal(readQuotaState(file).usage.length, 1, 'the denied continuation records no new dispatch');
  assert.equal((readQuotaState(file).leases ?? []).length, 0, 'a denied continuation reserves nothing');
  await f.cleanup();
});

test('essential 7: a new BEST instance applies the governor automatically at startup', async t => {
  const file = await quotaFile(t, { go: { monthly: 100 } });
  const f = await governor(t, file);
  const receipt = readQuotaState(file).runtime.instances.at(-1);
  assert.ok(receipt.instanceID, 'startup registers an instance receipt without any manual step');
  assert.ok(receipt.registeredAt);
  assert.equal(receipt.pid, process.pid);
  assert.equal(readQuotaState(file).policy.mode, 'active');
  await assert.rejects(f.hooks['model.request'](goRequest()), /BEST_QUOTA_BLOCKED/);
  // Healthy OpenAI still flows: the automatic startup gate is not a dead switch.
  await f.hooks['model.request'](openaiRequest());
  await f.cleanup();
  assert.ok(readQuotaState(file).runtime.instances.at(-1).unloadedAt, 'cleanup retires the receipt');
});

test('essential 8: a provider error cannot retry into an uncontrolled spend', async t => {
  const file = await quotaFile(t);
  const f = await governor(t, file);
  // Budget/permission class errors are never retried in active mode.
  for (const status of [429, 402, 403]) {
    const retry = { error: { status, message: 'provider refusal' }, decision: { retry: true, delay: 0 } };
    await f.hooks.retry(retry);
    assert.equal(retry.decision.retry, false, `status ${status} is not retried`);
  }
  const denial = { error: { message: 'BEST_QUOTA_BLOCKED (quota-unavailable): suspended' },
    decision: { retry: true, delay: 0 } };
  await f.hooks.retry(denial);
  assert.equal(denial.decision.retry, false, 'a governor denial is never retried');
  // A transient 5xx keeps the native bounded retry policy, but every physical
  // attempt must pass admission again: no quota change can be skipped.
  const transient = { error: { status: 503 }, decision: { retry: true, delay: 0 } };
  await f.hooks.retry(transient);
  assert.equal(transient.decision.retry, true, 'native 5xx recovery is not overridden');
  const event = { ...openaiRequest('retry'), request: new Request('http://127.0.0.1/mock') };
  await f.hooks['http.request'](event);
  await updateQuotaState(file, state => {
    const snapshot = state.snapshots.find(v => v.provider === 'openai');
    snapshot.at = new Date().toISOString();
    snapshot.windows.weekly.used = 100;
    return state;
  });
  await assert.rejects(f.hooks['http.request'](event), /BEST_QUOTA_BLOCKED/,
    'the retried physical transport is rechecked and stopped before HTTP');
  await f.cleanup();
});
