import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, on } from 'node:events';
import { setupGovernor } from '../shared/best-quota-runtime.mjs';
import { updateQuotaState, readQuotaState, classifyActivity } from '../shared/best-quota.mjs';

test('new 2.3.2 instance admits its first request with active persisted state without inventing certification', async t => {
  const f = await fixture(t);
  await updateQuotaState(f.file, state => ({ ...state, runtime: { ...state.runtime,
    hookVerified: true, verifiedAt: new Date().toISOString() } }));
  f.ctx.app.version = '2.3.2';
  const cleanup = await setupGovernor(f.ctx, { collect: async () => ({ snapshots: [], sources: {} }),
    subscription: async () => f.auth.binding, goPaymentSafety: async () => ({ certified: true }),
    transportSafety: async () => true });
  t.after(cleanup);
  t.after(f.cleanup);
  assert.equal(readQuotaState(f.file).runtime.hookVerified, false, 'old version certificate must be invalidated');
  await f.hooks['model.request']({ sessionID: 'first', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } });
  const state = readQuotaState(f.file);
  assert.equal(state.policy.mode, 'active');
  assert.equal(state.runtime.hookVerified, false, 'an admitted fixture request is not runtime certification');
  assert.equal(state.runtime.instances.at(-1).callbacks['model.request'].outcome, 'PASSED');
  assert.ok(state.leases.some(lease => lease.sessionID === 'first'));
});

test('registration immediately observes liveness only, without waiting for a first request', async t => {
  const f = await fixture(t);
  t.after(f.cleanup);
  const receipt = readQuotaState(f.file).runtime.instances.at(-1);
  assert.equal(receipt.callbacks.heartbeat.outcome, 'PASSED');
  assert.equal(receipt.callbacks.heartbeat.liveSubscription, false);
  assert.ok(Date.parse(receipt.callbacks.heartbeat.at) >= Date.parse(receipt.registeredAt));
  assert.equal(receipt.callbacks['model.request'], undefined);
});

test('another same-version active instance preserves observed certification and has its own liveness receipt', async t => {
  const f = await fixture(t);
  t.after(f.cleanup);
  const verifiedAt = new Date().toISOString();
  await updateQuotaState(f.file, state => ({ ...state, runtime: { ...state.runtime,
    hookVerified: true, verifiedAt } }));
  t.after(await setupGovernor(f.ctx, { collect: async () => ({ snapshots: [], sources: {} }),
    subscription: async () => f.auth.binding, transportSafety: async () => true }));
  const { runtime, policy } = readQuotaState(f.file);
  assert.equal(policy.mode, 'active');
  assert.equal(runtime.hookVerified, true);
  assert.equal(runtime.verifiedAt, verifiedAt);
  assert.equal(runtime.instances.length, 2);
  assert.notEqual(runtime.instances[0].instanceID, runtime.instances[1].instanceID);
  assert.ok(runtime.instances.every(entry => entry.registeredAt && entry.callbacks.heartbeat
    && !entry.callbacks.heartbeat.liveSubscription));
});

test('background delegation has an explicit foreground recovery path and reserves nothing before routing', async t => {
  const f = await fixture(t);
  t.after(f.cleanup);
  const event = { tool: 'subagent', id: 'background', sessionID: 'parent',
    input: { agent: 'general', background: true, prompt: 'private-do-not-log' } };
  await assert.rejects(f.tools['execute.before'](event), error =>
    error.message.includes('background-lifecycle-unverified; use background=false')
      && !error.message.includes('private-do-not-log'));
  assert.equal(readQuotaState(f.file).decisions.length, 0);
  assert.equal((readQuotaState(f.file).leases ?? []).length, 0);
  event.input.background = false;
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(readQuotaState(f.file).leases.length, 1);
  await f.tools['execute.after'](event);
  assert.equal(readQuotaState(f.file).leases.length, 0);
});

