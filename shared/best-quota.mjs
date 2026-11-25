// Deterministic subscription-quota estimates. No network, authentication or model calls.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const PROVIDERS = ['opencode-go', 'openai'];
const KINDS = ['scan', 'analysis', 'coding', 'small', 'complex', 'architecture', 'debug', 'security', 'review', 'visual'];
const HIGH_RISK = ['complex', 'architecture', 'debug', 'security', 'review'];
const STATES = ['NORMAL', 'CAUTION', 'CRITICAL', 'EXHAUSTED', 'UNKNOWN'];
const ACTIVITY_PROVIDERS = {
  'discovery-mimo': 'opencode-go',
  'coding-qwen': 'opencode-go',
  'visual-glm': 'opencode-go',
  'coordination-sol-low': 'openai',
  'analysis-review-sol-medium': 'openai',
  'reasoning-sol-high': 'openai',
};
const MAX_ENTRIES = 4096;
const MAX_BYTES = 16 * 1024 * 1024;
// Runtimes whose hook contract this governor was qualified against. A version
// outside this list blocks admission instead of silently skipping the guard.
export const VERIFIED_RUNTIME_VERSIONS = ['2.2.5', '2.2.7', '2.3.2'];
export const verifiedRuntime = version => typeof version === 'string' && VERIFIED_RUNTIME_VERSIONS.includes(version);
// A busy shared state may make progress for longer than one acquisition budget.
// Progress can renew that budget, but never beyond the total bounded wait.
const LOCK_STALL_MS = 2000;
const LOCK_MAX_WAIT_MS = 30000;
const blankState = () => ({ version: 1, snapshots: [], sources: {}, decisions: [], usage: [] });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const iso = value => new Date(value).toISOString();

function number(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!finite(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  return value;
}

function timestamp(value) {
  // Reject Date.parse's coercions and calendar overflow (e.g. February 30).
  if (typeof value !== 'string') throw new Error('invalid timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const parsed = Date.parse(value);
  if (!match || !finite(parsed)) throw new Error('invalid timestamp');
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
      || hour > 23 || minute > 59 || second > 59) throw new Error('invalid timestamp');
  return parsed;
}

function windowValue(value, percentKey, resetKey) {
  if (!object(value)) throw new Error('invalid usage window');
  return { used: number(value[percentKey], 'usage percent', 0, 100), resetAt: iso(timestamp(value[resetKey])) };
}

function connectionFingerprint(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('invalid connection fingerprint');
  return value;
}

export function normalizeGo(payload, now = Date.now()) {
  number(now, 'now');
  if (!object(payload?.usage)) throw new Error('invalid Go usage');
  return { provider: 'opencode-go', at: iso(now), source: 'LIVE', windows: Object.fromEntries(
    ['rolling', 'weekly', 'monthly'].map(name => [name, windowValue(payload.usage[name], 'percent', 'resetsAt')])) };
}

export function normalizeOpenAI(payload, now = Date.now()) {
  number(now, 'now');
  if (!object(payload?.rate_limit)) throw new Error('invalid OpenAI rate_limit');
  const windows = {};
  const snapshot = { provider: 'openai', at: iso(now), source: 'LIVE', windows };
  const addLimits = (limits, prefix = '') => {
    if (!object(limits)) throw new Error('invalid OpenAI rate_limit');
    let count = 0;
    for (const name of ['primary_window', 'secondary_window']) {
      const value = limits[name];
      if (value == null) continue;
      if (!object(value)) throw new Error('invalid OpenAI window');
      const duration = number(value.limit_window_seconds, 'window duration', 1);
      if (!Number.isInteger(duration)) throw new Error('invalid window duration');
      const reset = number(value.reset_at, 'reset_at', 0, 8640000000000);
      const alias = duration === 18000 ? 'rolling' : duration === 604800 ? 'weekly' : name;
      const key = `${prefix}${windows[prefix + alias] ? name : alias}`;
      windows[key] = { used: number(value.used_percent, 'used_percent', 0, 100), resetAt: iso(reset * 1000), limitWindowSeconds: duration };
      count++;
    }
    if (!count) throw new Error('missing OpenAI windows');
    for (const [input, output] of [['allowed', 'allowed'], ['limit_reached', 'limitReached']]) {
      if (limits[input] === undefined) continue;
      if (typeof limits[input] !== 'boolean') throw new Error('invalid OpenAI limit flag');
      snapshot[output] = output === 'allowed' ? (snapshot[output] ?? true) && limits[input] : (snapshot[output] ?? false) || limits[input];
    }
  };
  addLimits(payload.rate_limit);
  if (payload.additional_rate_limits != null) {
    if (!Array.isArray(payload.additional_rate_limits) || payload.additional_rate_limits.length > 31) throw new Error('invalid additional_rate_limits');
    const seen = new Set();
    for (const entry of payload.additional_rate_limits) {
      if (!object(entry)) throw new Error('invalid additional rate limit');
      const identity = ['limit_name', 'metered_feature'].map(key => {
        if (entry[key] === undefined) return null;
        if (typeof entry[key] !== 'string' || !entry[key].trim() || entry[key].length > 200) throw new Error('invalid additional rate limit identity');
        return entry[key];
      });
      if (identity.every(value => value === null)) throw new Error('missing additional rate limit identity');
      // Do not put raw feature labels in persistent keys; identities survive reordering.
      const prefix = `additional_${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12)}_`;
      if (seen.has(prefix)) throw new Error('duplicate additional rate limit');
      seen.add(prefix);
      addLimits(entry.rate_limit, prefix);
    }
  }
  return snapshot;
}

function cleanSnapshot(value) {
  if (!object(value) || !PROVIDERS.includes(value.provider) || !['LIVE', 'MANUAL'].includes(value.source) || !object(value.windows)) {
    throw new Error('invalid snapshot');
  }
  const windows = {};
  const keys = Object.keys(value.windows);
  if (!keys.length || keys.length > 64) throw new Error('invalid snapshot windows');
  if (value.provider === 'opencode-go' && ['rolling', 'weekly', 'monthly'].some(key => !keys.includes(key))) {
    throw new Error('missing Go windows');
  }
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('invalid window name');
    windows[key] = windowValue(value.windows[key], 'used', 'resetAt');
    if (value.windows[key].limitWindowSeconds !== undefined) {
      windows[key].limitWindowSeconds = number(value.windows[key].limitWindowSeconds, 'window duration', 1);
    }
  }
  const snapshot = { provider: value.provider, at: iso(timestamp(value.at)), source: value.source, windows };
  if (value.connection !== undefined) snapshot.connection = connectionFingerprint(value.connection);
  for (const key of ['allowed', 'limitReached']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error('invalid limit flag');
      snapshot[key] = value[key];
    }
  }
  return snapshot;
}

