import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectQuotas, subscriptionConnection, verifySubscriptionTransport } from '../shared/best-quota-sources.mjs';

const now = Date.now();
const meter = { percent: 30, resetsAt: new Date(now + 86400000).toISOString() };
function context(values) {
  return { integration: { connection: {
    active: async id => values[id] ? { id } : undefined,
    resolve: async connection => values[connection.id],
  } } };
}
test('sources use runtime credentials only, fixed GET destinations and sanitized metadata', async () => {
  const calls = [];
  const result = await collectQuotas(context({
    opencode: { type: 'key', key: 'test-go-secret', metadata: { orgID: 'workspace' } },
    openai: { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'test-oauth-secret', expires: now + 60000 },
  }), { now, fetch: async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.includes('opencode.ai') ? { usage: { rolling: meter, weekly: meter, monthly: meter } }
      : { rate_limit: { secondary_window: { used_percent: 20, reset_at: Math.floor(now / 1000) + 604800, limit_window_seconds: 604800 } } });
  } });
  assert.equal(result.snapshots.length, 2);
  assert.deepEqual(calls.map(c => c.url), ['https://opencode.ai/zen/go/v1/usage', 'https://chatgpt.com/backend-api/wham/usage']);
  assert.ok(calls.every(c => c.init.method === 'GET' && c.init.redirect === 'error'));
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('OpenAI API keys are not subscription credentials; endpoint failure retains no error body', async () => {
  let calls = 0;
  const result = await collectQuotas(context({ openai: { type: 'key', key: 'secret' },
    opencode: { type: 'key', key: 'secret' } }), { now,
    fetch: async () => { calls++; return new Response('secret diagnostic', { status: 503 }); } });
  assert.equal(calls, 1);
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.sources.openai.status, 'UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('subscription identity changes with account/method, never with token rotation, and API keys are refused', async () => {
  const value = { type: 'oauth', methodID: 'codex', access: 'secret-one', metadata: { accountID: 'one' } };
  const ctx = context({ openai: value });
  const original = await subscriptionConnection(ctx, 'openai');
  value.access = 'secret-two';
  assert.equal(await subscriptionConnection(ctx, 'openai'), original);
  value.metadata.accountID = 'two';
  assert.notEqual(await subscriptionConnection(ctx, 'openai'), original);
  value.type = 'key';
  assert.equal(await subscriptionConnection(ctx, 'openai'), null);
});

test('credential resolution failures become a denied connection without exporting diagnostics', async () => {
  const ctx = { integration: { connection: { active: async () => ({ id: 'test' }),
    resolve: async () => { throw new Error('sensitive-auth-diagnostic'); } } } };
  assert.equal(await subscriptionConnection(ctx, 'openai'), null);
});

test('actual transport must match both subscription destination and the active runtime OAuth credential', async () => {
  const ctx = context({ openai: { type: 'oauth', methodID: 'codex', access: 'mock-subscription', expires: Date.now() + 60000 } });
  const event = { model: { providerID: 'openai' }, request: new Request('https://chatgpt.com/backend-api/codex/responses',
    { headers: { Authorization: 'Bearer mock-subscription' } }) };
  assert.equal(await verifySubscriptionTransport(ctx, event), true);
  assert.equal(await verifySubscriptionTransport(ctx, { ...event, request: new Request('https://api.openai.com/v1/responses',
    { headers: { Authorization: 'Bearer mock-subscription' } }) }), false);
  assert.equal(await verifySubscriptionTransport(ctx, { ...event, request: new Request(event.request.url,
    { headers: { Authorization: 'Bearer mock-paid-key' } }) }), false);
  assert.equal(await verifySubscriptionTransport(ctx, { model: event.model, url: 'wss://chatgpt.com/backend-api/codex/responses',
    headers: { authorization: 'Bearer mock-subscription' } }), true);
});

test('transport account and workspace selectors must match the identity used to collect quotas', async () => {
  const ctx = context({ openai: { type: 'oauth', methodID: 'codex', access: 'mock-subscription',
    expires: Date.now() + 60000, metadata: { accountID: 'quota-account' } },
    opencode: { type: 'key', key: 'mock-go', metadata: { orgID: 'quota-workspace' } } });
  for (const [providerID, url, token, header, expected] of [
    ['openai', 'https://chatgpt.com/backend-api/codex/responses', 'mock-subscription', 'ChatGPT-Account-Id', 'quota-account'],
    ['opencode-go', 'https://opencode.ai/inference/go/openai/v1/chat/completions', 'mock-go', 'x-opencode-org-id', 'quota-workspace'],
  ]) {
    for (const [selector, allowed] of [[expected, true], [null, false], ['other-account', false]]) {
      const headers = { Authorization: `Bearer ${token}`, ...(selector ? { [header]: selector } : {}) };
      assert.equal(await verifySubscriptionTransport(ctx, { model: { providerID }, request: new Request(url, { headers }) }), allowed);
    }
  }
});

