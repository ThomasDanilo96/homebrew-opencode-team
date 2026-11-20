import { collectQuotas, subscriptionConnection, goExtraUsageSafety, verifySubscriptionTransport } from './best-quota-sources.mjs';
import { forecast, decideQuota, classifyActivity, calibrateQuota, estimateQuotaCost, readQuotaState, updateQuotaState,
  verifiedRuntime, liveLeases, reservedPercent } from './best-quota.mjs';
import { randomUUID } from 'node:crypto';

const kinds = { build: 'coding', general: 'coding', explore: 'scan', specialist: 'complex',
  reviewer: 'review', plan: 'architecture', 'visual-designer': 'visual' };
const candidate = (agent, model) => ({ agent, model, provider: model.split('/')[0] });
const exploreFallback = 'openai/gpt-6.2-sol#low';
const blocked = (reason = 'admission-denied') => {
  throw new Error(`BEST_QUOTA_BLOCKED (${reason}): new work suspended; state retained. Run opencode-team best quota status.`);
};

export async function setupGovernor(ctx, dependencies = {}) {
  const file = ctx.options.stateFile;
  if (typeof file !== 'string') throw new Error('BEST quota stateFile required');
  const collect = dependencies.collect ?? collectQuotas;
  const subscription = dependencies.subscription ?? subscriptionConnection;
  const goPaymentSafety = dependencies.goPaymentSafety ?? goExtraUsageSafety;
  const transportSafety = dependencies.transportSafety ?? verifySubscriptionTransport;
  const pinned = new Map();
  const leases = new Map();
  const effortTurns = new Map();
  const requestReservations = new Map();
  const asyncDelegation = ctx.app.version === '2.3.2';
  const active = state => state.policy?.mode === 'active';
  // A receipt belongs to one setup/cleanup lifecycle, not just a reusable PID.
  // Record only configuration identity and callback metadata, never event bodies.
  const instance = { instanceID: randomUUID(), pid: process.pid, version: ctx.app.version,
    origin: Object.keys(dependencies).length ? 'INJECTED_TEST' : 'NATIVE_RUNTIME',
    loadedAt: new Date().toISOString(), configuration: { file: process.env.OPENCODE_CONFIG ?? null,
      stateFile: file, location: ctx.location?.directory ?? null }, callbacks: {} };
  const attest = patch => updateQuotaState(file, state => {
    if (!state.runtime) return state;
    state.runtime.instances ??= [];
    const index = state.runtime.instances.findIndex(entry => entry.instanceID === instance.instanceID);
    const previous = index < 0 ? instance : state.runtime.instances[index];
    const receipt = { ...previous, ...patch, at: new Date().toISOString(),
      callbacks: { ...previous.callbacks, ...patch.callbacks } };
    if (index < 0) state.runtime.instances.push(receipt);
    else state.runtime.instances[index] = receipt;
    return state;
  });
  const guarded = fn => async event => {
    try {
      if (readQuotaState(file).policy?.mode === 'disabled') return;
      return await fn(event);
    }
    catch (error) {
      // Observation failure must not break work in monitor mode. No exception
      // text is logged: transport errors may contain credential material.
      let state;
      try { state = readQuotaState(file); } catch { blocked('quota-state-unavailable'); }
      if (active(state)) throw error;
      console.warn('BEST quota observation unavailable; monitor mode has not changed execution.');
    }
  };
  async function configuredModel(agent) {
    const { data } = await ctx.agent.get({ agentID: agent });
    const model = data?.model;
    if (!model?.providerID || !model.id) return null;
    return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}`;
  }
  const pidAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  const requestLeaseMs = 15 * 60000;
  function observedRequestCost(value, state, prediction, calibration) {
    const [model, variant] = value.model.split('#');
    const name = classifyActivity({ provider: value.provider, model, variant });
    if (name === 'reasoning-sol-high') {
      // High has no measured multiplier. Reserve at least the existing safety
      // margin (and two snapshot endpoints), or the largest observed Sol
      // envelope over the full admission horizon, whichever is greater.
      const estimates = ['coordination-sol-low', 'analysis-review-sol-medium', name]
        .map(activity => estimateQuotaCost(calibration, activity, requestLeaseMs))
        .filter(estimate => estimate.state === 'ESTIMATE');
      if (!estimates.length) return null;
      return Object.fromEntries(Object.keys(prediction.providers.openai.windows).map(window =>
        [window, estimates.some(estimate => Number.isFinite(estimate.windows[window]))
          ? Math.max(2, prediction.options.safetyMarginPercent, ...estimates.map(estimate => estimate.windows[window] ?? 0))
          : Infinity]));
    }
    if (name === 'unclassified') return {};
    const durations = state.usage.filter(u => u.durationMs > 0 && u.provider === value.provider && classifyActivity(u) === name
      && u.connection === prediction.providers[value.provider].connection
      && Date.parse(u.at) >= Date.parse(prediction.at) - prediction.options.smoothingMs).map(u => u.durationMs);
    if (!durations.length) return {};
    // Reserve the observed scenario for at most the admission lease horizon,
    // not the entire duration of a historical turn or interrupted execution.
    return estimateQuotaCost(calibration, name, Math.min(Math.max(...durations), requestLeaseMs)).windows;
  }
  const fitsObservedRequest = (cost, provider, held) => cost !== null && Object.entries(cost).every(([window, percent]) =>
    percent <= provider.windows[window]?.remaining - held);
  let refreshPromise, lastRefresh = 0;
  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && Date.now() - lastRefresh < 60000) return;
    refreshPromise = (async () => {
      const result = await collect(ctx);
      await updateQuotaState(file, state => {
        state.snapshots.push(...result.snapshots);
        for (const [provider, source] of Object.entries(result.sources)) {
          state.sources[provider] = { ...state.sources[provider], ...source,
            ...(source.status === 'LIVE' ? { error: undefined } : {}) };
        }
        return state;
      });
      lastRefresh = Date.now();
    })();
    try { await refreshPromise; } finally { refreshPromise = undefined; }
  }
  await guarded(() => updateQuotaState(file, state => ({ ...state, runtime: {
    ...state.runtime, version: ctx.app.version, loadedAt: new Date().toISOString(),
    hookVerified: state.runtime?.version === ctx.app.version && state.runtime?.hookVerified === true,
  } })))();
  await guarded(() => refresh())();
  async function choose(agent, models, leaseID, sessionID, reserveRequest = false) {
    await refresh();
    const { data: inventory } = await ctx.model.list();
    const goCertified = (await goPaymentSafety(readQuotaState(file))).certified === true;
    let decision, reservation;
    const state = await updateQuotaState(file, current => {
      const prediction = forecast(current, Date.now(), current.policy);
      const calibration = calibrateQuota(current);
      // Time alone is not proof that a worker ended. Recover a reservation only
      // after its owning server process is known to be gone; otherwise hold it.
      current.leases = liveLeases(current.leases ?? []);
      // Concurrency caps scale with the live BEST instances sharing this state
      // file, so 3-5 terminals are not serialized onto one delegation each.
      const instanceCapacity = Math.max(1, new Set((current.runtime?.instances ?? [])
        .filter(entry => !entry.unloadedAt && pidAlive(entry.pid)).map(entry => entry.instanceID)).size);
      // Percent points already committed by in-flight admissions (this and
      // other instances) so parallel terminals cannot spend one budget twice.
      const reserved = Object.fromEntries(['opencode-go', 'openai'].map(provider =>
        [provider, reservedPercent(current.leases.filter(lease =>
          reserveRequest || !sessionID || lease.sessionID !== sessionID), provider)]));
      const candidates = models.filter(value => inventory.some(m => m.providerID === value.provider
        && m.id === value.model.split('/').slice(1).join('/').split('#')[0] && m.enabled !== false
        && (!(reserveRequest || value.model === 'openai/gpt-6.2-sol#high')
          || m.variants?.some(variant => variant.id === value.model.split('#')[1]))))
        .filter(value => !leaseID || !active(current) || (current.leases ?? []).filter(l => l.provider === value.provider
            && l.scope !== 'admission' && (!sessionID || l.sessionID !== sessionID)).length
          < (value.provider === 'opencode-go' ? 2 : 1) * instanceCapacity)
        .filter(value => !active(current) || value.provider !== 'opencode-go' || goCertified)
        // No invented starting allowance for discovery. This excludes only
        // automatic MiMo routing; independent candidates remain eligible.
        .filter(value => classifyActivity({ provider: value.provider, model: value.model.split('#')[0] }) !== 'discovery-mimo'
          || calibration.classes['discovery-mimo'].state !== 'UNKNOWN')
        .filter(value => !active(current) || fitsObservedRequest(observedRequestCost(value, current, prediction, calibration),
          prediction.providers[value.provider], reserved[value.provider]));
      const routing = { kind: kinds[agent] ?? 'coding', candidates,
        forecast: prediction,
        // A new Build execution may have different effort requirements. Provider
        // hysteresis must not pin yesterday's Medium over today's qualified High.
        previous: agent === 'build' ? undefined : current.decisions.findLast(d => d.scope === 'routing' && d.candidate?.agent === agent),
        options: { ...current.policy, reserved } };
      // Explore uses OpenAI only when the configured model cannot be admitted.
      if (candidates.some(value => value.model === exploreFallback) && agent === 'explore') {
        decision = decideQuota({ ...routing, candidates: candidates.filter(value => value.model !== exploreFallback) });
      }
      if (!decision || decision.blocked) decision = decideQuota(routing);
      current.decisions.push({ ...decision, scope: 'routing', enforced: active(current) });
      if (reserveRequest && active(current) && !decision.blocked) {
        const cost = observedRequestCost(decision.candidate, current, prediction, calibration);
        const percent = Math.max(decision.estimatedTaskPercent ?? 0, ...Object.values(cost));
        const id = randomUUID();
        current.leases.push({ id, provider: decision.candidate.provider, ownerPid: process.pid,
          scope: 'admission', percent, sessionID, at: new Date().toISOString(),
          expiresAt: new Date(Date.now() + requestLeaseMs).toISOString() });
        reservation = { id, model: decision.candidate.model, cost,
          connection: prediction.providers[decision.candidate.provider].connection, recorded: false };
      }
      if (leaseID && active(current) && !decision.blocked) {
        current.leases ??= [];
        // A join is still one worker. Replace its capacity receipt atomically;
        // a delayed completion holding the old lease ID cannot release this run.
        if (sessionID) current.leases = current.leases.filter(lease =>
          lease.scope !== 'routing' || lease.sessionID !== sessionID);
        current.leases.push({ id: leaseID, provider: decision.candidate.provider, ownerPid: process.pid,
          ...(sessionID ? { sessionID } : {}),
          scope: 'routing', at: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() });
      }
      return current;
    });
    return { state, decision, reservation };
  }
  await ctx.tool.hook('execute.before', guarded(async event => {
    if (event.tool !== 'subagent') return;
    const agent = event.input?.agent;
    if (asyncDelegation && active(readQuotaState(file)) && (!ctx.event || !ctx.session.get)) {
      blocked('delegation-lifecycle-unverified');
    }
    if (!asyncDelegation && event.input?.background === true && active(readQuotaState(file))) {
      blocked('background-lifecycle-unverified; use background=false');
    }
    if (!kinds[agent] || (active(readQuotaState(file)) && !verifiedRuntime(ctx.app.version))) {
      if (active(readQuotaState(file))) blocked(!kinds[agent] ? 'unsupported-agent' : 'runtime-version-unverified');
      return;
    }
    if (event.input.sessionID) {
      // A resumed native child already owns its model and completed work. Never
      // run new-delegation routing over it, or replace it with a fresh child.
      // V2's Promise adapter unwraps data-only session responses, unlike the
      // location-scoped agent/model envelopes.
      const child = await ctx.session.get({ sessionID: event.input.sessionID });
      if (!child?.model || child.agent !== agent) {
        if (active(readQuotaState(file))) blocked('resume-session-model');
        return;
      }
      const model = `${child.model.providerID}/${child.model.id}${child.model.variant ? `#${child.model.variant}` : ''}`;
      if (event.input.model && event.input.model !== model) {
        if (active(readQuotaState(file))) blocked('resume-model-override');
        return;
      }
      await checkRequest({ sessionID: event.input.sessionID, agent, kind: 'primary', model: child.model }, false, false, undefined, true);
      const leaseID = randomUUID();
      const { state, decision } = await choose(agent, [candidate(agent, model)], leaseID, event.input.sessionID);
      if (active(state)) {
        if (decision.blocked) blocked(decision.reason);
        leases.set(`${event.sessionID}:${event.id}`, leaseID);
      }
      return;
    }
    const configured = await configuredModel(agent);
    if (!configured) { if (active(readQuotaState(file))) blocked('agent-model-unavailable'); return; }
    const models = [candidate(agent, configured)];
    // Cross-provider alternatives are for new delegations, never resumed children.
    if (agent === 'general') {
      const alternative = await configuredModel('specialist');
      if (alternative?.startsWith('openai/')) models.push(candidate(agent, alternative));
    } else if (agent === 'explore') models.push(candidate(agent, exploreFallback));
    if (event.input.model && !models.some(m => m.model === event.input.model)) {
      if (active(readQuotaState(file))) blocked('delegation-model-override');
      return;
    }
    const leaseID = randomUUID();
    const { state, decision } = await choose(agent, models, leaseID);
    if (!active(state)) return;
    if (decision.blocked) blocked(decision.reason);
    leases.set(`${event.sessionID}:${event.id}`, leaseID);
    event.input.model = decision.candidate.model;
  }));
  async function childIdleSince(sessionID, at) {
    try {
      const child = await ctx.session.get({ sessionID });
      return Number.isFinite(child?.time?.idle) && child.time.idle > Date.parse(at)
        && (!Number.isFinite(child.time.busy) || child.time.idle > child.time.busy);
    } catch {
      console.warn('BEST quota child lifecycle unavailable; reservation retained.');
      return false;
    }
  }
  await ctx.tool.hook('execute.after', async event => {
    const key = `${event.sessionID}:${event.id}`, id = leases.get(key);
    if (!id) return;
    if (asyncDelegation) {
      // 2.3.2 returns from subagent while the child is still running, regardless
      // of background=false. Persist the native child identity; tool completion
      // is not worker completion. Unknown correlation must retain capacity.
      const sessionID = event.result?.metadata?.sessionID;
      if (event.status !== 'completed' || typeof sessionID !== 'string'
          || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(sessionID)
          || (event.input?.sessionID && event.input.sessionID !== sessionID)) {
        blocked('delegation-lifecycle-unverified');
      }
      const state = await updateQuotaState(file, current => {
        const lease = current.leases?.find(lease => lease.id === id);
        if (lease) lease.sessionID = sessionID;
        return current;
      });
      leases.delete(key);
      const lease = state.leases?.find(lease => lease.id === id);
      // Reconcile a child that ended before execute.after could bind its ID.
      // A prior resume's stale outcome/idle timestamp is never sufficient.
      if (!lease || !await childIdleSince(sessionID, lease.at)) return;
    }
    // Releasing existing capacity is lifecycle cleanup, not new work. It must
    // still happen when a human disables monitoring while the worker finishes.
    await updateQuotaState(file, state => ({ ...state, leases: (state.leases ?? []).filter(l => l.id !== id) }));
    leases.delete(key);
  });
  async function recordRequest(event, state, binding) {
    const model = `${event.model.providerID}/${event.model.id}`;
    const variant = event.model.variant;
    const activityClass = classifyActivity({ provider: event.model.providerID, model, variant });
    const connection = binding ?? state.sources[event.model.providerID]?.connection;
    const at = new Date().toISOString();
    pinned.set(`${event.sessionID}:${event.kind}`, { model, variant, activityClass, connection, startedAt: Date.now() });
    await updateQuotaState(file, current => {
      current.usage.push({ at, provider: event.model.providerID, model,
        ...(variant ? { variant } : {}), ...(connection ? { connection } : {}),
        // Older running instances accept the variant but not the new class enum.
        // Infer High from its actual model/variant on read, without breaking them.
        ...(activityClass === 'reasoning-sol-high' ? {} : { activityClass }),
        kind: kinds[event.agent] ?? 'coding', requests: 1 });
      return current;
    });
  }
  const checkRequest = async (event, record = true, transport = false, observation, joining = false) => {
    await refresh();
    const model = `${event.model.providerID}/${event.model.id}`;
    const state = readQuotaState(file);
    if (observation) observation.mode = state.policy?.mode ?? 'disabled';
    if (!active(state)) {
      if (record && ['openai', 'opencode-go'].includes(event.model.providerID)) {
        await recordRequest(event, state);
      }
      return;
    }
    if (!verifiedRuntime(ctx.app.version)) blocked('runtime-version-unverified');
    // The guard sees the actual selected model, including old sessions and all
    // auxiliary calls. Never substitute HTTP endpoints, headers or credentials.
    const continuity = (event.kind === 'compaction' || event.agent === 'summary') && model === 'opencode-go/minimax-m3';
    const roleModel = (await configuredModel(event.agent || 'build'))?.split('#')[0];
    const alternative = event.agent === 'general' ? (await configuredModel('specialist'))?.split('#')[0] : null;
    const compatible = model === roleModel || (event.agent === 'general' && model === alternative)
      || (event.agent === 'explore' && `${model}#${event.model.variant}` === exploreFallback)
      || (event.kind === 'title' && model === 'openai/gpt-6-luna') || continuity;
    const binding = await subscription(ctx, event.model.providerID);
    if (event.model.providerID === 'opencode-go' && !(await goPaymentSafety(state, Date.now(), binding)).certified) blocked('go-payment-safety-unverified');
    if (!compatible || /claude|anthropic/i.test(model) || (/minimax/i.test(model) && !continuity)) blocked('incompatible-model');
    if (!binding) blocked('subscription-binding-unverified');
    // Transport verification is async prep and must finish before any
    // reservation is taken, so a transport failure never leaks a lease.
    if (transport && !await transportSafety(ctx, event)) blocked('subscription-transport-unverified');
    const selected = candidate(event.agent || 'build', `${model}${event.model.variant ? `#${event.model.variant}` : ''}`);
    // One atomic read-decide-reserve cycle: parallel BEST instances see each
    // other's in-flight percent before their own quota snapshot is written.
    let decision, leaseID, reservation;
    const observedState = await updateQuotaState(file, current => {
      // Same liveness rule as routing: an admission reservation whose owning
      // process is gone or whose deadline passed is already released, so a
      // session that died without a lifecycle event cannot hold budget forever.
      current.leases = liveLeases(current.leases ?? []);
      const prediction = forecast(current, Date.now(), current.policy);
      const provider = prediction.providers[event.model.providerID];
      if (provider.connection !== binding) blocked('account-changed');
      if (provider.confirmedExhausted || ['EXHAUSTED', 'UNKNOWN'].includes(provider.state)) blocked('quota-unavailable');
      const pending = requestReservations.get(`${event.sessionID}:${event.kind}`);
      // Reuse only this exact request's live receipt, never every reservation
      // sharing its session. Recheck quota and account, not a changed estimate
      // after the request (including its effort) has already been prepared.
      const own = pending && (!record || !pending.recorded) && pending.model === selected.model
        && pending.connection === binding && current.leases.find(lease => lease.id === pending.id);
      const held = reservedPercent((current.leases ?? []).filter(lease =>
        lease.id !== own?.id && !(joining && lease.sessionID === event.sessionID)), event.model.providerID);
      const cost = own ? pending.cost : observedRequestCost(selected, current, prediction, calibrateQuota(current));
      if (!fitsObservedRequest(cost, provider, held)) blocked('calibrated-request-envelope');
      decision = decideQuota({ kind: kinds[event.agent] ?? 'coding',
        candidates: [selected], forecast: prediction,
        options: { ...current.policy, reserved: { [event.model.providerID]: held } } });
      if (record) {
        current.decisions.push({ ...decision, scope: 'admission', enforced: true });
        if (!decision.blocked && !own) {
          leaseID = randomUUID();
          current.leases ??= [];
          current.leases.push({ id: leaseID, provider: decision.candidate.provider, ownerPid: process.pid,
            scope: 'admission', percent: Math.max(decision.estimatedTaskPercent ?? 0, ...Object.values(cost)), sessionID: event.sessionID,
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + requestLeaseMs).toISOString() });
          reservation = { id: leaseID, model: selected.model, cost, connection: binding, recorded: true };
        }
        if (!decision.blocked && own) reservation = { ...pending, recorded: true };
      }
      return current;
    });
    if (decision.blocked) blocked(decision.reason);
    if (!record) return;
    requestReservations.set(`${event.sessionID}:${event.kind}`, reservation);
    await recordRequest(event, observedState, binding);
  };
  const observedRequest = (name, record, transport) => guarded(async event => {
    const observation = { mode: readQuotaState(file).policy?.mode ?? 'disabled' };
    let outcome = 'ERROR';
    try {
      await checkRequest(event, record, transport, observation);
      outcome = observation.mode === 'active' ? 'PASSED' : 'MONITOR_OBSERVED';
    }
    catch (error) {
      outcome = error.message?.includes('BEST_QUOTA_BLOCKED') ? 'BLOCKED' : 'ERROR';
      throw error;
    } finally {
      const state = readQuotaState(file), source = state.sources[event.model.providerID];
      const age = Date.now() - Date.parse(source?.at);
      // A native hook invocation alone is not live subscription proof: local
      // fixture transports and injected safety bindings must never qualify.
      const liveSubscription = transport && instance.origin === 'NATIVE_RUNTIME'
        && source?.status === 'LIVE' && age >= 0 && age <= (state.policy?.staleAfterMs ?? 900000)
        && source.connection === await subscription(ctx, event.model.providerID)
        && await transportSafety(ctx, event);
      await attest({ callbacks: { [name]: { at: new Date().toISOString(), outcome,
        mode: observation.mode, liveSubscription: Boolean(liveSubscription) } } });
    }
  });
  async function recordApplied(decision) {
    await updateQuotaState(file, current => {
      const index = current.decisions.findLastIndex(entry => entry.scope === 'routing'
        && entry.at === decision.at && entry.candidate?.model === decision.candidate.model && entry.applied === undefined);
      if (index >= 0) current.decisions[index].applied = decision.candidate.model;
      return current;
    });
  }
  // Resolve the actual request rather than overwriting the user's session model.
  // Unlike prompt admission, this native boundary also covers /goal synthetics.
  if (ctx.app.version === '2.3.2') await ctx.session.hook('experimental.model.resolve', guarded(async event => {
    if (event.agent !== 'build' || event.kind !== 'primary'
        || event.model.providerID !== 'openai' || event.model.id !== 'gpt-6.2-sol') return;
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (!session || session.parentID) return;
    const state = readQuotaState(file);
    if (!active(state)) return;
    if (session.model && (session.model.providerID !== 'openai' || session.model.id !== 'gpt-6.2-sol'
        || (session.model.variant && !['default', 'low', 'medium', 'high'].includes(session.model.variant)))) return;
    const explicit = ['low', 'medium', 'high'].includes(session.model?.variant)
      ? `openai/gpt-6.2-sol#${session.model.variant}` : undefined;
    const previous = effortTurns.get(event.sessionID);
    const busy = session.time?.busy ?? 0;
    const continued = previous?.busy === busy && previous.explicit === explicit;
    let variant = continued ? previous.variant : session.model?.variant ?? 'medium';
    if (!continued && !explicit) {
      const messages = await ctx.session.context({ sessionID: event.sessionID });
      const start = messages.findLastIndex(message => message.type === 'user'
        || (message.type === 'synthetic' && message.metadata?.source === 'goal'));
      const mandate = messages.slice(Math.max(0, start));
      const complex = mandate.some(message => message.metadata?.source === 'goal'
        || message.agents?.some(agent => ['specialist', 'plan', 'reviewer'].includes(agent.name))
        || message.skills?.some(skill => ['security-review', 'architecture-decision-records'].includes(skill.id))
        || message.content?.some(part => part.type === 'tool' && part.name === 'todowrite'
          && part.state?.input?.todos?.filter(todo => ['pending', 'in_progress'].includes(todo.status)).length > 1));
      const task = mandate[0];
      // Only an unambiguous single response is automatically Low. Unknown work,
      // files and attached specialist skills retain the Medium default.
      const simple = task?.type === 'user' && !task.files?.length && !task.skills?.length && !task.agents?.length
        && /^(?:reply exactly|respond exactly|rispondi esattamente)\s+\S+[.!]?$/i.test(task.text?.trim() ?? '');
      variant = complex ? 'high' : simple ? 'low' : 'medium';
    }
    const connection = state.sources.openai?.connection;
    const highQualified = state.sources.openai?.status === 'LIVE' && typeof connection === 'string'
      && state.usage.some(usage => usage.connection === connection && usage.output > 0 && usage.durationMs > 0
        && classifyActivity(usage) === 'reasoning-sol-high');
    if (!explicit && variant === 'high' && !highQualified) variant = 'medium';
    const base = 'openai/gpt-6.2-sol';
    const models = [candidate('build', `${base}#${variant}`)];
    if (!explicit && variant === 'high') models.push(candidate('build', `${base}#medium`));
    if (!explicit && variant !== 'low') models.push(candidate('build', `${base}#low`));
    // Choose and reserve before native request construction, under the same
    // lock as admission. Another session cannot spend the chosen envelope.
    const { state: chosenState, decision, reservation } = await choose('build', models, undefined, event.sessionID, true);
    if (!active(chosenState)) return;
    if (decision.blocked) blocked(decision.reason);
    requestReservations.set(`${event.sessionID}:${event.kind}`, reservation);
    variant = decision.candidate.model.split('#')[1];
    event.model = { ...event.model, variant };
    effortTurns.set(event.sessionID, { busy, explicit, variant });
    await recordApplied(decision);
  }));
  // Regulation must reach the request, not only the record. This native prompt
  // hook runs before the runner resolves the turn's model, so switching the
  // session here is what the turn actually runs on. A subagent child was
  // already routed when it was dispatched; re-routing it would fight
  // execute.before and count its budget twice.
  await ctx.session.hook('prompt', guarded(async event => {
    let mode = readQuotaState(file).policy?.mode ?? 'monitor';
    let outcome = 'SKIPPED';
    try {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (!session || session.parentID || !kinds[session.agent]) return;
      const configured = await configuredModel(session.agent);
      if (!configured) return;
      // Build 6.2 is resolved once per execution, including goal continuations.
      if (ctx.app.version === '2.3.2' && session.agent === 'build'
          && configured.split('#')[0] === 'openai/gpt-6.2-sol') return;
      const selected = session.model && `${session.model.providerID}/${session.model.id}`;
      const keepVariant = session.agent === 'build' && selected?.startsWith('openai/')
        && selected === configured.split('#')[0] && ['low', 'medium'].includes(session.model.variant);
      const models = [candidate(session.agent, keepVariant ? `${selected}#${session.model.variant}` : configured)];
      // The same bounded cross-provider choice a new delegation gets: only
      // General may leave its configured provider, and only toward OpenAI.
      if (session.agent === 'general') {
        const alternative = await configuredModel('specialist');
        if (alternative?.startsWith('openai/')) models.push(candidate(session.agent, alternative));
      }
      const leaseID = randomUUID();
      const { state, decision } = await choose(session.agent, models, leaseID);
      mode = state.policy?.mode ?? mode;
      // Prompt routing decides, it does not dispatch: its capacity lease ends
      // with the decision so parallel prompts can never starve each other.
      // Admission still reserves the real percent at model.request.
      await updateQuotaState(file, current => ({ ...current,
        leases: (current.leases ?? []).filter(lease => lease.id !== leaseID) }));
      if (decision.blocked) {
        // Monitor keeps observing without refusing work. Active has no
        // admissible route left for this agent, so the turn stops before an
        // unregulated request can be queued.
        if (active(state)) blocked(decision.reason);
        outcome = 'MONITOR_OBSERVED';
        return;
      }
      const applied = decision.candidate.model;
      const effective = session.model
        ? `${session.model.providerID}/${session.model.id}${session.model.variant ? `#${session.model.variant}` : ''}`
        : configured;
      if (active(state)) {
        if (effective !== applied) {
          const [head, variant] = applied.split('#');
          const slash = head.indexOf('/');
          await ctx.session.switchModel({ sessionID: event.sessionID, model: {
            providerID: head.slice(0, slash), id: head.slice(slash + 1),
            ...(variant ? { variant } : {}) } });
        }
        // The applied model is the evidence the report reads, so it is written
        // onto the very decision that recommended it — only when this turn
        // will really run on that recommendation.
        await recordApplied(decision);
        outcome = 'APPLIED';
      } else outcome = 'MONITOR_OBSERVED';
    } catch (error) {
      outcome = error.message?.includes('BEST_QUOTA_BLOCKED') ? 'BLOCKED' : 'ERROR';
      throw error;
    } finally {
      await attest({ callbacks: { prompt: { at: new Date().toISOString(), outcome,
        mode, liveSubscription: false } } });
    }
  }));
  await ctx.session.hook('model.request', observedRequest('model.request', true, false));
  // Native retries may reuse an already prepared request. Inspect the final
  // HTTP attempt and WebSocket handshake as well, without changing either.
  await ctx.session.hook('http.request', observedRequest('http.request', false, true));
  await ctx.session.hook('experimental.ws.handshake', observedRequest('experimental.ws.handshake', false, true));
  const quotaRetry = guarded(event => {
    if (!active(readQuotaState(file))) return;
    const status = event.error?.status;
    // Transient failures still pass transport admission on each attempt.
    if (event.error?.message?.includes('BEST_QUOTA_BLOCKED') || status === 429
        || status === 402 || status === 403) {
      event.decision = { retry: false };
    }
  });
  await ctx.session.hook('retry', event => {
    // A provider safety denial can first surface as a WebSocket transport error.
    if (event.error?.code === 'misalignment_policy_violation'
        || /\bmisalignment_policy_violation\b/.test(event.error?.message ?? '')) {
      event.decision = { retry: false };
      return;
    }
    return quotaRetry(event);
  });
  await ctx.command.transform(editor => editor.add({ name: 'best-quota-refresh',
    description: 'Refresh subscription limits without inference', execute: guarded(() => refresh(true)) }));
  // Event lifecycle is optional only in isolated unit tests. The native plugin
  // always has this stream; it does not create a scheduler or a permanent daemon.
  const controller = new AbortController();
  let eventLoop;
  if (ctx.event) eventLoop = (async () => {
    const types = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.step.ended'];
    for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
      if (event.type !== 'session.step.ended') effortTurns.delete(event.data.sessionID);
      const ended = new Set();
      if (asyncDelegation && event.type !== 'session.step.ended') {
        for (const lease of readQuotaState(file).leases ?? []) {
          if (lease.scope === 'routing' && lease.sessionID === event.data.sessionID
              && Date.parse(lease.at) <= event.created && await childIdleSince(lease.sessionID, lease.at)) ended.add(lease.id);
        }
      }
      // An admission reservation covers one request; when the session's step or
      // execution ends the request is over, so its percent returns to the pool.
      const reconciled = await updateQuotaState(file, state => {
        state.leases = (state.leases ?? []).filter(lease =>
          !(lease.scope === 'admission' && lease.sessionID === event.data.sessionID
            && Date.parse(lease.at) < event.created) && !ended.has(lease.id));
        return state;
      });
      const liveIDs = new Set(reconciled.leases.map(lease => lease.id));
      for (const [key, receipt] of requestReservations) {
        if (key.startsWith(`${event.data.sessionID}:`)
            && !liveIDs.has(receipt.id)) requestReservations.delete(key);
      }
      if (event.type === 'session.step.ended') {
        const request = pinned.get(`${event.data.sessionID}:primary`), tokens = event.data.tokens;
        if (request) await guarded(() => attest({ lifecycle: { type: event.type, at: new Date(event.created).toISOString() } }))();
        // A delayed event must not be attributed to a later request/model.
        if (request && tokens && event.created >= request.startedAt) await guarded(() => updateQuotaState(file, state => {
          state.usage.push({ at: new Date(event.created).toISOString(), provider: request.model.split('/')[0], model: request.model,
            ...(request.variant ? { variant: request.variant } : {}), ...(request.connection ? { connection: request.connection } : {}),
            ...(request.activityClass === 'reasoning-sol-high' ? {} : { activityClass: request.activityClass }),
            durationMs: event.created - request.startedAt, requests: 0,
            input: tokens.input ?? 0, output: tokens.output ?? 0,
            cacheRead: tokens.cache?.read ?? 0, cacheWrite: tokens.cache?.write ?? 0 });
          return state;
        }))();
        continue;
      }
      for (const [key, request] of pinned) if (key.startsWith(`${event.data.sessionID}:`)
          && request.startedAt < event.created) {
        await guarded(() => attest({ lifecycle: { type: event.type, at: new Date(event.created).toISOString() } }))();
        if (pinned.get(key) === request) pinned.delete(key);
      }
    }
  })();
  await guarded(() => {
    const at = new Date().toISOString(), mode = readQuotaState(file).policy?.mode ?? 'monitor';
    // Hook registration has just completed in this process. Observe liveness
    // now, not three minutes later or only after the first admitted request.
    // This says nothing about subscription transport or runtime qualification.
    return attest({ registeredAt: at, callbacks: { heartbeat: {
      at, outcome: mode === 'active' ? 'PASSED' : 'MONITOR_OBSERVED', mode, liveSubscription: false } } });
  })();
  // Idle locations never fire request callbacks, so activation coverage must
  // not depend on a workspace happening to be busy. This in-process, unref'd
  // heartbeat — no daemon, no scheduler, no network — keeps proving that this
  // verified instance is still alive and its hooks are still registered; it is
  // cleared on unload and skipped while governance is disabled.
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const mode = readQuotaState(file).policy?.mode ?? 'monitor';
        if (mode === 'disabled') return;
        await attest({ callbacks: { heartbeat: {
          at: new Date().toISOString(), outcome: mode === 'active' ? 'PASSED' : 'MONITOR_OBSERVED',
          // Liveness proof only; a real request records transport proof itself.
          mode, liveSubscription: false } } });
      } catch { /* attestation must never disturb a running session */ }
    })();
  }, 180000);
  heartbeat.unref?.();
  return async () => {
    clearInterval(heartbeat);
    controller.abort();
    try {
      if (eventLoop) await eventLoop.catch(error => { if (error.name !== 'AbortError') throw error; });
    } finally {
      await attest({ unloadedAt: new Date().toISOString() });
    }
  };
}
