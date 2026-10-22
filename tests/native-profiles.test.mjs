import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const pin = 'b92f181b3b748d1abbc2afd94af6aa7d8c8fca29';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-team-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const team = path.join(dir, 'team');
  const deps = path.join(dir, 'deps');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(deps, 'bin'), { recursive: true });
  const executable = (file, text) => { fs.writeFileSync(file, text); fs.chmodSync(file, 0o755); };
  executable(path.join(dir, 'opencode'), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log(process.env.MOCK_VERSION || '2.0.32'); process.exit(0); }
require('fs').writeFileSync(process.env.MOCK_CAPTURE, JSON.stringify({pid:process.pid, args:process.argv.slice(2), env:process.env}));
if (process.env.MOCK_WAIT) setInterval(() => {}, 1000);
else process.exit(Number(process.env.MOCK_EXIT || 0));
`);
  executable(path.join(deps, 'bin', 'serena'), '#!/bin/sh\nprintf "serena-agent, version 1.7.0\\n"\n');
  executable(path.join(deps, 'bin', 'uv'), '#!/bin/sh\necho "unexpected dependency installation" >&2\nexit 92\n');
  const ecc = path.join(deps, `ecc-${pin}`);
  fs.mkdirSync(path.join(ecc, 'skills', 'tdd-workflow'), { recursive: true });
  fs.writeFileSync(path.join(ecc, 'skills', 'tdd-workflow', 'SKILL.md'), '---\nname: tdd-workflow\ndescription: Tests first\n---\nTests first.');
  fs.writeFileSync(path.join(ecc, 'LICENSE'), 'MIT');
  executable(path.join(deps, 'bin', 'git'), `#!/bin/sh
case "$*" in
  *'rev-parse HEAD') printf '%s\\n' "\${MOCK_ECC_HASH:-${pin}}" ;;
  *'status --porcelain') printf '%s' "\${MOCK_ECC_DIRTY:-}" ;;
  *) exit 91 ;;