test('pre-routing runtime and agent denials are distinguishable and do not disclose input', async t => {
  const f = await fixture(t);
  t.after(f.cleanup);
  const event = { tool: 'subagent', id: 'denied', sessionID: 'parent', input: { agent: 'unsupported' } };
  await assert.rejects(f.tools['execute.before'](event), /unsupported-agent/);
  f.ctx.app.version = '9.9.9';
  event.input.agent = 'general';
  await assert.rejects(f.tools['execute.before'](event), /runtime-version-unverified/);
  await assert.rejects(f.hooks['model.request']({ sessionID: 'first', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol' } }), /runtime-version-unverified/);
});

async function fixture(t, mode = 'active', payment = { certified: true }, collect = async () => ({ snapshots: [], sources: {} }), event, version = '2.2.5') {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const now = Date.now(), hooks = {}, tools = {}, commands = {};
  await updateQuotaState(file, s => ({ ...s, policy: { mode }, snapshots: [
    { provider: 'opencode-go', connection: 'a'.repeat(64), source: 'LIVE', at: new Date(now).toISOString(), windows: Object.fromEntries(
      ['rolling', 'weekly', 'monthly'].map(k => [k, { used: k === 'rolling' ? 100 : 20, resetAt: new Date(now + 86400000).toISOString() }])) },
    { provider: 'openai', connection: 'a'.repeat(64), source: 'LIVE', at: new Date(now).toISOString(), windows: {
      weekly: { used: 20, resetAt: new Date(now + 604800000).toISOString(), limitWindowSeconds: 604800 } } },
  ] }));
  const ctx = { app: { version }, options: { stateFile: file },
    agent: { get: async ({ agentID }) => ({ data: { model: agentID === 'general'
      ? { providerID: 'opencode-go', id: 'qwen3.7-plus' }
      : { providerID: 'openai', id: 'gpt-6.1-sol', variant: agentID === 'build' ? 'low' : 'medium' } } }) },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    tool: { hook: async (name, fn) => { tools[name] = fn; } },
    command: { transform: async fn => fn({ add: command => { commands[command.name] = command; } }) },
    ...(event ? { event } : {}),
    model: { list: async () => ({ data: [
      { providerID: 'opencode-go', id: 'qwen3.7-plus' }, { providerID: 'openai', id: 'gpt-6.1-sol' },
    ] }) },
  };
  const auth = { binding: 'a'.repeat(64) };
  const cleanup = await setupGovernor(ctx, { collect, subscription: async () => auth.binding,
    ...(payment ? { goPaymentSafety: async () => payment } : {}), transportSafety: async () => true });
  return { hooks, tools, commands, file, ctx, auth, cleanup };
}

for (const outcome of ['succeeded', 'failed', 'interrupted']) {
  test(`2.3.2 background reservation survives tool return and child steps until execution ${outcome}`, async t => {
    const bus = new EventEmitter();
    const f = await fixture(t, 'active', { certified: true }, undefined, {
      subscribe: async function* ({ signal }) {
        for await (const [event] of on(bus, 'event', { signal })) yield event;
      },
    }, '2.3.2');
    t.after(f.cleanup);
    const started = Date.now();
    let child = { time: { busy: started } };
    f.ctx.session.get = async () => child;
    const event = { tool: 'subagent', id: 'async', sessionID: 'parent',
      input: { agent: 'general', background: true } };
    await f.tools['execute.before'](event);
    await f.tools['execute.after']({ ...event, status: 'completed',
      result: { metadata: { sessionID: 'child', status: 'running' } } });
    assert.equal(readQuotaState(f.file).leases.length, 1);
    assert.equal(readQuotaState(f.file).leases[0].sessionID, 'child');
    bus.emit('event', { type: 'session.step.ended', created: Date.now(), data: { sessionID: 'child' } });
    await new Promise(setImmediate);
    assert.equal(readQuotaState(f.file).leases.length, 1, 'a tool step is not the end of child work');
    await assert.rejects(f.tools['execute.before']({ ...event, id: 'second' }), /BEST_QUOTA_BLOCKED/);
    if (outcome === 'interrupted') await updateQuotaState(f.file, state => ({ ...state, policy: { mode: 'disabled' } }));
    child = { time: { busy: started, idle: Date.now() + 1 } };
    bus.emit('event', { type: `session.execution.${outcome}`, created: child.time.idle, data: { sessionID: 'child' } });
    await new Promise(setImmediate);
    assert.equal(readQuotaState(f.file).leases.length, 0);
    await updateQuotaState(f.file, state => ({ ...state, policy: { mode: 'active' } }));
    await f.tools['execute.before']({ ...event, id: 'after-completion', input: { agent: 'general', background: false } });
  });
}

test('2.3.2 reconciles completion before tool return; missing correlation holds capacity', async t => {
  const f = await fixture(t, 'active', { certified: true }, undefined, { subscribe: async function* () {} }, '2.3.2');
  t.after(f.cleanup);
  f.ctx.session.get = async () => ({ time: { busy: Date.now() - 1000, idle: Date.now() + 1 } });
  const event = { tool: 'subagent', id: 'fast', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](event);
  await f.tools['execute.after']({ ...event, status: 'completed', result: { metadata: { sessionID: 'child' } } });
  assert.equal(readQuotaState(f.file).leases.length, 0);
  await f.tools['execute.before']({ ...event, id: 'ambiguous' });
  await assert.rejects(f.tools['execute.after']({ ...event, id: 'ambiguous', status: 'completed', result: {} }),
    /delegation-lifecycle-unverified/);
  assert.equal(readQuotaState(f.file).leases.length, 1);
});

test('2.3.2 joins a running child without self-blocking; stale and unrelated completion cannot release it', async t => {
  const bus = new EventEmitter();
  const f = await fixture(t, 'active', { certified: true }, undefined, {
    subscribe: async function* ({ signal }) {
      for await (const [event] of on(bus, 'event', { signal })) yield event;
    },
  }, '2.3.2');
  t.after(f.cleanup);
  const started = Date.now();
  let child = { agent: 'general', model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' },
    outcome: 'succeeded', time: { busy: started, idle: started - 1000 } };
  f.ctx.session.get = async () => child;
  const event = { tool: 'subagent', id: 'initial', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](event);
  const result = { metadata: { sessionID: 'child', status: 'running' } };
  await f.tools['execute.after']({ ...event, status: 'completed', result });
  await updateQuotaState(f.file, state => {
    state.snapshots.find(snapshot => snapshot.provider === 'openai').windows.weekly.used = 90;
    state.policy.expectedPercentByKind = { coding: { openai: 6 } };
    state.leases.push({ id: 'existing-request', provider: 'openai', scope: 'admission',
      percent: 6, sessionID: 'child', ownerPid: process.pid, at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString() });
    return state;
  });
  const resume = { ...event, id: 'join', input: { agent: 'general', sessionID: 'child' } };
  await f.tools['execute.before'](resume);
  await f.tools['execute.after']({ ...resume, status: 'completed', result });
  assert.equal(readQuotaState(f.file).leases.filter(lease => lease.scope === 'routing').length, 1,
    'joining the same child must keep exactly one capacity slot');
  assert.equal(readQuotaState(f.file).leases.length, 2);
  for (const [sessionID, created] of [['child', started - 1000], ['unrelated', Date.now()]]) {
    bus.emit('event', { type: 'session.execution.succeeded', created, data: { sessionID } });
    await new Promise(setImmediate);
  }
  assert.equal(readQuotaState(f.file).leases.length, 2);
  child = { ...child, time: { busy: started, idle: Date.now() + 1 } };
  bus.emit('event', { type: 'session.execution.succeeded', created: child.time.idle, data: { sessionID: 'child' } });
  await new Promise(setImmediate);
  assert.equal(readQuotaState(f.file).leases.length, 0);
});

test('delayed terminal reconciliation preserves a newer same-session admission', async t => {
  const bus = new EventEmitter();
  const f = await fixture(t, 'active', { certified: true }, undefined, {
    subscribe: async function* ({ signal }) {
      for await (const [event] of on(bus, 'event', { signal })) yield event;
    },
  }, '2.3.2');
  t.after(f.cleanup);
  f.ctx.session.get = async () => ({ time: { busy: Date.now() } });
  const event = { tool: 'subagent', id: 'dispatch', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](event);
  await f.tools['execute.after']({ ...event, status: 'completed', result: { metadata: { sessionID: 'child' } } });
  const created = Date.now();
  let observed, release;
  const reading = new Promise(resolve => { observed = resolve; });
  f.ctx.session.get = async () => {
    observed();
    return new Promise(resolve => { release = () => resolve({ time: { busy: created - 100, idle: created } }); });
  };
  bus.emit('event', { type: 'session.execution.succeeded', created, data: { sessionID: 'child' } });
  await reading;
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.hooks['model.request']({ sessionID: 'child', agent: 'general', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } });
  const reservation = readQuotaState(f.file).leases.find(lease => lease.scope === 'admission');
  assert.ok(Date.parse(reservation.at) > created);
  release();
  await new Promise(setImmediate);
  assert.ok(readQuotaState(f.file).leases.some(lease => lease.id === reservation.id),
    'an old execution cannot release budget reserved by the next request');
  bus.emit('event', { type: 'session.step.ended', created: Date.now() + 1,
    data: { sessionID: 'child', tokens: { input: 1, output: 2 } } });
  await new Promise(setImmediate);
  assert.ok(readQuotaState(f.file).usage.some(entry => entry.requests === 0 && entry.output === 2),
    'an old execution cannot erase the next request telemetry');
});

test('internal instance receipt records actual host and observed callbacks without promoting injected tests to live proof', async t => {
  const f = await fixture(t, 'monitor');
  let receipt = readQuotaState(f.file).runtime.instances.at(-1);
  assert.equal(receipt.pid, process.pid);
  assert.equal(receipt.version, '2.2.5');
  assert.equal(receipt.origin, 'INJECTED_TEST');
  assert.ok(receipt.instanceID);
  assert.ok(receipt.registeredAt);
  assert.deepEqual(Object.keys(receipt.callbacks), ['heartbeat']);
  const event = { sessionID: 'do-not-persist-this-session', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' },
    request: new Request('http://127.0.0.1/mock', { headers: { authorization: 'Bearer do-not-persist-this-token' } }) };
  await f.hooks['model.request'](event);
  await f.hooks['http.request'](event);
  receipt = readQuotaState(f.file).runtime.instances.at(-1);
  assert.equal(receipt.callbacks['model.request'].outcome, 'MONITOR_OBSERVED');
  assert.equal(receipt.callbacks['http.request'].liveSubscription, false);
  assert.equal(JSON.stringify(receipt).includes('do-not-persist'), false);
  const id = receipt.instanceID;
  await f.cleanup();
  receipt = readQuotaState(f.file).runtime.instances.at(-1);
  assert.equal(receipt.instanceID, id);
  assert.ok(receipt.unloadedAt);
});

test('internal receipt uses the policy actually checked after an in-flight refresh', async t => {
  let pending = false, release;
  const f = await fixture(t, 'active', { certified: true }, async () => {
    if (pending) await new Promise(resolve => { release = resolve; });
    return { snapshots: [], sources: {} };
  });
  pending = true;
  const refresh = f.commands['best-quota-refresh'].execute();
  const request = f.hooks['model.request']({ sessionID: 'changing-policy', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol' } });
  await updateQuotaState(f.file, state => ({ ...state, policy: { mode: 'monitor' } }));
  release();
  await Promise.all([refresh, request]);
  const callback = readQuotaState(f.file).runtime.instances.at(-1).callbacks['model.request'];
  assert.equal(callback.mode, 'monitor');
  assert.equal(callback.outcome, 'MONITOR_OBSERVED');
});

test('internal receipt is retired even when event-stream cleanup reports a failure', async t => {
  let fail;
  const f = await fixture(t, 'monitor', { certified: true }, undefined, {
    subscribe: async function* () { await new Promise((resolve, reject) => { fail = reject; }); },
  });
  const cleanup = f.cleanup();
  fail(new Error('Synthetic event stream failure'));
  await assert.rejects(cleanup, /Synthetic event stream failure/);
  assert.ok(readQuotaState(f.file).runtime.instances.at(-1).unloadedAt);
});
test('preexisting selected Go model is stopped before dispatch; paid fallback always denied', async t => {
  const f = await fixture(t);
  await assert.rejects(f.hooks['model.request']({ sessionID: 'old', agent: 'general', kind: 'primary',
    model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } }), /BEST_QUOTA_BLOCKED/);
  await assert.rejects(f.hooks['model.request']({ sessionID: 'old', agent: 'build', kind: 'primary',
    model: { providerID: 'paid-api', id: 'cheap' } }), /BEST_QUOTA_BLOCKED/);
});
test('new General delegation routes to sustainable OpenAI, without rewriting the task', async t => {
  const f = await fixture(t);
  const event = { tool: 'subagent', sessionID: 'parent', input: { agent: 'general', prompt: 'unchanged work' } };
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(event.input.prompt, 'unchanged work');
  assert.equal(readQuotaState(f.file).decisions.at(-1).candidate.provider, 'openai');
});

test('uncalibrated MiMo is excluded from automatic delegation without blocking qualified independent work', async t => {
  const f = await fixture(t);
  f.ctx.agent.get = async ({ agentID }) => ({ data: { model: agentID === 'explore'
    ? { providerID: 'opencode-go', id: 'mimo-v2.6-flash' }
    : { providerID: 'opencode-go', id: 'qwen3.7-plus' } } });
  f.ctx.model.list = async () => ({ data: [
    { providerID: 'opencode-go', id: 'mimo-v2.6-flash' },
    { providerID: 'opencode-go', id: 'qwen3.7-plus' },
    { providerID: 'openai', id: 'gpt-6.2-sol' },
  ] });
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots[0].windows)) window.used = 10;
    return state;
  });
  const event = { tool: 'subagent', id: 'discovery', sessionID: 'parent', input: { agent: 'explore' } };
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.2-sol#low');
  const model = { providerID: 'openai', id: 'gpt-6.2-sol', variant: 'low' };
  const request = { sessionID: 'child', agent: 'explore', kind: 'primary', model };
  await f.hooks['model.request'](request);
  await assert.rejects(f.hooks['model.request']({ ...request, model: { ...model, variant: 'medium' } }), /BEST_QUOTA_BLOCKED/);
  await f.tools['execute.after'](event);
  f.ctx.session.get = async () => ({ agent: 'explore', model });
  const resume = { ...event, input: { agent: 'explore', sessionID: 'child' } };
  await f.tools['execute.before'](resume);
  assert.equal(resume.input.model, undefined);
  await f.tools['execute.after'](resume);
  await f.tools['execute.before']({ tool: 'subagent', id: 'coding', sessionID: 'parent', input: { agent: 'general' } });
  await updateQuotaState(f.file, state => {
    const [go] = state.snapshots;
    for (const window of Object.values(go.windows)) window.used = 95;
    const at = Date.parse(go.at);
    state.snapshots.push({ ...structuredClone(go), at: new Date(at - 60000).toISOString() });
    state.usage.push({ at: new Date(at - 1000).toISOString(), provider: go.provider,
      model: 'opencode-go/mimo-v2.6-flash', connection: go.connection, requests: 1 });
    state.usage.push({ ...state.usage.at(-1), at: go.at, requests: 0, durationMs: 1000 });
    return state;
  });
  const critical = { ...event, input: { agent: 'explore' } };
  await f.tools['execute.before'](critical);
  assert.equal(critical.input.model, 'opencode-go/mimo-v2.6-flash');
  await f.tools['execute.after'](critical);
  await updateQuotaState(f.file, state => {
    for (const snapshot of state.snapshots) {
      if (snapshot.provider === 'opencode-go') snapshot.windows.monthly.used = 100;
    }
    return state;
  });
  await f.tools['execute.before'](critical);
  assert.equal(critical.input.model, 'openai/gpt-6.2-sol#low');
  await f.tools['execute.after'](critical);
  await updateQuotaState(f.file, state => {
    state.snapshots.find(s => s.provider === 'openai').windows.weekly.used = 100;
    return state;
  });
  await assert.rejects(f.tools['execute.before'](critical), /quota-unavailable/);
});
test('monitor records decisions but does not change execution; retry governor never retries quota denial', async t => {
  const f = await fixture(t, 'monitor');
  const event = { tool: 'subagent', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, undefined);
  const retry = { error: { message: 'BEST_QUOTA_BLOCKED', status: 429 }, decision: { retry: true, delay: 0 } };
  await f.hooks.retry(retry);
  assert.equal(retry.decision.retry, true, 'monitor must not alter retries');
  const safety = { error: { type: 'provider.transport',
    message: 'misalignment_policy_violation: Potentially unintended activity' }, decision: { retry: true } };
  await f.hooks.retry(safety);
  assert.equal(safety.decision.retry, false, 'provider safety denials are terminal even in monitor');
  await updateQuotaState(f.file, state => ({ ...state, policy: { ...state.policy, mode: 'active' } }));
  const invalid = { error: { type: 'provider.invalid-request', code: 'misalignment_policy_violation' },
    decision: { retry: true } };
  await f.hooks.retry(invalid);
  assert.deepEqual(invalid.decision, { retry: false });
  const transient = { error: { type: 'provider.transport', status: 503 },
    decision: { retry: true, delay: 1000 } };
  await f.hooks.retry(transient);
  assert.deepEqual(transient.decision, { retry: true, delay: 1000 });
});