function quotaOptions(options) {
  return {
    staleAfterMs: number(options.staleAfterMs ?? 15 * 60000, 'staleAfterMs', 0),
    safetyMarginPercent: number(options.safetyMarginPercent ?? 15, 'safetyMarginPercent', 0, 99),
    smoothingMs: number(options.smoothingMs ?? 6 * HOUR, 'smoothingMs', 1),
  };
}

function estimateWindow(name, latest, samples, now, options) {
  const value = latest.windows[name];
  const reset = timestamp(value.resetAt);
  const ageMs = now - timestamp(latest.at);
  const usable = Math.max(0, 100 - value.used - options.safetyMarginPercent);
  const timeRemainingMs = Math.max(0, reset - now);
  const sustainablePerHour = timeRemainingMs > 0 ? usable / (timeRemainingMs / HOUR) : null;
  const anomalies = [];
  const freshness = ageMs < 0 ? 'FUTURE' : ageMs > options.staleAfterMs ? 'STALE' : 'FRESH';
  if (freshness !== 'FRESH') anomalies.push(freshness === 'FUTURE' ? 'future-snapshot' : 'stale-snapshot');
  if (reset <= now) anomalies.push('reset-expired');
  // Walk only the current reset cycle: a new reset must never become a negative delta.
  const cycle = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (timestamp(sample.at) > timestamp(latest.at)) continue;
    if (sample.connection !== latest.connection || !sample.windows[name] || sample.windows[name].resetAt !== value.resetAt) break;
    cycle.unshift(sample);
  }
  let weightedDelta = 0, weightedHours = 0;
  for (let i = 1; i < cycle.length; i++) {
    const before = cycle[i - 1], after = cycle[i];
    const elapsed = timestamp(after.at) - timestamp(before.at);
    if (elapsed <= 0 || timestamp(after.at) < now - options.smoothingMs) continue;
    const delta = after.windows[name].used - before.windows[name].used;
    if (delta < 0) anomalies.push(name === 'rolling' ? 'rolling-release' : 'unexpected-decrease');
    if (delta > 0 && sustainablePerHour > 0 && delta / (elapsed / HOUR) > sustainablePerHour * 3) anomalies.push('budget-spike');
    const weight = Math.exp(-(timestamp(latest.at) - timestamp(after.at)) / options.smoothingMs);
    weightedDelta += Math.max(0, delta) * weight;
    weightedHours += elapsed / HOUR * weight;
  }
  const observedPerHour = weightedHours > 0 ? weightedDelta / weightedHours : null;
  const remaining = 100 - value.used;
  const projectedMs = observedPerHour > 0 ? remaining / observedPerHour * HOUR : null;
  // A projection cannot cross a reset and still describe this allowance cycle.
  const exhaustsAt = projectedMs !== null && projectedMs <= reset - now ? iso(now + projectedMs) : null;
  let state = 'NORMAL';
  if (value.used >= 100) state = 'EXHAUSTED';
  else if (usable <= 0 || value.used >= 95 || (observedPerHour !== null && observedPerHour > sustainablePerHour)) state = 'CRITICAL';
  else if (value.used >= 80 || (observedPerHour !== null && observedPerHour > sustainablePerHour * 0.8)) state = 'CAUTION';
  if (freshness !== 'FRESH' || reset <= now || anomalies.includes('unexpected-decrease')) state = 'UNKNOWN';
  return { state, used: value.used, remaining, resetAt: value.resetAt, timeRemainingMs,
    ...(value.limitWindowSeconds === undefined ? {} : { limitWindowSeconds: value.limitWindowSeconds }),
    observedPerHour, sustainablePerHour, sustainablePerDay: sustainablePerHour === null ? null : sustainablePerHour * 24,
    exhaustsAt, source: latest.source, projectionSource: 'ESTIMATE', sampleCount: cycle.length,
    freshness, ageMs, anomalies: [...new Set(anomalies)] };
}

