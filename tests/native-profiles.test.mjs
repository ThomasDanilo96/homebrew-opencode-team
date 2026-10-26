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

const trustedExternal = ['~/Sites/Github/*', '~/Sites/Python/*', '~/.local/bin/*', '~/Library/LaunchAgents/*',
  ...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())].map((directory) => path.join(directory, 'opencode', '*')))];
const ordinaryGit = ['git add shared/profiles.mjs', 'git commit -m "scoped fix"',
  'git -C /development/fixture add .', 'git -C /development/fixture commit -m "scoped fix"',
  'git -c credential.interactive=false add .',
  'git -c credential.interactive=false -C /development/fixture commit -m "scoped fix"'];
const approvalCommands = ['git reset --hard HEAD', 'git -C /development/fixture reset --hard HEAD',
  'git clean -fd', 'git -c credential.interactive=false clean -fd',
  'git push -f origin HEAD', 'git push --force origin HEAD', 'git push --force-with-lease origin HEAD',
  'git -C /development/fixture push origin HEAD --force-with-lease',
  'git push +HEAD:main', 'git push origin +HEAD:main', 'git push --mirror origin',
  'git commit --amend --no-edit', 'git rebase main', 'git filter-branch --all', 'git filter-repo --force',
  'rm -rf build', '/bin/rm -rf build', 'rmdir build',
  'git config --global credential.helper store', 'git credential approve',
  'ssh-keygen -t ed25519', 'ssh-add -D', 'security delete-generic-password -s fixture',
  'chmod 600 ~/.ssh/config', 'cp fixture ~/.git-credentials',
  'dropdb fixture', 'psql -c "DROP DATABASE fixture"', 'mysql -e "DROP DATABASE fixture"',
  'opencode api delete /api/session/fixture', 'opencode --standalone api delete /api/session/fixture',
  'kubectl delete deployment fixture', 'helm upgrade fixture chart', 'terraform apply',
  'aws cloudformation deploy', 'gcloud run deploy fixture', 'az deployment group create',
  'launchctl bootstrap gui/501 fixture.plist', 'sudo true'];

// Mirror the documented whole-value wildcard rules; the opt-in test below also
// checks these same resources against the native evaluator (never a shell).
function permissionEffect(config, agent, action, resource, home) {
  const match = (pattern, value) => {
    const regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    return new RegExp(`^${regex}$`).test(value) || (pattern.endsWith(' *') && value === pattern.slice(0, -2));
  };
  let effect = 'allow';
  for (const rule of [...config.permissions, ...(config.agents[agent].permissions || [])]) {
    const pattern = ['external_directory', 'read', 'edit'].includes(action)
      ? rule.resource.replace(/^~(?=\/|$)/, home) : rule.resource;
    if (match(rule.action, action) && match(pattern, resource)) effect = rule.effect;
  }
  return effect;
}