test('stale telemetry suspends the next model boundary of both admitted and new tasks', async t => {
  const f = await fixture(t);
  const event = { sessionID: 'running', agent: 'build', kind: 'primary', model: { providerID: 'openai', id: 'gpt-6.1-sol' } };
  await f.hooks['model.request'](event);
  await updateQuotaState(f.file, state => {
    for (const snapshot of state.snapshots) snapshot.at = new Date(Date.now() - 20 * 60000).toISOString();
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
  await assert.rejects(f.hooks['model.request']({ ...event, sessionID: 'new' }), /BEST_QUOTA_BLOCKED/);
});

test('concurrent subagents reserve provider slots atomically, and release after completion', async t => {
  const f = await fixture(t);
  const events = ['a', 'b'].map(id => ({ id, sessionID: 'parent', tool: 'subagent', input: { agent: 'general' } }));
  const results = await Promise.allSettled(events.map(e => f.tools['execute.before'](e)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const successful = results.findIndex(r => r.status === 'fulfilled');
  await f.tools['execute.after'](events[successful]);
  await f.tools['execute.before']({ id: 'c', sessionID: 'parent', tool: 'subagent', input: { agent: 'general' } });
});

test('account change, OpenAI API-key channel and unqualified runtime cannot reuse old quotas', async t => {
  const f = await fixture(t);
  const event = { sessionID: 'selected', agent: 'build', kind: 'primary', model: { providerID: 'openai', id: 'gpt-6.1-sol' } };
  await updateQuotaState(f.file, state => { state.snapshots.forEach(s => { s.connection = 'b'.repeat(64); }); return state; });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
  f.ctx.app.version = '2.2.6';
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
});

test('dispatch admissions do not overwrite General routing cooldown', async t => {
  const f = await fixture(t);
  const first = { tool: 'subagent', id: 'one', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](first);
  await f.hooks['model.request']({ sessionID: 'child', agent: 'general', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } });
  await f.tools['execute.after'](first);
  await updateQuotaState(f.file, state => {
    const go = state.snapshots.find(s => s.provider === 'opencode-go');
    for (const window of Object.values(go.windows)) window.used = 10;
    return state;
  });
  const second = { tool: 'subagent', id: 'two', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](second);
  assert.equal(second.input.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(readQuotaState(f.file).decisions.at(-1).reason, 'quota-hysteresis');
});

test('loading disabled still registers a guard for later activation in the same process', async t => {
  const f = await fixture(t, 'disabled');
  await updateQuotaState(f.file, state => ({ ...state, policy: { mode: 'active' } }));
  assert.equal(typeof f.hooks['model.request'], 'function');
  await assert.rejects(f.hooks['model.request']({ sessionID: 'later', agent: 'build', kind: 'primary',
    model: { providerID: 'paid-api', id: 'cheap' } }), /BEST_QUOTA_BLOCKED/);
});

test('live worker reservations do not expire merely because ten minutes elapsed', async t => {
  const f = await fixture(t);
  const first = { tool: 'subagent', id: 'one', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](first);
  await updateQuotaState(f.file, state => { state.leases[0].expiresAt = new Date(Date.now() - 1).toISOString(); return state; });
  await assert.rejects(f.tools['execute.before']({ ...first, id: 'two', input: { agent: 'general' } }), /BEST_QUOTA_BLOCKED/);
  await f.tools['execute.after'](first);
  await f.tools['execute.before']({ ...first, id: 'three', input: { agent: 'general' } });
});

test('completion releases an already acquired reservation even while policy is disabled', async t => {
  const f = await fixture(t);
  const first = { tool: 'subagent', id: 'one', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](first);
  await updateQuotaState(f.file, state => ({ ...state, policy: { mode: 'disabled' } }));
  await f.tools['execute.after'](first);
  assert.equal(readQuotaState(f.file).leases.length, 0);
  await updateQuotaState(f.file, state => ({ ...state, policy: { mode: 'active' } }));
  await f.tools['execute.before']({ ...first, id: 'two', input: { agent: 'general' } });
});

test('a pinned task cannot hide a confirmed limit behind UNKNOWN telemetry', async t => {
  const f = await fixture(t);
  const event = { sessionID: 'running', agent: 'build', kind: 'primary', model: { providerID: 'openai', id: 'gpt-6.1-sol' } };
  await f.hooks['model.request'](event);
  await updateQuotaState(f.file, state => {
    const ai = state.snapshots.find(s => s.provider === 'openai');
    ai.allowed = false;
    ai.windows.weekly.resetAt = new Date(Date.now() - 1).toISOString();
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
});

test('new account needs new admission even for a previously pinned model', async t => {
  const f = await fixture(t);
  const event = { sessionID: 'running', agent: 'build', kind: 'primary', model: { providerID: 'openai', id: 'gpt-6.1-sol' } };
  await f.hooks['model.request'](event);
  f.auth.binding = 'b'.repeat(64);
  await updateQuotaState(f.file, state => {
    const ai = state.snapshots.find(s => s.provider === 'openai');
    ai.connection = f.auth.binding;
    ai.windows.weekly.used = 100;
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
});

test('MiniMax continuity compaction is preserved, never an implementation fallback', async t => {
  const f = await fixture(t);
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots[0].windows)) window.used = 20;
    return state;
  });
  const event = { sessionID: 'compacting', agent: 'build', kind: 'compaction', model: { providerID: 'opencode-go', id: 'minimax-m3' } };
  await f.hooks['model.request'](event);
  await assert.rejects(f.hooks['model.request']({ ...event, kind: 'primary' }), /BEST_QUOTA_BLOCKED/);
});

test('uncertified Go billing is denied even with abundant quota and a pinned live connection', async t => {
  const f = await fixture(t, 'active', { certified: false });
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots[0].windows)) window.used = 10;
    return state;
  });
  await assert.rejects(f.hooks['model.request']({ sessionID: 'manual', agent: 'general', kind: 'primary',
    model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } }), /BEST_QUOTA_BLOCKED/);
});