export function forecast(history, now = Date.now(), options = {}) {
  number(now, 'now');
  const settings = quotaOptions(options);
  const input = Array.isArray(history) ? history : history?.snapshots;
  if (!Array.isArray(input)) throw new Error('invalid quota history');
  const providers = {};
  for (const provider of PROVIDERS) {
    const anomalies = [];
    const samples = [];
    for (const value of input) {
      if (value?.provider !== provider) continue;
      try { samples.push(cleanSnapshot(value)); }
      catch { anomalies.push('invalid-snapshot'); }
    }
    // Canonical tie breaking makes forecasts independent of input order.
    samples.sort((a, b) => timestamp(a.at) - timestamp(b.at) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const current = samples.filter(sample => timestamp(sample.at) <= now);
    const latest = current.at(-1) ?? samples.at(-1);
    if (!latest) {
      providers[provider] = { state: 'UNKNOWN', windows: {}, limitingWindow: null, at: null,
        source: 'UNKNOWN', freshness: 'MISSING', anomalies: [...new Set([...anomalies, 'missing-snapshot'])] };
      continue;
    }
    const windows = Object.fromEntries(Object.keys(latest.windows).sort().map(name => [name, estimateWindow(name, latest, samples, now, settings)]));
    const entries = Object.entries(windows);
    // UNKNOWN dominates: one unobserved constraint is enough to prevent safe admission.
    const pressure = window => window.observedPerHour > 0 && window.sustainablePerHour > 0
      ? window.observedPerHour / window.sustainablePerHour : 0;
    entries.sort(([a, av], [b, bv]) => STATES.indexOf(bv.state) - STATES.indexOf(av.state)
      || pressure(bv) - pressure(av) || av.sustainablePerHour - bv.sustainablePerHour || a.localeCompare(b));
    const [limitingWindow, limiting] = entries[0];
    const forcedExhausted = latest.allowed === false || latest.limitReached === true;
    const confirmedExhausted = forcedExhausted || Object.values(latest.windows).some(window => window.used >= 100);
    const missingWeek = provider === 'openai' && !Object.values(latest.windows).some(window => window.limitWindowSeconds === 604800);
    const state = limiting.state === 'UNKNOWN' || missingWeek ? 'UNKNOWN' : forcedExhausted ? 'EXHAUSTED' : limiting.state;
    providers[provider] = { state, confirmedExhausted, windows, limitingWindow, at: latest.at, source: latest.source, freshness: limiting.freshness,
      ...(latest.connection === undefined ? {} : { connection: latest.connection }),
      anomalies: [...new Set([...anomalies, ...entries.flatMap(([, value]) => value.anomalies),
        ...(missingWeek ? ['missing-weekly-window'] : []), ...(forcedExhausted ? ['provider-limit-reached'] : [])])] };
  }
  return { at: iso(now), providers, options: settings };
}

export function classifyActivity(usage) {
  if (!object(usage) || typeof usage.model !== 'string') return 'unclassified';
  let result = 'unclassified';
  if (usage.provider === 'opencode-go') {
    if (/^opencode-go\/mimo(?:[-.0-9]|$)/i.test(usage.model ?? '')) result = 'discovery-mimo';
    else if (/^opencode-go\/qwen(?:[-.0-9]|$)/i.test(usage.model ?? '')) result = 'coding-qwen';
    else if (/^opencode-go\/glm(?:[-.0-9]|$)/i.test(usage.model ?? '')) result = 'visual-glm';
  } else if (usage.provider === 'openai' && /^openai\/gpt-6\.[12]-sol$/.test(usage.model)) {
    // OpenAI Sol coding events (6.1 legacy and 6.2 current) share one account
    // identity and weekly quota; they do not identify the reasoning variant.
    if (usage.variant === 'low') result = 'coordination-sol-low';
    else if (usage.variant === 'medium') result = 'analysis-review-sol-medium';
    else if (usage.variant === 'high' && usage.model === 'openai/gpt-6.2-sol') result = 'reasoning-sol-high';
  }
  return usage.activityClass === undefined || usage.activityClass === result ? result : 'unclassified';
}

export function calibrateQuota(state, now = Date.now()) {
  number(now, 'now');
  if (!object(state) || !Array.isArray(state.snapshots) || !Array.isArray(state.usage)) throw new Error('invalid calibration state');
  const options = quotaOptions(state.policy ?? {});
  const since = now - options.smoothingMs;
  const excluded = { manual: 0, invalidSnapshots: 0, future: 0, outsideLookback: 0,
    connectionChanges: 0, inactiveConnections: 0, nonPositiveIntervals: 0, resetChanges: 0,
    expiredResets: 0, missingWindows: 0, decreases: 0, activityConnectionMismatches: 0 };
  const gaps = { count: 0, intervalMs: 0 };
  const anomalies = new Set();
  const samples = [];
  for (const value of state.snapshots) {
    let sample;
    try { sample = cleanSnapshot(value); }
    catch { excluded.invalidSnapshots++; continue; }
    if (sample.source !== 'LIVE') { excluded.manual++; continue; }
    const at = timestamp(sample.at);
    if (at > now) { excluded.future++; continue; }
    if (at < since) { excluded.outsideLookback++; continue; }
    samples.push(sample);
  }
  samples.sort((a, b) => timestamp(a.at) - timestamp(b.at) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const usage = { classified: 0, unclassified: 0, invalid: 0, outsideLookback: 0, future: 0, nonActivity: 0 };
  const activities = [];
  for (const value of state.usage) {
    let entry;
    try { entry = cleanUsage(value); }
    catch { usage.invalid++; continue; }
    const at = timestamp(entry.at);
    if (at > now) { usage.future++; continue; }
    if (at < since) { usage.outsideLookback++; continue; }
    const completion = entry.requests === 0 && entry.durationMs !== undefined;
    if (!(entry.requests > 0) && !completion) { usage.nonActivity++; continue; }
    const name = classifyActivity(entry);
    usage[name === 'unclassified' ? 'unclassified' : 'classified']++;
    if (name !== 'unclassified') activities.push({ name, provider: entry.provider, connection: entry.connection,
      at, completion, start: at - (completion ? entry.durationMs : 0) });
  }
  const classes = Object.fromEntries(Object.entries(ACTIVITY_PROVIDERS).map(([name, provider]) => [name, {
    provider, state: 'UNKNOWN', observations: 0, attribution: 'CONSERVATIVE_SHARED',
    uncertainty: ['external-usage-not-excludable', 'account-activity-not-independently-verifiable',
      'one-percent-point-per-snapshot-including-fractional', 'future-task-length-unknown'],
    requiredWindows: [], windows: {},
  }]));
  for (const provider of PROVIDERS) {
    const history = samples.filter(sample => sample.provider === provider);
    const latest = history.at(-1);
    const required = new Set(latest ? Object.keys(latest.windows) : provider === 'opencode-go' ? ['rolling', 'weekly', 'monthly'] : ['rolling', 'weekly']);
    const missingWeek = provider === 'openai' && latest && !Object.values(latest.windows).some(window => window.limitWindowSeconds === 604800);
    if (missingWeek) {
      required.add('weekly');
      anomalies.add('missing-weekly-window');
    }
    const names = [...required].sort();
    const entries = Object.entries(classes).filter(([, entry]) => entry.provider === provider);
    const lastInterval = new Map();
    for (const [, entry] of entries) {
      entry.requiredWindows = names;
      for (const name of names) entry.windows[name] = { state: 'UNKNOWN', observations: 0,
        observedPercent: null, observedPerHour: null, conservativePerHour: null, intervalMs: 0,
        quantizationBoundPercent: 0, segments: 0, resetAt: latest?.windows[name]?.resetAt ?? null };
    }
    for (let i = 1; i < history.length; i++) {
      const before = history[i - 1], after = history[i];
      const start = timestamp(before.at), end = timestamp(after.at), intervalMs = end - start;
      if (intervalMs <= 0) { excluded.nonPositiveIntervals++; continue; }
      if (before.connection !== after.connection) { excluded.connectionChanges++; continue; }
      if (after.connection !== latest.connection) { excluded.inactiveConnections++; continue; }
      if (intervalMs > options.staleAfterMs * 2) { gaps.count++; gaps.intervalMs += intervalMs; continue; }
      // Requests identify starts in [start, end); only explicit duration-bearing
      // requests=0 completions can establish overlap with preceding intervals.
      const present = new Map();
      for (const item of activities) {
        if (item.provider !== provider) continue;
        const overlaps = item.completion ? item.at > start && (item.at <= end || item.start < end)
          : item.at >= start && item.at < end;
        if (!overlaps) continue;
        if (item.connection !== undefined && item.connection !== after.connection) {
          excluded.activityConnectionMismatches++;
          continue;
        }
        present.set(item.name, present.get(item.name) || item.connection === undefined);
      }
      const observed = new Set();
      for (const name of names) {
        const previous = before.windows[name], current = after.windows[name];
        if (!previous || !current) { excluded.missingWindows++; continue; }
        if (previous.resetAt !== current.resetAt || current.resetAt !== latest.windows[name]?.resetAt
            || previous.limitWindowSeconds !== current.limitWindowSeconds) { excluded.resetChanges++; continue; }
        if (timestamp(current.resetAt) <= end) { excluded.expiredResets++; continue; }
        const delta = current.used - previous.used;
        if (delta < 0) { excluded.decreases++; anomalies.add('unexpected-decrease'); continue; }
        for (const [className, legacy] of present) {
          const entry = classes[className];
          if (legacy && !entry.uncertainty.includes('legacy-activity-connection-unverified')) entry.uncertainty.push('legacy-activity-connection-unverified');
          const window = classes[className].windows[name];
          window.observations++;
          window.observedPercent = (window.observedPercent ?? 0) + delta;
          window.intervalMs += intervalMs;
          // Nonnegative adjacent deltas telescope. Bound only the segment's two
          // endpoints (one point each, including floats of unknown precision).
          // A gap, missing activity or excluded pair breaks adjacency per window.
          if (lastInterval.get(window) !== i - 1) {
            window.quantizationBoundPercent += 2;
            window.segments++;
          }
          lastInterval.set(window, i);
          observed.add(className);
        }
      }
      for (const name of observed) classes[name].observations++;
    }
    const fresh = latest && now - timestamp(latest.at) <= options.staleAfterMs;
    if (!latest) anomalies.add('missing-live-snapshot');
    else if (!fresh) anomalies.add('stale-snapshot');
    for (const [, entry] of entries) {
      for (const window of Object.values(entry.windows)) {
        if (!window.observations) continue;
        window.observedPerHour = window.observedPercent / (window.intervalMs / HOUR);
        window.conservativePerHour = (window.observedPercent + window.quantizationBoundPercent) / (window.intervalMs / HOUR);
        if (fresh && timestamp(window.resetAt) > now) window.state = 'ESTIMATE';
      }
      if (!missingWeek && entry.observations && names.every(name => entry.windows[name].state === 'ESTIMATE')) entry.state = 'ESTIMATE';
      if (!entry.observations) entry.uncertainty.push('class-unobserved');
    }
  }
  return { at: iso(now), source: 'ESTIMATE', taskLength: 'UNKNOWN', since: iso(Math.max(0, since)),
    activitySemantics: { requests: 'START_[before,after)', completions: 'REQUESTS_0_WITH_DURATION_OVERLAP',
      tokenOnly: 'IGNORED', observations: 'VALID_SNAPSHOT_INTERVAL_COUNT',
      connectionMismatches: 'EVENT_INTERVAL_COUNT', quantization: 'TWO_POINTS_PER_CONTIGUOUS_CLASS_WINDOW_SEGMENT' },
    options, classes, usage, excluded, gaps, anomalies: [...anomalies].sort() };
}

export function estimateQuotaCost(calibration, className, horizonMs) {
  const unknown = { source: 'ESTIMATE', state: 'UNKNOWN', windows: {}, taskLength: 'UNKNOWN' };
  const entry = Object.hasOwn(ACTIVITY_PROVIDERS, className) ? calibration?.classes?.[className] : null;
  if (!finite(horizonMs) || horizonMs < 0 || entry?.state !== 'ESTIMATE' || !entry.observations
      || !Array.isArray(entry.requiredWindows) || !entry.requiredWindows.length
      || !entry.requiredWindows.every(name => entry.windows?.[name]?.state === 'ESTIMATE'
        && finite(entry.windows[name].conservativePerHour) && entry.windows[name].conservativePerHour >= 0)) return unknown;
  // This is a caller-chosen time scenario, not a measurement of future task length.
  // Percentages may exceed 100; never silently cap a projected cost.
  const windows = Object.fromEntries(entry.requiredWindows.map(name => [name, entry.windows[name].conservativePerHour * horizonMs / HOUR]));
  if (!Object.values(windows).every(finite)) return unknown;
  return { source: 'ESTIMATE', state: 'ESTIMATE', attribution: 'CONSERVATIVE_SHARED',
    horizonMs, horizonSource: 'CALLER_SUPPLIED', taskLength: 'UNKNOWN', windows };
}

function safeCandidate(value) {
  return object(value) && PROVIDERS.includes(value.provider) && typeof value.model === 'string'
    && value.model.startsWith(`${value.provider}/`) && /^[a-z0-9][a-z0-9./_#:+-]{0,159}$/i.test(value.model)
    && value.paid !== true && value.available !== false;
}

function cleanExpectedEstimates(estimates) {
  if (estimates === undefined) return undefined;
  if (!object(estimates)) throw new Error('invalid expectedPercentByKind');
  return Object.fromEntries(Object.entries(estimates).map(([kind, providers]) => {
    if (!KINDS.includes(kind) || !object(providers)) throw new Error('invalid task estimate');
    return [kind, Object.fromEntries(Object.entries(providers).map(([provider, percent]) => {
      if (!PROVIDERS.includes(provider)) throw new Error('invalid estimate provider');
      return [provider, number(percent, 'estimated task percent', 0, 100)];
    }))];
  }));
}

// In-flight work that still counts against the shared budget. A reservation
// whose owning server process is gone is released; a single-request admission
// reservation also releases at its own deadline, because no later callback may
// ever arrive for it. Routing (delegation) leases stay PID-governed only.
export function liveLeases(leases, now = Date.now()) {
  return (Array.isArray(leases) ? leases : []).filter(lease => {
    if (lease.ownerPid) {
      try { process.kill(lease.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') return false; }
    }
    if (lease.scope === 'admission') { try { return timestamp(lease.expiresAt) > now; } catch { return false; } }
    return true;
  });
}

// Percent points of one provider already committed by in-flight requests.
export function reservedPercent(leases, provider, window) {
  return (Array.isArray(leases) ? leases : []).reduce((total, lease) =>
    total + (lease.provider === provider ? lease.percentByWindow?.[window] ?? lease.percent ?? 0 : 0), 0);
}

export function decideQuota({ kind, candidates, forecast: prediction, previous, now = Date.now(), options = {} }) {
  number(now, 'now');
  const at = iso(now);
  const block = reason => ({ blocked: true, reason, candidate: null, kind, at, switchedAt: previous?.switchedAt ?? null, estimatedTaskPercent: null });
  if (!KINDS.includes(kind) || !Array.isArray(candidates)) return block('invalid-input');
  const cooldownMs = number(options.cooldownMs ?? 5 * 60000, 'cooldownMs');
  const hysteresisPercent = number(options.hysteresisPercent ?? 5, 'hysteresisPercent', 0, 100);
  const staleAfterMs = number(options.staleAfterMs ?? prediction?.options?.staleAfterMs ?? 15 * 60000, 'staleAfterMs');
  const safetyMarginPercent = number(options.safetyMarginPercent ?? prediction?.options?.safetyMarginPercent ?? 15, 'safetyMarginPercent', 0, 99);
  // Percent points already committed by other instances' in-flight work. The
  // shared state file is the only place these are counted, so parallel BEST
  // terminals cannot each spend the same remaining headroom.
  const reserved = (provider, window) => {
    const configured = options.reserved?.[provider];
    const value = object(configured) ? configured[window] : configured;
    return finite(value) && value > 0 ? Math.min(value, 100) : 0;
  };
  const estimates = cleanExpectedEstimates(options.expectedPercentByKind);
  const estimate = candidate => estimates?.[kind]?.[candidate.provider] ?? null;
  const eligible = candidates.filter(safeCandidate).filter(candidate =>
    (!HIGH_RISK.includes(kind) || candidate.provider === 'openai')
    // Preserve BEST's visual quality floor; another GLM generation is not an automatic fallback.
    && (kind !== 'visual' || (candidate.provider === 'opencode-go' && /^opencode-go\/glm-5\.3-flash(?:#[a-z0-9_-]+)?$/i.test(candidate.model))));
  if (!eligible.length) return block('no-eligible-candidate');
  const admission = candidate => {
    const provider = prediction?.providers?.[candidate.provider];
    // Regulation, not prohibition: CRITICAL providers keep admitting work while
    // real budget remains. Only an exhausted or unobservable provider stops.
    if (!provider || !['NORMAL', 'CAUTION', 'CRITICAL'].includes(provider.state) || !object(provider.windows) || !Object.keys(provider.windows).length) return false;
    try {
      if (now - timestamp(provider.at) > staleAfterMs || timestamp(provider.at) > now) return false;
      // Every window must still hold real budget after in-flight reservations:
      // the most restrictive one governs, and a reset in one window never renews
      // another (a weekly reset does not restore an exhausted month). The safety
      // margin is a routing preference only; necessity may spend budget down to 0%.
      return Object.entries(provider.windows).every(([key, window]) => !['EXHAUSTED', 'UNKNOWN'].includes(window.state)
        && window.freshness === 'FRESH' && timestamp(window.resetAt) > now && finite(window.used) && finite(window.remaining)
        && window.remaining - reserved(candidate.provider, key) > 0
        && window.remaining - reserved(candidate.provider, key) >= (estimate(candidate) ?? 0));
    } catch { return false; }
  };
  const available = eligible.filter(admission);
  if (!available.length) return block('quota-unavailable');
  const budget = candidate => Math.min(...Object.entries(prediction.providers[candidate.provider].windows)
    .map(([key, window]) => Math.max(0, window.remaining - safetyMarginPercent - reserved(candidate.provider, key))));
  const score = candidate => Math.min(...Object.entries(prediction.providers[candidate.provider].windows).map(([key, window]) => {
    const headroom = Math.max(0, window.remaining - safetyMarginPercent - reserved(candidate.provider, key));
    if (window.observedPerHour > 0 && window.sustainablePerHour > 0) {
      const pacingHeadroom = Math.max(0, 100 * (1 - window.observedPerHour / window.sustainablePerHour));
      return Math.min(headroom, pacingHeadroom);
    }
    return headroom;
  }));
  // When pacing headroom is 0 for every provider (both under pressure), the
  // tie break goes to the provider with the most real remaining budget, so
  // regulation keeps routing instead of stalling; stable order is the last tie.
  const ordered = available.map((candidate, index) => ({ candidate, index, score: score(candidate), budget: budget(candidate) }))
    .sort((a, b) => b.score - a.score || b.budget - a.budget || a.index - b.index);
  let selected = ordered[0].candidate;
  let reason = HIGH_RISK.includes(kind) ? 'high-risk-forces-openai' : kind === 'visual' ? 'visual-go-glm' : 'quota-headroom';
  const incumbent = available.find(candidate => candidate.provider === previous?.candidate?.provider && candidate.model === previous?.candidate?.model
    && candidate.agent === previous?.candidate?.agent);
  let priorSwitch = null;
  try { if (previous?.switchedAt) priorSwitch = timestamp(previous.switchedAt); } catch { /* Invalid prior state cannot pin a route. */ }
  if (incumbent && selected !== incumbent && priorSwitch !== null && priorSwitch <= now
      && (now - priorSwitch < cooldownMs || score(selected) - score(incumbent) < hysteresisPercent)) {
    selected = incumbent;
    reason = 'quota-hysteresis';
  }
  const unchanged = selected.provider === previous?.candidate?.provider && selected.model === previous?.candidate?.model
    && selected.agent === previous?.candidate?.agent;
  return { blocked: false, reason, candidate: selected, kind, at, switchedAt: unchanged && priorSwitch !== null ? iso(priorSwitch) : at,
    estimatedTaskPercent: estimate(selected) };
}

// Reject symlinks in *every* existing path component, not just the final file.
function checkPath(file, create = false, contendedLock = false) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('unsafe quota path');
  const absolute = path.resolve(file);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (i < parts.length - 1 && create) {
        try { fs.mkdirSync(current, { mode: 0o700 }); }
        catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        stat = fs.lstatSync(current);
      } else continue;
    }
    if (stat.isSymbolicLink()) throw new Error('unsafe quota path: symlink');
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error('unsafe quota directory');
      if (i === parts.length - 2 && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) {
        throw new Error('quota directory must be private (0700) and owned by the current user');
      }
    } else {
      // macOS can report the old regular inode after another writer unlinks
      // its lock. O_EXCL still decides who owns the current directory entry.
      if (contendedLock && stat.isFile() && stat.nlink === 0 && stat.uid === process.getuid()) continue;
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw new Error('unsafe quota file or hardlink');
    }
  }
  return absolute;
}

function cleanCandidate(value) {
  if (!safeCandidate(value)) throw new Error('invalid quota candidate');
  const candidate = { provider: value.provider, model: value.model };
  if (value.agent !== undefined) {
    if (typeof value.agent !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/i.test(value.agent)) throw new Error('invalid agent');
    candidate.agent = value.agent;
  }
  return candidate;
}

function cleanUsage(entry) {
  if (!object(entry) || !PROVIDERS.includes(entry.provider)) throw new Error('invalid quota usage');
  const usage = { at: iso(timestamp(entry.at)), provider: entry.provider };
  if (entry.connection !== undefined) usage.connection = connectionFingerprint(entry.connection);
  if (entry.model !== undefined) Object.assign(usage, cleanCandidate(entry));
  if (entry.durationMs !== undefined) usage.durationMs = number(entry.durationMs, 'durationMs');
  if (entry.activityClass !== undefined) {
    if (typeof entry.activityClass !== 'string'
        || (!Object.hasOwn(ACTIVITY_PROVIDERS, entry.activityClass) && entry.activityClass !== 'unclassified')) throw new Error('invalid usage activityClass');
    usage.activityClass = entry.activityClass;
  }
  if (entry.variant !== undefined) {
    if (typeof entry.variant !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,79}$/i.test(entry.variant)) throw new Error('invalid usage variant');
    usage.variant = entry.variant;
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests', 'retries']) {
    if (entry[key] !== undefined) usage[key] = number(entry[key], key);
  }
  if (entry.kind !== undefined) {
    if (!KINDS.includes(entry.kind)) throw new Error('invalid usage kind');
    usage.kind = entry.kind;
  }
  if (entry.outcome !== undefined) {
    if (!['passed', 'failed', 'blocked'].includes(entry.outcome)) throw new Error('invalid usage outcome');
    usage.outcome = entry.outcome;
  }
  return usage;
}

// Revocation audit entries carry this nil connection instead of an account
// identity, so no reader can ever certify them for a real subscription.
export const REVOKED_CONNECTION = '0'.repeat(64);

export function cleanExtraUsageConfirmation(value) {
  if (!object(value) || value.source !== 'manual_user_confirmed' || value.status !== 'OFF'
      || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id)
      || typeof value.confirmedBy !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.confirmedBy)
      || (value.provider !== undefined && value.provider !== 'opencode-go')) {
    throw new Error('invalid Extra Usage confirmation');
  }
  const confirmedAt = timestamp(value.confirmedAt), expiresAt = timestamp(value.expiresAt);
  // The one-hour window is retained only as a stored-format constraint so
  // older readers can still validate the audit entry. It is not a lifetime:
  // goExtraUsageSafety treats a manual OFF declaration as persistent.
  if (expiresAt <= confirmedAt || expiresAt - confirmedAt > 3600000) throw new Error('invalid Extra Usage confirmation expiry');
  return { id: value.id, source: 'manual_user_confirmed', status: 'OFF', confirmedBy: value.confirmedBy,
    provider: 'opencode-go', connection: connectionFingerprint(value.connection),
    confirmedAt: iso(confirmedAt), expiresAt: iso(expiresAt) };
}

function cleanState(value, now) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.snapshots) || !object(value.sources)
      || !Array.isArray(value.decisions) || !Array.isArray(value.usage)) throw new Error('invalid quota state');
  const state = blankState();
  if (value.extraUsageConfirmations !== undefined) {
    if (!Array.isArray(value.extraUsageConfirmations)) throw new Error('invalid Extra Usage confirmation audit');
    // Declarations and revocations are auditable history: they are bounded by
    // the fixed entry cap only, never aged out, so revoking or re-confirming
    // cannot erase the record of what was declared and when.
    state.extraUsageConfirmations = value.extraUsageConfirmations.map(cleanExtraUsageConfirmation).slice(-MAX_ENTRIES);
  }
  if (value.policy !== undefined) {
    const policy = value.policy;
    if (!object(policy) || !['monitor', 'active', 'disabled'].includes(policy.mode)) throw new Error('invalid quota policy');
    state.policy = { mode: policy.mode };
    for (const [key, min, max] of [['safetyMarginPercent', 0, 99], ['staleAfterMs', 0], ['smoothingMs', 1], ['cooldownMs', 0], ['hysteresisPercent', 0, 100]]) {
      if (policy[key] !== undefined) state.policy[key] = number(policy[key], key, min, max);
    }
    if (policy.expectedPercentByKind !== undefined) state.policy.expectedPercentByKind = cleanExpectedEstimates(policy.expectedPercentByKind);
  }
  if (value.runtime !== undefined) {
    const runtime = value.runtime;
    if (!object(runtime) || typeof runtime.version !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,79}$/i.test(runtime.version)
        || typeof runtime.hookVerified !== 'boolean') throw new Error('invalid quota runtime');
    state.runtime = { version: runtime.version, loadedAt: iso(timestamp(runtime.loadedAt)), hookVerified: runtime.hookVerified };
    if (runtime.instances !== undefined) {
      if (!Array.isArray(runtime.instances)) throw new Error('invalid runtime instances');
      state.runtime.instances = runtime.instances.map(entry => {
        if (!object(entry) || !Number.isInteger(entry.pid) || entry.pid <= 0
            || typeof entry.instanceID !== 'string' || !/^[a-f0-9-]{36}$/i.test(entry.instanceID)
            || !['NATIVE_RUNTIME', 'INJECTED_TEST'].includes(entry.origin)
            || typeof entry.version !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,79}$/i.test(entry.version)
            || !object(entry.configuration) || !object(entry.callbacks)) throw new Error('invalid runtime instance');
        const result = { instanceID: entry.instanceID, pid: entry.pid, version: entry.version, origin: entry.origin,
          loadedAt: iso(timestamp(entry.loadedAt)), at: iso(timestamp(entry.at)), configuration: {}, callbacks: {} };
        for (const key of ['file', 'stateFile', 'location']) {
          const value = entry.configuration[key];
          if (value !== null && (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value))) {
            throw new Error('invalid runtime configuration identity');
          }
          result.configuration[key] = value;
        }
        for (const key of ['registeredAt', 'unloadedAt']) if (entry[key] !== undefined) result[key] = iso(timestamp(entry[key]));
        for (const name of ['model.request', 'http.request', 'experimental.ws.handshake', 'heartbeat', 'prompt']) {
          const callback = entry.callbacks[name];
          if (callback === undefined) continue;
          if (!object(callback) || !['MONITOR_OBSERVED', 'PASSED', 'BLOCKED', 'ERROR', 'APPLIED', 'SKIPPED'].includes(callback.outcome)
              || !['monitor', 'active', 'disabled'].includes(callback.mode)
              || typeof callback.liveSubscription !== 'boolean') throw new Error('invalid runtime callback receipt');
          result.callbacks[name] = { at: iso(timestamp(callback.at)), outcome: callback.outcome,
            mode: callback.mode, liveSubscription: callback.liveSubscription };
        }
        if (entry.lifecycle !== undefined) {
          if (!object(entry.lifecycle) || !['session.step.ended', 'session.execution.succeeded',
            'session.execution.failed', 'session.execution.interrupted'].includes(entry.lifecycle.type)) throw new Error('invalid runtime lifecycle');
          result.lifecycle = { type: entry.lifecycle.type, at: iso(timestamp(entry.lifecycle.at)) };
        }
        return result;
      }).filter(entry => timestamp(entry.at) >= now - 35 * DAY).slice(-MAX_ENTRIES);
    }
    if (runtime.verifiedAt !== undefined) state.runtime.verifiedAt = iso(timestamp(runtime.verifiedAt));
    if (runtime.hookVerified && runtime.verifiedAt === undefined) throw new Error('missing runtime verifiedAt');
  }
  if (value.leases !== undefined) {
    if (!Array.isArray(value.leases)) throw new Error('invalid quota leases');
    state.leases = value.leases.map(lease => {
      if (!object(lease) || typeof lease.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(lease.id)
          || !PROVIDERS.includes(lease.provider)) throw new Error('invalid quota lease');
      const result = { id: lease.id, provider: lease.provider, expiresAt: iso(timestamp(lease.expiresAt)) };
      if (lease.ownerPid !== undefined) {
        if (!Number.isInteger(lease.ownerPid) || lease.ownerPid <= 0) throw new Error('invalid lease owner');
        result.ownerPid = lease.ownerPid;
      }
      if (lease.scope !== undefined) {
        if (!['routing', 'admission'].includes(lease.scope)) throw new Error('invalid lease scope');
        result.scope = lease.scope;
      }
      // Percent points this in-flight request already committed to the shared
      // budget. Absent means the request committed nothing measurable.
      if (lease.percent !== undefined) result.percent = number(lease.percent, 'lease percent', 0, 100);
      if (lease.percentByWindow !== undefined) {
        if (!object(lease.percentByWindow) || lease.scope !== 'admission' || !finite(result.percent)) {
          throw new Error('invalid lease window envelope');
        }
        const entries = Object.entries(lease.percentByWindow);
        if (!entries.length || entries.length > 64 || entries.some(([key, percent]) =>
          !/^[a-z][a-z0-9_]{0,47}$/.test(key) || ['constructor', 'prototype'].includes(key)
          || !finite(percent) || percent < 0 || percent > result.percent)
          || Math.max(...entries.map(([, percent]) => percent)) !== result.percent) {
          throw new Error('invalid lease window envelope');
        }
        result.percentByWindow = Object.fromEntries(entries);
      }
      if (lease.sessionID !== undefined) {
        if (typeof lease.sessionID !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(lease.sessionID)) throw new Error('invalid lease session');
        result.sessionID = lease.sessionID;
      }
      if (lease.at !== undefined) result.at = iso(timestamp(lease.at));
      return result;
    });
    // Dropping a live reservation would undercount concurrent admission: fail closed instead.
    if (state.leases.length > 1000) throw new Error('too many active quota leases');
  }
  const recent = entry => timestamp(entry.at) >= now - 35 * DAY && timestamp(entry.at) <= now;
  state.snapshots = value.snapshots.map(cleanSnapshot).filter(recent).sort((a, b) => timestamp(a.at) - timestamp(b.at)).slice(-MAX_ENTRIES);
  for (const provider of PROVIDERS) {
    const source = value.sources[provider];
    if (source === undefined) continue;
    if (!object(source)) throw new Error('invalid quota source');
    const metadata = {};
    if (source.connection !== undefined) metadata.connection = connectionFingerprint(source.connection);
    for (const key of ['at', 'lastSuccessAt', 'lastErrorAt']) if (source[key] !== undefined) metadata[key] = iso(timestamp(source[key]));
    if (source.status !== undefined) {
      if (!['LIVE', 'MANUAL', 'OK', 'ERROR', 'UNKNOWN', 'STALE', 'UNAVAILABLE'].includes(source.status)) throw new Error('invalid source status');
      metadata.status = source.status;
    }
    // Never persist raw exception messages, headers, endpoints or auth material.
    if (source.error !== undefined && ['OFFLINE', 'AUTH', 'INVALID', 'TIMEOUT', 'UNAVAILABLE', 'UNKNOWN'].includes(source.error)) metadata.error = source.error;
    state.sources[provider] = metadata;
  }
  state.decisions = value.decisions.map(entry => {
    if (!object(entry) || typeof entry.blocked !== 'boolean' || !KINDS.includes(entry.kind)) throw new Error('invalid quota decision');
    const decision = { at: iso(timestamp(entry.at)), kind: entry.kind, blocked: entry.blocked };
    if (entry.enforced !== undefined) {
      if (typeof entry.enforced !== 'boolean') throw new Error('invalid enforcement flag');
      decision.enforced = entry.enforced;
    }
    if (entry.scope !== undefined) {
      if (!['routing', 'admission'].includes(entry.scope)) throw new Error('invalid decision scope');
      decision.scope = entry.scope;
    }
    if (entry.reason !== undefined) {
      if (!['invalid-input', 'no-eligible-candidate', 'quota-unavailable', 'high-risk-forces-openai', 'visual-go-glm', 'quota-headroom', 'quota-hysteresis'].includes(entry.reason)) throw new Error('invalid decision reason');
      decision.reason = entry.reason;
    }
    if (entry.candidate != null) decision.candidate = cleanCandidate(entry.candidate);
    else if (entry.candidate === null) decision.candidate = null;
    if (entry.switchedAt != null) decision.switchedAt = iso(timestamp(entry.switchedAt));
    else if (entry.switchedAt === null) decision.switchedAt = null;
    if (entry.estimatedTaskPercent !== undefined) {
      decision.estimatedTaskPercent = entry.estimatedTaskPercent === null ? null : number(entry.estimatedTaskPercent, 'estimated task percent', 0, 100);
    }
    if (entry.applied != null) {
      if (typeof entry.applied !== 'string' || !/^[a-z0-9-]+\/[a-z0-9.+#-]+$/i.test(entry.applied) || entry.applied.length > 200) throw new Error('invalid applied model');
      decision.applied = entry.applied;
    } else if (entry.applied === null) decision.applied = null;
    return decision;
  }).filter(recent).sort((a, b) => timestamp(a.at) - timestamp(b.at)).slice(-MAX_ENTRIES);
  state.usage = value.usage.map(cleanUsage).filter(recent).sort((a, b) => timestamp(a.at) - timestamp(b.at)).slice(-MAX_ENTRIES);
  return state;
}

function readQuotaDocument(file) {
  const absolute = checkPath(file);
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('unsafe quota state file');
    const content = fs.readFileSync(descriptor, 'utf8');
    return { state: cleanState(JSON.parse(content), Date.now()), content, mode: stat.mode };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: blankState() };
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function readQuotaState(file) {
  return readQuotaDocument(file).state;
}

// Age is not evidence of death: slow or suspended writers still own their lock.
// Legacy empty locks have no provable owner and must fail closed.
function orphanedLock(lock) {
  let fd;
  try {
    fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 128) return;
    let pid;
    try { ({ pid } = JSON.parse(fs.readFileSync(fd, 'utf8'))); }
    catch { return; }
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return stat; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function breakStaleLock(lock) {
  // Ordinary contention must not create recovery guards or leave one behind
  // if a waiting process exits. Repeat all evidence after taking the guard.
  if (!orphanedLock(lock)) return false;
  const guard = `${lock}.reap`;
  checkPath(guard, false, true);
  let guardFd;
  try { guardFd = fs.openSync(guard, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  // Serialize reapers, not normal writers. Never reap this guard recursively:
  // ambiguous ownership must fail closed rather than recreate the unlink race.
  try {
    const first = orphanedLock(lock);
    if (!first) return false;
    let second;
    try { second = fs.lstatSync(lock); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    if (second.ino !== first.ino || second.dev !== first.dev || second.mtimeMs !== first.mtimeMs
        || second.ctimeMs !== first.ctimeMs || second.size !== first.size) return false;
    try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return true;
  } finally {
    fs.closeSync(guardFd);
    fs.unlinkSync(guard);
  }
}

export async function updateQuotaState(file, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('invalid quota callback');
  const lockTimeoutMs = number(options.lockTimeoutMs ?? LOCK_STALL_MS, 'lockTimeoutMs', 0, LOCK_MAX_WAIT_MS);
  const retryMs = number(options.retryMs ?? 10, 'retryMs', 1, 1000);
  const absolute = checkPath(file, true);
  const lock = `${absolute}.lock`;
  let descriptor;
  const started = performance.now();
  const deadline = started + (options.lockTimeoutMs === undefined ? LOCK_MAX_WAIT_MS : lockTimeoutMs);
  let progressDeadline = started + lockTimeoutMs, previousLock, attempted = false;
  while (descriptor === undefined) {
    if (attempted && performance.now() >= Math.min(deadline, progressDeadline)) throw new Error('quota state locked');
    attempted = true;
    checkPath(absolute);
    checkPath(lock, false, true);
    try { descriptor = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Renew only on a different lock generation, not on repeated polling of
      // the same holder. Explicit timeouts still obey the fixed deadline.
      let stat;
      try { stat = fs.lstatSync(lock); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (stat && previousLock && (stat.ino !== previousLock.ino || stat.dev !== previousLock.dev
          || stat.birthtimeMs !== previousLock.birthtimeMs)) {
        progressDeadline = performance.now() + lockTimeoutMs;
      }
      previousLock = stat ?? previousLock;
      const now = performance.now();
      if (now >= deadline || now >= progressDeadline) throw new Error('quota state locked');
      breakStaleLock(lock);
      await delay(Math.min(retryMs, Math.max(1, Math.min(deadline, progressDeadline) - performance.now())));
    }
  }
  let temporary, temporaryFd;
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    const { state: before, content: previousContent, mode } = readQuotaDocument(absolute);
    const next = callback(before);
    if (next && typeof next.then === 'function') {
      // Consume a rejected Promise without permitting asynchronous state writes.
      Promise.resolve(next).catch(() => {});
      throw new Error('quota callback must be synchronous');
    }
    const state = cleanState(next, Date.now());
    const content = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('quota state too large');
    if (content === previousContent && (mode & 0o777) === 0o600) return state;
    temporary = `${absolute}.${randomUUID()}.tmp`;
    checkPath(temporary);
    temporaryFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(temporaryFd, content);
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd);
    temporaryFd = undefined;
    checkPath(absolute);
    checkPath(temporary);
    fs.renameSync(temporary, absolute);
    temporary = undefined;
    const directoryFd = fs.openSync(path.dirname(absolute), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return state;
  } finally {
    if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
    if (temporary !== undefined) fs.unlinkSync(temporary);
    const held = fs.fstatSync(descriptor);
    fs.closeSync(descriptor);
    let current;
    try { current = fs.lstatSync(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current?.nlink === 1 && current.ino === held.ino && current.dev === held.dev
        && current.birthtimeMs === held.birthtimeMs) {
      try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