test('native discovery ignores profile-local OpenCode while BEST keeps private tools on PATH', (t) => {
  const f = fixture(t);
  const privateBin = path.join(f.team, 'data/best/bin');
  fs.mkdirSync(privateBin, { recursive: true });
  const fork = path.join(privateBin, 'opencode');
  fs.writeFileSync(fork, '#!/bin/sh\necho "profile-local fork must not run" >&2\nexit 95\n', { mode: 0o755 });
  delete f.env.OPENCODE_TEAM_OPENCODE_BIN;
  f.env.PATH = `${privateBin}:${f.dir}:${f.env.PATH}`;
  ok(f.run('setup'));
  for (const profile of ['best', 'free']) {
    ok(f.run(profile, 'run', 'official native'));
    const capture = JSON.parse(fs.readFileSync(f.env.MOCK_CAPTURE));
    assert.equal(capture.args[1], 'official native');
    if (profile === 'best') assert.ok(capture.env.PATH.startsWith(`${privateBin}:`));
  }
  assert.match(fs.readFileSync(fork, 'utf8'), /profile-local fork/);
  // A profile bin may contain a symlink to a fork outside the profile tree.
  const externalFork = path.join(f.dir, 'retention-fork');
  fs.renameSync(fork, externalFork);
  fs.symlinkSync(externalFork, fork);
  const alias = path.join(f.dir, 'private-bin-alias');
  fs.symlinkSync(privateBin, alias);
  f.env.PATH = `${alias}:${f.env.PATH}`;
  ok(f.run('best', 'run', 'official through alias'));
  const denied = path.join(f.dir, 'denied-path');
  const hook = path.join(f.dir, 'deny-unused-path.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';
const original = fs.realpathSync;
fs.realpathSync = function(file, ...args) {
  if (file === ${JSON.stringify(denied)}) throw Object.assign(new Error('unused PATH access denied'), {code:'EPERM'});
  return original.call(this, file, ...args);
};
`);
  f.env.NODE_OPTIONS = `--import=${hook}`;
  f.env.PATH += `${path.delimiter}${denied}`;
  ok(f.run('best', 'run', 'do not inspect unused PATH entries'));
});

function mockCleanup(f) {
  const hook = path.join(f.dir, 'launchctl-mock.mjs');
  f.env.MOCK_LAUNCHCTL_LOG = path.join(f.dir, 'launchctl.log');
  f.env.MOCK_LAUNCHCTL_STATE = path.join(f.dir, 'launchctl-state');
  fs.writeFileSync(hook, `import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process, 'platform', {value:'darwin'});
if (!process.env.MOCK_REAL_HOME) os.userInfo = () => ({homedir:process.env.HOME});
const original = cp.spawnSync;
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (process.env.MOCK_MARKER_FAIL && target.endsWith('/cleanup.json')) throw new Error('injected cleanup receipt failure');
  return rename(source, target);
};
cp.spawnSync = (bin, args, opts) => {
  if (bin !== '/bin/launchctl') return original(bin, args, opts);
  fs.appendFileSync(process.env.MOCK_LAUNCHCTL_LOG, JSON.stringify(args)+'\\n');
  const state = process.env.MOCK_LAUNCHCTL_STATE;
  if (process.env.MOCK_LAUNCHCTL_FAIL === args[0]) return {status:5,stderr:'injected launchctl failure',stdout:''};
  if (args[0] === 'print') return fs.existsSync(state)
    ? {status:0,stderr:'',stdout:'path = '+fs.readFileSync(state,'utf8')+'\\n'}
    : {status:113,stderr:'Could not find service',stdout:''};
  if (args[0] === 'bootstrap') fs.writeFileSync(state,args[2]);
  if (args[0] === 'bootout') fs.unlinkSync(state);
  return {status:0,stderr:'',stdout:''};
};
syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `--import=${hook}`;
  return () => fs.existsSync(f.env.MOCK_LAUNCHCTL_LOG)
    ? fs.readFileSync(f.env.MOCK_LAUNCHCTL_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];
}

test('macOS setup schedules only an owned safe job, with persistent disable and scoped uninstall (mock launchctl)', (t) => {
  const f = fixture(t);
  const calls = mockCleanup(f);
  delete f.env.OPENCODE_TEAM_HOME;
  const plist = path.join(f.home, 'Library/LaunchAgents/io.opencode-team.safe-caches.plist');
  const old = path.join(f.home, 'Library/LaunchAgents/local.disk-cleanup.plist');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, 'legacy user job');
  ok(f.run('setup'));
  const bytes = fs.readFileSync(plist, 'utf8');
  assert.match(bytes, /\/usr\/bin\/python3/);
  assert.match(bytes, /shared\/maintenance\.py/);
  assert.match(bytes, /<key>StandardOutPath<\/key>/);
  assert.match(bytes, /<key>StandardErrorPath<\/key>/);
  assert.match(bytes, /<key>Hour<\/key><integer>4<\/integer><key>Minute<\/key><integer>15<\/integer>/);
  assert.doesNotMatch(bytes, /RunAtLoad|StartInterval/);
  assert.match(bytes, /StartCalendarInterval/);
  assert.equal(calls().filter((c) => c[0] === 'bootstrap').length, 1);
  assert.ok(!calls().some((c) => c[0] === 'kickstart'));
  ok(f.run('setup'));
  assert.equal(calls().filter((c) => c[0] === 'bootstrap').length, 1);
  ok(f.run('cleanup', 'disable'));
  assert.equal(fs.existsSync(plist), false, 'disabled jobs must not be rediscovered at the next login');
  ok(f.run('setup'));
  assert.match(f.run('cleanup', 'status').stdout, /disabled/i);
  assert.equal(calls().filter((c) => c[0] === 'bootstrap').length, 1);
  ok(f.run('cleanup', 'enable'));
  ok(f.run('cleanup', 'uninstall'));
  assert.equal(fs.existsSync(plist), false);
  ok(f.run('setup'));
  assert.equal(fs.existsSync(plist), false, 'uninstall stays disabled across setup');
  assert.equal(fs.readFileSync(old, 'utf8'), 'legacy user job');
  assert.ok(calls().every((c) => c.every((arg) => !arg.includes('local.disk-cleanup'))));
});

