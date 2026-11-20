// Real OpenCode server, scripted local HTTP only. No subscription inference.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { updateQuotaState, readQuotaState, VERIFIED_RUNTIME_VERSIONS } from '../shared/best-quota.mjs';

test('native V2 quota gates existing sessions and native children before local transport', { timeout: 240000 }, async t => {
  const scratch = path.join(fs.realpathSync(os.tmpdir()), 'opencode');
  const dir = fs.mkdtempSync(path.join(fs.existsSync(scratch) ? scratch : fs.realpathSync(os.tmpdir()), 'quota-native-'));
  let requests = 0;
  let respond;
  const models = [];
  const recentRequests = [];
  const mock = http.createServer(async (req, res) => {
    requests++;
    if (!respond) { res.writeHead(500).end(); return; }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    models.push(body.model);
    recentRequests.push({ model: body.model, user: JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content).slice(0, 160) });
    if (recentRequests.length > 6) recentRequests.shift();
    const delta = await respond(body);
    if (delta.status) {
      res.writeHead(delta.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic loopback unavailable', type: 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [value, finish] of [[delta, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  for (const name of ['home', 'config', 'data', 'state', 'cache', 'tmp', 'config-dir']) fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
  const file = path.join(dir, 'state/quota.json');
  await updateQuotaState(file, s => ({ ...s, policy: { mode: 'active' } }));
  const config = path.join(dir, 'opencode.json');
  fs.writeFileSync(config, JSON.stringify({
    $schema: 'https://opencode.ai/config.json', model: 'quota-test/probe',
    agents: { build: { model: 'quota-test/probe' }, title: { model: 'quota-test/probe' } },
    plugins: [{ package: path.resolve('shared/best-quota-plugin'), options: { stateFile: file } }],
    providers: { 'quota-test': { package: '@opencode/ai/providers/openai-compatible', env: [],
      settings: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: '' },
      models: { probe: { modelID: 'probe', package: '@opencode/ai/providers/openai-compatible', capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } } } },
  }));
  const password = randomBytes(24).toString('hex');
  const env = { PATH: process.env.PATH, HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'),
    OPENCODE_PASSWORD: password, OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: path.join(dir, 'config-dir'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    ...Object.fromEntries(['config', 'data', 'state', 'cache'].map(k => [`XDG_${k.toUpperCase()}_HOME`, path.join(dir, k)])) };
  let child, url, errors = '';
  async function stopServer() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  t.after(async () => {
    await stopServer();
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function startServer() {
    child = spawn(process.env.OPENCODE_QUOTA_NATIVE_BIN || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', data => { errors += data; });
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server startup timeout: ${errors}`)), 25000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${errors}`)); });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
  }
  await startServer();
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  async function api(method, endpoint, body) {
    const response = await fetch(url + endpoint, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
    assert.ok(response.ok, `${endpoint}: ${response.status} ${await response.clone().text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  // Plugin activation finishes after `opencode serve` already accepts requests,
  // so every gate waits for the runtime's own inventory/receipt instead of
  // racing boot.
  const instanceIDs = () => new Set((readQuotaState(file).runtime?.instances ?? []).map(entry => entry.instanceID));
  async function waitForGovernor(label) {
    const deadline = Date.now() + 90000;
    for (;;) {
      const plugins = await api('GET', '/api/plugin' + query);
      if (JSON.stringify(plugins).includes('opencode-team.best-quota')) return plugins;
      if (Date.now() > deadline) assert.fail(`governor never registered (${label}): ${JSON.stringify(plugins)} ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  async function waitForReplacement(label, known) {
    const deadline = Date.now() + 90000;
    for (;;) {
      const instances = readQuotaState(file).runtime?.instances ?? [];
      const fresh = instances.find(entry => !known.has(entry.instanceID) && !entry.unloadedAt);
      if (fresh) return fresh;
      if (Date.now() > deadline) assert.fail(`plugin reload never activated (${label}): ${JSON.stringify(instances)} ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  async function prompt(sessionID, text, command, attachments = {}) {
    // A reused session retains its previous outcome while the next run starts.
    // Observe this execution's native lifecycle instead of polling stale state.
    const controller = new AbortController();
    const response = await fetch(url + '/api/event', { headers: { Authorization: auth },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
    assert.ok(response.ok);
    const finished = (async () => {
      let pending = '', started = false;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).trimEnd();
          pending = pending.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5));
          if (event.data?.sessionID !== sessionID) continue;
          if (event.type === 'session.execution.started') started = true;
          if (started && ['succeeded', 'failed', 'interrupted'].some(outcome => event.type === `session.execution.${outcome}`)) {
            return event.type.split('.').at(-1);
          }
        }
      }
      assert.fail(`session ${sessionID} event stream ended: ${errors}`);
    })();
    try {
      await api('POST', `/api/session/${sessionID}/${command ? 'command' : 'prompt'}`,
        command ? { text, name: command } : { text, ...attachments });
      return await finished;
    } catch (error) {
      t.diagnostic(`Prompt ${text.slice(0, 80)} failed; recent loopback requests: ${JSON.stringify(recentRequests)}`);
      throw error;
    } finally {
      controller.abort();
      await finished.catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  }
  async function assertBlocked(sessionID, text) {
    const before = requests;
    assert.equal(await prompt(sessionID, text), 'failed');
    const log = await api('GET', `/api/experimental/session/${sessionID}/export`);
    assert.ok(JSON.stringify(log).includes('BEST_QUOTA_BLOCKED'), 'failure must originate in governor');
    assert.equal(requests, before, 'denial must precede every local transport, including auxiliary requests');
  }
  const info = await api('GET', '/api/info');
  assert.ok(VERIFIED_RUNTIME_VERSIONS.includes(info.version),
    `requalify hooks on another runtime version: ${info.version} not in ${VERIFIED_RUNTIME_VERSIONS.join(',')}`);
  const asyncChildren = info.version === '2.3.2';
  const delegationRequests = asyncChildren ? 4 : 3;
  async function settleDelegation(sessionID, expectedRequests) {
    if (!asyncChildren) return;
    const deadline = Date.now() + 10000;
    while (requests < expectedRequests) {
      if (Date.now() > deadline) assert.fail(`asynchronous delegation did not complete: ${JSON.stringify(recentRequests)} ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await api('POST', `/api/experimental/session/${sessionID}/wait`);
  }
  const query = `?location%5Bdirectory%5D=${encodeURIComponent(dir)}`;
  await api('GET', '/api/agent' + query);
  const plugins = await waitForGovernor('initial activation');
  assert.ok(JSON.stringify(plugins).includes('opencode-team.best-quota'), JSON.stringify(plugins) + errors);
  const { data: session } = await api('POST', '/api/session', { title: 'Quota no-inference probe', location: { directory: dir } });
  await api('POST', `/api/session/${session.id}/model`, { model: { providerID: 'quota-test', id: 'probe' } });
  await assertBlocked(session.id, 'Never reaches a model transport.');
  assert.equal(requests, 0, 'no transport invocation, even for an already selected model');
  const nativeReceipt = readQuotaState(file).runtime.instances.findLast(entry => !entry.unloadedAt);
  assert.equal(nativeReceipt.pid, info.pid, 'receipt is written by the actual native host, not the test driver');
  assert.equal(nativeReceipt.origin, 'NATIVE_RUNTIME');
  assert.ok(nativeReceipt.registeredAt);
  assert.equal(nativeReceipt.callbacks['model.request'].outcome, 'BLOCKED');
  assert.equal(nativeReceipt.callbacks['model.request'].liveSubscription, false, 'local fixture is not live account proof');

  // Reload a test-only adapter with synthetic account data. Native tools and
  // child sessions are real; subscription percentages/auth and LLM replies are not.
  // These safety stubs are fixture-only, not a real payment/auth certification.
  const wrapper = path.join(dir, 'test-plugin');
  fs.mkdirSync(wrapper);
  fs.writeFileSync(path.join(wrapper, 'index.js'), `import { setupGovernor } from ${JSON.stringify(new URL('../shared/best-quota-runtime.mjs', import.meta.url).href)};
 export default {id:'opencode-team.best-quota',setup:ctx=>setupGovernor(ctx,{
 collect:async()=>({snapshots:[],sources:{}}),subscription:async()=> 'a'.repeat(64),
 goPaymentSafety:async()=>({certified:true}),transportSafety:async()=>true})};`);
  const now = Date.now();
  await updateQuotaState(file, s => ({ ...s, snapshots: [
    { provider: 'opencode-go', connection: 'a'.repeat(64), source: 'LIVE', at: new Date(now).toISOString(), windows: Object.fromEntries(
      ['rolling', 'weekly', 'monthly'].map(k => [k, { used: 99, resetAt: new Date(now + 86400000).toISOString() }])) },
    { provider: 'openai', connection: 'a'.repeat(64), source: 'LIVE', at: new Date(now).toISOString(), windows: {
      weekly: { used: 20, resetAt: new Date(now + 604800000).toISOString(), limitWindowSeconds: 604800 } } },
  ] }));
  const configuration = JSON.parse(fs.readFileSync(config));
  const definition = structuredClone(configuration.providers['quota-test']);
  delete configuration.providers['quota-test'];
  configuration.providers.openai = { ...definition, models: { 'gpt-6.1-sol': { ...definition.models.probe, modelID: 'gpt-6.1-sol' } } };
  configuration.providers['opencode-go'] = { ...definition, models: { 'qwen3.7-plus': { ...definition.models.probe, modelID: 'qwen3.7-plus' } } };
  configuration.model = 'openai/gpt-6.1-sol';
  configuration.providers.openai.models['gpt-6.2-sol'] = { ...definition.models.probe, modelID: 'gpt-6.2-sol' };
  configuration.agents = { build: { model: 'openai/gpt-6.1-sol' }, title: { model: 'openai/gpt-6.1-sol' },
    specialist: { model: 'openai/gpt-6.1-sol#medium', mode: 'subagent' },
    general: { model: 'opencode-go/qwen3.7-plus', mode: 'subagent' },
    explore: { model: 'opencode-go/mimo-v2.6-flash', mode: 'subagent' } };
  configuration.plugins = [{ package: wrapper, options: { stateFile: file } }];
  fs.writeFileSync(config, JSON.stringify(configuration));
  respond = body => {
    const user = body.messages.findLastIndex(m => m.role === 'user');
    const text = JSON.stringify(body.messages[user]?.content);
    if (text.includes('CHILD_ONLY')) return { content: 'CHILD_DONE' };
    if (text.includes('CHILD_RESUME')) return { content: 'CHILD_RESUMED' };
    if (body.messages.slice(user + 1).some(m => m.role === 'tool')) return { content: 'PARENT_DONE' };
    if (!text.includes('PARENT_NATIVE_PROBE') && !text.includes('EXPLORE_NATIVE_PROBE')) return { content: 'HEALTHY_DONE' };
    return { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'subagent',
      arguments: JSON.stringify({ agent: text.includes('EXPLORE_NATIVE_PROBE') ? 'explore' : 'general',
        description: 'Quota scoped probe', prompt: 'CHILD_ONLY', background: false }) } }] };
  };
  const known1 = instanceIDs();
  await api('POST', '/api/location/reload' + query);
  await waitForReplacement('fixture adapter with synthetic account data', known1);
  await api('GET', '/api/agent' + query);
  const { data: parent } = await api('POST', '/api/session', { title: 'Quota routing probe', location: { directory: dir } });
  assert.equal(await prompt(parent.id, 'PARENT_NATIVE_PROBE'), 'succeeded', errors);
  await settleDelegation(parent.id, delegationRequests);
  const sessions = await api('GET', '/api/session?limit=20');
  const children = sessions.data.filter(s => s.parentID === parent.id);
  assert.equal(children.length, 1, JSON.stringify(await api('GET', `/api/experimental/session/${parent.id}/export`)));
  assert.equal(children[0].agent, 'general');
  assert.equal(children[0].model.providerID, 'openai');
  assert.equal(children[0].model.id, 'gpt-6.1-sol');
  assert.deepEqual(models, Array(delegationRequests).fill('gpt-6.1-sol'));

  // Regression for the first chat after loading active persisted state on a
  // newly qualified runtime. Percentages and all replies remain synthetic.
  await updateQuotaState(file, state => {
    state.snapshots.find(s => s.provider === 'openai').windows.weekly.used = 54;
    const go = state.snapshots.find(s => s.provider === 'opencode-go');
    for (const window of Object.values(go.windows)) window.used = 20;
    go.windows.monthly.used = 95;
    return state;
  });
  let releaseChild, childStarted;
  const childHeld = new Promise(resolve => { releaseChild = resolve; });
  const childReady = new Promise(resolve => { childStarted = resolve; });
  t.after(() => releaseChild());
  respond = async body => {
    const user = body.messages.findLastIndex(m => m.role === 'user');
    const text = JSON.stringify(body.messages[user]?.content);
    if (text.includes('CHILD_ONLY')) {
      childStarted();
      await childHeld;
      return { content: 'CHILD_DONE' };
    }
    if (text.includes('<subagent ')) return { content: 'BACKGROUND_DONE' };
    const tools = body.messages.slice(user + 1).filter(m => m.role === 'tool');
    if (asyncChildren && tools.length) return { content: 'BACKGROUND_DISPATCHED' };
    if (tools.length >= 2) return { content: 'FOREGROUND_RECOVERY_DONE' };
    if (tools.length) assert.ok(JSON.stringify(tools).includes('background-lifecycle-unverified; use background=false'));
    return { tool_calls: [{ index: 0, id: tools.length ? 'foreground-recovery' : 'background-denied',
      type: 'function', function: { name: 'subagent', arguments: JSON.stringify({
        agent: 'general', description: 'Bounded recovery', prompt: 'CHILD_ONLY', background: !tools.length }) } }] };
  };
  const { data: fresh } = await api('POST', '/api/session', { title: 'First critical request', location: { directory: dir } });
  const beforeFresh = requests;
  const freshPrompt = prompt(fresh.id, 'PARENT_BACKGROUND_PROBE');
  await Promise.race([childReady, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('child did not start')), 10000).unref())]);
  assert.equal(readQuotaState(file).leases.filter(lease => lease.scope === 'routing').length, 1,
    'native running child still holds routing capacity after subagent returned');
  releaseChild();
  assert.equal(await freshPrompt, 'succeeded');
  await settleDelegation(fresh.id, beforeFresh + 4);
  assert.equal(requests, beforeFresh + 4, 'parent, explicit foreground recovery, child, parent continuation');
  assert.equal((await api('GET', '/api/session?limit=20')).data.filter(s => s.parentID === fresh.id).length, 1,
    'rejected background must not create a child');
  assert.equal((readQuotaState(file).leases ?? []).length, 0, 'foreground and request lifecycle release every reservation');
  t.diagnostic(`PASS: new active chat at 46% weekly / 5% monthly admits first request; ${asyncChildren ? 'native background delegation completes' : 'explicit background denial recovers through native foreground delegation'}`);
  // Restore the original scripted routing probes.
  let finishExplore;
  const exploreHeld = new Promise(resolve => { finishExplore = resolve; });
  let exploreResultReceived = false;
  t.after(() => finishExplore());
  respond = async body => {
    const user = body.messages.findLastIndex(m => m.role === 'user');
    const text = JSON.stringify(body.messages[user]?.content);
    if (text.includes('CHILD_ONLY')) {
      if (asyncChildren) await exploreHeld;
      return { content: 'CHILD_DONE' };
    }
    if (text.includes('<subagent ')) {
      assert.ok(text.includes('CHILD_DONE'), 'native continuation includes the child result');
      exploreResultReceived = true;
      return { content: 'PARENT_DONE' };
    }
    if (body.messages.slice(user + 1).some(m => m.role === 'tool')) return { content: 'PARENT_DONE' };
    if (!text.includes('EXPLORE_NATIVE_PROBE')) return { content: 'HEALTHY_DONE' };
    return { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'subagent',
      arguments: JSON.stringify({ agent: 'explore', description: 'Quota scoped probe', prompt: 'CHILD_ONLY', background: false }) } }] };
  };

  const { data: exploreParent } = await api('POST', '/api/session', { title: 'Explore probe', location: { directory: dir } });
  const beforeExplore = models.length;
  assert.equal(await prompt(exploreParent.id, 'EXPLORE_NATIVE_PROBE'), 'succeeded', errors);
  if (asyncChildren) {
    assert.equal(readQuotaState(file).leases.filter(lease => lease.scope === 'routing').length, 1,
      'foreground tool returned while required child was still held');
    finishExplore();
  }
  await settleDelegation(exploreParent.id, beforeExplore + delegationRequests);
  if (asyncChildren) assert.ok(exploreResultReceived);
  const exploreChild = (await api('GET', '/api/session?limit=20')).data.find(s => s.parentID === exploreParent.id);
  assert.equal(exploreChild?.agent, 'explore');
  assert.equal(exploreChild.model.variant, 'low');
   assert.deepEqual(models.slice(beforeExplore), asyncChildren
     ? ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-sol']
     : ['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-sol']);

  if (asyncChildren) {
    const { data: goal } = await api('POST', '/api/session', { title: 'BEST goal probe', location: { directory: dir } });
    const evidence = path.join(dir, 'goal-evidence');
    const rollout = path.join(dir, 'goal-rollout');
    fs.writeFileSync(rollout, 'awaiting approval');
    const actions = ['printf prepared > goal-input',
      'test "$(cat goal-input)" = prepared && printf verified > goal-evidence'];
    let turns = 0, reviews = 0, checked = 0;
    respond = body => {
      const text = JSON.stringify(body.messages.at(-1));
      if (/verdict/.test(text)) {
        reviews++;
        return { content: JSON.stringify(turns === 1
          ? { verdict: 'continue', reason: 'Authorized check remains', next_step: 'Finish the authorized check only' }
          : { verdict: 'blocked', reason: 'Only the privileged operation remains' }) };
      }
      if (turns === 1 && checked < actions.length) {
        const command = actions[checked++];
        return { tool_calls: [{ index: 0, id: `goal-check-${checked}`, type: 'function', function: {
          name: 'shell', arguments: JSON.stringify({ command,
            description: 'Record authorized isolated check', workdir: dir }),
        } }] };
      }
      turns++;
      return { content: turns === 1 ? 'Stopped before checking' : 'Authorized check finished; privileged operation not attempted' };
    };
    const objective = 'Prepare and verify the local fixture; replacing goal-rollout requires approval and is not authorized.';
    const { data: direct } = await api('POST', '/api/session', { title: 'BEST direct mandate probe', location: { directory: dir } });
    assert.equal(await prompt(direct.id, objective), 'succeeded');
    assert.equal(turns, 1, 'a normal prompt stops without activating GoalPlugin');
    assert.equal(reviews, 0);
    assert.equal(fs.existsSync(evidence), false);
    turns = 0;
    assert.equal(await prompt(goal.id, objective, 'goal'), 'succeeded');
    assert.equal(turns, 2);
    assert.equal(reviews, 2);
    assert.equal(fs.readFileSync(evidence, 'utf8'), 'verified');
    assert.equal(fs.readFileSync(rollout, 'utf8'), 'awaiting approval');
    t.diagnostic('PASS: native /goal recovered a premature stop, prepared and verified the fixture, and left rollout untouched');
    respond = () => ({ content: 'HEALTHY_DONE' });
  }
  const beforeHealthy = requests;
  assert.equal(await prompt(parent.id, 'HEALTHY_FOLLOWUP'), 'succeeded');
  assert.equal(requests, beforeHealthy + 1, 'same session accepts a new healthy prompt');
  t.diagnostic('PASS: existing selected model denied; native new General routes around exhausted Go; healthy same-session followup');

  const childID = children[0].id;
  respond = body => {
    const user = body.messages.findLastIndex(m => m.role === 'user');
    const text = JSON.stringify(body.messages[user]?.content);
    if (text.includes('CHILD_RESUME')) return { content: 'CHILD_RESUMED' };
    if (body.messages.slice(user + 1).some(m => m.role === 'tool')) return { content: 'PARENT_RESUMED_DONE' };
    const tool = body.tools.find(tool => tool.function?.name === 'subagent');
    assert.ok(tool.function.parameters.properties.sessionID, 'native resume schema must use sessionID');
    return { tool_calls: [{ index: 0, id: 'resume', type: 'function', function: { name: 'subagent',
      arguments: JSON.stringify({ agent: 'general', sessionID: childID, description: 'Resume bounded child',
        prompt: 'CHILD_RESUME', background: false }) } }] };
  };
  const beforeResume = requests;
  assert.equal(await prompt(parent.id, 'RESUME_NATIVE_CHILD'), 'succeeded');
  await settleDelegation(parent.id, beforeResume + delegationRequests);
  assert.equal(requests, beforeResume + delegationRequests, 'native parent, existing child, parent continuation: ' + JSON.stringify(
    (await api('GET', `/api/experimental/session/${parent.id}/export`)).data.messages
      .filter(m => m.type === 'assistant').flatMap(m => m.content ?? []).filter(p => p.type === 'tool').map(p => p.state)));
  const resumed = await api('GET', '/api/session?limit=20');
  assert.deepEqual(resumed.data.filter(s => s.parentID === parent.id).map(s => s.id), [childID], 'native resume must not create another child');
  const resumedLog = await api('GET', `/api/experimental/session/${childID}/export`);
  assert.ok(JSON.stringify(resumedLog).includes('CHILD_RESUMED'), 'existing child actually executed the new prompt');
  t.diagnostic('PASS: native subagent sessionID resumes the existing child');

  async function quota(used, resetAt = Date.now() + 604800000) {
    await updateQuotaState(file, state => {
      const snapshot = state.snapshots.find(s => s.provider === 'openai');
      snapshot.at = new Date().toISOString();
      snapshot.windows.weekly = { used, resetAt: new Date(resetAt).toISOString(), limitWindowSeconds: 604800 };
      return state;
    });
  }
  respond = () => ({ content: 'HEALTHY_DONE' });
  await quota(100);
  await assertBlocked(parent.id, 'Existing successful session, now exhausted.');
  await assertBlocked(childID, 'Existing successful native child, now exhausted.');
  // Fabricated input in the disposable fixture only; never historical context.
  await assertBlocked(parent.id, 'SYNTHETIC_LARGE_INPUT:' + 'x'.repeat(128 * 1024));
  t.diagnostic('PASS: exhausted reused parent, existing native child, and fabricated 128 KiB input dispatch zero HTTP requests');

  await quota(20, Date.now() - 1000);
  await assertBlocked(parent.id, 'An expired reset timestamp is not a fresh allowance.');
  await quota(20);
  assert.equal(await prompt(parent.id, 'Fresh synthetic snapshot permits the next prompt.'), 'succeeded');
  t.diagnostic('PASS: expired reset blocks until a fresh synthetic snapshot is supplied');

  await updateQuotaState(file, state => {
    const go = state.snapshots.find(s => s.provider === 'opencode-go');
    go.at = new Date().toISOString();
    for (const window of Object.values(go.windows)) window.used = 10;
    return state;
  });
  const beforeIncompatible = requests;
  await api('POST', `/api/session/${parent.id}/model`, { model: { providerID: 'opencode-go', id: 'qwen3.7-plus' } });
  await assertBlocked(parent.id, 'Manually selected model is incompatible with Build.');
  assert.equal(requests, beforeIncompatible);
  await api('POST', `/api/session/${parent.id}/model`, { model: { providerID: 'openai', id: 'gpt-6.1-sol' } });
  t.diagnostic('PASS: incompatible manual selection is denied despite healthy quota, without transport');

  await quota(100);
  const persisted = await api('GET', `/api/experimental/session/${parent.id}/export`);
  const previousPID = child.pid;
  await stopServer();
  await startServer();
  assert.notEqual(child.pid, previousPID, 'server process really restarted');
  assert.ok(VERIFIED_RUNTIME_VERSIONS.includes((await api('GET', '/api/info')).version));
  const reloadedPlugins = await waitForGovernor('post-restart activation');
  assert.ok(JSON.stringify(reloadedPlugins).includes('opencode-team.best-quota'));
  await api('GET', '/api/agent' + query);
  assert.deepEqual(await api('GET', `/api/experimental/session/${parent.id}/export`), persisted, 'same isolated DB retains session and messages');
  await assertBlocked(parent.id, 'Resume persisted session after an actual server restart.');
  t.diagnostic('PASS: restart reloads plugin metadata and denies the persisted session before HTTP');

  await quota(20);
  let unavailable = true;
  respond = () => {
    if (unavailable) { unavailable = false; return { status: 503 }; }
    return { content: 'RECOVERED_LOOPBACK' };
  };
  const beforeUnavailable = requests;
  assert.equal(await prompt(parent.id, 'Synthetic provider unavailable, then recovers.'), 'succeeded');
  assert.ok(requests > beforeUnavailable + 1, '503 reached loopback and native runtime retried');
  assert.ok(models.slice(beforeUnavailable).every(model => model === 'gpt-6.1-sol'), '503 must not switch models');
  t.diagnostic(`PASS: synthetic 503 recovery used ${requests - beforeUnavailable} loopback requests; native default retry policy was not overridden`);

  respond = async () => {
    await quota(100);
    return { status: 503 };
  };
  const beforeRetryQuota = requests;
  assert.equal(await prompt(parent.id, 'Quota changes while a prepared HTTP request is retried.'), 'failed');
  assert.equal(requests, beforeRetryQuota + 1, 'physical retry must recheck quota and never reach transport after exhaustion');
  t.diagnostic('PASS: quota changing during native 503 recovery blocks the next physical transport');
  await quota(20);

  respond = () => ({ status: 429 });
  const beforeRateLimit = requests;
  assert.equal(await prompt(parent.id, 'Synthetic transport rate limit.'), 'failed');
  assert.equal(requests, beforeRateLimit + 1, 'governor suppresses native retries for 429');
  t.diagnostic('PASS: synthetic transport 429 is not retried');

  // Create a Go child while both providers are healthy, then resume that same
  // native child after only Go exhausts. The parent remains admissible on OpenAI.
  await updateQuotaState(file, state => ({ ...state, policy: { ...state.policy, cooldownMs: 0 } }));
  respond = body => {
    const user = body.messages.findLastIndex(m => m.role === 'user');
    const text = JSON.stringify(body.messages[user]?.content);
    if (text.includes('CHILD_GO')) return { content: 'GO_CHILD_DONE' };
    if (text.includes('<subagent ')) return { content: 'PARENT_GO_DONE' };
    if (body.messages.slice(user + 1).some(m => m.role === 'tool')) return { content: 'PARENT_GO_DONE' };
    return { tool_calls: [{ index: 0, id: 'go-child', type: 'function', function: { name: 'subagent',
      arguments: JSON.stringify({ agent: 'general', description: 'Bounded Go child', prompt: 'CHILD_GO', background: false }) } }] };
  };
  const beforeGo = requests;
  assert.equal(await prompt(parent.id, 'CREATE_NATIVE_GO_CHILD'), 'succeeded');
  await settleDelegation(parent.id, beforeGo + delegationRequests);
  assert.equal(requests, beforeGo + delegationRequests);
  const goChildren = (await api('GET', '/api/session?limit=20')).data.filter(s => s.parentID === parent.id && s.id !== childID);
  assert.equal(goChildren.length, 1);
  const goChild = goChildren[0];
  assert.equal(goChild.model.providerID, 'opencode-go');
  assert.equal(goChild.model.id, 'qwen3.7-plus');
  await updateQuotaState(file, state => {
    const go = state.snapshots.find(s => s.provider === 'opencode-go');
    go.at = new Date().toISOString();
    for (const window of Object.values(go.windows)) window.used = 100;
    return state;
  });
  respond = body => {
    const user = body.messages.findLastIndex(m => m.role === 'user');
    if (JSON.stringify(body.messages[user]?.content).includes('EXHAUSTED_CHILD_RESUME')) return { content: 'UNEXPECTED_EXHAUSTED_CHILD_DISPATCH' };
    if (body.messages.slice(user + 1).some(m => m.role === 'tool')) return { content: 'PARENT_HANDLED_CHILD_DENIAL' };
    return { tool_calls: [{ index: 0, id: 'blocked-resume', type: 'function', function: { name: 'subagent',
      arguments: JSON.stringify({ agent: 'general', sessionID: goChild.id, description: 'Resume exhausted Go child',
        prompt: 'EXHAUSTED_CHILD_RESUME', background: false }) } }] };
  };
  const beforeGoResume = requests;
  assert.equal(await prompt(parent.id, 'RESUME_EXHAUSTED_NATIVE_GO_CHILD'), 'succeeded');
  const deniedResume = await api('GET', `/api/experimental/session/${parent.id}/export`);
  assert.ok(JSON.stringify(deniedResume).includes('BEST_QUOTA_BLOCKED'), 'native child resume reports the governor denial to its parent');
  assert.equal(requests, beforeGoResume + 2, 'only the admitted parent and its continuation may dispatch; no exhausted child or replacement');
  const retainedChild = (await api('GET', `/api/session/${goChild.id}`)).data;
  assert.equal(retainedChild.model.providerID, 'opencode-go', 'resuming an existing child must not rewrite its model');
  assert.equal((await api('GET', '/api/session?limit=20')).data.filter(s => s.parentID === parent.id).length, 2, 'denied resume must not create a replacement child');
  t.diagnostic('PASS: native sessionID resume denies an exhausted Go child while its healthy parent continues, without replacement');

  if (asyncChildren) {
    // Verify the real 2.3.2 resolve boundary and recorded effective variants.
    // Models, quota, qualification evidence and transport remain loopback fixtures.
    const configuredBuild = configuration.agents.build.model;
    configuration.agents.build.model = 'openai/gpt-6.2-sol#medium';
    configuration.providers.openai.models['gpt-6.2-sol'].variants =
      ['low', 'medium', 'high'].map(id => ({ id, settings: { reasoningEffort: id } }));
    fs.writeFileSync(config, JSON.stringify(configuration));
    const knownEffort = instanceIDs();
    await api('POST', '/api/location/reload' + query);
    await waitForReplacement('automatic effort fixture', knownEffort);
    await updateQuotaState(file, state => {
      const at = Date.now();
      const ai = state.snapshots.find(s => s.provider === 'openai');
      ai.at = new Date(at).toISOString();
      state.snapshots.push({ ...structuredClone(ai), at: new Date(at - 90000).toISOString() });
      state.sources.openai = { status: 'LIVE', connection: 'a'.repeat(64) };
      state.usage.push({ at: new Date(at - 45000).toISOString(), provider: 'openai',
        model: 'openai/gpt-6.2-sol', variant: 'medium', connection: 'a'.repeat(64), requests: 1 },
      { at: new Date(at).toISOString(), provider: 'openai', model: 'openai/gpt-6.2-sol',
        variant: 'high', connection: 'a'.repeat(64), requests: 0, durationMs: 1000, output: 1 });
      return state;
    });
    respond = () => ({ content: 'EFFORT_DONE' });
    for (const [variant, text, attachments] of [
      ['low', 'Reply exactly AUTO_LOW', {}],
      ['medium', 'Ordinary implementation mandate.', {}],
      ['high', 'Inspect a critical technical boundary.', { agents: [{ name: 'specialist' }] }],
    ]) {
      const { data: effort } = await api('POST', '/api/session', {
        title: `Automatic ${variant} fixture`, agent: 'build', location: { directory: dir },
        ...(variant === 'medium' ? { model: { providerID: 'openai', id: 'gpt-6.2-sol' } } : {}),
      });
      const before = requests;
      assert.equal(await prompt(effort.id, text, undefined, attachments), 'succeeded');
      assert.equal(requests, before + 1);
      const context = await api('GET', `/api/session/${effort.id}/context`);
      const reply = context.data.findLast(message => message.type === 'assistant');
      assert.equal(reply.model.id, 'gpt-6.2-sol');
      assert.equal(reply.model.variant, variant);
      assert.deepEqual((await api('GET', `/api/session/${effort.id}`)).data.model,
        effort.model,
        'automatic effort must not overwrite the session selection');
    }
    configuration.agents.build.model = configuredBuild;
    fs.writeFileSync(config, JSON.stringify(configuration));
    t.diagnostic('PASS: native automatic Low/Medium/High reach loopback with matching assistant models; session selections untouched');
  }

  // Production subscription validator, same provider ID and fresh old quota,
  // but the runtime connection now resolves to an API key. No credential saved.
  fs.writeFileSync(path.join(wrapper, 'index.js'), `import { setupGovernor } from ${JSON.stringify(new URL('../shared/best-quota-runtime.mjs', import.meta.url).href)};
export default {id:'opencode-team.best-quota',setup:ctx=>setupGovernor({...ctx,integration:{connection:{
active:async()=>({id:'mock-api-channel'}),resolve:async()=>({type:'key',key:'mock-test-only'})}}},
{collect:async()=>({snapshots:[],sources:{}})})};`);
  const known2 = instanceIDs();
  await api('POST', '/api/location/reload' + query);
  await waitForReplacement('production validator adapter', known2);
  await api('GET', '/api/agent' + query);
  const beforePaid = requests;
  const { data: paid } = await api('POST', '/api/session', { title: 'Reject API channel', location: { directory: dir } });
  await api('POST', `/api/session/${paid.id}/model`, { model: { providerID: 'openai', id: 'gpt-6.1-sol' } });
  await assertBlocked(paid.id, 'Never reaches the API channel.');
  assert.equal(requests, beforePaid, 'fresh OAuth quota must not authorize an API-key request');
  t.diagnostic('PASS: production validator rejects a synthetic API-key channel despite fresh subscription quota');
  const receipts = readQuotaState(file).runtime.instances;
  assert.ok(receipts.some(entry => entry.unloadedAt), 'reload retires the previous setup receipt');
  assert.ok(receipts.some(entry => entry.lifecycle), 'native session lifecycle is observed internally');
  assert.ok(receipts.filter(entry => entry.origin === 'INJECTED_TEST').every(entry =>
    Object.values(entry.callbacks).every(callback => callback.liveSubscription === false)));
  t.diagnostic('PASS: internal receipts bind the native PID, setup/cleanup and observed callbacks; injected loopback tests never certify live subscription transport');
});
