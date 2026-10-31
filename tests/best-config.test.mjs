import './guardrail/assert-isolated.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chooseRoute, metrics } from '../shared/best-routing.mjs';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'best-routing-config.json'), 'utf8'));
const availability = JSON.parse(fs.readFileSync(path.join(root, 'best-routing-availability.json'), 'utf8'));

test('effective BEST uses Go directly and explicit native commands override stored models', () => {
  assert.equal(config.default_agent, 'build');
  assert.equal(config.model, 'opencode-go/minimax-m3');
  assert.equal(config.agents.build.model, config.model);
  assert.equal(config.agents.general.model, config.model);
  assert.equal(config.agents.explore.model, 'opencode-go/mimo-v2.6-flash');
  assert.equal(config.agents.title.model, 'openai/gpt-6-luna#low');
  assert.equal(config.agents.summary.model, 'opencode-go/minimax-m3');
  assert.equal(config.agents.compaction.model, 'opencode-go/minimax-m3');
  assert.equal(config.agents['visual-designer'].model, 'opencode-go/glm-5.3-flash');
  for (const command of Object.values(config.commands)) {
    assert.equal(command.subagent, false);
    assert.ok(config.agents[command.agent]);
    assert.ok(availability.models.includes(command.model.split('#')[0]));
  }
  for (const name of ['architect', 'debug', 'reviewCritical'])
    assert.equal(config.commands[name].model, 'openai/gpt-6.1-sol#medium');
  assert.deepEqual(config.policies.filter(p => p.action === 'provider.use'), [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'opencode-go', effect: 'allow' },
    { action: 'provider.use', resource: 'openai', effect: 'allow' },
  ]);
});

test('no BEST agent, command or availability entry can reach Claude through Go', () => {
  const claude = /claude|anthropic|haiku|opus|sonnet/i;
  for (const [name, agent] of Object.entries(config.agents)) {
    assert.ok(!claude.test(agent.model || ''), `agent ${name} routes to Claude`);
    const text = JSON.stringify(agent);
    assert.ok(!claude.test(text), `agent ${name} mentions Claude in its contract`);
  }
  for (const [name, command] of Object.entries(config.commands)) {
    assert.ok(!claude.test(command.model || ''), `command ${name} routes to Claude`);
    assert.ok(!claude.test(JSON.stringify(command)), `command ${name} mentions Claude`);
  }
  for (const model of availability.models) {
    assert.ok(!claude.test(model), `availability exposes Claude model ${model}`);
  }
  assert.ok(!claude.test(JSON.stringify(config.policies)), 'policy references Claude');
  assert.ok(!claude.test(JSON.stringify(config.providers)), 'provider block references Claude');
  assert.equal(config.agents['visual-designer'].model, 'opencode-go/glm-5.3-flash');
  assert.equal(config.commands.visual.model, 'opencode-go/glm-5.3-flash');
  assert.equal(config.commands.visualFallback.model, 'opencode-go/minimax-m3');
});

test('visual routing selects GLM, falls back to M3, keeps skills and excludes Claude', () => {
  const empty = [];
  const primary = chooseRoute('visual', 3, config, availability, empty);
  assert.equal(primary.model, 'opencode-go/glm-5.3-flash');
  assert.equal(primary.nativeCommand, 'visual');
  assert.equal(primary.agent, 'visual-designer');
  assert.equal(primary.provider, 'opencode-go');
  assert.equal(primary.fallback, false);
  assert.ok(primary.skills.includes('frontend-design'), 'frontend-design skill lost');

  const fallback = chooseRoute('visual', 3, config, {
    ...availability, unavailable: ['opencode-go/glm-5.3-flash'],
  }, empty);
  assert.equal(fallback.model, 'opencode-go/minimax-m3');
  assert.equal(fallback.nativeCommand, 'visualFallback');
  assert.equal(fallback.agent, 'visual-designer');
  assert.equal(fallback.fallback, true);
  assert.ok(fallback.skills.includes('frontend-design'), 'frontend-design skill lost on fallback');

  for (const route of [primary, fallback]) {
    assert.ok(!/claude|anthropic|haiku/i.test(route.model), `route to Claude: ${route.model}`);
  }
});