test('custom homes never schedule automatically and explicit enable escapes plist values (mock launchctl)', (t) => {
  const f = fixture(t);
  const calls = mockCleanup(f);
  ok(f.run('setup'));
  assert.deepEqual(calls(), []);
  assert.match(f.run('cleanup', 'status').stdout, /not installed/i);
  const oddHome = path.join(f.dir, 'home & <test>');
  fs.renameSync(f.home, oddHome);
  f.env.HOME = oddHome;
  ok(f.run('cleanup', 'enable'));
  const plist = path.join(oddHome, 'Library/LaunchAgents/io.opencode-team.safe-caches.plist');
  const text = fs.readFileSync(plist, 'utf8');
  assert.ok(text.includes('home &amp; &lt;test&gt;'));
  const parsed = spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' });
  if (process.platform === 'darwin') ok(parsed);
});

test('scheduled cleanup follows the stable installation symlink across upgrades', (t) => {
  const f = fixture(t);
  mockCleanup(f);
  const versions = ['old-keg', 'new-keg'].map((name) => path.join(f.dir, name));
  for (const directory of versions) {
    fs.mkdirSync(directory);
    for (const asset of ['bin', 'shared']) fs.cpSync(path.join(root, asset), path.join(directory, asset), { recursive: true });
  }
  const stable = path.join(f.dir, 'opt-opencode-team');
  fs.symlinkSync(versions[0], stable);
  ok(spawnSync('bash', [path.join(stable, 'bin/opencode-team'), 'cleanup', 'enable'], { env: f.env, encoding: 'utf8' }));
  const plist = fs.readFileSync(path.join(f.home, 'Library/LaunchAgents/io.opencode-team.safe-caches.plist'), 'utf8');
  const scheduled = plist.match(/<string>\/usr\/bin\/python3<\/string><string>([^<]+)<\/string>/)[1];
  assert.equal(scheduled, path.join(stable, 'shared/maintenance.py'));
  fs.unlinkSync(stable);
  fs.symlinkSync(versions[1], stable);
  fs.rmSync(versions[0], { recursive: true });
  assert.ok(fs.existsSync(scheduled), 'upgrading/removing the old keg must not orphan the scheduled script');
});

test('explicit custom-root maintenance scheduling preserves the selected root (mock launchctl)', (t) => {
  const f = fixture(t);
  mockCleanup(f);
  ok(f.run('cleanup', 'enable'));
  const text = fs.readFileSync(path.join(f.home, 'Library/LaunchAgents/io.opencode-team.safe-caches.plist'), 'utf8');
  assert.ok(text.includes(`<key>OPENCODE_TEAM_HOME</key><string>${f.team}</string>`));
});

test('cleanup refuses foreign or edited agents and propagates launchctl failures (mock launchctl)', (t) => {
  const f = fixture(t);
  const calls = mockCleanup(f);
  const plist = path.join(f.home, 'Library/LaunchAgents/io.opencode-team.safe-caches.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, 'foreign job');
  assert.notEqual(f.run('cleanup', 'enable').status, 0);
  assert.equal(fs.readFileSync(plist, 'utf8'), 'foreign job');
  assert.deepEqual(calls(), []);
  fs.unlinkSync(plist);
  f.env.MOCK_LAUNCHCTL_FAIL = 'bootstrap';
  const result = f.run('cleanup', 'enable');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected launchctl failure/);
  delete f.env.MOCK_LAUNCHCTL_FAIL;
  ok(f.run('cleanup', 'enable'));
  fs.appendFileSync(plist, '<!-- user edit -->');
  const before = calls().length;
  assert.notEqual(f.run('cleanup', 'uninstall').status, 0);
  assert.match(fs.readFileSync(plist, 'utf8'), /user edit/);
  assert.equal(calls().length, before);
});