test('runtime accepts a persistent manual_user_confirmed declaration and denies expired-format, revoked or different subscription identities', async t => {
  const f = await fixture(t, 'active', null);
  const now = Date.now();
  const declaration = (connection, confirmedBy = 'requesting_user') => ({ id: '12345678-1234-1234-1234-123456789abc',
    source: 'manual_user_confirmed', status: 'OFF', provider: 'opencode-go', confirmedBy, connection,
    confirmedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() });
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots[0].windows)) window.used = 10;
    state.sources['opencode-go'] = { connection: 'a'.repeat(64), status: 'LIVE' };
    state.extraUsageConfirmations = [declaration('a'.repeat(64))];
    return state;
  });
  const event = { sessionID: 'confirmed', agent: 'general', kind: 'primary',
    model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } };
  await f.hooks['model.request'](event);
  // The stored window is a format legacy, not a lifetime: a past expiresAt
  // does not re-expire the declaration.
  await updateQuotaState(f.file, state => {
    state.extraUsageConfirmations[0].expiresAt = new Date(now - 1).toISOString();
    return state;
  });
  await f.hooks['model.request'](event);
  // Another subscription identity never inherits the declaration.
  await updateQuotaState(f.file, state => {
    state.extraUsageConfirmations[0].connection = 'b'.repeat(64);
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
  // An explicit revocation fails closed immediately, keeping the old entry.
  await updateQuotaState(f.file, state => {
    state.extraUsageConfirmations.push({ ...declaration('0'.repeat(64), 'revoked.requesting_user'),
      id: '22222222-2222-4222-8222-222222222222', confirmedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString() });
    return state;
  });
  assert.equal(readQuotaState(f.file).extraUsageConfirmations.length, 2);
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
  // Re-confirming the same identity restores the persistent declaration.
  await updateQuotaState(f.file, state => {
    state.extraUsageConfirmations.push(declaration('a'.repeat(64)));
    return state;
  });
  await f.hooks['model.request'](event);
});