esac
`);
  const env = { ...process.env, HOME: home, OPENCODE_TEAM_HOME: team,
    PATH: `${path.join(deps, 'bin')}:${process.env.PATH}`,
    OPENCODE_TEAM_DEPENDENCY_ROOT: deps, OPENCODE_TEAM_OPENCODE_BIN: path.join(dir, 'opencode'),
    OPENCODE_TEAM_ECC_SOURCE: ecc, MOCK_CAPTURE: path.join(dir, 'capture.json') };
  const run = (...args) => spawnSync('bash', [path.join(root, 'bin/opencode-team'), ...args], { env, encoding: 'utf8', cwd: dir });
  const configPath = (profile) => path.join(team, 'config', profile, 'opencode.jsonc');
  const config = (profile) => JSON.parse(fs.readFileSync(configPath(profile), 'utf8'));
  return { dir, home, team, deps, env, run, config, configPath, ecc };
}
const ok = (result) => assert.equal(result.status, 0, result.stderr + result.stdout);

test('generated BEST permissions allow authorized work while FREE and read-only boundaries remain intact', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const rule = (action, effect, resource = '*') => ({ action, resource, effect });
  assert.deepEqual(f.config('best').permissions, [
    rule('external_directory', 'allow'), rule('shell', 'allow'),
    rule('read', 'deny', '*.env'), rule('read', 'deny', '*.env.*'),
    rule('read', 'allow', '*.env.example'),
  ]);
  assert.deepEqual(f.config('free').permissions, [rule('external_directory', 'ask'), rule('shell', 'ask')]);
  assert.equal(f.config('best').agents.general.permissions, undefined, 'General inherits global rules after native defaults');
  for (const id of ['plan', 'explore', 'reviewer']) {
    const rules = f.config('best').agents[id].permissions;
    assert.ok(rules.some((r) => r.action === '*' && r.effect === 'deny'));
    assert.ok(!rules.some((r) => r.effect === 'ask'));
    assert.ok(rules.some((r) => r.action === 'external_directory' && r.effect === 'allow'));
    for (const action of ['shell', 'edit', 'execute', 'subagent', 'serena_replace_symbol_body']) {
      assert.ok(!rules.some((r) => r.action === action && r.effect === 'allow'), `${id}: ${action}`);
    }
    assert.ok(f.config('free').agents[id].permissions.some((r) => r.action === 'external_directory' && r.effect === 'ask'));
  }
});

test('native V2 resolves generated policies without executing shell resources', {
  skip: !process.env.OPENCODE_TEAM_NATIVE_TEST_BIN,
  timeout: 300000,
}, (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  f.env.OPENCODE_TEAM_OPENCODE_BIN = process.env.OPENCODE_TEAM_NATIVE_TEST_BIN;
  f.env.PATH = process.env.PATH;
  const api = (profile, method, route, body) => {
    const result = f.run(profile, 'api', method, route, ...(body ? ['--data', JSON.stringify(body)] : []));
    ok(result);
    return JSON.parse(result.stdout).data;
  };
  const commands = [
    `DB_ENGINE=mysql DB_HOST=127.0.0.1 .venv/bin/python manage.py shell -c "from django.db import connection; cursor = connection.cursor(); cursor.execute('SELECT VERSION()'); print(cursor.fetchone()[0]); cursor.close()"`,
    'python manage.py test', 'FLAG=yes python -c "print(1)"', 'npm install',
    'git status --short', 'git push origin HEAD', 'git fetch origin',
    'ssh -o BatchMode=yes devhost true', 'scp fixture devhost:development/',
    'sftp -b batch devhost', 'rsync -a fixture/ devhost:development/',
  ];
  for (const profile of ['best', 'free']) {
    // The standalone API host does not register the CLI's built-in agents.
    // Supply the documented base and generated rules as session permissions:
    // this tests the native evaluator, not CLI agent registration or scanning.
    const config = f.config(profile);
    const sessions = new Map();
    const evaluate = (agent, action, resource, expected) => {
      if (!sessions.has(agent)) {
        const permissions = [
          { action: '*', resource: '*', effect: 'allow' },
          { action: 'read', resource: '*.env', effect: 'ask' },
          { action: 'read', resource: '*.env.*', effect: 'ask' },
          { action: 'read', resource: '*.env.example', effect: 'allow' },
          ...config.permissions, ...(config.agents[agent].permissions || []),
        ];
        sessions.set(agent, api(profile, 'post', '/api/session', {
          title: 'permission regression fixture', location: { directory: f.dir }, permissions,
        }));
      }
      const session = sessions.get(agent);
      const result = api(profile, 'post', `/api/session/${session.id}/permission`, { action, resources: [resource] });
      assert.equal(result.effect, expected, `${profile}/${agent}: ${action} ${resource}`);
    };
    for (const agent of profile === 'best' ? ['build', 'general', 'specialist'] : ['build', 'general']) {
      for (const command of commands) evaluate(agent, 'shell', command, profile === 'best' ? 'allow' : 'ask');
      evaluate(agent, 'external_directory', '/development/fixture/*', profile === 'best' ? 'allow' : 'ask');
      for (const action of ['read', 'edit', 'skill', 'serena_replace_symbol_body']) evaluate(agent, action, 'fixture', 'allow');
      evaluate(agent, 'read', 'settings.env', profile === 'best' ? 'deny' : 'ask');
      evaluate(agent, 'read', 'settings.env.production', profile === 'best' ? 'deny' : 'ask');
      evaluate(agent, 'read', 'settings.env.example', 'allow');
    }
    evaluate('build', 'subagent', 'general', 'allow');
    for (const agent of ['plan', 'explore', 'reviewer']) {
      for (const action of ['shell', 'edit', 'execute', 'subagent', 'serena_replace_symbol_body']) evaluate(agent, action, 'fixture', 'deny');
      evaluate(agent, 'serena_find_symbol', '*', 'allow');
      evaluate(agent, 'external_directory', '/development/fixture/*', profile === 'best' ? 'allow' : 'ask');
    }
  }
});

test('only best/free public profiles; native arguments and resume are forwarded exactly', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  for (const profile of ['best', 'free']) {
    const result = f.run('start', profile, 'run', '-s', 'ses_native', '--model', profile === 'free' ? 'opencode/big-pickle' : 'openai/gpt-6.1-sol', 'a prompt with spaces');
    ok(result);
    const capture = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
    assert.deepEqual(capture.args, ['run', '-s', 'ses_native', '--model', profile === 'free' ? 'opencode/big-pickle' : 'openai/gpt-6.1-sol', 'a prompt with spaces', '--standalone']);
    assert.equal(capture.env.XDG_DATA_HOME, path.join(f.team, 'data', profile, 'data'));
    assert.equal(capture.env.XDG_CONFIG_HOME, path.join(f.team, 'config', profile, 'v2', 'xdg-config'));
    const tools = path.join(f.team, 'data/best');
    if (profile === 'best') assert.ok(capture.env.PATH.startsWith(`${tools}/bin${path.delimiter}${tools}/quality/node_modules/.bin${path.delimiter}`));
    else assert.ok(!capture.env.PATH.includes(`${tools}/quality/node_modules/.bin`));
    assert.equal(capture.env.npm_config_cache, profile === 'best' ? path.join(f.team, 'cache/best/npm') : f.env.npm_config_cache);
    assert.equal(capture.env.CTX7_TELEMETRY_DISABLED, profile === 'best' ? '1' : f.env.CTX7_TELEMETRY_DISABLED);
  }
  for (const command of ['openai', 'daily', 'best-ecc', 'best-native', 'go', 'deep-audit', 'runtime-gc', 'maintenance']) {
    assert.notEqual(f.run(command).status, 0, command);
  }
  f.env.MOCK_EXIT = '7';
  assert.equal(f.run('best', 'run', 'hello').status, 7);
});

test('BEST keeps an OpenAI coordinator and Go workers; FREE stays singleton and reviewers read-only', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  for (const profile of ['best', 'free']) {
    const c = f.config(profile);
    assert.equal(c.default_agent, 'build');
    assert.equal(c.$schema, 'https://opencode.ai/config.json');
    assert.equal(c.model, profile === 'best' ? 'openai/gpt-6.1-sol' : 'team-free/mimo-v2.6-flash-free');
    const expected = profile === 'best' ? {
      build: 'openai/gpt-6.1-sol#low', general: 'opencode-go/minimax-m3',
      explore: 'opencode-go/mimo-v2.6-flash', title: 'opencode-go/mimo-v2.6-flash',
      summary: 'opencode-go/minimax-m3', compaction: 'opencode-go/minimax-m3',
      plan: 'openai/gpt-6.1-sol#medium', reviewer: 'openai/gpt-6.1-sol#medium',
      specialist: 'openai/gpt-6.1-sol#medium',
    } : Object.fromEntries(['build', 'plan', 'explore', 'general', 'reviewer', 'title', 'summary', 'compaction'].map((id) => [id, c.model]));
    assert.deepEqual(Object.fromEntries(Object.entries(c.agents).map(([id, agent]) => [id, agent.model])), expected);
    assert.equal(c.plugin, undefined);
    assert.equal(c.plugins, undefined);
    assert.equal(c.agent, undefined);
    assert.deepEqual(c.skills, [path.join(f.ecc, 'skills'), ...(profile === 'best' ? [path.join(root, 'shared/skills')] : [])]);
    assert.deepEqual(Object.keys(c.mcp.servers), profile === 'best' ? ['serena', 'playwright'] : ['serena']);
    assert.ok(c.mcp.servers.serena.command.includes('--project-from-cwd'));
    if (profile === 'best') {
      assert.deepEqual(c.mcp.servers.playwright, {
        type: 'local',
        command: ['npx', '--yes', '@playwright/mcp@0.0.83', '--headless', '--isolated', '--browser', 'chromium', '--image-responses', 'omit', '--snapshot-mode', 'none', '--no-webmcp'],
      });
    } else assert.equal(c.mcp.servers.playwright, undefined);
    const permissions = c.agents.reviewer.permissions;
    assert.ok(permissions.some((p) => p.action === '*' && p.effect === 'deny'));
    assert.ok(!permissions.some((p) => ['shell', 'edit', 'execute', 'subagent'].includes(p.action) && p.effect === 'allow'));
    assert.ok(permissions.some((p) => p.action === 'serena_find_symbol' && p.effect === 'allow'));
  }
  assert.deepEqual(f.config('best').policies, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'opencode-go', effect: 'allow' },
    { action: 'provider.use', resource: 'openai', effect: 'allow' },
  ]);
  assert.deepEqual(f.config('best').providers, {
    openai: { models: { 'gpt-6.1-sol': { settings: { reasoningEffort: 'low' } } } },
  }, 'V2 drops root #variants, so bare native sessions also need a low model default');
  assert.equal(f.config('best').agents.expert, undefined, 'Build already owns difficult reasoning; no duplicate specialist');
  assert.equal(f.config('free').agents.expert, undefined);
  assert.deepEqual(f.config('free').policies.slice(0, 2), [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'team-free', effect: 'allow' },
  ]);
  const provider = f.config('free').providers['team-free'];
  assert.equal(provider.canonical, undefined);
  assert.deepEqual(Object.keys(provider.models), ['mimo-v2.6-flash-free']);
  assert.equal(provider.settings.apiKey, '');
  assert.equal(provider.headers.Authorization, '');
  assert.deepEqual(provider.env, []);
});

test('BEST Hybrid specialist reuses general, denies only question/subagent and inherits 0.2.1 shell/edit from BEST globals', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const best = f.config('best');
  const free = f.config('free');
  const specialist = best.agents.specialist;
  assert.ok(specialist, 'BEST Hybrid introduces a specialist agent');
  assert.equal(specialist.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(specialist.mode, 'subagent');
  assert.equal(typeof specialist.description, 'string');
  assert.ok(specialist.description.length > 16, `specialist description must be meaningful, got ${JSON.stringify(specialist.description)}`);
  assert.ok(Array.isArray(specialist.permissions));
  // The contract is "deny question and subagent only": shell, edit, execute and
  // external_directory must flow through the shared BEST globals, which allow
  // shell and external_directory and deny only *.env/*.env.* secret reads.
  assert.deepEqual(specialist.permissions, [
    { action: 'question', resource: '*', effect: 'deny' },
    { action: 'subagent', resource: '*', effect: 'deny' },
  ], 'specialist explicitly denies question and subagent and nothing else');
  // General is reused, not duplicated as a separate role.
  assert.ok(best.agents.general && best.agents.general.description, 'general agent still owns independent implementation');
  assert.equal(best.agents['coder-a'], undefined, 'no coder-a duplicate alongside specialist');
  assert.equal(best.agents['coder-b'], undefined, 'no coder-b duplicate alongside specialist');
  // Reviewer remains a distinct read-only role; specialist is not a rename.
  assert.equal(best.agents.reviewer.mode, 'subagent');
  assert.ok(best.agents.reviewer.permissions.some((r) => r.action === 'serena_find_symbol' && r.effect === 'allow'));
  // 0.2.1 BEST globals: shell allow, external_directory allow, *.env read deny.
  const globals = best.permissions;
  assert.ok(globals.some((r) => r.action === 'shell' && r.effect === 'allow'),
    '0.2.1 BEST globals still allow shell for any agent that does not deny it');
  assert.ok(globals.some((r) => r.action === 'external_directory' && r.effect === 'allow'),
    '0.2.1 BEST globals still allow external_directory');
  assert.ok(globals.some((r) => r.action === 'read' && r.resource === '*.env' && r.effect === 'deny'),
    '0.2.1 BEST globals still deny secret reads');
  // FREE agent roster stays exactly the documented 0-agent, no-role extras.
  assert.deepEqual(Object.keys(free.agents).sort(), ['build', 'compaction', 'explore', 'general', 'plan', 'reviewer', 'summary', 'title']);
  assert.equal(free.agents.specialist, undefined, 'FREE does not inherit the BEST specialist role');
});

test('BEST Hybrid specialist inherits its coordinator override, FREE ignores it', (t) => {
  const f = fixture(t);
  f.env.OPENCODE_TEAM_BEST_MODEL = 'openai/another-coordinator';
  ok(f.run('setup'));
  const best = f.config('best');
  assert.equal(best.agents.build.model, 'openai/another-coordinator#low');
  assert.equal(best.agents.plan.model, 'openai/another-coordinator#medium');
  assert.equal(best.agents.reviewer.model, 'openai/another-coordinator#medium');
  assert.equal(best.agents.specialist.model, 'openai/another-coordinator#medium',
    'specialist uses the same BEST coordinator and medium reasoning variant as plan/reviewer');
  // Worker pool keeps its opencode-go identity: override only swaps the OpenAI tier.
  assert.equal(best.agents.general.model, 'opencode-go/minimax-m3');
  assert.equal(best.agents.explore.model, 'opencode-go/mimo-v2.6-flash');
  assert.equal(best.agents.title.model, 'opencode-go/mimo-v2.6-flash');
  assert.equal(best.agents.summary.model, 'opencode-go/minimax-m3');
  assert.equal(best.agents.compaction.model, 'opencode-go/minimax-m3');
  assert.equal(best.providers.openai.models['another-coordinator'].settings.reasoningEffort, 'low');
  // FREE singleton is unaffected by the BEST override.
  const free = f.config('free');
  assert.equal(free.model, 'team-free/mimo-v2.6-flash-free');
  assert.equal(free.agents.build.model, 'team-free/mimo-v2.6-flash-free');
  assert.equal(free.agents.specialist, undefined);
});

test('BEST Hybrid supplement is appended to BEST AGENTS.md only; FREE stays exactly shared/instructions.md; setup is byte-idempotent', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const instructionsPath = path.join(root, 'shared/instructions.md');
  const supplementPath = path.join(root, 'shared/best-hybrid.md');
  const instructionsBytes = fs.readFileSync(instructionsPath);
  const supplementBytes = fs.readFileSync(supplementPath);
  const bestFile = path.join(f.team, 'config/best/v2/AGENTS.md');
  const freeFile = path.join(f.team, 'config/free/v2/AGENTS.md');
  const bestBytes = fs.readFileSync(bestFile);
  const freeBytes = fs.readFileSync(freeFile);
  // FREE generated instructions must be byte-identical to the shared source.
  assert.ok(freeBytes.equals(instructionsBytes),
    'FREE generated AGENTS.md must equal shared/instructions.md byte-for-byte');
  assert.equal(bestBytes.length >= instructionsBytes.length, true,
    'BEST generated AGENTS.md must at minimum contain the shared instructions');
  assert.equal(bestBytes.subarray(0, instructionsBytes.length).equals(instructionsBytes), true,
    'BEST generated AGENTS.md must start with shared/instructions.md bytes verbatim');
  assert.ok(supplementBytes.length > 0, 'supplement must carry content');
  assert.deepEqual(bestBytes, Buffer.concat([instructionsBytes, Buffer.from('\n'), supplementBytes]));
  const strict = bestBytes.toString().split('## BEST strict minimalism')[1];
  assert.ok(strict, 'BEST must generate the strict minimalism policy');
  assert.match(strict, /concrete demonstrated need/);
  assert.match(strict, /Django ORM, QuerySet, ModelForm/);
  assert.match(strict, /FAIL[\s\S]*simplif/);
  assert.ok(!freeBytes.includes(Buffer.from('## BEST strict minimalism')));
  ok(f.run('best', 'run', 'fixture'));
  const capture = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
  const loaded = JSON.parse(fs.readFileSync(capture.env.OPENCODE_CONFIG));
  assert.ok(loaded.instructions.includes(bestFile), 'launched BEST references the generated policy');
  assert.equal(capture.env.OPENCODE_CONFIG_DIR, path.dirname(bestFile));
  // Idempotence: a second setup run must not rewrite either file.
  const bestMtime = fs.statSync(bestFile).mtimeMs;
  const freeMtime = fs.statSync(freeFile).mtimeMs;
  ok(f.run('setup'));
  assert.equal(fs.statSync(bestFile).mtimeMs, bestMtime, 'BEST AGENTS.md untouched on repeat');
  assert.equal(fs.statSync(freeFile).mtimeMs, freeMtime, 'FREE AGENTS.md untouched on repeat');
  assert.ok(fs.readFileSync(bestFile).equals(bestBytes), 'BEST AGENTS.md bytes preserved on repeat');
  assert.ok(fs.readFileSync(freeFile).equals(freeBytes), 'FREE AGENTS.md bytes preserved on repeat');
  // The shared source is never copied into the generated tree as a regular file.
  assert.notEqual(bestFile, instructionsPath);
  assert.notEqual(freeFile, instructionsPath);
});

test('isolated BEST permits Go without changing or inheriting the classic OpenAI-only configuration', (t) => {
  const f = fixture(t);
  const classic = path.join(f.home, '.config/opencode/opencode.jsonc');
  fs.mkdirSync(path.dirname(classic), { recursive: true });
  const bytes = JSON.stringify({
    model: 'openai/gpt-6.1-sol',
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'openai', effect: 'allow' },
    ],
    agents: { reviewer: { model: 'openai/gpt-6-astra#high' } },
  });
  fs.writeFileSync(classic, bytes, { mode: 0o400 });
  const before = fs.statSync(classic).mtimeMs;
  ok(f.run('setup'));
  ok(f.run('best', 'run', 'hello'));
  const { args, env } = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
  assert.ok(args.includes('--standalone'));
  assert.equal(env.OPENCODE_CONFIG, f.configPath('best'));
  assert.equal(env.XDG_CONFIG_HOME, path.join(f.team, 'config/best/v2/xdg-config'));
  assert.ok(f.config('best').policies.some((p) => p.resource === 'opencode-go' && p.effect === 'allow'));
  assert.equal(f.config('best').agents.reviewer.model, 'openai/gpt-6.1-sol#medium');
  assert.equal(fs.readFileSync(classic, 'utf8'), bytes);
  assert.equal(fs.statSync(classic).mtimeMs, before);
  assert.equal(fs.statSync(classic).mode & 0o777, 0o400);
});

test('BEST references the original global AGENTS.md without copying or modifying it; FREE stays isolated', (t) => {
  const f = fixture(t);
  const original = path.join(f.home, '.config/opencode/AGENTS.md');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, '# Original user rules\nFirst version.\n', { mode: 0o600 });
  ok(f.run('setup'));
  assert.deepEqual(f.config('best').instructions, [original, path.join(f.team, 'config/best/v2/AGENTS.md')]);
  assert.deepEqual(f.config('free').instructions, [path.join(f.team, 'config/free/v2/AGENTS.md')]);
  assert.equal(fs.readFileSync(original, 'utf8'), '# Original user rules\nFirst version.\n');
  const before = fs.statSync(f.configPath('best')).mtimeMs;
  fs.writeFileSync(original, '# Original user rules\nUpdated by the user.\n');
  fs.chmodSync(original, 0o400);
  ok(f.run('setup'));
  ok(f.run('best', 'run', 'hello'));
  assert.equal(fs.statSync(f.configPath('best')).mtimeMs, before, 'source edits need no regenerated copy');
  assert.equal(fs.readFileSync(original, 'utf8'), '# Original user rules\nUpdated by the user.\n');
  assert.equal(fs.statSync(original).mode & 0o777, 0o400);
  const custom = path.join(f.dir, 'my-rules.md');
  fs.writeFileSync(custom, 'Explicit shared rules');
  f.env.OPENCODE_TEAM_RULES_FILE = custom;
  ok(f.run('setup'));
  assert.equal(f.config('best').instructions[0], custom);
  assert.equal(fs.readFileSync(custom, 'utf8'), 'Explicit shared rules');
});

test('shared rules cannot alias a generated file that setup would overwrite', (t) => {
  for (const alias of [false, true]) {
    const f = fixture(t);
    ok(f.run('setup'));
    const owned = path.join(f.team, 'config/best/v2/AGENTS.md');
    fs.writeFileSync(owned, 'User rules must not be overwritten');
    const source = alias ? path.join(f.dir, 'rules-alias.md') : owned;
    if (alias) fs.symlinkSync(owned, source);
    f.env.OPENCODE_TEAM_RULES_FILE = source;
    const result = f.run('setup');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside generated/);
    assert.equal(fs.readFileSync(owned, 'utf8'), 'User rules must not be overwritten');
  }
});

test('missing optional common rules are reported; an explicit invalid rules source fails before replacement', (t) => {
  const f = fixture(t);
  const initial = f.run('setup');
  ok(initial);
  assert.match(initial.stderr, /AGENTS\.md.*not found/);
  const before = fs.readFileSync(f.configPath('best'), 'utf8');
  f.env.OPENCODE_TEAM_RULES_FILE = path.join(f.dir, 'missing-rules.md');
  assert.notEqual(f.run('setup').status, 0);
  assert.equal(fs.readFileSync(f.configPath('best'), 'utf8'), before);
  f.env.OPENCODE_TEAM_RULES_FILE = f.dir;
  assert.notEqual(f.run('setup').status, 0);
  assert.equal(fs.readFileSync(f.configPath('best'), 'utf8'), before);
});

test('standalone is passed in the native subcommand scope, not as a root flag', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  fs.writeFileSync(f.env.OPENCODE_TEAM_OPENCODE_BIN, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.32'); process.exit(0); }
if (args[0] === '--standalone' && ['run', 'auth', 'session', 'api', 'models'].includes(args[1])) {
  console.error('Unrecognized root flag: --standalone'); process.exit(64);
}
require('fs').writeFileSync(process.env.MOCK_CAPTURE, JSON.stringify(args));
`);
  for (const args of [['run', 'hello'], ['auth', 'list'], ['session', 'list'], ['api', 'get', '/api/model'], ['models']]) {
    ok(f.run('free', ...args));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE)), [...args, '--standalone']);
  }
  ok(f.run('free', 'run', '--', '--literal-prompt'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE)), ['run', '--standalone', '--', '--literal-prompt']);
});