test('cleanup status and non-macOS commands are read-only; fake HOME cannot address the real GUI domain', (t) => {
  const f = fixture(t);
  const calls = mockCleanup(f);
  ok(f.run('cleanup', 'status'));
  assert.equal(fs.existsSync(f.team), false);
  f.env.MOCK_REAL_HOME = '1';
  assert.notEqual(f.run('cleanup', 'enable').status, 0);
  assert.deepEqual(calls(), []);
  const hook = path.join(f.dir, 'not-macos.mjs');
  fs.writeFileSync(hook, "Object.defineProperty(process, 'platform', {value:'linux'});");
  f.env.NODE_OPTIONS = `--import=${hook}`;
  ok(f.run('cleanup', 'enable'));
  assert.equal(fs.existsSync(path.join(f.home, 'Library/LaunchAgents')), false);
});

test('cleanup receipt failure leaves no orphan agent and a failed bootstrap is retryable (mock launchctl)', (t) => {
  const f = fixture(t);
  const calls = mockCleanup(f);
  const plist = path.join(f.home, 'Library/LaunchAgents/io.opencode-team.safe-caches.plist');
  f.env.MOCK_MARKER_FAIL = '1';
  assert.notEqual(f.run('cleanup', 'enable').status, 0);
  assert.equal(fs.existsSync(plist), false, 'failed ownership receipt must roll back the new agent');
  assert.ok(!calls().some((c) => c[0] === 'bootstrap'));
  delete f.env.MOCK_MARKER_FAIL;
  delete f.env.OPENCODE_TEAM_HOME;
  f.env.MOCK_LAUNCHCTL_FAIL = 'bootstrap';
  assert.notEqual(f.run('setup').status, 0);
  assert.match(f.run('cleanup', 'status').stdout, /not loaded/i);
  delete f.env.MOCK_LAUNCHCTL_FAIL;
  ok(f.run('setup'));
  assert.equal(calls().filter((c) => c[0] === 'bootstrap').length, 2);
  f.env.MOCK_LAUNCHCTL_FAIL = 'bootout';
  assert.notEqual(f.run('cleanup', 'disable').status, 0);
  assert.ok(fs.existsSync(plist));
  assert.match(f.run('cleanup', 'status').stdout, /disabled.*loaded/i);
  delete f.env.MOCK_LAUNCHCTL_FAIL;
  ok(f.run('cleanup', 'uninstall'));
  assert.equal(fs.existsSync(plist), false);
});

test('generated BEST permissions allow authorized work while FREE and read-only boundaries remain intact', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const rule = (action, effect, resource = '*') => ({ action, resource, effect });
  const best = f.config('best');
  assert.deepEqual(best.permissions.filter((r) => r.action === 'external_directory'), [
    rule('external_directory', 'ask'), ...trustedExternal.map((directory) => rule('external_directory', 'allow', directory)),
  ]);
  assert.deepEqual(f.config('free').permissions, [rule('external_directory', 'ask'), rule('shell', 'ask')]);
  assert.equal(f.config('best').agents.general.permissions, undefined, 'General inherits global rules after native defaults');
  for (const id of ['plan', 'explore', 'reviewer']) {
    const rules = f.config('best').agents[id].permissions;
    assert.ok(rules.some((r) => r.action === '*' && r.effect === 'deny'));
    assert.deepEqual(rules.filter((r) => r.action === 'external_directory'), best.permissions.filter((r) => r.action === 'external_directory'));
    for (const action of ['shell', 'edit', 'subagent', 'serena_replace_symbol_body', 'serena_write_memory', 'serena_delete_memory']) {
      assert.ok(!rules.some((r) => r.action === action && r.effect === 'allow'), `${id}: ${action}`);
    }
    for (const action of ['execute', 'serena_activate_project', 'serena_list_memories', 'serena_read_memory']) {
      assert.ok(rules.some((r) => r.action === action && r.effect === 'allow'), `${id}: ${action}`);
    }
    assert.ok(f.config('free').agents[id].permissions.some((r) => r.action === 'external_directory' && r.effect === 'ask'));
  }
});