test('native delegation graph has no cycles, scanners remain read-only', () => {
  assert.equal(config.experimental.subagent_depth, 1);
  const edges = name => (config.agents[name].permissions || [])
    .filter(p => p.action === 'subagent' && p.effect === 'allow').map(p => p.resource);
  function visit(name, ancestors = []) {
    assert.ok(!ancestors.includes(name), `circular delegation: ${ancestors} -> ${name}`);
    for (const child of edges(name)) visit(child, [...ancestors, name]);
  }
  visit('build');
  for (const name of ['general', 'go-specialist', 'visual-designer'])
    assert.deepEqual(edges(name), []);
  for (const name of ['explore', 'analysis', 'reviewer']) {
    const rules = config.agents[name].permissions;
    assert.equal(rules[0].effect, 'deny');
    assert.ok(!rules.some(p => ['edit', 'shell', 'subagent'].includes(p.action) && p.effect === 'allow'));
  }
});

test('effective commands handle model outages and weighted work without provider calls', () => {
  const empty = [];
  assert.equal(chooseRoute('visual', 3, config, availability, empty).provider, 'opencode-go');
  assert.equal(chooseRoute('visual', 3, config, {
    ...availability, unavailable: ['opencode-go/glm-5.3-flash'],
  }, empty).model, 'opencode-go/minimax-m3');
  assert.equal(chooseRoute('review', 5, config, {
    ...availability, connected: ['opencode-go'],
  }, empty).blocked, true);
  assert.equal(chooseRoute('scan', 1, config, {
    ...availability, exhausted: ['opencode-go'],
  }, empty).blocked, true);
  const work = [];
  for (let i = 0; i < 20; i++) {
    for (const [kind, weight] of [['scan', 1], [i % 2 ? 'coding' : 'complex', 3]]) {
      const route = chooseRoute(kind, weight, config, availability, work);
      assert.equal(route.blocked, undefined);
      work.push({ id: `fixture-${work.length}`, kind, weight, provider: route.provider,
        model: route.model, agent: route.agent, outcome: 'passed', duration_ms: 1 });
    }
  }
  const measured = metrics(work);
  assert.ok(Math.abs(measured.perProvider.openai.weightedSharePct - 50) <= 5);
  assert.equal(chooseRoute('coding', 3, config, availability, work).skills, undefined);
});

test('installed OpenCode accepts the configuration in an isolated memory-only server', () => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'best-config-'));
  try {
    const candidate = structuredClone(config);
    candidate.instructions = [];
    candidate.skills = [];
    for (const server of Object.values(candidate.mcp.servers)) server.disabled = true;
    const file = path.join(temporary, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify(candidate));
    const env = { ...process.env, HOME: path.join(temporary, 'home'),
      XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'),
      XDG_STATE_HOME: path.join(temporary, 'state'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
      OPENCODE_CONFIG: file, OPENCODE_CONFIG_DIR: path.join(temporary, 'config-dir'),
      OPENCODE_DB: ':memory:' };
    const result = spawnSync('/opt/homebrew/Cellar/opencode-v2/2.2.1/bin/opencode',
      ['debug', 'config', '--standalone'], { env, cwd: temporary, encoding: 'utf8',
        timeout: 45000, maxBuffer: 2 * 1024 * 1024, detached: true });
    if (result.error?.code === 'ETIMEDOUT') {
      try { process.kill(-result.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (result.status !== 0) {
      for (const file of fs.globSync('**/*.log', { cwd: temporary })) {
        const bytes = fs.readFileSync(path.join(temporary, file), 'utf8');
        console.error(file, bytes.slice(-8000));
      }
    }
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(result.stdout.includes(file), 'explicit BEST config was not discovered');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
