import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forecast, decideQuota, calibrateQuota, readQuotaState, updateQuotaState, normalizeGo, normalizeOpenAI, verifiedRuntime } from './best-quota.mjs';
import { goExtraUsageSafety } from './best-quota-sources.mjs';

function parseInput(input) {
  try { return JSON.parse(input); } catch { throw new Error('Invalid quota JSON input'); }
}

export function nativeUsageReport(payload) {
  const data = payload?.data;
  const count = value => {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid native usage aggregate');
    return value;
  };
  const tokens = value => ({ input: count(value.input), output: count(value.output),
    cacheRead: count(value.cache.read), cacheWrite: count(value.cache.write) });
  if (!data || !Array.isArray(data.models)) throw new Error('Native usage unavailable');
  return { status: 'LIVE', from: new Date(data.range.from).toISOString(), to: new Date(data.range.to).toISOString(),
    sessions: count(data.sessions), subagents: count(data.subagents), prompts: count(data.prompts),
    steps: count(data.steps), tokens: tokens(data.tokens),
    models: data.models.map(entry => {
      const model = `${entry.model.providerID}/${entry.model.id}${entry.model.variant ? `#${entry.model.variant}` : ''}`;
      if (!/^[a-z0-9./_#+-]{1,200}$/i.test(model)) throw new Error('Invalid native model identity');
      return { model, steps: count(entry.steps), tokens: tokens(entry.tokens) };
    }).sort((a, b) => b.steps - a.steps),
    tools: data.tools?.totals ? { calls: count(data.tools.totals.calls), failed: count(data.tools.totals.failed),
      unfinished: count(data.tools.totals.unfinished) } : null,
    note: 'Model steps and cache tokens are workload metadata, not allowance percentages or proof of duplicate work.',
  };
}

function runtimeInventory(scope) {
  if (process.platform !== 'darwin' || !scope?.databaseDirectory) return null;
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,lstart=,comm='], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0) return null;
  const processes = result.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/);
    return match && path.basename(match[3]) === 'opencode'
      ? [{ pid: Number(match[1]), startedAt: new Date(match[2]).toISOString() }] : [];
  });
  if (!processes.length || processes.length > 64) return null;
  // Inspect only process identity and open-file names, never arguments,
  // environment, database contents or server/provider authentication material.
  const files = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', processes.map(p => p.pid).join(','), '-Fpn'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  if (files.status !== 0) return null;
  const best = new Set();
  let pid;
  for (const line of files.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line === `n${path.join(scope.databaseDirectory, 'opencode.db')}`) best.add(pid);
  }
  return processes.filter(p => best.has(p.pid));
}

export function runtimeCoverage(state, file, scope, inventory = runtimeInventory(scope), now = Date.now()) {
  const blocked = { status: 'BLOCKED', reason: 'EXISTING_LIVE_SESSION_COVERAGE_UNVERIFIED', instances: [], instanceIDs: [] };
  if (!scope?.configFile || !Array.isArray(inventory) || !inventory.length) return blocked;
  const instances = inventory.map(process => {
    const locations = new Map();
    for (const entry of [...(state.runtime?.instances ?? [])].sort((a, b) => Date.parse(a.loadedAt) - Date.parse(b.loadedAt))) {
      if (entry.pid === process.pid && Date.parse(entry.loadedAt) >= Date.parse(process.startedAt)) {
        locations.set(entry.configuration.location, entry);
      }
    }
    const receipts = [...locations.values()];
    const observed = entry => {
      const registered = Date.parse(entry.registeredAt), loaded = Date.parse(entry.loadedAt), started = Date.parse(process.startedAt);
      const fresh = name => {
        const value = entry.callbacks[name], at = Date.parse(value?.at);
        return Boolean(value) && value.outcome !== 'ERROR' && at >= registered && at <= now && now - at <= 900000;
      };
      // The instance must be provably alive now: a recent observed request or
      // the in-process heartbeat that idle locations emit instead of requests.
      const alive = fresh('heartbeat') || fresh('model.request');
      // Traffic evidence: any request that reached transport was proven against
      // a live subscription; an instance whose latest request was denied never
      // left pre-dispatch; one that has never sent a request needs no sample yet.
      const sample = entry.callbacks['model.request'];
      const reachedTransport = ['http.request', 'experimental.ws.handshake'].some(name =>
        entry.callbacks[name]?.liveSubscription === true && Date.parse(entry.callbacks[name].at) >= registered);
      const governed = !sample || reachedTransport || sample.outcome === 'BLOCKED';
      return !entry.unloadedAt && entry.origin === 'NATIVE_RUNTIME' && verifiedRuntime(entry.version)
        && entry.configuration.file === scope.configFile && entry.configuration.stateFile === file
        && typeof entry.configuration.location === 'string' && started <= loaded && loaded <= registered && registered <= now
        && alive && governed;
    };
    return { pid: process.pid, startedAt: process.startedAt, status: receipts.length && receipts.every(observed) ? 'PASS' : 'BLOCKED',
      instanceIDs: receipts.map(entry => entry.instanceID) };
  });
  return { status: instances.every(entry => entry.status === 'PASS') ? 'PASS' : 'BLOCKED',
    reason: instances.every(entry => entry.status === 'PASS') ? null : blocked.reason,
    instances, instanceIDs: instances.flatMap(entry => entry.instanceIDs) };
}