test('BEST asks for destructive shell operations and unknown directories without blocking ordinary Git or read-only MCP', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const best = f.config('best');
  // A fixture HOME lives inside the trusted temp root; use a non-temp HOME to
  // check that similarly named directories do not inherit a home exception.
  const home = '/Users/permission-fixture';
  const evaluate = (agent, action, resource, expected) =>
    assert.equal(permissionEffect(best, agent, action, resource, home), expected, `${agent}: ${action} ${resource}`);
  for (const agent of ['build', 'general', 'specialist', 'plan', 'explore', 'reviewer']) {
    const readonly = ['plan', 'explore', 'reviewer'].includes(agent);
    for (const command of ordinaryGit) evaluate(agent, 'shell', command, readonly ? 'deny' : 'allow');
    for (const command of approvalCommands) evaluate(agent, 'shell', command, readonly ? 'deny' : 'ask');
    for (const directory of trustedExternal) evaluate(agent, 'external_directory', directory.replace(/^~/, home), 'allow');
    for (const directory of ['/development/fixture/*', '/etc/*', `${home}/Sites/Github-other/*`,
      path.join(os.tmpdir(), '*'), path.join(fs.realpathSync(os.tmpdir()), 'untrusted', '*')]) {
      evaluate(agent, 'external_directory', directory, 'ask');
    }
    evaluate(agent, 'read', `${home}/Library/LaunchAgents/fixture.plist`, 'allow');
    evaluate(agent, 'edit', `${home}/Library/LaunchAgents/fixture.plist`, 'deny');
    evaluate(agent, 'edit', `${home}/.local/bin/fixture`, readonly ? 'deny' : 'allow');
    for (const action of ['execute', 'serena_activate_project', 'serena_list_memories', 'serena_read_memory']) evaluate(agent, action, '*', 'allow');
    if (readonly) {
      for (const action of ['edit', 'subagent', 'serena_replace_symbol_body', 'serena_write_memory', 'serena_delete_memory']) evaluate(agent, action, 'fixture', 'deny');
    }
  }
});

