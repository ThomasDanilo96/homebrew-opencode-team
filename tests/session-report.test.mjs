import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerReport } from '../shared/session-report/report.mjs';

const text = (value) => ({ type: 'text', text: value });
const shell = (command, exit, output = '') => ({
  type: 'tool', name: 'shell', executed: false, state: {
    status: 'completed', input: { command }, metadata: { exit },
    content: [text(output)],
  },
});
const sha = '0123456789abcdef0123456789abcdef01234567';

function fixture({ fromChild = false, failCopy = false, checkpoints = {}, confirmed = true } = {}) {
  const children = [
    { id: 'done', agent: 'reviewer', title: 'Review error handling', outcome: 'succeeded' },
    { id: 'busy', agent: 'general', title: 'Check packaging', outcome: 'succeeded' },
    { id: 'new', agent: 'explore', title: 'Inspect routes', outcome: 'failed' },
  ];
  let layer;
  const copies = [], toasts = [], calls = [];
  const updates = { active: true, exit: null, failCopy, treeStatus: 'modified' };
  const record = (id, created, message) => ({ id, time: { created, completed: created }, ...message });
  const ctx = {
    ui: { router: { current: () => ({ type: 'session', sessionID: fromChild ? 'done' : 'root' }) },
      toast: { show: (toast) => toasts.push(toast) } },
    keymap: { layer: (create) => { layer = create; } },
    client: {
      session: {
        get: async ({ sessionID }) => sessionID === 'root' ?
          { id: 'root', outcome: 'succeeded', location: { directory: '/fixture/repo' } } : { parentID: 'root' },
        list: async (input) => ({ data: input.parentID === 'root' ? children : [], cursor: {} }),
        active: async () => updates.active ? { busy: { type: 'running' } } : {},
      },
      permission: { list: async () => [{ action: 'shell', resources: ['DO_NOT_COPY'] }] },
      vcs: { get: async () => ({ data: { branch: { current: 'master' } } }),
        status: async () => ({ data: [{ file: 'README.md', status: updates.treeStatus }] }) },
      message: { list: async ({ sessionID, type, order }) => {
        calls.push(sessionID);
        if (type === 'user') return { data: order === 'asc' ?
          [record('old', 1, { type: 'user', text: 'Incarico precedente da inventariare.' })] :
          [record('current', 10, { type: 'user', text: 'Correggi la verifica locale.\npassword: hidden-multiline' })] };
        if (sessionID !== 'root') return { data: sessionID === 'new' ? [record('bad', 15, { type: 'idle', outcome: 'failed' })] : [
          record('reply', 16, { type: 'assistant', agent: sessionID === 'done' ? 'reviewer' : 'general',
            model: { providerID: 'openai', id: 'test-model', variant: 'medium' }, tokens: { input: 5, cache: { read: 2 } },
            content: [text(sessionID === 'done' ? 'Nessun rilievo.' : 'Vecchia risposta.')] }),
        ] };
        return { cursor: {}, data: [record('out', 20, { type: 'assistant', snapshot: { files: ['shared/example.mjs', '.env', 'private.pem'] }, content: [
          shell('node --test tests/report.test.mjs', 0, 'DO_NOT_COPY\nPASS'),
          shell('pytest tests/test_report.py', 1),
          shell('npm test && deploy', 0),
          shell('pytest --version', 0),
          shell('bash tests/guardrail/runner.sh packaging', 0),
          shell('node --test tests/skipped.test.mjs', 0, '# tests 1\n# skipped 1\n'),
          shell('shasum -a 256 package.json', 0, `${'a'.repeat(64)}  package.json\n`),
          shell('git rev-parse --verify HEAD', 0, `${sha}\n`),
          shell('git commit -m example', 0, '[master abcdef0] example'),
          shell('git commit -m example', 0, 'untrusted abcdef1\n'),
          text('Risultato: Validazione corretta.\nBloccato: manca accesso allo staging.\nGO mancante: approvazione deploy.\nProssimo passo: chiedere approvazione al responsabile.'),
          text('Risultato: Authorization: Bearer custom-secret'),
          text('Completato: https://user:pass@example.test/path'),
          text('Bloccato: token: short-value'),
          text('Errore: DB_PASSWORD=shorter-value'),
          text('Aperto: chiave `sk-proj-abcdef1234567890`'),
          { ...shell('bun test tests/later.test.mjs', updates.exit), id: 'later',
            state: { status: updates.exit === null ? 'running' : 'completed',
              input: { command: 'bun test tests/later.test.mjs' }, metadata: { exit: updates.exit } } },
          { ...shell('unsupported command', updates.exit), id: 'unlisted',
            state: { status: updates.exit === null ? 'running' : 'completed',
              input: { command: 'unsupported command' }, metadata: { exit: updates.exit } } },
        ] }),
        record('resume', 17, { type: 'synthetic', text: 'NOT A USER MANDATE' }),
        record('compact', 13, { type: 'compaction', status: 'completed', summary: 'DO_NOT_COPY' }),
        record('current', 10, { type: 'user', text: 'Correggi la verifica locale.\npassword: hidden-multiline' }),
        record('old', 1, { type: 'user', text: 'Incarico precedente da inventariare.' })] };
      } },
    },
  };
  registerReport(ctx, async (value) => {
    if (updates.failCopy) throw new Error('clipboard detail DO_NOT_COPY');
    copies.push(value);
    return confirmed;
  }, { profile: 'best', checkpoints, saveCheckpoint: async (id, value) => { checkpoints[id] = value; } });
  const commands = Object.fromEntries(layer().commands.map((command) => [command.slash.name, command]));
  return { command: commands.handoff, commands, copies, toasts, calls, updates, checkpoints };
}