export async function quotaCLI(args, file, scope) {
  const [command = 'status', ...rest] = args;
  const allowed = ['status', 'report', 'doctor', 'forecast', 'monitor', 'disable', 'activate', 'manual', 'configure', 'confirm-extra-usage-off'];
  if (!allowed.includes(command)) throw new Error(`Unknown quota command: ${command}`);
  let state = readQuotaState(file);
  let admittedCoverage;
  if (['monitor', 'disable', 'activate'].includes(command)) {
    if (rest.length) throw new Error('Unexpected quota arguments');
    if (command === 'activate' && !goExtraUsageSafety(state).certified) {
      throw new Error(`Activation blocked: ${goExtraUsageSafety(state).reason}; a new explicit user confirmation OFF is required`);
    }
    if (command === 'activate' && (!state.runtime?.hookVerified || !verifiedRuntime(state.runtime?.version))) {
      throw new Error('Activation blocked: native pre-dispatch interception is not verified for this runtime');
    }
    if (command === 'activate') {
      const coverage = runtimeCoverage(state, file, scope);
      if (coverage.status !== 'PASS') throw new Error(`Activation blocked: ${coverage.reason}`);
      admittedCoverage = coverage;
      const prediction = forecast(state, Date.now(), state.policy);
      if (Object.values(prediction.providers).some(p => p.state === 'UNKNOWN' || !p.connection || p.source !== 'LIVE')) {
        throw new Error('Activation blocked: refresh both subscription sources and validate their connection identities');
      }
    }
    state = await updateQuotaState(file, current => {
      if (command === 'activate') {
        const billing = goExtraUsageSafety(current);
        if (!billing.certified) throw new Error(`Activation blocked: ${billing.reason}`);
        if (runtimeCoverage(current, file, scope, admittedCoverage.instances).status !== 'PASS'
            || !admittedCoverage.instanceIDs.every(id => current.runtime?.instances?.some(entry => entry.instanceID === id && !entry.unloadedAt))) {
          throw new Error('Activation blocked: EXISTING_LIVE_SESSION_COVERAGE_UNVERIFIED; instance reloaded during activation');
        }
      }
      return { ...current, policy: { ...current.policy,
        mode: command === 'activate' ? 'active' : command === 'monitor' ? 'monitor' : 'disabled' } };
    });
  } else if (command === 'confirm-extra-usage-off') {
    if (rest.length !== 4 || rest[0] !== '--confirmed-by' || rest[2] !== '--confirmed-at') {
      throw new Error('Usage: best quota confirm-extra-usage-off --confirmed-by USER_LABEL --confirmed-at ISO_TIMESTAMP');
    }
    const confirmedAt = Date.parse(rest[3]), now = Date.now();
    if (!Number.isFinite(confirmedAt) || confirmedAt > now || now - confirmedAt >= 3600000) {
      throw new Error('Extra Usage confirmation expired or invalid; request a new user confirmation OFF');
    }
    state = await updateQuotaState(file, current => {
      const connection = current.sources['opencode-go']?.connection;
      if (!connection) throw new Error('Go subscription identity unavailable; refresh before confirming Extra Usage OFF');
      current.extraUsageConfirmations ??= [];
      current.extraUsageConfirmations.push({ id: randomUUID(), source: 'manual_user_confirmed', status: 'OFF',
        confirmedBy: rest[1], connection, confirmedAt: new Date(confirmedAt).toISOString(),
        expiresAt: new Date(confirmedAt + 3600000).toISOString() });
      return current;
    });
  } else if (command === 'manual') {
    if (rest.length !== 1 || !['openai', 'opencode-go'].includes(rest[0])) throw new Error('Usage: best quota manual openai|opencode-go < verified-usage.json');
    // Same rigorously validated schema as the endpoint; never labelled automatic.
    const input = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > 65536) throw new Error('Manual quota input too large');
    const payload = parseInput(input);
    const observedAt = Date.parse(payload.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 15 * 60000) {
      throw new Error('Manual input requires a verified observedAt timestamp from the last 15 minutes');
    }
    const snapshot = (rest[0] === 'openai' ? normalizeOpenAI : normalizeGo)(payload, observedAt);
    snapshot.source = 'MANUAL';
    if (state.sources[rest[0]]?.connection) snapshot.connection = state.sources[rest[0]].connection;
    state = await updateQuotaState(file, current => {
      current.snapshots.push(snapshot);
      current.sources[rest[0]] = { ...current.sources[rest[0]], at: snapshot.at, status: 'MANUAL', lastSuccessAt: snapshot.at };
      return current;
    });
  } else if (command === 'configure') {
    if (rest.length) throw new Error('Usage: best quota configure < policy.json');
    const input = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > 8192) throw new Error('Quota policy input too large');
    const settings = parseInput(input);
    if (!settings || Array.isArray(settings) || typeof settings !== 'object' || 'mode' in settings) throw new Error('Use monitor/activate/disable to change mode');
    const keys = ['safetyMarginPercent', 'staleAfterMs', 'smoothingMs', 'cooldownMs', 'hysteresisPercent', 'expectedPercentByKind'];
    if (Object.keys(settings).some(k => !keys.includes(k))) throw new Error('Unknown quota policy setting');
    state = await updateQuotaState(file, current => ({ ...current, policy: { mode: 'monitor', ...current.policy, ...settings } }));
  } else if (command === 'report') {
    if (rest.length && (rest.length !== 2 || rest[0] !== '--days' || !/^\d+$/.test(rest[1]) || Number(rest[1]) < 1 || Number(rest[1]) > 35)) {
      throw new Error('Usage: best quota report --days 1..35');
    }
  } else if (rest.length) throw new Error('Unexpected quota arguments');
  const prediction = forecast(state, Date.now(), state.policy);
  const extraUsage = goExtraUsageSafety(state);
  const coverage = runtimeCoverage(state, file, scope);
  const calibration = calibrateQuota(state);
  const uncalibratedClasses = Object.entries(calibration.classes).filter(([, entry]) => entry.state === 'UNKNOWN').map(([name]) => name);
  const automaticallyExcludedClasses = uncalibratedClasses.filter(name => name === 'discovery-mimo');
  const days = command === 'report' && rest.length ? Number(rest[1]) : 7;
  const recent = state.usage.filter(entry => Date.parse(entry.at) >= Date.now() - days * 86400000);
  const models = {};
  for (const entry of recent) {
    const key = entry.model ?? entry.provider;
    const model = models[key] ??= { requests: 0, retries: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const metric of Object.keys(model)) model[metric] += entry[metric] ?? (metric === 'requests' ? 1 : 0);
  }
  const candidates = [
    { provider: 'opencode-go', model: 'opencode-go/qwen3.7-plus', agent: 'general' },
    { provider: 'openai', model: 'openai/gpt-6.1-sol#medium', agent: 'general' },
  ];
  return {
    operational: state.policy?.mode === 'active' ? (coverage.status === 'PASS' && extraUsage.certified && state.runtime?.hookVerified
      && verifiedRuntime(state.runtime.version) ? 'ACTIVE' : 'BLOCKED') : 'MONITOR ONLY',
    mode: state.policy?.mode ?? 'monitor', at: prediction.at, providers: prediction.providers,
    activation: { status: extraUsage.certified && coverage.status === 'PASS'
      && state.runtime?.hookVerified && verifiedRuntime(state.runtime?.version)
      && Object.values(prediction.providers).every(p => p.state !== 'UNKNOWN' && p.connection && p.source === 'LIVE') ? 'PASS' : 'BLOCKED',
      blockers: [...(extraUsage.certified ? [] : [extraUsage.reason]), ...(coverage.status === 'PASS' ? [] : [coverage.reason]),
      ...(!state.runtime?.hookVerified || !verifiedRuntime(state.runtime?.version) ? ['NATIVE_RUNTIME_UNVERIFIED'] : []),
      ...(Object.values(prediction.providers).some(p => p.state === 'UNKNOWN' || !p.connection || p.source !== 'LIVE') ? ['SUBSCRIPTION_QUOTAS_UNVERIFIED'] : []),
      ],
      // Per-class cost envelopes refine admission when available. Missing
      // estimates do not disable the independent, mandatory account gates.
      warnings: uncalibratedClasses.length ? ['ACTIVITY_COST_ESTIMATES_INCOMPLETE'] : [],
      uncalibratedClasses, automaticallyExcludedClasses, coverage,
      extraUsage, nativeQualification: coverage.status === 'PASS' ? 'LIVE_CALLBACKS_OBSERVED'
        : state.runtime?.hookVerified ? 'SIMULATED_NATIVE_ONLY' : 'UNVERIFIED' },
    sources: state.sources, policy: { ...prediction.options, cooldownMs: 300000, hysteresisPercent: 5,
      ...(state.policy ?? { mode: 'monitor' }) }, runtime: state.runtime ?? null,
    days, models, recommended: decideQuota({ kind: 'coding', candidates, forecast: prediction,
      previous: state.decisions.at(-1), options: state.policy }),
    routing: (() => {
      const last = state.decisions.filter(d => d.scope === 'routing').at(-1);
      const applied = Boolean((state.policy?.mode ?? 'monitor') === 'active'
        && last?.enforced === true && last?.applied && last?.candidate?.model === last.applied);
      return {
        // PASS only when the last routing decision was enforced at dispatch
        // time and the model recorded as applied is the one recommended.
        // Monitor mode never enforces, so it honestly reports FAIL.
        automatic: applied ? 'PASS' : 'FAIL',
        mode: state.policy?.mode ?? 'monitor',
        recommended: last?.candidate?.model ?? null,
        applied: last?.applied ?? null,
        at: last?.at ?? null,
        enforced: last?.enforced === true,
        decisions: state.decisions.filter(d => d.scope === 'routing').length,
        appliedDecisions: state.decisions.filter(d => d.scope === 'routing' && d.applied).length,
      };
    })(),
    effective: state.decisions.filter(d => d.enforced === true).slice(-20),
    simulated: state.decisions.filter(d => d.enforced !== true).slice(-20),
    collectionStartedAt: state.usage[0]?.at ?? null,
    reservations: state.leases ?? [],
    calibration: { ...calibration, configuredTaskEstimates: Boolean(state.policy?.expectedPercentByKind),
      note: 'Class envelopes use real quota deltas, not tokens or step weights. Concurrent and external consumption cannot be isolated; future task duration remains unknown.' },
    limitations: ['A projection is not a provider guarantee; no inference is used by quota commands.',
      'Missing or stale constraints block new work only in verified active mode.',
      'High cache-read alone does not establish redundant work; historical content is not collected.'],
  };
}
