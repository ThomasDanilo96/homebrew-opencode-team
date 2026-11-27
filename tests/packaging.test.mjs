import './guardrail/assert-isolated.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
function runtimeFixture(temp) {
  const dir = path.join(temp, 'runtime-assets');
  fs.mkdirSync(dir);
  const asset = path.join(dir, 'opencode-team-runtime-2.3.2-darwin-arm64.tar.gz');
  const bytes = Buffer.from('locked runtime fixture');
  fs.writeFileSync(asset, bytes);
  const lock = path.join(dir, 'runtime-lock.json');
  fs.writeFileSync(lock, JSON.stringify({ 'darwin-arm64': {
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  } }));
  return { dir, lock, asset };
}
test('source Homebrew formula installs a working portable launcher without obsolete assets', (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'team-formula-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const mock = `require 'pathname'
require 'fileutils'
class Pathname
  def install(*sources)
    mkpath
    sources.each { |source| FileUtils.cp_r(source, self.to_s) }
  end
end
class Formula
  def self.method_missing(*); nil; end
  def self.test(&block); end
  def self.depends_on(name)
    (@dependencies ||= []) << name
  end
  def self.dependencies; @dependencies; end
  def bin; Pathname.new(ENV.fetch('MOCK_PREFIX'))/'bin'; end
  def libexec; Pathname.new(ENV.fetch('MOCK_PREFIX'))/'libexec'; end
  def zsh_completion; Pathname.new(ENV.fetch('MOCK_PREFIX'))/'share/zsh/site-functions'; end
  def opt_prefix; Pathname.new(ENV.fetch('MOCK_PREFIX')); end
  def formula_opt_bin(*); File.dirname(ENV.fetch('MOCK_NODE')); end
  def chmod(mode, file); File.chmod(mode, file); end
end
load ARGV.fetch(0)
abort 'unexpected dependencies' unless OpencodeTeam.dependencies.sort == ['git','node@22','uv'].sort
formula = OpencodeTeam.new
formula.bin.mkpath
formula.install
`;
  const result = spawnSync('ruby', ['-e', mock, path.join(root, 'Formula/opencode-team.rb')], {
    cwd: root, env: { ...process.env, MOCK_PREFIX: temp, MOCK_NODE: process.execPath }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const launcher = path.join(temp, 'bin/opencode-team');
  const version = spawnSync(launcher, ['version'], { cwd: temp, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `OpenCode Team ${fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()}`);
  for (const legacy of ['core', 'teams', 'benchmarks']) assert.equal(fs.existsSync(path.join(temp, 'libexec', legacy)), false);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'bin')), ['opencode-team']);
  assert.ok(fs.existsSync(path.join(temp, 'share/zsh/site-functions/_opencode-team')));
  assert.equal(fs.readFileSync(path.join(temp, 'libexec/shared/disk-cleanup.sh'), 'utf8'),
    fs.readFileSync(path.join(root, 'shared/disk-cleanup.sh'), 'utf8'));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/shared/maintenance.py')));
  assert.deepEqual(fs.readdirSync(path.join(temp, 'libexec/tests')).sort(),
    [...fs.readdirSync(path.join(root, 'tests')).filter(name => /\.(?:mjs|py|sh)$/.test(name) || name === 'README.md'), 'guardrail'].sort());
  assert.ok(fs.existsSync(path.join(temp, 'libexec/tests/guardrail/runner.sh')));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/shared/best-quota-plugin/index.js')));
  const quota = spawnSync(launcher, ['best', 'quota', 'status'], {
    cwd: temp, encoding: 'utf8', env: { ...process.env, OPENCODE_TEAM_HOME: path.join(temp, 'isolated-team') },
  });
  assert.equal(quota.status, 0, quota.stderr);
  assert.equal(JSON.parse(quota.stdout).mode, 'monitor', 'uninitialized governor observes but never silently activates');
  assert.equal(fs.readFileSync(path.join(temp, 'libexec/shared/skills/documentation-lookup.md'), 'utf8'),
    fs.readFileSync(path.join(root, 'shared/skills/documentation-lookup.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(temp, 'libexec/shared/skills/release-preparation.md'), 'utf8'),
    fs.readFileSync(path.join(root, 'shared/skills/release-preparation.md'), 'utf8'));
});

test('zsh completion registers only the supported launcher and offers only best/free profiles', () => {
  const script = [
    'fpath=("$1/completions" $fpath)',
    'autoload -Uz compinit',
    'compinit -i -D',
    'print -r -- "${_comps[opencode-team]:-missing}"',
    'source "$1/completions/_opencode-team"',
    '_arguments() { if [[ "$*" == *"->profile"* ]]; then state=profile; else state=command; fi; }',
    '_describe() { local -a items; eval "items=(\\\"\\${${2}[@]}\\\")"; print -rl -- "${items[@]}"; }',
    'words=(opencode-team start b); CURRENT=3; _opencode-team',
  ].join('\n');
  const result = spawnSync('zsh', ['-f', '-c', script, 'zsh', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /_opencode-team/);
  assert.match(result.stdout, /best:/);
  assert.match(result.stdout, /free:/);
  assert.doesNotMatch(result.stdout, /daily:|go:|openai:|best-ecc:|best-native:/);
});

test('published archive identity stays immutable while candidate versions can advance; staging stays confined', (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'team-staging-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const formula = path.join(root, 'Formula/opencode-team.rb');
  const source = fs.readFileSync(formula, 'utf8');
  const url = source.match(/^  url "([^"]+)"$/m)[1];
  const sha = source.match(/^  sha256 "([0-9a-f]{64})"$/m)[1];
  // Pin the published archive, not HEAD: CI must not compare a commit to itself.
  const publishedVersion = '0.3.12';
  const oldURL = `https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v${publishedVersion}.tar.gz`;
  const oldSHA = '4a14454ca2b05ecfccc3737d7d81afa1c5a7b92a8a456bb87de872cfd65d01bc';
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const compare = (a, b) => a.split('.').reduce((order, part, i) => order || Math.sign(Number(part) - Number(b.split('.')[i])), 0);
  assert.ok(compare(version, publishedVersion) >= 0, 'candidate must not predate the published release');
  const archiveVersion = url.match(/\/archive\/refs\/tags\/v(\d+\.\d+\.\d+)\.tar\.gz$/)[1];
  assert.ok(compare(version, archiveVersion) >= 0, 'stable metadata may lag an unpublished candidate, never lead it');
  const assertPublishedChecksum = (archiveURL, checksum) => {
    if (archiveURL === oldURL) assert.equal(checksum, oldSHA, 'never rewrite the checksum of an existing archive');
  };
  assert.throws(() => assertPublishedChecksum(oldURL, 'a'.repeat(64)), /never rewrite/);
  assertPublishedChecksum(url, sha);
  if (url !== oldURL) {
    assert.equal(url, `https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v${version}.tar.gz`);
    assert.ok(compare(version, oldURL.match(/\/v(\d+\.\d+\.\d+)\.tar\.gz$/)[1]) > 0);
    assert.notEqual(sha, oldSHA, 'a new VERSION changes the archive contents');
  }
  const output = path.join(temp, 'formula.rb');
  const assets = runtimeFixture(temp);
  const args = [path.join(root, '.github/scripts/render-staging-formula.rb'), '--runtime', formula, output,
    'OpencodeTeamStaging', version, 'file:///candidate.tar.gz', 'a'.repeat(64), assets.lock, assets.dir];
  const valid = spawnSync('ruby', args, { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /class OpencodeTeamStaging < Formula/);
  args[7] = 'not-a-checksum';
  const invalid = spawnSync('ruby', args, { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid SHA-256/);
  assert.equal(fs.readFileSync(formula, 'utf8'), source);
});

test('staging candidate installs guarded test surface and runs installed smoke within sandbox', (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'team-staging-install-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const formula = path.join(root, 'Formula/opencode-team.rb');
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const output = path.join(temp, 'staging.rb');
  const assets = runtimeFixture(temp);
  const args = [path.join(root, '.github/scripts/render-staging-formula.rb'), '--runtime', formula, output,
    'OpencodeTeamStaging', version, 'file:///candidate.tar.gz', 'a'.repeat(64), assets.lock, assets.dir];
  const render = spawnSync('ruby', args, { encoding: 'utf8' });
  assert.equal(render.status, 0, render.stderr);
  const rendered = fs.readFileSync(output, 'utf8');
  assert.match(rendered, /class OpencodeTeamStaging < Formula/);
  assert.ok(!rendered.includes('system "bash", libexec/"tests/setup-smoke.sh"'),
    'staging test block must not call setup-smoke.sh directly');
  assert.ok(!rendered.includes('system "bash", libexec/"tests/guardrail/runner.sh"'),
    'brew test already applies a sandbox; guarded smoke must run separately, not nest Seatbelt');
  assert.ok(rendered.includes('assert_predicate libexec/"tests/guardrail/runner.sh", :executable?'));
  assert.match(rendered, /test_isolation\.py/);
  assert.match(rendered, /\.github/);
  assert.match(rendered, /tests\/guardrail/);
  assert.match(rendered, /b92f181b3b748d1abbc2afd94af6aa7d8c8fca29/);
  const mock = `require 'pathname'
require 'fileutils'
class Pathname
  def install(*sources)
    mkpath
    sources.each do |source|
      if source.is_a?(Array)
        source.each { |s| FileUtils.cp_r(s, self.to_s) }
      else
        FileUtils.cp_r(source, self.to_s)
      end
    end
  end
end
class Formula
  def self.method_missing(*); nil; end
  def self.test(&block); end
  def self.depends_on(name)
    (@dependencies ||= []) << name
  end
  def self.dependencies; @dependencies; end
  def bin; Pathname.new(ENV.fetch('MOCK_PREFIX'))/'bin'; end
  def libexec; Pathname.new(ENV.fetch('MOCK_PREFIX'))/'libexec'; end
  def zsh_completion; Pathname.new(ENV.fetch('MOCK_PREFIX'))/'share/zsh/site-functions'; end
  def opt_prefix; Pathname.new(ENV.fetch('MOCK_PREFIX')); end
  def version; "0.3.13"; end
  def resources; ENV["MOCK_RUNTIME"] ? [Struct.new(:name).new("team-runtime")] : []; end
  def resource(name); self; end
  def stage(&block); Dir.chdir(ENV.fetch("MOCK_RUNTIME"), &block); end
  def odie(message); abort message; end
  def formula_opt_bin(*); File.dirname(ENV.fetch('MOCK_NODE')); end
  def chmod(mode, file); File.chmod(mode, file); end
end
load ARGV.fetch(0)
abort 'unexpected dependencies' unless OpencodeTeamStaging.dependencies.sort == ['git','node@22','uv'].sort
formula = OpencodeTeamStaging.new
formula.bin.mkpath
formula.install
`;
  const env = { ...process.env, MOCK_PREFIX: temp, MOCK_NODE: process.execPath };
  const unguarded = spawnSync('ruby', ['-e', mock, output], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(unguarded.status, 0);
  assert.match(unguarded.stderr, /No checksum-locked Session Guard runtime/);
  const runtime = path.join(temp, 'fixture-runtime');
  fs.mkdirSync(runtime);
  for (const file of ['opencode', 'manifest.json', 'LICENSE']) fs.writeFileSync(path.join(runtime, file), file);
  const result = spawnSync('ruby', ['-e', mock, output], {
    cwd: root, env: { ...env, MOCK_RUNTIME: runtime }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(temp, 'libexec/tests/guardrail/runner.sh')));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/tests/guardrail/assert-isolated.mjs')));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/tests/guardrail/profile.sb')));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/tests/test_isolation.py')));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/tests/native-profiles.test.mjs')));
  assert.ok(fs.existsSync(path.join(temp, 'libexec/.github/scripts/render-staging-formula.rb')));
  assert.equal(fs.existsSync(path.join(temp, 'libexec/best-quota-native.test.mjs')), false,
    'staging must not misplace a continued formula install argument into libexec root');
  const launcher = path.join(temp, 'bin/opencode-team');
  assert.equal(fs.readFileSync(path.join(temp, 'libexec/.requires-session-guard'), 'utf8'), `${path.join(temp, 'libexec')}\n`);
  assert.equal(fs.readFileSync(path.join(temp, 'libexec/runtime/opencode'), 'utf8'), 'opencode');
  const v = spawnSync(launcher, ['version'], { cwd: temp, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), `OpenCode Team ${version}`);
  assert.equal(fs.readFileSync(path.join(temp, 'libexec/shared/ecc.lock'), 'utf8').trim(),
    'b92f181b3b748d1abbc2afd94af6aa7d8c8fca29');
  assert.deepEqual(fs.readFileSync(path.join(temp, 'libexec/shared/maintenance.py')),
    fs.readFileSync(path.join(root, 'shared/maintenance.py')));
  const installed = path.join(temp, 'libexec');
  for (const name of ['home', 'team', 'tmp']) fs.mkdirSync(path.join(installed, name));
  // Already inside the runner's kernel sandbox: macOS rejects sandbox_apply
  // nesting. Exercise installed tests under that existing boundary, not a bypass.
  const smoke = spawnSync('bash', [path.join(installed, 'tests/setup-smoke.sh')],
    { cwd: installed, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, OPENCODE_TEAM_STAGING_ROOT: installed,
        HOME: path.join(installed, 'home'), OPENCODE_TEAM_HOME: path.join(installed, 'team'),
        TMPDIR: path.join(installed, 'tmp') } });
  assert.equal(smoke.status, 0, smoke.stderr + smoke.stdout);
  assert.match(smoke.stdout, /PACKAGING CONFIG SMOKE PASS/);
});

test('runtime formula validates local resources and requires a complete platform lock for stable promotion', (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'team-runtime-formula-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const lock = path.join(temp, 'runtime-lock.json');
  const asset = path.join(temp, 'opencode-team-runtime-2.3.2-darwin-arm64.tar.gz');
  const output = path.join(temp, 'formula.rb');
  const bytes = Buffer.from('runtime fixture');
  fs.writeFileSync(asset, bytes);
  const entry = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const writeLock = (targets) => fs.writeFileSync(lock, JSON.stringify(Object.fromEntries(targets.map((target) => [target, entry]))));
  const render = (...extra) => spawnSync('ruby', [path.join(root, '.github/scripts/render-staging-formula.rb'),
    '--runtime', path.join(root, 'Formula/opencode-team.rb'), output, 'OpencodeTeam', '0.3.13',
    'file:///candidate.tar.gz', 'a'.repeat(64), lock, ...extra], { encoding: 'utf8' });
  writeLock(['darwin-arm64']);
  assert.equal(render(temp).status, 0);
  assert.match(fs.readFileSync(output, 'utf8'), /on_macos do[\s\S]+on_arm do[\s\S]+resource "team-runtime"/);
  assert.match(render().stderr, /requires all runtime targets/);
  fs.appendFileSync(asset, 'changed');
  assert.match(render(temp).stderr, /runtime asset mismatch/);
  writeLock(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64-baseline']);
  assert.equal(render().status, 0);
  assert.equal((fs.readFileSync(output, 'utf8').match(/resource "team-runtime"/g) ?? []).length, 4);
});

test('release handoff binds archive, commit, source and complete operational instructions', t => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'release-handoff-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source with spaces');
  fs.mkdirSync(source);
  for (const name of ['bin', 'shared', 'tests', 'Formula', 'completions', '.github', 'VERSION']) {
    fs.cpSync(path.join(root, name), path.join(source, name), { recursive: true });
  }
  const git = args => {
    const r = spawnSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr.toString());
    return r.stdout;
  };
  git(['init', '-b', 'master']);
  git(['add', '.']);
  git(['commit', '-m', 'Frozen packaging fixture']);
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  const archive = path.join(temp, 'candidate.tar.gz');
  fs.writeFileSync(archive, git(['archive', '--format=tar.gz', '--prefix=candidate/', commit]));
  const bundle = path.join(temp, 'handoff with spaces');
  const renderer = path.join(root, '.github/scripts/render-staging-formula.rb');
  const assets = runtimeFixture(temp);
  const prepare = spawnSync('ruby', [renderer, '--handoff', archive, commit, source, bundle, assets.dir], { encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  const partial = path.join(temp, 'incomplete.tar.gz');
  fs.writeFileSync(partial, git(['archive', '--format=tar.gz', '--prefix=candidate/', commit,
    'VERSION', 'Formula', '.github', 'tests']));
  const incompleteTree = spawnSync('ruby', [renderer, '--handoff', partial, commit, source,
    path.join(temp, 'partial handoff')], { encoding: 'utf8' });
  assert.match(incompleteTree.stderr, /ARCHIVE_TREE_MISMATCH/, 'a valid commit header does not prove a complete payload');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'release.json'), 'utf8'));
  const verify = (sha = manifest.archive_sha256, ref = commit, tree = source) =>
    spawnSync('ruby', [renderer, '--verify', bundle, ref, sha, tree], { encoding: 'utf8' });
  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);
  const originalAsset = fs.readFileSync(assets.asset);
  fs.appendFileSync(assets.asset, 'swapped runtime');
  assert.match(verify().stderr, /runtime asset mismatch/);
  fs.writeFileSync(assets.asset, originalAsset);
  assert.match(valid.stdout, /HANDOFF_VALID/);
  assert.doesNotMatch(valid.stdout, /RELEASE_PREPARATION=PASS/, 'identity alone is not packaging completion');
  assert.match(fs.readFileSync(path.join(bundle, 'OPERATIONS.md'), 'utf8'), new RegExp(commit));
  assert.match(fs.readFileSync(path.join(bundle, 'OPERATIONS.md'), 'utf8'), new RegExp(manifest.archive_sha256));
  const relative = spawnSync('ruby', [renderer, '--verify', path.basename(bundle), commit, manifest.archive_sha256, source],
    { cwd: temp, encoding: 'utf8' });
  assert.equal(relative.status, 0, relative.stderr);
  const instructionsFile = path.join(bundle, 'OPERATIONS.md');
  const operations = fs.readFileSync(instructionsFile, 'utf8');
  const install = [...operations.matchAll(/```sh\n([\s\S]*?)\n```/g)].at(-1)[1];
  const mockBin = path.join(temp, 'mock-bin');
  fs.mkdirSync(mockBin);
  const marker = path.join(temp, 'brew-called');
  const calls = path.join(temp, 'brew-calls');
  fs.writeFileSync(path.join(mockBin, 'brew'), `#!/bin/sh
set -eu
case "$*" in
  'tap-new --no-git opencode-team/staging')
    test ! -e "$MOCK_TAP"
    mkdir -p "$MOCK_TAP/Formula"
    printf 'tap-new\\n' >> "$BREW_CALLS" ;;
  '--repo opencode-team/staging')
    test -d "$MOCK_TAP"
    printf 'repo\\n' >> "$BREW_CALLS"
    printf '%s\\n' "$MOCK_TAP" ;;
  'install --formula opencode-team/staging/opencode-team-staging')
    cmp "$EXPECTED_FORMULA" "$MOCK_TAP/Formula/opencode-team-staging.rb"
    printf 'install\\n' >> "$BREW_CALLS"
    : > "$BREW_CALLED" ;;
  *) exit 86 ;;
