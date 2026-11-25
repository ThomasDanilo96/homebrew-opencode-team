import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readQuotaState, updateQuotaState } from '../shared/best-quota.mjs';

const WRITERS = 8;
const ITERATIONS = 9;
const ENTRY_CAP = 4096;
const MARKER = 1_000_000_000;
const iso = value => new Date(value).toISOString();

// Only accepted, ordinarily populated fields: no arbitrary padding or real data.
function syntheticState() {
  const now = Date.now() - 1000;
  const connection = 'a'.repeat(64);
  const candidate = { provider: 'openai', model: 'openai/gpt-6.1-sol', agent: 'general' };
  const snapshots = Array.from({ length: ENTRY_CAP }, (_, i) => ({
    provider: 'opencode-go', at: iso(now - (ENTRY_CAP - i) * 60000), source: 'LIVE',
    windows: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((name, j) => [name, {
      used: 20 + i % 60, resetAt: iso(now + [5, 168, 720][j] * 3600000),
    }])), connection,
  }));
  const decisions = Array.from({ length: ENTRY_CAP }, (_, i) => ({
    at: iso(now - (ENTRY_CAP - i) * 60000), kind: 'coding', blocked: false,
    enforced: true, scope: 'admission', reason: 'quota-headroom', candidate,
    switchedAt: iso(now - 3600000), estimatedTaskPercent: 0.25,
    applied: candidate.model,
  }));
  const usage = Array.from({ length: ENTRY_CAP - WRITERS * ITERATIONS }, (_, i) => ({
    at: iso(now - (ENTRY_CAP - i) * 60000), ...candidate,
    durationMs: 100 + i, activityClass: 'coordination-sol-low', variant: 'low',
    input: 2400 + i, output: 600 + i, cacheRead: 1200, cacheWrite: 100,
    requests: 1, retries: 0, kind: 'coding', outcome: 'passed',
  }));
  return { version: 1, policy: { mode: 'active' },
    leases: [{ id: 'existing-admission', provider: 'openai', scope: 'admission', ownerPid: process.pid,
      sessionID: 'existing-session', at: iso(now), expiresAt: iso(now + 900000), percent: 0.5 }],
    snapshots, sources: {
    'opencode-go': { status: 'LIVE', connection, at: iso(now), lastSuccessAt: iso(now) },
  }, decisions, usage };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-contention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'private', 'quota.json');
  const expected = syntheticState();
  await updateQuotaState(file, () => expected);
  // Prove validation neither pruned history nor discarded invented filler.
  assert.deepEqual(readQuotaState(file), expected);
  const bytes = fs.statSync(file).size;
  assert.ok(bytes >= 3_600_000 && bytes <= 4_100_000, `fixture bytes: ${bytes}`);
  return { file, bytes, initialUsage: expected.usage.length, expectedLeases: expected.leases };
}

function instrument(file, current) {
  const originals = Object.fromEntries(
    ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync', 'unlinkSync'].map(key => [key, fs[key]]),
  );
  fs.openSync = function (name, flags, ...args) {
    const metric = current();
    const lock = name === `${file}.lock` && typeof flags === 'number' && (flags & fs.constants.O_EXCL);
    if (lock && metric) metric.lockAttempts++;
    const fd = originals.openSync.call(this, name, flags, ...args);
    if (lock && metric) metric.acquiredAt = performance.now();
    return fd;
  };
  for (const [name, field] of [['writeFileSync', 'writeMs'], ['fsyncSync', 'fsyncMs']]) {
    fs[name] = function (...args) {
      const metric = current();
      const start = performance.now();
      try { return originals[name].apply(this, args); }
      finally {
        if (metric) {
          metric[field] += performance.now() - start;
          metric[name === 'fsyncSync' ? 'fsyncCalls' : 'writeCalls']++;
        }
      }
    };
  }
  fs.renameSync = function (...args) {
    const result = originals.renameSync.apply(this, args);
    if (args[1] === file && current()) current().replacements++;
    return result;
  };
  fs.unlinkSync = function (...args) {
    const result = originals.unlinkSync.apply(this, args);
    if (args[0] === `${file}.lock` && current()) current().releasedAt = performance.now();
    return result;
  };
  return () => Object.assign(fs, originals);
}