test('setup is idempotent; migration backs up configs only and rollback preserves native auth/sessions', (t) => {
  const f = fixture(t);
  const old = '{ "plugin": ["legacy"], "model": "old" }\n';
  fs.mkdirSync(path.dirname(f.configPath('best')), { recursive: true });
  fs.writeFileSync(f.configPath('best'), old);
  const data = path.join(f.team, 'data', 'best', 'data', 'opencode');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'auth.json'), '{"openai":{"type":"oauth","refresh":"profile-only"}}');
  fs.writeFileSync(path.join(data, 'opencode.db'), 'historical database bytes');
  const global = path.join(f.home, '.local/share/opencode');
  fs.mkdirSync(global, { recursive: true });
  fs.writeFileSync(path.join(global, 'auth.json'), 'GLOBAL MUST NOT CHANGE');
  ok(f.run('setup'));
  const before = fs.statSync(f.configPath('best')).mtimeMs;
  ok(f.run('setup'));
  assert.equal(fs.statSync(f.configPath('best')).mtimeMs, before);
  const backups = path.join(f.team, 'config', 'backups');
  const entries = fs.readdirSync(backups);
  assert.equal(entries.length, 1);
  assert.equal(fs.statSync(path.join(backups, entries[0])).mode & 0o777, 0o700);
  ok(f.run('rollback', entries[0]));
  assert.equal(fs.readFileSync(f.configPath('best'), 'utf8'), old);
  assert.equal(fs.readFileSync(path.join(data, 'opencode.db'), 'utf8'), 'historical database bytes');
  assert.match(fs.readFileSync(path.join(data, 'auth.json'), 'utf8'), /profile-only/);
  assert.equal(fs.readFileSync(path.join(global, 'auth.json'), 'utf8'), 'GLOBAL MUST NOT CHANGE');
});