test('a fully exhausted quota suspends a long running task at the next request, not during a file tool', async t => {
  const f = await fixture(t);
  const event = { sessionID: 'long', agent: 'build', kind: 'primary', model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } };
  await f.hooks['model.request'](event);
  await updateQuotaState(f.file, state => {
    state.snapshots.find(s => s.provider === 'openai').windows.weekly.used = 100;
    return state;
  });
  await f.tools['execute.before']({ tool: 'patch', sessionID: 'long', input: { operation: 'already started' } });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
});

test('HTTP retries and WebSocket handshakes recheck prepared requests without rewriting transport', async t => {
  const f = await fixture(t);
  const event = { sessionID: 'physical', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' },
    request: new Request('http://127.0.0.1/mock', { headers: { 'x-test': 'unchanged' } }) };
  await f.hooks['http.request'](event);
  assert.equal(event.request.headers.get('x-test'), 'unchanged');
  await updateQuotaState(f.file, state => {
    state.snapshots.find(s => s.provider === 'openai').windows.weekly.used = 100;
    return state;
  });
  await assert.rejects(f.hooks['http.request'](event), /BEST_QUOTA_BLOCKED/);
  await assert.rejects(f.hooks['experimental.ws.handshake']({ ...event, url: 'wss://example.test', headers: {} }), /BEST_QUOTA_BLOCKED/);
});

