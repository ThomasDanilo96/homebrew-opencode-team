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

function fixture({ fromChild = false, failCopy = false } = {}) {
  const children = [
    { id: 'done', agent: 'reviewer', title: 'Review error handling', outcome: 'succeeded' },
    { id: 'busy', agent: 'general', title: 'Check packaging', outcome: 'succeeded' },
    { id: 'new', agent: 'explore', title: 'Inspect routes' },
  ];
  let layer;
  const copies = [], toasts = [], calls = [];
  const ctx = {
    ui: { router: { current: () => ({ type: 'session', sessionID: fromChild ? 'done' : 'root' }) },
      toast: { show: (toast) => toasts.push(toast) } },
    keymap: { layer: (create) => { layer = create; } },
    client: {
      session: {
        get: async ({ sessionID }) => sessionID === 'root' ? { id: 'root', outcome: 'succeeded' } : { parentID: 'root' },
        list: async (input) => { assert.equal(input.parentID, 'root'); return { data: children, cursor: {} }; },
        active: async () => ({ busy: { type: 'running' } }),
      },
      permission: { list: async () => [{ action: 'shell', resources: ['DO_NOT_COPY'] }] },
      message: { list: async ({ sessionID, type }) => {
        calls.push(sessionID);
        if (type === 'user') return { data: [{ text: 'Correggi la verifica locale.\npassword: hidden-multiline' }] };
        if (sessionID !== 'root') return { data: sessionID === 'new' ? [] : [
          { type: 'assistant', content: [text(sessionID === 'done' ? 'Nessun rilievo.' : 'Vecchia risposta.')], time: { completed: 1 } },
        ] };
        return { cursor: {}, data: [{ type: 'assistant', time: { completed: 1 }, snapshot: { files: ['shared/example.mjs', '.env', 'private.pem'] }, content: [
          shell('node --test tests/report.test.mjs', 0, 'DO_NOT_COPY\nPASS'),
          shell('pytest tests/test_report.py', 1),
          shell('npm test && deploy', 0),
          shell('git rev-parse --verify HEAD', 0, `${sha}\n`),
          shell('git commit -m example', 0, '[master abcdef0] example'),
          shell('git commit -m example', 0, 'untrusted abcdef1\n'),
          text('Risultato: Validazione corretta.\nBloccato: manca accesso allo staging.\nGO mancante: approvazione deploy.\nProssimo passo: chiedere approvazione al responsabile.'),
          text('Risultato: Authorization: Bearer custom-secret'),
          text('Completato: https://user:pass@example.test/path'),
          text('Bloccato: token: short-value'),
          text('Aperto: chiave `sk-proj-abcdef1234567890`'),
        ] }] };
      } },
    },
  };
  registerReport(ctx, async (value) => {
    if (failCopy) throw new Error('clipboard detail DO_NOT_COPY');
    copies.push(value);
  });
  const command = layer().commands[0];
  return { command, copies, toasts, calls };
}

test('copies the parent objective and native file, commit, test and approval evidence', async () => {
  const { command, copies, toasts } = fixture();
  assert.equal(command.palette, true);
  assert.equal(command.title, 'Copia resoconto');
  await command.run();
  assert.equal(copies.length, 1);
  for (const value of ['Correggi la verifica locale.', 'Validazione corretta.', 'shared/example.mjs',
    sha, 'abcdef0', 'node --test tests/report.test.mjs` — PASS', 'pytest tests/test_report.py` — FAIL',
    'manca accesso allo staging.', 'approvazione deploy.', 'chiedere approvazione al responsabile.'])
    assert.ok(copies[0].includes(value), value);
  assert.equal(toasts.at(-1).variant, 'success');
});

test('from a child reads its parent and real children, with running overriding stale success', async () => {
  const { command, copies, calls } = fixture({ fromChild: true });
  await command.run();
  assert.deepEqual(new Set(calls), new Set(['root', 'done', 'busy', 'new']));
  assert.match(copies[0], /reviewer.*Review error handling.*concluso.*Nessun rilievo/);
  assert.match(copies[0], /general.*Check packaging.*in esecuzione/);
  assert.match(copies[0], /explore.*Inspect routes.*non confermato/);
  assert.doesNotMatch(copies[0], /Vecchia risposta/);
});

test('omits secrets, sensitive paths, raw shell output and unverified claims', async () => {
  const { command, copies } = fixture();
  await command.run();
  assert.doesNotMatch(copies[0], /hidden-multiline|custom-secret|short-value|sk-proj|user:pass|DO_NOT_COPY|\.env|private\.pem|deploy`|abcdef1/);
});

test('a clipboard failure is reported without success or raw error details', async () => {
  const { command, copies, toasts } = fixture({ failCopy: true });
  await command.run();
  assert.deepEqual(copies, []);
  assert.deepEqual(toasts.map(({ variant }) => variant), ['error']);
  assert.doesNotMatch(toasts[0].message, /DO_NOT_COPY/);
});
