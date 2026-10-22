import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
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
  assert.deepEqual(fs.readdirSync(path.join(temp, 'libexec/tests')).sort(), ['native-profiles.test.mjs', 'setup-smoke.sh']);
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
  const publishedVersion = '0.3.1';
  const oldURL = `https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v${publishedVersion}.tar.gz`;
  const oldSHA = '913459f53bfdfba5a3bfb3f498f320aa085576e0785e1865de775a84d1fa93be';
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
  const args = [path.join(root, '.github/scripts/render-staging-formula.rb'), formula, output,
    'OpencodeTeamStaging', version, 'file:///candidate.tar.gz', 'a'.repeat(64)];
  const valid = spawnSync('ruby', args, { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /class OpencodeTeamStaging < Formula/);
  args[args.length - 1] = 'not-a-checksum';
  const invalid = spawnSync('ruby', args, { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid SHA-256/);
  assert.equal(fs.readFileSync(formula, 'utf8'), source);
});