test('BEST asks before editing credentials and keys while examples and read-only boundaries stay intact', (t) => {
  const f = fixture(t);
  ok(f.run('setup'));
  const best = f.config('best');
  const home = '/Users/permission-fixture';
  const project = `${home}/Sites/Github/fixture`;
  const protectedFiles = ['private.pem', 'private.key', '.env', '.env.production', 'settings.env', 'settings.env.local',
    'auth.json', 'cached-auth.json.backup', 'credentials.json', 'secrets.yaml',
    '.ssh/config', '.aws/config', '.gnupg/gpg.conf', '.netrc'];
  for (const agent of ['build', 'general', 'specialist', 'plan', 'explore', 'reviewer']) {
    const readonly = ['plan', 'explore', 'reviewer'].includes(agent);
    const evaluate = (file, expected) =>
      assert.equal(permissionEffect(best, agent, 'edit', file, home), expected, `${agent}: edit ${file}`);
    for (const file of protectedFiles) {
      evaluate(file, readonly ? 'deny' : 'ask');
      evaluate(`${project}/${file}`, readonly ? 'deny' : 'ask');
    }
    for (const file of ['.ssh/config', '.aws/config', '.gnupg/gpg.conf', '.netrc']) evaluate(`${home}/${file}`, readonly ? 'deny' : 'ask');
    for (const file of ['.env.example', 'settings.env.example', `${project}/.env.example`, `${project}/app.mjs`]) evaluate(file, readonly ? 'deny' : 'allow');
    evaluate(`${home}/Library/LaunchAgents/secrets.plist`, 'deny');
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
        ].map((rule) => ({ ...rule,
          // Session rules bypass config loading, where native V2 expands ~.
          resource: ['external_directory', 'read', 'edit'].includes(rule.action)
            ? rule.resource.replace(/^~(?=\/|$)/, f.home) : rule.resource,
        }));
        sessions.set(agent, api(profile, 'post', '/api/session', {
          title: 'permission regression fixture', location: { directory: f.dir }, permissions,
        }));
      }
      const session = sessions.get(agent);
      const result = api(profile, 'post', `/api/session/${session.id}/permission`, { action, resources: [resource] });
      assert.equal(result.effect, expected, `${profile}/${agent}: ${action} ${resource}`);
    };
    for (const agent of profile === 'best' ? ['build', 'general', 'specialist'] : ['build', 'general']) {
      for (const command of [...commands, ...ordinaryGit]) evaluate(agent, 'shell', command, profile === 'best' ? 'allow' : 'ask');
      for (const command of approvalCommands) evaluate(agent, 'shell', command, 'ask');
      evaluate(agent, 'external_directory', '/development/fixture/*', 'ask');
      for (const directory of trustedExternal) evaluate(agent, 'external_directory', directory.replace(/^~/, f.home), profile === 'best' ? 'allow' : 'ask');
      evaluate(agent, 'read', `${f.home}/Library/LaunchAgents/fixture.plist`, 'allow');
      evaluate(agent, 'edit', `${f.home}/Library/LaunchAgents/fixture.plist`, profile === 'best' ? 'deny' : 'allow');
      evaluate(agent, 'edit', `${f.home}/.local/bin/fixture`, 'allow');
      for (const action of ['read', 'edit', 'skill', 'serena_replace_symbol_body']) evaluate(agent, action, 'fixture', 'allow');
      evaluate(agent, 'read', 'settings.env', profile === 'best' ? 'deny' : 'ask');
      evaluate(agent, 'read', 'settings.env.production', profile === 'best' ? 'deny' : 'ask');
      evaluate(agent, 'read', 'settings.env.example', 'allow');
    }
    evaluate('build', 'edit', `${f.home}/Sites/Github/fixture/private.key`, profile === 'best' ? 'ask' : 'allow');
    evaluate('build', 'edit', `${f.home}/Sites/Github/fixture/.env.example`, 'allow');
    evaluate('build', 'subagent', 'general', 'allow');
    for (const agent of ['plan', 'explore', 'reviewer']) {
      for (const action of ['shell', 'edit', 'subagent', 'serena_replace_symbol_body', 'serena_write_memory', 'serena_delete_memory']) evaluate(agent, action, 'fixture', 'deny');
      for (const command of [ordinaryGit[0], approvalCommands[0]]) evaluate(agent, 'shell', command, 'deny');
      for (const action of ['execute', 'serena_activate_project', 'serena_list_memories', 'serena_read_memory']) evaluate(agent, action, '*', profile === 'best' ? 'allow' : 'deny');
      evaluate(agent, 'serena_find_symbol', '*', 'allow');
      evaluate(agent, 'external_directory', '/development/fixture/*', 'ask');
      for (const directory of trustedExternal) evaluate(agent, 'external_directory', directory.replace(/^~/, f.home), profile === 'best' ? 'allow' : 'ask');
    }
    evaluate('reviewer', 'edit', `${f.home}/Sites/Github/fixture/private.key`, 'deny');
    evaluate('reviewer', 'edit', `${f.home}/Sites/Github/fixture/.env.example`, 'deny');
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
      build: 'openai/gpt-6.1-sol#low', general: 'opencode-go/longcat-2.0',
      explore: 'opencode-go/mimo-v2.6-flash', title: 'openai/gpt-6-luna#low',
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
    assert.ok(!permissions.some((p) => ['shell', 'edit', 'subagent', ...(profile === 'free' ? ['execute'] : [])].includes(p.action) && p.effect === 'allow'));
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
  // external_directory must flow through the shared BEST safety rules.
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
  // BEST globals allow routine shell work and trusted external directories.
  const globals = best.permissions;
  assert.ok(globals.some((r) => r.action === 'shell' && r.effect === 'allow'),
    'BEST globals allow routine shell work for any agent that does not deny it');
  assert.ok(globals.some((r) => r.action === 'external_directory' && r.resource === '*' && r.effect === 'ask'),
    'BEST globals ask for untrusted external directories');
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
  assert.equal(best.agents.general.model, 'opencode-go/longcat-2.0');
  assert.equal(best.agents.explore.model, 'opencode-go/mimo-v2.6-flash');
  assert.equal(best.agents.title.model, 'openai/gpt-6-luna#low');
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
  assert.equal(f.config('best').agents.title.model, 'openai/gpt-6-luna#low');
  assert.equal(f.config('best').agents.summary.model, 'opencode-go/minimax-m3');
  assert.equal(f.config('best').agents.compaction.model, 'opencode-go/minimax-m3');
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