test('native child resume keeps its selected model and cannot silently route off an exhausted provider', async t => {
  const f = await fixture(t);
  f.ctx.session.get = async () => ({ agent: 'general', model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } });
  const event = { tool: 'subagent', id: 'resume', sessionID: 'parent',
    input: { agent: 'general', sessionID: 'existing-child', prompt: 'continue only' } };
  await assert.rejects(f.tools['execute.before'](event), /BEST_QUOTA_BLOCKED/);
  assert.equal(event.input.model, undefined);
  assert.equal(event.input.sessionID, 'existing-child');
});

test('request telemetry preserves actual Sol variants without deriving percentages from tokens', async t => {
  const f = await fixture(t, 'monitor');
  await f.hooks['model.request']({ sessionID: 'low', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } });
  await f.hooks['model.request']({ sessionID: 'medium', agent: 'reviewer', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } });
  assert.deepEqual(readQuotaState(f.file).usage.map(u => [u.variant, u.activityClass]), [
    ['low', 'coordination-sol-low'], ['medium', 'analysis-review-sol-medium'],
  ]);
});

// --- Prompt-time regulation: the recommendation must become the model the turn runs on.

const promptSession = (over = {}) => ({ id: 'ses_prompt', agent: 'general',
  model: { providerID: 'opencode-go', id: 'qwen3.7-plus' }, ...over });
const routingDecisions = file => readQuotaState(file).decisions.filter(d => d.scope === 'routing');
const healthyGo = file => updateQuotaState(file, state => {
  for (const window of Object.values(state.snapshots.find(s => s.provider === 'opencode-go').windows)) window.used = 10;
  return state;
});

test('active prompt routing switches a General session off exhausted Go and the turn runs on the applied model', async t => {
  const f = await fixture(t);
  const switches = [];
  f.ctx.session.get = async () => promptSession();
  f.ctx.session.switchModel = async input => switches.push(input);
  await f.hooks['prompt']({ sessionID: 'ses_prompt' });
  assert.deepEqual(switches, [{ sessionID: 'ses_prompt',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } }]);
  const last = routingDecisions(f.file).at(-1);
  assert.equal(last.blocked, false);
  assert.equal(last.enforced, true);
  assert.equal(last.candidate.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(last.applied, last.candidate.model, 'applied is the recommendation itself');
  // Prompt routing decides, it does not hold capacity: only real admissions do.
  assert.equal(readQuotaState(f.file).leases.length, 0);
  // The next native request is checked against the model that was applied.
  await f.hooks['model.request']({ sessionID: 'ses_prompt', agent: 'general', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } });
  const receipt = readQuotaState(f.file).runtime.instances.at(-1).callbacks;
  assert.equal(receipt.prompt.outcome, 'APPLIED');
  assert.equal(receipt.prompt.mode, 'active');
  assert.equal(receipt.prompt.liveSubscription, false, 'a prompt is not transport proof');
  assert.equal(receipt['model.request'].outcome, 'PASSED');
});