test('copies the parent objective and native file, commit, test and approval evidence', async () => {
  const { command, copies, toasts } = fixture();
  assert.equal(command.palette, true);
  assert.match(command.title, /AI Handoff/);
  assert.ok(command.slash.aliases.includes('copia-resoconto'));
  await command.run();
  assert.equal(copies.length, 1);
  for (const value of ['Correggi la verifica locale.', 'Validazione corretta.', 'shared/example.mjs',
    sha, 'abcdef0', 'node --test tests/report.test.mjs', 'PASS', 'pytest tests/test_report.py', 'FAIL',
    'manca accesso allo staging.', 'approvazione deploy.', 'chiedere approvazione al responsabile.'])
    assert.ok(copies[0].includes(value), value);
  assert.equal(toasts.at(-1).variant, 'success');
  assert.doesNotMatch(copies[0], /Incarico precedente|NOT A USER MANDATE/);
});

test('from a child reads its parent and real children, with running overriding stale success', async () => {
  const { command, copies, calls } = fixture({ fromChild: true });
  await command.run();
  assert.deepEqual(new Set(calls), new Set(['root', 'done', 'busy', 'new']));
  for (const value of ['reviewer', 'Review error handling', 'concluso', 'Nessun rilievo',
    'general', 'Check packaging', 'in esecuzione', 'explore', 'Inspect routes', 'fallito']) assert.ok(copies[0].includes(value), value);
  assert.doesNotMatch(copies[0], /Vecchia risposta/);
});

test('omits secrets, sensitive paths, raw shell output and unverified claims', async () => {
  const { command, copies } = fixture();
  await command.run();
  assert.doesNotMatch(copies[0], /hidden-multiline|custom-secret|short(?:er)?-value|sk-proj|user:pass|DO_NOT_COPY|\.env|private\.pem|deploy`|abcdef1|pytest --version/);
});

test('a clipboard failure is reported without success or raw error details', async () => {
  const { command, copies, toasts, checkpoints } = fixture({ failCopy: true });
  await command.run();
  assert.deepEqual(copies, []);
  assert.deepEqual(checkpoints, {});
  assert.deepEqual(toasts.map(({ variant }) => variant), ['error']);
  assert.doesNotMatch(toasts[0].message, /DO_NOT_COPY/);
});

test('whole-session JSON shares the extractor and distinguishes operation evidence, reports and unknowns', async () => {
  const { commands, copies } = fixture();
  await commands['handoff-sessione'].run();
  await commands['handoff-sessione-json'].run();
  const report = JSON.parse(copies[1]);
  assert.equal(report.version, 1);
  assert.equal(report.scope, 'session');
  for (const value of ['Incarico precedente', 'Correggi la verifica locale.', 'OBSERVED', 'REPORTED', 'UNKNOWN', 'compaction']) {
    assert.ok(copies[0].includes(value), value);
    assert.ok(copies[1].includes(value), value);
  }
  assert.equal(report.execution.usage.find(({ agent }) => agent === 'reviewer').tokens.cacheRead, 2);
  assert.equal(report.evidence.find(({ data }) => data.command === 'bash tests/guardrail/runner.sh packaging').data.result, 'PASS');
  assert.equal(report.evidence.find(({ data }) => data.command === 'node --test tests/skipped.test.mjs').data.result, 'SKIP');
  assert.equal(report.evidence.find(({ kind }) => kind === 'digest verificato').data.sha256, 'a'.repeat(64));
  assert.doesNotMatch(copies[1], /DO_NOT_COPY|NOT A USER MANDATE/);
});

test('incremental export emits pending-to-completed transitions, not the unchanged tool evidence', async () => {
  const { commands, copies, updates, checkpoints } = fixture();
  await commands['handoff-incrementale-json'].run();
  const initial = JSON.parse(copies[0]);
  assert.equal(initial.scope, 'session');
  assert.equal(initial.previous, null);
  updates.exit = 0;
  updates.active = false;
  updates.treeStatus = 'deleted';
  await commands['handoff-incrementale-json'].run();
  const delta = JSON.parse(copies[1]);
  assert.equal(delta.previous, initial.id);
  assert.match(copies[1], /later\.test\.mjs.*PASS|PASS.*later\.test\.mjs/s);
  assert.match(copies[1], /concluso/);
  assert.equal(delta.evidence.find(({ ref }) => ref.call === 'unlisted').data.result, 'PASS');
  assert.equal(delta.evidence.find(({ kind }) => kind === 'working tree attuale').data.paths[0].status, 'deleted');
  assert.doesNotMatch(copies[1], /unsupported command/);
  assert.doesNotMatch(copies[1], /test_report\.py/);
  assert.doesNotMatch(JSON.stringify(checkpoints), /later\.test\.mjs|Vecchia risposta/);
  await commands['handoff-incrementale-json'].run();
  assert.deepEqual(JSON.parse(copies[2]).evidence, []);
});

test('a latest export does not turn already recorded history into new incremental evidence', async () => {
  const { commands, copies } = fixture();
  await commands.handoff.run();
  await commands['handoff-incrementale-json'].run();
  assert.deepEqual(JSON.parse(copies[1]).evidence, []);
});

test('OSC clipboard without confirmation leaves the checkpoint untouched', async () => {
  const { command, copies, checkpoints, toasts } = fixture({ confirmed: false });
  await command.run();
  assert.equal(copies.length, 1);
  assert.deepEqual(checkpoints, {});
  assert.equal(toasts[0].variant, 'warning');
});