test('Go SDK auth variants carry the same resolved credential without opening a foreign route', async () => {
  const ctx = context({ opencode: { type: 'key', key: 'mock-go', metadata: { orgID: 'quota-workspace' } },
    openai: { type: 'oauth', methodID: 'codex', access: 'mock-subscription', expires: now + 60000 } });
  const go = (url, headers) => verifySubscriptionTransport(ctx, { model: { providerID: 'opencode-go' },
    request: new Request(url, { headers }) });
  // Anthropic SDK (qwen3.7-plus, minimax-m3): x-api-key, no Bearer.
  assert.equal(await go('https://opencode.ai/inference/go/anthropic/v1/messages',
    { 'x-api-key': 'mock-go', 'x-opencode-org-id': 'quota-workspace' }), true);
  // Google SDK (gemini-4-argon-contributor): x-goog-api-key, no Bearer.
  assert.equal(await go('https://opencode.ai/inference/go/google/v1beta/models/x:generateContent',
    { 'x-goog-api-key': 'mock-go', 'x-opencode-org-id': 'quota-workspace' }), true);
  // A different or absent credential still fails closed on every SDK form.
  assert.equal(await go('https://opencode.ai/inference/go/anthropic/v1/messages',
    { 'x-api-key': 'mock-paid-key', 'x-opencode-org-id': 'quota-workspace' }), false);
  assert.equal(await go('https://opencode.ai/inference/go/anthropic/v1/messages',
    { 'x-opencode-org-id': 'quota-workspace' }), false);
  assert.equal(await go('https://opencode.ai/inference/go/google/v1beta/models/x:generateContent',
    { 'x-goog-api-key': 'mock-paid-key', 'x-opencode-org-id': 'quota-workspace' }), false);
  // The workspace selector keeps binding every SDK form.
  assert.equal(await go('https://opencode.ai/inference/go/anthropic/v1/messages',
    { 'x-api-key': 'mock-go', 'x-opencode-org-id': 'other-workspace' }), false);
  // Off-route destinations stay denied even with a valid credential.
  assert.equal(await go('https://evil.example.com/inference/go/anthropic/v1/messages',
    { 'x-api-key': 'mock-go', 'x-opencode-org-id': 'quota-workspace' }), false);
  // The ChatGPT transport still requires Bearer; x-api-key is never enough there.
  assert.equal(await verifySubscriptionTransport(ctx, { model: { providerID: 'openai' },
    request: new Request('https://chatgpt.com/backend-api/codex/responses',
      { headers: { 'x-api-key': 'mock-subscription' } }) }), false);
});

test('native V2 browser and headless accountID binds quota collection and physical transport to the same account', async () => {
  for (const methodID of ['chatgpt-browser', 'chatgpt-headless']) {
    const ctx = context({ openai: { type: 'oauth', methodID, access: 'mock-oauth',
      expires: now + 60000, metadata: { accountID: 'native-account' } } });
    const before = await subscriptionConnection(ctx, 'openai');
    assert.ok(before);
    const result = await collectQuotas(ctx, { now, fetch: async (url, init) => {
      assert.equal(init.headers['ChatGPT-Account-Id'], 'native-account');
      return Response.json({ rate_limit: { secondary_window: { used_percent: 20,
        reset_at: Math.floor(now / 1000) + 604800, limit_window_seconds: 604800 } } });
    } });
    assert.equal(result.sources.openai.status, 'LIVE');
    assert.equal(result.sources.openai.connection, before);
    const url = 'https://chatgpt.com/backend-api/codex/responses';
    for (const [selector, allowed] of [['native-account', true], ['other-account', false], [null, false]]) {
      assert.equal(await verifySubscriptionTransport(ctx, { model: { providerID: 'openai' }, request: new Request(url, {
        headers: { authorization: 'Bearer mock-oauth', ...(selector ? { 'chatgpt-account-id': selector } : {}) },
      }) }), allowed);
    }
  }
});
