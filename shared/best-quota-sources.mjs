// Authentication stays inside the supported plugin connection interface.
// Account endpoints are compatibility adapters, never inference or billing APIs.
import { normalizeGo, normalizeOpenAI, cleanExtraUsageConfirmation, REVOKED_CONNECTION } from './best-quota.mjs';
import { createHash } from 'node:crypto';

export function goExtraUsageSafety(state, now = Date.now(), connection = state?.sources?.['opencode-go']?.connection) {
  const unknown = { status: 'UNKNOWN', certified: false, apiAttested: false, reason: 'GO_EXTRA_USAGE_UNVERIFIED',
    source: 'https://opencode.ai/v2/docs/console/go#usage-beyond-limits' };
  const value = state?.extraUsageConfirmations?.at(-1);
  if (!value) return unknown;
  let entry;
  try { entry = cleanExtraUsageConfirmation(value); } catch { return unknown; }
  if (!Number.isFinite(now)) return unknown;
  // A revocation is the newest audit entry and wins over any older
  // declaration: it carries a nil connection, so it can never be certified
  // for an account, and it fails closed everywhere.
  if (entry.confirmedBy.startsWith('revoked.') || entry.connection === REVOKED_CONNECTION) {
    return { ...unknown, status: 'REVOKED', reason: 'GO_EXTRA_USAGE_CONFIRMATION_REVOKED', source: 'manual_user_revoked' };
  }
  // Bound to this exact subscription identity: a different account or an
  // unverifiable one never inherits the declaration.
  if (entry.connection !== connection || Date.parse(entry.confirmedAt) > now) return unknown;
  // Accepted user declaration, never an automatic billing/API attestation.
  // It persists: expiresAt only satisfies the stored format for older
  // readers. A later Go Console change is not detected automatically —
  // revoke and re-confirm to reflect it.
  return { status: 'OFF', certified: true, apiAttested: false, source: 'manual_user_confirmed',
    persistent: true, autoDetectsConsoleChanges: false,
    confirmation: { ...entry, persistent: true } };
}

const fingerprint = (id, connection, value) => createHash('sha256').update(JSON.stringify([
  id, connection.id, value.type, value.methodID, value.metadata?.orgID,
  value.metadata?.accountID, value.metadata?.clientID,
])).digest('hex');

async function resolveSubscription(ctx, provider) {
  const ids = provider === 'opencode-go' ? ['opencode', 'opencode-go'] : provider === 'openai' ? ['openai'] : [];
  for (const id of ids) {
    let connection, value;
    try {
      connection = await ctx.integration.connection.active(id);
      if (connection) value = await ctx.integration.connection.resolve(connection);
    } catch {
      // An unverifiable connection is denied; never forward auth diagnostics
      // into tool/session output, where they could contain credential material.
      return null;
    }
    if (!connection) continue;
    if ((provider === 'opencode-go' && ['oauth', 'key'].includes(value?.type))
        || (provider === 'openai' && value?.type === 'oauth'
         && ['chatgpt-token-sharing', 'chatgpt-browser', 'chatgpt-headless', 'codex'].includes(value.methodID))) {
      // Bind quota to a public runtime connection identity, never a token hash.
      return { id, connection, value };
    }
  }
  return null;
}

export async function subscriptionConnection(ctx, provider) {
  const resolved = await resolveSubscription(ctx, provider);
  return resolved ? fingerprint(resolved.id, resolved.connection, resolved.value) : null;
}