test('a healthy configured Go route is kept: no switch, applied equals recommendation', async t => {
  const f = await fixture(t);
  await healthyGo(f.file);
  const switches = [];
  f.ctx.session.get = async () => promptSession();
  f.ctx.session.switchModel = async input => switches.push(input);
  await f.hooks['prompt']({ sessionID: 'ses_prompt' });
  assert.equal(switches.length, 0, 'the session is already on the recommended model');
  const last = routingDecisions(f.file).at(-1);
  assert.equal(last.candidate.model, 'opencode-go/qwen3.7-plus');
  assert.equal(last.applied, last.candidate.model);
  assert.equal(readQuotaState(f.file).leases.length, 0);
});

test('a continued prompt stays on the model already applied instead of re-switching every turn', async t => {
  const f = await fixture(t);
  const switches = [];
  let model = { providerID: 'opencode-go', id: 'qwen3.7-plus' };
  f.ctx.session.get = async () => promptSession({ model });
  f.ctx.session.switchModel = async input => { switches.push(input); model = input.model; };
  await f.hooks['prompt']({ sessionID: 'ses_prompt' });
  await f.hooks['prompt']({ sessionID: 'ses_prompt' });
  assert.equal(switches.length, 1, 'one switch, then the applied model is reused');
  const routing = routingDecisions(f.file);
  assert.equal(routing.length, 2, 'each continuation still records its own decision');
  assert.ok(routing.every(d => d.applied === d.candidate.model));
});

test('monitor mode records the routing recommendation and never switches the session', async t => {
  const f = await fixture(t, 'monitor');
  const switches = [];
  f.ctx.session.get = async () => promptSession();
  f.ctx.session.switchModel = async input => switches.push(input);
  await f.hooks['prompt']({ sessionID: 'ses_prompt' });
  assert.equal(switches.length, 0);
  const last = routingDecisions(f.file).at(-1);
  assert.equal(last.enforced, false);
  assert.equal(last.applied, undefined, 'monitor never claims an applied model');
  const receipt = readQuotaState(f.file).runtime.instances.at(-1).callbacks.prompt;
  assert.equal(receipt.outcome, 'MONITOR_OBSERVED');
  assert.equal(receipt.mode, 'monitor');
});

test('a delegated child prompt is skipped so execute.before stays its only router', async t => {
  const f = await fixture(t);
  f.ctx.session.get = async () => promptSession({ parentID: 'ses_parent' });
  f.ctx.session.switchModel = async () => { throw new Error('a child must not be re-routed at prompt time'); };
  await f.hooks['prompt']({ sessionID: 'ses_child' });
  assert.equal(routingDecisions(f.file).length, 0);
  assert.equal(readQuotaState(f.file).runtime.instances.at(-1).callbacks.prompt.outcome, 'SKIPPED');
  // Dispatch-time routing of a new delegation is unchanged.
  const event = { tool: 'subagent', sessionID: 'parent', input: { agent: 'general', prompt: 'unchanged work' } };
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium');
  await f.hooks['prompt']({ sessionID: 'ses_child' });
  assert.equal(routingDecisions(f.file).length, 1, 'the child adds no second routing decision');
});

test('Specialist and Reviewer route and admit their configured Sol Medium', async t => {
  const f = await fixture(t);
  for (const agent of ['specialist', 'reviewer']) {
    const event = { tool: 'subagent', id: agent, sessionID: 'parent', input: { agent } };
    await f.tools['execute.before'](event);
    assert.equal(event.input.model, 'openai/gpt-6.1-sol#medium');
    const request = { sessionID: agent, agent, kind: 'primary',
      model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } };
    await f.hooks['model.request'](request);
    assert.equal(readQuotaState(f.file).decisions.at(-1).blocked, false);
    await f.tools['execute.after'](event);
    // End the synthetic request before testing another worker on the same slot.
    await updateQuotaState(f.file, state => ({ ...state,
      leases: state.leases.filter(lease => lease.sessionID !== agent) }));
  }
});

test('Build keeps explicit Low, Medium or High on the configured subscription', async t => {
  const f = await fixture(t);
  f.ctx.session.switchModel = async () => { assert.fail('must not reset the selected variant'); };
  for (const variant of ['low', 'medium', 'high']) {
    await seedSolCalibration(f.file);
    f.ctx.agent.get = async () => ({ data: { model: { providerID: 'openai', id: 'gpt-6.1-sol',
      variant: variant === 'low' ? 'medium' : 'low' } } });
    f.ctx.session.get = async () => promptSession({ agent: 'build',
      model: { providerID: 'openai', id: 'gpt-6.1-sol', variant } });
    await f.hooks.prompt({ sessionID: 'ses_build' });
    assert.equal(routingDecisions(f.file).at(-1).applied, `openai/gpt-6.1-sol#${variant}`);
  }
});

async function seedSolCalibration(file) {
  await updateQuotaState(file, state => {
    const at = Date.now();
    const ai = state.snapshots.find(s => s.provider === 'openai');
    state.snapshots = state.snapshots.filter(s => s.provider !== 'openai');
    state.snapshots.push({ ...structuredClone(ai), at: new Date(at - 60000).toISOString() },
      { ...structuredClone(ai), at: new Date(at).toISOString() });
    state.usage.push({ at: new Date(at - 30000).toISOString(), provider: 'openai',
      model: 'openai/gpt-6.2-sol', variant: 'medium', connection: 'a'.repeat(64), requests: 1 });
    return state;
  });
}