test('failed setup preflights both profiles and leaves existing config intact', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.configPath('best')), { recursive: true });
  fs.writeFileSync(f.configPath('best'), 'existing bytes');
  fs.mkdirSync(path.dirname(f.configPath('free')), { recursive: true });
  fs.mkdirSync(f.configPath('free'));
  assert.notEqual(f.run('setup').status, 0);
  assert.equal(fs.readFileSync(f.configPath('best'), 'utf8'), 'existing bytes');
  fs.rmdirSync(f.configPath('free'));
  ok(f.run('setup'));
});

test('symlink config, data and roots are rejected without touching the target', (t) => {
  for (const relative of ['config', 'config/best/opencode.jsonc', 'data/best/data/opencode/auth.json', 'state/best']) {
    const f = fixture(t);
    const target = path.join(f.dir, 'do-not-touch');
    fs.writeFileSync(target, 'private');
    const link = path.join(f.team, relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    assert.notEqual(f.run('setup').status, 0, relative);
    assert.equal(fs.readFileSync(target, 'utf8'), 'private');
  }
});

test('V1/malformed versions are rejected before setup; doctor is read-only', (t) => {
  const f = fixture(t);
  for (const version of ['1.18.30', 'garbage', '3.0.0']) {
    f.env.MOCK_VERSION = version;
    assert.notEqual(f.run('setup').status, 0);
    assert.equal(fs.existsSync(f.team), false);
  }
  f.env.MOCK_VERSION = '2.0.32';
  assert.notEqual(f.run('doctor').status, 0);
  assert.equal(fs.existsSync(f.team), false);
  ok(f.run('setup'));
  ok(f.run('doctor'));
});

test('FREE never imports auth or inherited provider/config overrides; historic paid auth remains dormant', (t) => {
  const f = fixture(t);
  f.env.OPENCODE_CONFIG_CONTENT = '{"model":"openai/paid"}';
  f.env.OPENCODE_DB = path.join(f.dir, 'global.db');
  f.env.OPENAI_API_KEY = 'do-not-inherit';
  f.env.OPENCODE_API_KEY = 'paid-zen';
  ok(f.run('setup'));
  ok(f.run('free', 'run', 'hello'));
  const { env } = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
  for (const key of ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'OPENAI_API_KEY', 'OPENCODE_API_KEY']) assert.equal(env[key], undefined);
  const auth = path.join(f.team, 'data/free/data/opencode/auth.json');
  fs.writeFileSync(auth, '{"opencode":{"type":"api","key":"paid"}}');
  const result = f.run('free', 'run', 'hello');
  ok(result);
  assert.equal(f.config('free').policies[0].effect, 'deny');
  assert.equal(f.config('free').policies[1].resource, 'team-free');
  assert.match(fs.readFileSync(auth, 'utf8'), /paid/);
  ok(f.run('best', 'run', 'hello'));
  const best = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
  assert.equal(best.env.OPENAI_API_KEY, undefined, 'BEST requires its own connection rather than ambient paid credentials');
});