export async function verifySubscriptionTransport(ctx, event) {
  try {
    const provider = event.model.providerID;
    const resolved = await resolveSubscription(ctx, provider);
    if (!resolved) return false;
    const { value } = resolved;
    if (value.type === 'oauth' && value.expires <= Date.now()) return false;
    const url = new URL(event.request?.url ?? event.url);
    if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    const route = provider === 'opencode-go'
      ? url.hostname === 'opencode.ai' && /^\/(inference|zen)\/go\//.test(url.pathname)
      : provider === 'openai' && (value.methodID === 'chatgpt-token-sharing'
        ? url.hostname === 'api.openai.com' && url.pathname.startsWith('/v1/')
        : url.hostname === 'chatgpt.com' && url.pathname.startsWith('/backend-api/codex/'));
    if (!route) return false;
    const headers = new Headers(event.request?.headers ?? event.headers);
    const token = value.type === 'oauth' ? value.access : value.key;
    if (!token) return false;
    // One Go gateway, three AI SDKs: the OpenAI-compatible and OpenAI SDKs
    // authenticate with `authorization: Bearer`, the Anthropic SDK (qwen3.7-plus,
    // minimax-m3, claude-haiku-5-5 …) with `x-api-key`, and the Google SDK
    // (gemini-4-argon-contributor) with `x-goog-api-key`. Each form must carry
    // the exact same resolved subscription token, so a wrong or missing
    // credential still fails closed; the ChatGPT transport keeps Bearer only.
    const credential = headers.get('authorization') === `Bearer ${token}`
      || (provider === 'opencode-go'
        && (headers.get('x-api-key') === token || headers.get('x-goog-api-key') === token));
    if (!credential) return false;
    const expected = provider === 'opencode-go' ? value.metadata?.orgID : value.metadata?.accountID;
    const selected = headers.get(provider === 'opencode-go' ? 'x-opencode-org-id' : 'chatgpt-account-id');
    // A shared token may select several accounts/workspaces. It is not enough
    // for its bearer to match while the allowance belongs to a different one.
    return typeof expected === 'string' ? selected === expected : selected === null;
  } catch {
    // No raw URL/header/credential diagnostics can escape this validator.
    return false;
  }
}

export async function collectQuotas(ctx, options = {}) {
  const now = options.now ?? Date.now();
  const request = options.fetch ?? fetch;
  const snapshots = [], sources = {};
  async function collect(provider, integrationIDs, endpoint, normalize) {
    const at = new Date(now).toISOString();
    try {
      let credential, binding;
      for (const id of integrationIDs) {
        const connection = await ctx.integration.connection.active(id);
        if (connection) {
          credential = await ctx.integration.connection.resolve(connection);
          if (credential) binding = fingerprint(id, connection, credential);
        }
        if (credential) break;
      }
      const subscription = provider !== 'openai' || (credential?.type === 'oauth'
        && ['chatgpt-token-sharing', 'chatgpt-browser', 'chatgpt-headless', 'codex'].includes(credential.methodID));
      const token = credential?.type === 'oauth' ? credential.access : credential?.type === 'key' ? credential.key : undefined;
      if (!subscription || !token) {
        sources[provider] = { at, status: 'UNAVAILABLE', error: 'AUTH' };
        return;
      }
      // Never refresh, export, decode or persist credentials ourselves.
      if (credential.type === 'oauth' && credential.expires <= now) {
        sources[provider] = { at, status: 'UNAVAILABLE', error: 'AUTH' };
        return;
      }
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (provider === 'opencode-go' && typeof credential.metadata?.orgID === 'string') headers['x-opencode-org-id'] = credential.metadata.orgID;
      if (provider === 'openai' && typeof credential.metadata?.accountID === 'string') headers['ChatGPT-Account-Id'] = credential.metadata.accountID;
      const response = await request(endpoint, { method: 'GET', headers,
        redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        await response.body?.cancel();
        sources[provider] = { at, lastErrorAt: at, status: 'ERROR', error: [401, 403].includes(response.status) ? 'AUTH' : 'UNAVAILABLE' };
        return;
      }
      // Bound account responses. No raw response or exception is logged or saved.
      const reader = response.body.getReader();
      let text = '', size = 0;
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error('oversize');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      const connection = await subscriptionConnection(ctx, provider);
      if (connection !== binding) throw new Error('connection changed');
      const snapshot = normalize(JSON.parse(text), now);
      snapshot.connection = connection;
      snapshots.push(snapshot);
      sources[provider] = { at, lastSuccessAt: at, status: 'LIVE', connection };
    } catch {
      sources[provider] = { at, lastErrorAt: at, status: 'ERROR', error: 'UNAVAILABLE' };
    }
  }
  await collect('opencode-go', ['opencode', 'opencode-go'], 'https://opencode.ai/zen/go/v1/usage', normalizeGo);
  await collect('openai', ['openai'], 'https://chatgpt.com/backend-api/wham/usage', normalizeOpenAI);
  return { snapshots, sources };
}
