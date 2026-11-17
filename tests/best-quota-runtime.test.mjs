import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupGovernor } from '../shared/best-quota-runtime.mjs';
import { updateQuotaState, readQuotaState } from '../shared/best-quota.mjs';

async function fixture(t, mode = 'active', payment = { certified: true }, collect = async () => ({ snapshots: [], sources: {} }), event) {
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
  const ctx = { app: { version: '2.2.5' }, options: { stateFile: file },
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

test('internal instance receipt records actual host and observed callbacks without promoting injected tests to live proof', async t => {
  const f = await fixture(t, 'monitor');
  let receipt = readQuotaState(f.file).runtime.instances.at(-1);
  assert.equal(receipt.pid, process.pid);
  assert.equal(receipt.version, '2.2.5');
  assert.equal(receipt.origin, 'INJECTED_TEST');
  assert.ok(receipt.instanceID);
  assert.ok(receipt.registeredAt);
  assert.deepEqual(receipt.callbacks, {});
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
    { providerID: 'openai', id: 'gpt-6.1-sol' },
  ] });
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots[0].windows)) window.used = 10;
    return state;
  });
  await assert.rejects(f.tools['execute.before']({ tool: 'subagent', id: 'discovery', sessionID: 'parent',
    input: { agent: 'explore' } }), /BEST_QUOTA_BLOCKED/);
  await f.tools['execute.before']({ tool: 'subagent', id: 'coding', sessionID: 'parent', input: { agent: 'general' } });
});
test('monitor records decisions but does not change execution; retry governor never retries quota denial', async t => {
  const f = await fixture(t, 'monitor');
  const event = { tool: 'subagent', sessionID: 'parent', input: { agent: 'general' } };
  await f.tools['execute.before'](event);
  assert.equal(event.input.model, undefined);
  const retry = { error: { message: 'BEST_QUOTA_BLOCKED', status: 429 }, decision: { retry: true, delay: 0 } };
  await f.hooks.retry(retry);
  assert.equal(retry.decision.retry, true, 'monitor must not alter retries');
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

test('runtime accepts a valid manual_user_confirmed declaration but denies expired or different subscription identities', async t => {
  const f = await fixture(t, 'active', null);
  const now = Date.now();
  await updateQuotaState(f.file, state => {
    for (const window of Object.values(state.snapshots[0].windows)) window.used = 10;
    state.sources['opencode-go'] = { connection: 'a'.repeat(64), status: 'LIVE' };
    state.extraUsageConfirmations = [{ id: '12345678-1234-1234-1234-123456789abc', source: 'manual_user_confirmed',
      status: 'OFF', confirmedBy: 'requesting_user', connection: 'a'.repeat(64),
      confirmedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() }];
    return state;
  });
  const event = { sessionID: 'confirmed', agent: 'general', kind: 'primary',
    model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } };
  await f.hooks['model.request'](event);
  await updateQuotaState(f.file, state => {
    state.extraUsageConfirmations[0].expiresAt = new Date(now - 1).toISOString();
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
  await updateQuotaState(f.file, state => {
    state.extraUsageConfirmations[0].expiresAt = new Date(now + 60000).toISOString();
    state.extraUsageConfirmations[0].connection = 'b'.repeat(64);
    return state;
  });
  await assert.rejects(f.hooks['model.request'](event), /BEST_QUOTA_BLOCKED/);
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

test('a calibrated next-request envelope must fit every residual window, even when raw quota state is NORMAL', async t => {
  const f = await fixture(t);
  await updateQuotaState(f.file, state => {
    const ai = state.snapshots.find(s => s.provider === 'openai');
    const at = Date.now();
    ai.at = new Date(at).toISOString();
    state.snapshots.push({ ...structuredClone(ai), at: new Date(at - 60000).toISOString() });
    state.usage.push({ at: new Date(at).toISOString(), provider: 'openai', model: 'openai/gpt-6.1-sol',
      variant: 'low', activityClass: 'coordination-sol-low', connection: 'a'.repeat(64), durationMs: 3600000, requests: 0 });
    return state;
  });
  await assert.rejects(f.hooks['model.request']({ sessionID: 'large-next', agent: 'build', kind: 'primary',
    model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' } }), /calibrated-request-envelope/);
});