test('explicit coordinator and worker model choices update only their roles with backup', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  f.env.OPENCODE_TEAM_BEST_MODEL = 'openai/another-coordinator';
  f.env.OPENCODE_TEAM_BEST_GO_MODEL = 'opencode-go/another-worker';
  ok(f.run('setup'));
  assert.equal(f.config('best').model, 'openai/another-coordinator');
  assert.equal(f.config('best').agents.general.model, 'opencode-go/another-worker');
  assert.equal(f.config('best').agents.title.model, 'opencode-go/mimo-v2.6-flash');
  assert.equal(f.config('best').agents.compaction.model, 'opencode-go/another-worker');
  assert.equal(f.config('best').agents.build.model, 'openai/another-coordinator#low');
  assert.equal(f.config('best').agents.reviewer.model, 'openai/another-coordinator#medium');
  assert.equal(f.config('best').providers.openai.models['another-coordinator'].settings.reasoningEffort, 'low');
  f.env.OPENCODE_TEAM_BEST_GO_MODEL = 'opencode/paid-model';
  assert.notEqual(f.run('setup').status, 0);
  delete f.env.OPENCODE_TEAM_BEST_GO_MODEL;
  f.env.OPENCODE_TEAM_FREE_MODEL = 'openai/paid';
  assert.notEqual(f.run('setup').status, 0);
  assert.equal(f.config('free').model, 'team-free/mimo-v2.6-flash-free');
});

