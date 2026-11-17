import { collectQuotas, subscriptionConnection, goExtraUsageSafety, verifySubscriptionTransport } from './best-quota-sources.mjs';
import { forecast, decideQuota, classifyActivity, calibrateQuota, estimateQuotaCost, readQuotaState, updateQuotaState,
  verifiedRuntime, liveLeases, reservedPercent } from './best-quota.mjs';
import { randomUUID } from 'node:crypto';

const kinds = { build: 'coding', general: 'coding', explore: 'scan', specialist: 'complex',
  reviewer: 'review', plan: 'architecture', 'visual-designer': 'visual' };
const candidate = (agent, model) => ({ agent, model, provider: model.split('/')[0] });
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
      try { state = readQuotaState(file); } catch { blocked(); }
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
  function fitsObservedRequest(value, state, prediction, calibration) {
    const [model, variant] = value.model.split('#');
    const name = classifyActivity({ provider: value.provider, model, variant });
    if (name === 'unclassified') return true;
    const durations = state.usage.filter(u => u.durationMs > 0 && u.provider === value.provider && classifyActivity(u) === name
      && u.connection === prediction.providers[value.provider].connection
      && Date.parse(u.at) >= Date.parse(prediction.at) - prediction.options.smoothingMs).map(u => u.durationMs);
    if (!durations.length) return true;
    // A conservative scenario for the next request, not an asserted bound on
    // an unbounded task's duration or a token-to-allowance conversion.
    const cost = estimateQuotaCost(calibration, name, Math.max(...durations));
    return cost.state !== 'ESTIMATE' || Object.entries(cost.windows).every(([window, percent]) =>
      percent <= prediction.providers[value.provider].windows[window]?.remaining - prediction.options.safetyMarginPercent);
  }
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
  async function choose(agent, models, leaseID) {
    await refresh();
    const { data: inventory } = await ctx.model.list();
    const goCertified = (await goPaymentSafety(readQuotaState(file))).certified === true;
    let decision;
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
        [provider, reservedPercent(current.leases, provider)]));
      const candidates = models.filter(value => inventory.some(m => m.providerID === value.provider
        && m.id === value.model.split('/').slice(1).join('/').split('#')[0] && m.enabled !== false))
        .filter(value => !active(current) || (current.leases ?? []).filter(l => l.provider === value.provider
            && l.scope !== 'admission').length
          < (value.provider === 'opencode-go' ? 2 : 1) * instanceCapacity)
        .filter(value => !active(current) || value.provider !== 'opencode-go' || goCertified)
        // No invented starting allowance for discovery. This excludes only
        // automatic MiMo routing; independent candidates remain eligible.
        .filter(value => classifyActivity({ provider: value.provider, model: value.model.split('#')[0] }) !== 'discovery-mimo'
          || calibration.classes['discovery-mimo'].state !== 'UNKNOWN')
        .filter(value => !active(current) || fitsObservedRequest(value, current, prediction, calibration));
      decision = decideQuota({ kind: kinds[agent] ?? 'coding', candidates,
        forecast: prediction,
        previous: current.decisions.findLast(d => d.scope === 'routing' && d.candidate?.agent === agent),
        options: { ...current.policy, reserved } });
      current.decisions.push({ ...decision, scope: 'routing', enforced: active(current) });
      if (active(current) && !decision.blocked) {
        current.leases ??= [];
        current.leases.push({ id: leaseID, provider: decision.candidate.provider, ownerPid: process.pid,
          scope: 'routing', expiresAt: new Date(Date.now() + 600000).toISOString() });
      }
      return current;
    });
    return { state, decision };
  }
  await ctx.tool.hook('execute.before', guarded(async event => {
    if (event.tool !== 'subagent') return;
    const agent = event.input?.agent;
    if (event.input?.background === true && active(readQuotaState(file))) blocked();
    if (!kinds[agent] || (active(readQuotaState(file)) && !verifiedRuntime(ctx.app.version))) {
      if (active(readQuotaState(file))) blocked();
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
      await checkRequest({ sessionID: event.input.sessionID, agent, kind: 'primary', model: child.model }, false);
      const leaseID = randomUUID();
      const { state, decision } = await choose(agent, [candidate(agent, model)], leaseID);
      if (active(state)) {
        if (decision.blocked) blocked(decision.reason);
        leases.set(`${event.sessionID}:${event.id}`, leaseID);
      }
      return;
    }
    const configured = await configuredModel(agent);
    if (!configured) { if (active(readQuotaState(file))) blocked(); return; }
    const models = [candidate(agent, configured)];
    // Only a new bounded General delegation may cross providers. No replay, no
    // mutation of a model already dispatched, no lower-quality critical fallback.
    if (agent === 'general') {
      const alternative = await configuredModel('specialist');
      if (alternative?.startsWith('openai/')) models.push(candidate(agent, alternative));
    }
    if (event.input.model && !models.some(m => m.model === event.input.model)) {
      if (active(readQuotaState(file))) blocked();
      return;
    }
    const leaseID = randomUUID();
    const { state, decision } = await choose(agent, models, leaseID);
    if (!active(state)) return;
    if (decision.blocked) blocked();
    leases.set(`${event.sessionID}:${event.id}`, leaseID);
    event.input.model = decision.candidate.model;
  }));
  await ctx.tool.hook('execute.after', async event => {
    const key = `${event.sessionID}:${event.id}`, id = leases.get(key);
    if (!id) return;
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
        ...(variant ? { variant } : {}), ...(connection ? { connection } : {}), activityClass,
        kind: kinds[event.agent] ?? 'coding', requests: 1 });
      return current;
    });
  }
  const checkRequest = async (event, record = true, transport = false, observation) => {
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
    if (!verifiedRuntime(ctx.app.version)) blocked();
    // The guard sees the actual selected model, including old sessions and all
    // auxiliary calls. Never substitute HTTP endpoints, headers or credentials.
    const continuity = (event.kind === 'compaction' || event.agent === 'summary') && model === 'opencode-go/minimax-m3';
    const roleModel = (await configuredModel(event.agent || 'build'))?.split('#')[0];
    const alternative = event.agent === 'general' ? (await configuredModel('specialist'))?.split('#')[0] : null;
    const compatible = model === roleModel || (event.agent === 'general' && model === alternative)
      || (event.kind === 'title' && model === 'openai/gpt-6-luna') || continuity;
    const binding = await subscription(ctx, event.model.providerID);
    if (event.model.providerID === 'opencode-go' && !(await goPaymentSafety(state, Date.now(), binding)).certified) blocked();
    if (!compatible || /claude|anthropic/i.test(model) || (/minimax/i.test(model) && !continuity) || !binding) blocked();
    // Transport verification is async prep and must finish before any
    // reservation is taken, so a transport failure never leaks a lease.
    if (transport && !await transportSafety(ctx, event)) blocked();
    const selected = candidate(event.agent || 'build', `${model}${event.model.variant ? `#${event.model.variant}` : ''}`);
    // One atomic read-decide-reserve cycle: parallel BEST instances see each
    // other's in-flight percent before their own quota snapshot is written.
    let decision, leaseID;
    const observedState = await updateQuotaState(file, current => {
      // Same liveness rule as routing: an admission reservation whose owning
      // process is gone or whose deadline passed is already released, so a
      // session that died without a lifecycle event cannot hold budget forever.
      current.leases = liveLeases(current.leases ?? []);
      const prediction = forecast(current, Date.now(), current.policy);
      const provider = prediction.providers[event.model.providerID];
      if (provider.connection !== binding) blocked('account-changed');
      if (provider.confirmedExhausted || ['EXHAUSTED', 'UNKNOWN'].includes(provider.state)) blocked('quota-unavailable');
      if (!fitsObservedRequest(selected, current, prediction, calibrateQuota(current))) blocked('calibrated-request-envelope');
      // A record=false observation must not count its own session's existing
      // lease, or a retry could block the very request it is re-checking.
      const held = reservedPercent((current.leases ?? []).filter(lease =>
        record || !lease.sessionID || lease.sessionID !== event.sessionID), event.model.providerID);
      decision = decideQuota({ kind: kinds[event.agent] ?? 'coding',
        candidates: [selected], forecast: prediction,
        options: { ...current.policy, reserved: { [event.model.providerID]: held } } });
      if (record) {
        current.decisions.push({ ...decision, scope: 'admission', enforced: true });
        if (!decision.blocked) {
          leaseID = randomUUID();
          current.leases ??= [];
          current.leases.push({ id: leaseID, provider: decision.candidate.provider, ownerPid: process.pid,
            scope: 'admission', percent: decision.estimatedTaskPercent ?? 0, sessionID: event.sessionID,
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 15 * 60000).toISOString() });
        }
      }
      return current;
    });
    if (decision.blocked) blocked(decision.reason);
    if (!record) return;
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
      const models = [candidate(session.agent, configured)];
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
        await updateQuotaState(file, current => {
          const index = current.decisions.findLastIndex(entry => entry.scope === 'routing'
            && entry.at === decision.at && entry.candidate?.model === applied && entry.applied === undefined);
          if (index >= 0) current.decisions[index].applied = applied;
          return current;
        });
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
  await ctx.session.hook('retry', guarded(event => {
    if (!active(readQuotaState(file))) return;
    const status = event.error?.status;
    // Denials and provider-class failures that signal budget or permission
    // problems are not transient: retrying would consume the shared budget
    // without a new admission decision. Transient 5xx keeps the native retry
    // policy — every physical attempt still passes `http.request` admission,
    // so a retry can never reach transport without a fresh quota check.
    if (event.error?.message?.includes('BEST_QUOTA_BLOCKED') || status === 429
        || status === 402 || status === 403) {
      event.decision = { retry: false };
    }
  }));
  await ctx.command.transform(editor => editor.add({ name: 'best-quota-refresh',
    description: 'Refresh subscription limits without inference', execute: guarded(() => refresh(true)) }));
  // Event lifecycle is optional only in isolated unit tests. The native plugin
  // always has this stream; it does not create a scheduler or a permanent daemon.
  const controller = new AbortController();
  let eventLoop;
  if (ctx.event) eventLoop = (async () => {
    const types = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.step.ended'];
    for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
      // An admission reservation covers one request; when the session's step or
      // execution ends the request is over, so its percent returns to the pool.
      await guarded(() => updateQuotaState(file, state => {
        state.leases = (state.leases ?? []).filter(lease =>
          !(lease.scope === 'admission' && lease.sessionID === event.data.sessionID));
        return state;
      }))();
      if (event.type === 'session.step.ended') {
        const request = pinned.get(`${event.data.sessionID}:primary`), tokens = event.data.tokens;
        if (request) await guarded(() => attest({ lifecycle: { type: event.type, at: new Date(event.created).toISOString() } }))();
        // A delayed event must not be attributed to a later request/model.
        if (request && tokens && event.created >= request.startedAt) await guarded(() => updateQuotaState(file, state => {
          state.usage.push({ at: new Date(event.created).toISOString(), provider: request.model.split('/')[0], model: request.model,
            ...(request.variant ? { variant: request.variant } : {}), ...(request.connection ? { connection: request.connection } : {}),
            activityClass: request.activityClass, durationMs: event.created - request.startedAt, requests: 0,
            input: tokens.input ?? 0, output: tokens.output ?? 0,
            cacheRead: tokens.cache?.read ?? 0, cacheWrite: tokens.cache?.write ?? 0 });
          return state;
        }))();
        continue;
      }
      for (const key of pinned.keys()) if (key.startsWith(`${event.data.sessionID}:`)) {
        await guarded(() => attest({ lifecycle: { type: event.type, at: new Date(event.created).toISOString() } }))();
        pinned.delete(key);
      }
    }
  })();
  await guarded(() => attest({ registeredAt: new Date().toISOString() }))();
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