function metricFor(noop) {
  return {
    noop, startedAt: performance.now(), acquiredAt: null, callbackAt: null, releasedAt: null,
    lockAttempts: 0, writeCalls: 0, fsyncCalls: 0, replacements: 0, writeMs: 0, fsyncMs: 0,
  };
}

async function writer(file, writerID) {
  let current;
  instrument(file, () => current);
  process.send({ type: 'ready' });
  await new Promise(resolve => process.once('message', resolve));
  const records = [];
  for (let i = 0; i < ITERATIONS; i++) {
    current = metricFor(i % 3 === 2);
    const marker = MARKER + writerID * ITERATIONS + i;
    try {
      // Intentionally use the production default timeout and retry interval.
      await updateQuotaState(file, state => {
        current.callbackAt = performance.now();
        if (!current.noop) state.usage.push({
          at: iso(Date.now()), provider: 'openai', durationMs: marker,
        });
        return state;
      });
      current.success = true;
      if (!current.noop) current.marker = marker;
    } catch (error) {
      // Keep earlier successes and continue measuring subsequent updates.
      current.success = false;
      current.error = error.message;
    }
    current.elapsedMs = performance.now() - current.startedAt;
    current.waitMs = current.acquiredAt === null ? null : current.acquiredAt - current.startedAt;
    current.readMs = current.callbackAt === null ? null : current.callbackAt - current.acquiredAt;
    current.holdMs = current.releasedAt === null ? null : current.releasedAt - current.acquiredAt;
    records.push(current);
  }
  process.send({ type: 'result', records });
  process.disconnect();
}

async function reader(file) {
  process.send({ type: 'ready' });
  await new Promise(resolve => process.once('message', resolve));
  let stopped = false, reads = 0, failures = 0;
  let minUsage = Infinity, maxUsage = 0;
  const errors = new Set();
  process.once('message', () => { stopped = true; });
  while (!stopped) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(state.version, 1);
      assert.equal(state.snapshots.length, ENTRY_CAP);
      assert.equal(state.decisions.length, ENTRY_CAP);
      assert.ok(Array.isArray(state.usage));
      minUsage = Math.min(minUsage, state.usage.length);
      maxUsage = Math.max(maxUsage, state.usage.length);
      reads++;
    } catch (error) {
      failures++;
      errors.add(error.message);
    }
    // Yield for IPC, not to manufacture lock hold time or deadline failures.
    await new Promise(resolve => setImmediate(resolve));
  }
  process.send({ type: 'result', reads, failures, errors: [...errors], minUsage, maxUsage });
  process.disconnect();
}

