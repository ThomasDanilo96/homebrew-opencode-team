import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const script = path.resolve(import.meta.dirname, '../shared/disk-cleanup.sh');

test('safe-only cleanup dry-run and apply preserve protected data, symlinks and active logs', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'safe-caches-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const write = (relative, text = 'keep') => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const old = write('.serena/logs/2000-01-01/old.log');
  const held = write('.serena/logs/2000-01-01/held.log');
  const fresh = write('.serena/logs/2000-01-01/fresh.log');
  const nested = write('.serena/logs/2000-01-01/nested/keep.log');
  const protectedFiles = ['.local/share/opencode/opencode.db', '.local/share/opencode/auth.json',
    '.config/opencode/opencode.jsonc', '.local/state/opencode/session.json',
    '.serena/logs/2000-01-01/auth.json', '.serena/logs/2000-01-01/opencode.db'].map((p) => write(p));
  for (const file of [old, held, nested, ...protectedFiles]) fs.utimesSync(file, 0, 0);
  fs.symlinkSync(fresh, path.join(home, '.serena/logs/2000-01-01/link.log'));
  const chrome = write('Library/Caches/Google/Chrome/cache', 'cache');
  const target = write('precious/file');
  fs.symlinkSync(path.dirname(target), path.join(home, 'Library/Caches/Google/Chrome-headless'));
  for (const [name, body] of Object.entries({
    ps: 'printf "idle\\n"',
    lsof: `printf 'n%s\\n' '${held}'`,
    docker: 'echo "Docker must not run without a local socket" >&2; exit 99',
  })) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = (...args) => spawnSync('/bin/zsh', [script, ...args], {
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, encoding: 'utf8',
  });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY-RUN Serena log/);
  assert.ok(fs.existsSync(old));
  assert.ok(fs.existsSync(chrome));
  const apply = run('--safe-caches-only');
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(chrome), false);
  for (const file of [held, fresh, nested, target, ...protectedFiles]) assert.ok(fs.existsSync(file), file);
  fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const uncertain = write('.serena/logs/2000-01-01/uncertain.log');
  fs.utimesSync(uncertain, 0, 0);
  const failedCheck = run();
  assert.equal(failedCheck.status, 0, failedCheck.stderr);
  assert.match(failedCheck.stdout, /runtime check failed/);
  assert.ok(fs.existsSync(uncertain));
  assert.notEqual(run('--legacy').status, 0);
});

test('Docker cleanup uses only an exact local desktop builder and old build cache (mock CLI and socket)', async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'safe-docker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(home, '.docker/run'), { recursive: true });
  fs.mkdirSync(bin);
  for (const name of ['ps', 'lsof']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf "nfixture\\n"\n', { mode: 0o755 });
  const log = path.join(dir, 'docker-calls');
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify({args:a,env:process.env})+'\\n');
if (a[0] === 'context') console.log(JSON.stringify(process.env.MOCK_REMOTE ? 'ssh://remote' : process.env.DOCKER_HOST));
else if (a[0] === 'buildx') console.log('Name: desktop-linux\\nDriver: docker\\nNodes:\\nName: desktop-linux\\nEndpoint: desktop-linux');
else if (process.env.MOCK_PRUNE_FAIL && a.includes('prune')) process.exit(9);
else console.log('local cache');
`, { mode: 0o755 });
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(home, '.docker/run/docker.sock'), resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    MOCK_DOCKER_LOG: log, DOCKER_HOST: 'ssh://must-not-use', DOCKER_TLS_VERIFY: '1',
    BUILDX_BUILDER: 'remote-builder' };
  const run = (...args) => spawnSync('/bin/zsh', [script, ...args], { env, encoding: 'utf8' });
  const old = path.join(home, '.serena/logs/2000-01-01/after-docker-error.log');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, 'safe old log');
  fs.utimesSync(old, 0, 0);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(run('--dry-run').status, 0);
  assert.ok(calls().every((c) => !c.args.includes('prune')));
  assert.equal(run().status, 0);
  const prune = calls().filter((c) => c.args.includes('prune'));
  assert.deepEqual(prune.map((c) => c.args), [['--context=desktop-linux', 'buildx', '--builder', 'desktop-linux', 'prune', '--force', '--filter', 'until=168h']]);
  assert.ok(calls().every((c) => c.env.DOCKER_HOST === `unix://${home}/.docker/run/docker.sock` && !c.env.DOCKER_TLS_VERIFY && !c.env.BUILDX_BUILDER));
  env.MOCK_REMOTE = '1';
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, 'safe old log');
  fs.utimesSync(old, 0, 0);
  const remote = run();
  assert.equal(remote.status, 1);
  assert.match(remote.stdout, /not the exact local home socket/);
  assert.equal(calls().filter((c) => c.args.includes('prune')).length, 1);
  assert.equal(fs.existsSync(old), false, 'Docker failure must not suppress independent Serena cleanup');
  delete env.MOCK_REMOTE;
  env.MOCK_PRUNE_FAIL = '1';
  assert.equal(run().status, 1, 'prune failure must not report success');
});

test('unsupported Playwright GC preserves revisions without executing registered package code', (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'safe-playwright-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['ps', 'lsof']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf "nfixture\\n"\n', { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const registry = path.join(dir, 'Library/Caches/ms-playwright');
  const packageDir = path.join(dir, 'registered-package');
  fs.mkdirSync(packageDir);
  fs.mkdirSync(path.join(registry, '.links'), { recursive: true });
  fs.writeFileSync(path.join(registry, '.links/package'), packageDir);
  const targets = ['chromium-1', 'chromium_headless_shell-1', 'ffmpeg-1'].map((name) => path.join(registry, name));
  for (const target of targets) {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'INSTALLATION_COMPLETE'), '');
  }
  const log = path.join(dir, 'playwright-calls');
  fs.writeFileSync(path.join(packageDir, 'cli.js'), `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
if (!process.argv.includes('--dry-run')) process.exit(99);
for (const target of ${JSON.stringify(targets)}) console.log('  Install location: '+target);
`);
  const result = spawnSync('/bin/zsh', [script], {
    env: { ...process.env, HOME: dir, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /download-capable install disabled/);
  assert.equal(fs.existsSync(log), false, 'a skipped cleanup must not execute a registered package');
  assert.ok(targets.every((target) => fs.existsSync(path.join(target, 'INSTALLATION_COMPLETE'))));
});