test('a write failure midway through setup restores both previous configs and allows retry', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const before = ['best', 'free'].map((p) => fs.readFileSync(f.configPath(p), 'utf8'));
  const fault = path.join(f.dir, 'fault.mjs');
  fs.writeFileSync(fault, `import fs from 'node:fs';
const rename = fs.renameSync;
let failed = false;
fs.renameSync = function(source, target) {
  if (!failed && target === ${JSON.stringify(f.configPath('free'))}) {
    failed = true;
    throw Object.assign(new Error('injected disk failure'), {code:'EIO'});
  }
  return rename(source, target);
};`);
  f.env.NODE_OPTIONS = `--import=${fault}`;
  f.env.OPENCODE_TEAM_BEST_MODEL = 'openai/changed';
  // A local config edit makes FREE participate in this transaction too.
  fs.writeFileSync(f.configPath('free'), `${before[1]} `);
  const result = f.run('setup');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected disk failure/);
  assert.equal(fs.readFileSync(f.configPath('best'), 'utf8'), before[0]);
  assert.equal(fs.readFileSync(f.configPath('free'), 'utf8'), `${before[1]} `);
  assert.equal(fs.existsSync(path.join(f.team, 'config', '.pending')), false);
  delete f.env.NODE_OPTIONS;
  ok(f.run('setup'));
  assert.equal(f.config('best').model, 'openai/changed');
});