esac
`, { mode: 0o755 });
  const runInstall = () => spawnSync('/bin/sh', ['-c', install], { encoding: 'utf8',
    env: { ...process.env, PATH: `${mockBin}:${process.env.PATH}`, BREW_CALLED: marker,
      BREW_CALLS: calls, MOCK_TAP: path.join(temp, 'temporary tap'),
      EXPECTED_FORMULA: path.join(bundle, 'opencode-team-staging.rb') } });
  const installed = runInstall();
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(fs.existsSync(marker), 'the complete validated command reaches only the mocked installer');
  assert.equal(fs.readFileSync(calls, 'utf8'), 'tap-new\nrepo\ninstall\n');
  fs.unlinkSync(marker);
  const verifierFile = path.join(bundle, 'verify-release.rb');
  const verifierBytes = fs.readFileSync(verifierFile);
  fs.writeFileSync(verifierFile, 'exit 0\n');
  fs.appendFileSync(path.join(bundle, 'archive.tar.gz'), 'wrong archive');
  assert.notEqual(runInstall().status, 0, 'the real generated command must authenticate its verifier before execution');
  assert.equal(fs.existsSync(marker), false, 'a replaced verifier must not allow installation of another archive');
  assert.equal(fs.readFileSync(calls, 'utf8'), 'tap-new\nrepo\ninstall\n', 'integrity failure precedes every Homebrew mutation');
  fs.writeFileSync(verifierFile, verifierBytes);
  fs.copyFileSync(archive, path.join(bundle, 'archive.tar.gz'));
  const substituted = { ...manifest, source: `${source}-substituted` };
  fs.writeFileSync(path.join(bundle, 'release.json'), JSON.stringify(substituted));
  fs.writeFileSync(instructionsFile, operations.replaceAll(source.replaceAll(' ', '\\ '),
    substituted.source.replaceAll(' ', '\\ ')));
  assert.match(verify().stderr, /HANDOFF_SOURCE_MISMATCH/);
  fs.writeFileSync(path.join(bundle, 'release.json'), JSON.stringify(manifest));
  fs.writeFileSync(instructionsFile, operations);
  assert.notEqual(verify('a'.repeat(64)).status, 0, 'a command pinned to another archive must fail');
  assert.notEqual(verify(undefined, 'a'.repeat(40)).status, 0, 'a command pinned to another commit must fail');
  const bundledArchive = path.join(bundle, 'archive.tar.gz');
  fs.appendFileSync(bundledArchive, 'tamper');
  assert.match(verify().stderr, /ARCHIVE_SHA256_MISMATCH/);
  assert.notEqual(runInstall().status, 0, 'the generated install command refuses a different archive');
  assert.equal(fs.existsSync(marker), false);
  fs.copyFileSync(archive, bundledArchive);
  const code = path.join(source, 'shared/profiles.mjs');
  const before = fs.readFileSync(code);
  fs.appendFileSync(code, '\n// fixture drift\n');
  assert.match(verify().stderr, /SOURCE_MISMATCH/);
  fs.writeFileSync(code, before);
  const instructions = path.join(bundle, 'OPERATIONS.md');
  const text = fs.readFileSync(instructions);
  fs.unlinkSync(instructions);
  assert.match(verify().stderr, /MISSING_HANDOFF_FILE.*OPERATIONS/);
  const incomplete = spawnSync('bash', [path.join(root, 'tests/guardrail/runner.sh'), 'packaging',
    bundle, commit, manifest.archive_sha256], { encoding: 'utf8' });
  assert.notEqual(incomplete.status, 0);
  assert.doesNotMatch(incomplete.stdout, /RELEASE_PREPARATION=PASS|Isolation negative-control suite/);
  fs.writeFileSync(instructions, text);
  fs.unlinkSync(path.join(bundle, 'opencode-team-staging.rb'));
  assert.match(verify().stderr, /MISSING_HANDOFF_FILE.*opencode-team-staging/);
  assert.equal(fs.existsSync(path.join(temp, 'installed.marker')), false, 'handoff generation never installs');
});
