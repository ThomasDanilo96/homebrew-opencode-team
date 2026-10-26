import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