test('an interrupted transaction is blocked on launch and recovered before the next setup', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  f.env.OPENCODE_TEAM_BEST_MODEL = 'openai/new';
  ok(f.run('setup'));
  const id = fs.readdirSync(path.join(f.team, 'config/backups'))[0];
  fs.writeFileSync(path.join(f.team, 'config/.pending'), id);
  assert.notEqual(f.run('best', 'run', 'hello').status, 0);
  assert.notEqual(f.run('doctor').status, 0);
  // Recovery happens even if a dependency then prevents setup from completing.
  f.env.MOCK_ECC_DIRTY = ' M skills/tdd-workflow/SKILL.md';
  const result = f.run('setup');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Recovered interrupted/);
  assert.equal(f.config('best').model, 'openai/gpt-6.1-sol');
  assert.equal(fs.existsSync(path.join(f.team, 'config/.pending')), false);
  delete f.env.MOCK_ECC_DIRTY;
  ok(f.run('setup'));
});

test('launch refuses an active setup and rechecks transactions after the native version probe', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const lock = path.join(f.team, 'config/.setup-lock');
  fs.writeFileSync(lock, 'setup-running');
  assert.notEqual(f.run('best', 'run', 'hello').status, 0);
  assert.equal(fs.existsSync(f.env.MOCK_CAPTURE), false);
  fs.unlinkSync(lock);
  const pending = path.join(f.team, 'config/.pending');
  fs.writeFileSync(f.env.OPENCODE_TEAM_OPENCODE_BIN, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === '--version') {
  fs.writeFileSync(${JSON.stringify(pending)}, 'transaction-started-during-version');
  console.log('2.0.32'); process.exit(0);
}
fs.writeFileSync(process.env.MOCK_CAPTURE, 'must-not-launch');
`);
  assert.notEqual(f.run('best', 'run', 'hello').status, 0);
  assert.equal(fs.existsSync(f.env.MOCK_CAPTURE), false);
});

test('setup never overwrites modified dependencies; rollback cannot escape its owned file list', (t) => {
  const f = fixture(t);
  f.env.MOCK_ECC_DIRTY = ' M skills/tdd-workflow/SKILL.md';
  assert.notEqual(f.run('setup').status, 0);
  assert.equal(fs.existsSync(f.configPath('best')), false);
  delete f.env.MOCK_ECC_DIRTY;
  ok(f.run('setup'));
  const id = '2026-10-19T00-00-00.000Z-abcdef';
  const dir = path.join(f.team, 'config/backups', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{path:'../../global-auth', existed:true, backup:'0'}]));
  fs.writeFileSync(path.join(dir, '0'), 'do not write');
  assert.notEqual(f.run('rollback', id).status, 0);
  assert.equal(fs.existsSync(path.join(f.team, 'global-auth')), false);
});

test('existing default managed Serena 1.7.0 is reused without uv installation', (t) => {
  const f = fixture(t);
  const original = path.join(f.team, 'data/bin/serena');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.copyFileSync(path.join(f.deps, 'bin/serena'), original);
  fs.chmodSync(original, 0o755);
  delete f.env.OPENCODE_TEAM_DEPENDENCY_ROOT;
  ok(f.run('setup'));
  assert.equal(f.config('best').mcp.servers.serena.command[0], original);
  assert.equal(fs.existsSync(path.join(f.team, 'data/dependencies/bin/serena')), false);
});

test('fresh provisioning installs only pinned Serena and skills content into the declared dependency root', (t) => {
  const f = fixture(t);
  fs.rmSync(f.ecc, { recursive: true });
  fs.unlinkSync(path.join(f.deps, 'bin/serena'));
  delete f.env.OPENCODE_TEAM_ECC_SOURCE;
  const log = path.join(f.dir, 'dependency-log');
  f.env.MOCK_DEP_LOG = log;
  fs.writeFileSync(path.join(f.deps, 'bin/git'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DEP_LOG, JSON.stringify({command:'git',args, prompt:process.env.GIT_TERMINAL_PROMPT, interactive:process.env.GCM_INTERACTIVE, askpass:process.env.SSH_ASKPASS_REQUIRE, ssh:process.env.GIT_SSH_COMMAND})+'\\n');
if (args.includes('clone')) {
 const target = args.at(-1);
 fs.mkdirSync(path.join(target, 'skills/tdd-workflow'), {recursive:true});
 fs.writeFileSync(path.join(target,'skills/tdd-workflow/SKILL.md'), 'Tests first');
 fs.writeFileSync(path.join(target,'LICENSE'), 'MIT');
}
if (args.includes('rev-parse')) console.log('${pin}');
`);
  const uv = path.join(f.deps, 'bin/uv');
  fs.writeFileSync(uv, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
fs.appendFileSync(process.env.MOCK_DEP_LOG, JSON.stringify({command:'uv',args:process.argv.slice(2), tool:process.env.UV_TOOL_DIR, bin:process.env.UV_TOOL_BIN_DIR, python:process.env.UV_PYTHON_INSTALL_DIR})+'\\n');
const file = path.join(process.env.UV_TOOL_BIN_DIR,'serena');
fs.writeFileSync(file, '#!/bin/sh\\necho "serena-agent, version 1.7.0"\\n', {mode:0o755});
`);
  fs.chmodSync(uv, 0o755);
  ok(f.run('setup'));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const install = calls.find((c) => c.command === 'uv');
  assert.deepEqual(install.args, ['tool', 'install', '--python', '3.13', 'serena-agent==1.7.0']);
  assert.equal(install.tool, path.join(f.deps, 'serena'));
  assert.equal(install.bin, path.join(f.deps, 'bin'));
  assert.equal(install.python, path.join(f.deps, 'python'));
  assert.ok(calls.some((c) => c.args.includes('fetch') && c.args.includes(pin)));
  assert.ok(calls.some((c) => c.args.includes('clone') && c.args.includes('https://github.com/affaan-m/ECC.git')));
  for (const call of calls.filter((c) => c.command === 'git' && ['clone', 'fetch', 'sparse-checkout', 'checkout'].some((action) => c.args.includes(action)))) {
    assert.deepEqual(call.args.slice(0, 2), ['-c', 'credential.interactive=false']);
    assert.equal(call.prompt, '0');
    assert.equal(call.interactive, 'Never');
    assert.equal(call.askpass, 'never');
    assert.equal(call.ssh, 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o NumberOfPasswordPrompts=0 -o ConnectTimeout=15');
  }
  assert.ok(calls.some((c) => c.args.includes('sparse-checkout') && c.args.includes('--no-cone') && c.args.slice(-2).join(',') === '/skills/,/LICENSE'));
  assert.doesNotMatch(JSON.stringify(calls), /brew|npm|codex|hooks|orchestrator/);
});

test('help/config/version need no setup; unsupported/missing profile and concurrent setup fail clearly', (t) => {
  const f = fixture(t);
  for (const args of [[], ['--help'], ['version'], ['config', 'best'], ['config', 'free']]) ok(f.run(...args));
  assert.match(f.run().stdout, /only|native V2/i);
  assert.equal(f.run('config', 'free').stdout.trim(), f.configPath('free'));
  for (const args of [['start'], ['start', 'daily'], ['config', 'daily'], ['best'], ['setup', 'unexpected']]) assert.notEqual(f.run(...args).status, 0);
  fs.mkdirSync(path.join(f.team, 'config'), { recursive: true });
  fs.writeFileSync(path.join(f.team, 'config/.setup-lock'), 'another-setup');
  const result = f.run('setup');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locked/);
  assert.equal(fs.readFileSync(path.join(f.team, 'config/.setup-lock'), 'utf8'), 'another-setup');
});

test('default paths ignore ambient XDG and profile data stays outside Premium roots', (t) => {
  const f = fixture(t);
  delete f.env.OPENCODE_TEAM_HOME;
  f.env.XDG_DATA_HOME = path.join(f.dir, 'premium');
  ok(f.run('setup'));
  ok(f.run('free', 'run', 'hello'));
  const { env } = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
  assert.equal(env.XDG_DATA_HOME, path.join(f.home, '.local/share/opencode-team/free/data'));
  assert.equal(env.XDG_STATE_HOME, path.join(f.home, '.local/state/opencode-team/free'));
  assert.equal(fs.existsSync(path.join(f.dir, 'premium')), false);
});

test('SIGINT addressed to the launcher is forwarded to its native child without leaving a server orphan', async (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const child = spawn('bash', [path.join(root, 'bin/opencode-team'), 'best', 'run', 'wait'], {
    env: { ...f.env, MOCK_WAIT: '1' }, stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({code, signal})));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(f.env.MOCK_CAPTURE); i++) await delay(20);
    assert.ok(fs.existsSync(f.env.MOCK_CAPTURE), 'mock child started');
    child.kill('SIGINT');
    const result = await Promise.race([exited, delay(2000).then(() => null)]);
    assert.ok(result, 'launcher and native child must stop after interrupt');
    assert.equal(result.signal, 'SIGINT');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
  }
});