function child(t, mode, file, index = 0) {
  const process = fork(fileURLToPath(import.meta.url), [mode, file, String(index)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', result;
  process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  t.after(() => { if (process.exitCode === null) process.kill(); });
  const ready = new Promise((resolve, reject) => {
    process.on('message', message => {
      if (message.type === 'ready') resolve();
      if (message.type === 'result') result = message;
    });
    process.once('error', reject);
    process.once('close', code => reject(new Error(`child closed before ready: ${code} ${stderr}`)));
  });
  const done = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', code => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`child exit ${code}: ${stderr || 'missing metrics'}`));
    });
  });
  // Register handlers immediately even when startup fails before ready.
  done.catch(() => {});
  return { ready, done, send: message => process.send(message) };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const rounded = value => Math.round(value * 100) / 100;
  return {
    count: sorted.length,
    p50: rounded(sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0),
    p95: rounded(sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

if (process.argv[2] === '--quota-writer') {
  await writer(process.argv[3], Number(process.argv[4]));
} else if (process.argv[2] === '--quota-reader') {
  await reader(process.argv[3]);
} else {
  test('unchanged quota updates do not replace the state inode or fsync', { timeout: 15000 }, async t => {
    const { file, bytes } = await fixture(t);
    const before = fs.statSync(file);
    const original = fs.readFileSync(file, 'utf8');
    let current;
    const restore = instrument(file, () => current);
    const records = [];
    try {
      for (const callback of [state => state, state => structuredClone(state), state => ({ ...state })]) {
        current = metricFor(true);
        await updateQuotaState(file, state => {
          current.callbackAt = performance.now();
          return callback(state);
        });
        records.push(current);
      }
    } finally { restore(); }
    const after = fs.statSync(file);
    const replacements = records.reduce((sum, record) => sum + record.replacements, 0);
    const fsyncCalls = records.reduce((sum, record) => sum + record.fsyncCalls, 0);
    t.diagnostic(JSON.stringify({
      fixtureBytes: bytes, noopUpdates: records.length, replacements, fsyncCalls,
      unchangedInode: before.ino === after.ino,
      holdMs: distribution(records.map(record => record.releasedAt - record.acquiredAt)),
    }));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual({ replacements, fsyncCalls, inode: after.ino }, {
      replacements: 0, fsyncCalls: 0, inode: before.ino,
    });
  });

  test('realistic contention preserves every default-timeout update and atomic JSON reads', { timeout: 30000 }, async t => {
    const { file, bytes, initialUsage, expectedLeases } = await fixture(t);
    const observer = child(t, '--quota-reader', file);
    const writers = Array.from({ length: WRITERS }, (_, i) => child(t, '--quota-writer', file, i));
    await Promise.all([observer.ready, ...writers.map(writer => writer.ready)]);
    const start = performance.now();
    observer.send('start');
    for (const writer of writers) writer.send('start');
    const results = await Promise.all(writers.map(writer => writer.done));
    const elapsedMs = performance.now() - start;
    observer.send('stop');
    const observed = await observer.done;
    const records = results.flatMap(result => result.records);
    const successes = records.filter(record => record.success);
    const errors = records.filter(record => !record.success);
    const mutations = successes.filter(record => !record.noop);
    const noops = successes.filter(record => record.noop);
    const finalState = readQuotaState(file);
    const persisted = finalState.usage;
    const actualMarkers = persisted.filter(entry => entry.durationMs >= MARKER).map(entry => entry.durationMs);
    const expectedMarkers = mutations.map(record => record.marker);
    t.diagnostic(JSON.stringify({
      fixtureBytes: bytes, writers: WRITERS, iterations: ITERATIONS,
      elapsedMs: Math.round(elapsedMs), attempted: records.length, successes: successes.length,
      failures: errors.length, errors: [...new Set(errors.map(record => record.error))],
      mutations: mutations.length, noops: noops.length,
      noopReplacements: noops.reduce((sum, record) => sum + record.replacements, 0),
      replacements: records.reduce((sum, record) => sum + record.replacements, 0),
      fsyncCalls: records.reduce((sum, record) => sum + record.fsyncCalls, 0),
      updatesPerSecond: Math.round(successes.length / elapsedMs * 1000 * 100) / 100,
      waitMs: distribution(records.map(record => record.waitMs)),
      callbackEntryMs: distribution(records.map(record => record.callbackAt === null ? null : record.callbackAt - record.startedAt)),
      readMs: distribution(records.map(record => record.readMs)),
      holdMs: distribution(records.map(record => record.holdMs)),
      writeMs: distribution(successes.map(record => record.writeMs)),
      fsyncMs: distribution(successes.map(record => record.fsyncMs)),
      lockAttempts: records.reduce((sum, record) => sum + record.lockAttempts, 0),
      reader: observed,
    }));
    // First retain evidence of successful writes even when the timeout regression is RED.
    assert.deepEqual(actualMarkers.sort((a, b) => a - b), expectedMarkers.sort((a, b) => a - b));
    assert.equal(persisted.length, initialUsage + mutations.length);
    assert.deepEqual(finalState.policy, { mode: 'active' });
    assert.deepEqual(finalState.leases, expectedLeases);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(observed.reads > 0, 'reader must sample during writer activity');
    assert.equal(observed.failures, 0, JSON.stringify(observed.errors));
    assert.ok(observed.maxUsage > observed.minUsage, 'reader must observe replaced snapshots');
    assert.equal(errors.length, 0, `${errors.length}/${records.length} default-timeout updates failed`);
    assert.equal(mutations.length, WRITERS * (ITERATIONS - ITERATIONS / 3));
  });
}