test('High bootstrap reserves a conservative observed envelope and fails closed without calibration', async t => {
  const f = await fixture(t);
  f.ctx.agent.get = async () => ({ data: { model: { providerID: 'openai', id: 'gpt-6.2-sol', variant: 'medium' } } });
  const request = { sessionID: 'high-probe', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.2-sol', variant: 'high' } };
  await assert.rejects(f.hooks['model.request'](request), /calibrated-request-envelope/);
  await seedSolCalibration(f.file);
  await f.hooks['model.request'](request);
  const state = readQuotaState(f.file);
  assert.equal(classifyActivity(state.usage.at(-1)), 'reasoning-sol-high');
  assert.equal(state.usage.at(-1).activityClass, undefined, 'old running governors must still read the shared state');
  assert.ok(state.leases.find(l => l.sessionID === request.sessionID).percent >= 15);
  await updateQuotaState(f.file, s => ({ ...s, leases: [...s.leases, {
    id: 'other-high', scope: 'admission', provider: 'openai', percent: 66,
    at: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), ownerPid: process.pid,
  }] }));
  await assert.rejects(f.hooks['model.request']({ ...request, sessionID: 'second' }), /calibrated-request-envelope/);
});

test('active prompt stops a Build turn with no admissible provider instead of dispatching unregulated', async t => {
  const f = await fixture(t);
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots.find(s => s.provider === 'openai').windows)) window.used = 100;
    return state;
  });
  f.ctx.session.get = async () => promptSession({ agent: 'build',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } });
  f.ctx.session.switchModel = async () => { throw new Error('an unregulated turn must not start'); };
  await assert.rejects(f.hooks['prompt']({ sessionID: 'ses_build' }), /BEST_QUOTA_BLOCKED/);
  assert.equal(readQuotaState(f.file).runtime.instances.at(-1).callbacks.prompt.outcome, 'BLOCKED');
  const last = routingDecisions(f.file).at(-1);
  assert.equal(last.blocked, true, 'the report still shows why the turn stopped');
});

test('Visual keeps its Go GLM floor: applied when Go is healthy, blocked when Go is exhausted', async t => {
  const f = await fixture(t);
  f.ctx.agent.get = async ({ agentID }) => ({ data: { model: agentID === 'visual-designer'
    ? { providerID: 'opencode-go', id: 'glm-5.3-flash' } : { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } } });
  f.ctx.model.list = async () => ({ data: [
    { providerID: 'opencode-go', id: 'glm-5.3-flash' }, { providerID: 'opencode-go', id: 'qwen3.7-plus' },
    { providerID: 'openai', id: 'gpt-6.1-sol' },
  ] });
  const switches = [];
  let model = { providerID: 'opencode-go', id: 'glm-5.3-flash' };
  f.ctx.session.get = async () => promptSession({ agent: 'visual-designer', model });
  f.ctx.session.switchModel = async input => { switches.push(input); model = input.model; };
  // The fixture exhausts Go, so the only admissible visual model is gone.
  await assert.rejects(f.hooks['prompt']({ sessionID: 'ses_visual' }), /BEST_QUOTA_BLOCKED/);
  await healthyGo(f.file);
  await f.hooks['prompt']({ sessionID: 'ses_visual' });
  assert.equal(switches.length, 0, 'already on the only admissible visual model');
  const last = routingDecisions(f.file).at(-1);
  assert.equal(last.candidate.model, 'opencode-go/glm-5.3-flash');
  assert.equal(last.applied, last.candidate.model);
});

test('a live reservation from another instance stops this one from double-spending the same headroom', async t => {
  const f = await fixture(t);
  await healthyGo(f.file);
  const switches = [];
  f.ctx.session.get = async () => promptSession();
  f.ctx.session.switchModel = async input => switches.push(input);
  // Another live BEST instance already holds 90 of Go's 90 remaining points.
  await updateQuotaState(f.file, state => ({ ...state, leases: [...(state.leases ?? []), {
    id: 'other-instance-go', provider: 'opencode-go', scope: 'admission', percent: 90,
    ownerPid: 1, sessionID: 'other-instance', at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  }] }));
  await f.hooks['prompt']({ sessionID: 'ses_prompt' });
  assert.deepEqual(switches, [{ sessionID: 'ses_prompt',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'medium' } }],
  'routing yields to the headroom the other instance already committed');
  const last = routingDecisions(f.file).at(-1);
  assert.equal(last.candidate.provider, 'openai');
  assert.equal(last.applied, last.candidate.model);
  const leases = readQuotaState(f.file).leases;
  assert.equal(leases.length, 1, 'only our own routing lease was released');
  assert.equal(leases[0].id, 'other-instance-go');
});

test('a bounded calibrated request can use the routing margin but not another request’s reserved budget', async t => {
  const f = await fixture(t);
  await updateQuotaState(f.file, state => {
    const ai = state.snapshots.find(s => s.provider === 'openai');
    ai.windows.weekly.used = 59;
    const at = Date.now();
    ai.at = new Date(at).toISOString();
    state.snapshots.push({ ...structuredClone(ai), at: new Date(at - 60000).toISOString() });
    state.usage.push({ at: new Date(at).toISOString(), provider: 'openai', model: 'openai/gpt-6.1-sol',
      variant: 'low', activityClass: 'coordination-sol-low', connection: 'a'.repeat(64), durationMs: 3600000, requests: 0 });
    return state;
  });
  const request = { sessionID: 'first', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } };
  const outcomes = await Promise.allSettled([f.hooks['model.request'](request),
    f.hooks['model.request']({ ...request, sessionID: 'second' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /calibrated-request-envelope/);
  const [lease] = readQuotaState(f.file).leases;
  assert.ok(lease.percent > 26 && lease.percent <= 41);
  await updateQuotaState(f.file, state => {
    state.leases = [];
    for (const snapshot of state.snapshots.filter(s => s.provider === 'openai')) snapshot.windows.weekly.used = 80;
    return state;
  });
  await assert.rejects(f.hooks['model.request'](request), /calibrated-request-envelope/);
});
