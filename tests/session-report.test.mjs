import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerReport, renderMarkdown } from '../shared/session-report/report.mjs';

const text = (value) => ({ type: 'text', text: value });
const shell = (command, exit, output = '') => ({
  type: 'tool', name: 'shell', executed: false, state: {
    status: 'completed', input: { command }, metadata: { exit },
    content: [text(output)],
  },
});
const sha = '0123456789abcdef0123456789abcdef01234567';

function fixture({ fromChild = false, failCopy = false, checkpoints = {}, confirmed = true, operational = false } = {}) {
  const children = [
    { id: 'done', agent: 'reviewer', title: 'Review error handling', outcome: 'succeeded' },
    { id: 'busy', agent: 'general', title: 'Check packaging', outcome: 'succeeded' },
    { id: 'new', agent: 'explore', title: 'Inspect routes', outcome: 'failed' },
  ];
  let layer;
  const copies = [], toasts = [], calls = [];
  const updates = { active: true, exit: null, failCopy, treeStatus: 'modified', go: false, background: false };
  const record = (id, created, message) => ({ id, time: { created, completed: created }, ...message });
  const current = record('current', 10, { type: 'user', text: 'Correggi la verifica locale.\npassword: hidden-multiline' });
  const old = record('old', 1, { type: 'user', text: 'Incarico precedente da inventariare.' });
  const users = operational ? [
    record('resume-user', 15, { type: 'user', text: 'Riprendi la verifica locale.\n1. Verifica il bundle effettivo.' }),
    record('go', 14, { type: 'user', text: 'AUTORIZZO UNA FINESTRA PRODUTTIVA UNA TANTUM.' }),
    record('stop', 13, { type: 'user', text: 'STOP AI NUOVI TENTATIVI PRODUTTIVI.' }),
    record('cancel', 12, { type: 'user', text: 'Ho sbagliato a inviare il prompt, annulla quello che hai fatto.' }),
    record('wrong', 11, { type: 'user', text: 'Costruisci un plugin non pertinente.\n## Criteri di accettazione\n- Criterio annullato.' }),
    current, old,
  ] : [current, old];
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
      permission: { list: async () => operational ? [] : [{ action: 'shell', resources: ['DO_NOT_COPY'] }] },
      experimental: { job: { list: async () => updates.background ? [
        { kind: 'shell', id: 'job-fixture', sessionID: 'root', status: updates.exit === null ? 'running' : 'cancelled',
          time: { started: 19, ...(updates.exit !== null ? { completed: 25 } : {}) }, command: 'DO_NOT_COPY' },
      ] : [] } },
      vcs: { get: async () => ({ data: { branch: { current: 'master' } } }),
        status: async () => ({ data: [{ file: 'README.md', status: updates.treeStatus }] }) },
      message: { list: async ({ sessionID, type, order, limit }) => {
        calls.push(sessionID);
        const input = updates.go ? [record('new-go', 24, { type: 'user',
          text: 'GO. AUTORIZZO una sola finestra per il piano di prova.\nSolo verifica; nessun secondo fermo.' }), ...users] : users;
        if (type === 'user') return { data: (order === 'asc' ? [...input].reverse() : input).slice(0, limit) };
        if (sessionID !== 'root') return { data: sessionID === 'new' ? [record('bad', 15, { type: 'idle', outcome: 'failed' })] : [
          record('reply', 16, { type: 'assistant', agent: sessionID === 'done' ? 'reviewer' : 'general',
            model: { providerID: 'openai', id: 'test-model', variant: 'medium' }, tokens: { input: 5, cache: { read: 2 } },
            content: [text(sessionID === 'done' ? operational ? [
              '**Request changes — two concrete blockers.**',
              '1. **A pruned candidate image can still trigger the stopped backup.** The check in `src/receipt.py` does not verify image availability.',
              '2. **The age cap can expire after scheduler withdrawal.** Restore the scheduler if the validation fails before switch.',
              'Static review only; I did not rerun the tests.',
            ].join('\n') : 'Nessun rilievo.' : 'Vecchia risposta.')] }),
        ] };
        return { cursor: {}, data: [...(operational === 'closed' ? [
          record('closed', 22, { type: 'assistant', finish: 'stop', content: [
            text('Recovery completato. Fleet è in `rolled_back`; il gate dello scheduler è stato ripristinato.'),
            text('Prima di un nuovo tentativo serve verificare `finalize`, `export_controller_dependencies()` e `scripts.shared_jobs`.'),
            text('Valore ambiguo: `random_opaque_value_with_no_technical_context`.'),
          ] }),
        ] : []), ...(['recovery', 'closed'].includes(operational) ? [
          record('final', 21, { type: 'assistant', finish: 'stop', content: [
            text('Nessuna promozione. Il recovery nativo è in corso; il ripristino del gate non è ancora confermato.'),
          ] }),
        ] : []), record('out', 20, { type: 'assistant', snapshot: { files: ['shared/example.mjs', '.env', 'private.pem'] }, content: [
          shell('node --test tests/report.test.mjs', 0, 'DO_NOT_COPY\nPASS'),
          { ...shell('pytest tests/test_report.py', 1), time: { completed: 18 } },
          ...(operational ? [{ ...shell('pytest tests/test_report.py', 0), time: { completed: 19 } }] : []),
          ...(operational ? [
            { ...shell("set -e; python3 -B -m unittest suite.Backup.test_expiry", 1, 'Ran 1 test in 0.013s\n\nFAILED (failures=1)\n'),
              time: { completed: 18 } },
            { ...shell("set -e; python3 -B -m unittest suite.Backup.test_expiry", 0, 'Ran 1 test in 0.011s\n\nOK\n'),
              time: { completed: 19 } },
            { ...shell('npm test', 1), time: { completed: 18 } },
            { ...shell('npm test', 0), time: { completed: 19 } },
            { ...shell('python -m unittest suite.Backup.test_other_scope', 1, 'Ran 1 test in 0.01s\n\nFAILED (failures=1)\n'),
              time: { completed: 17 } },
          ] : []),
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
          ...(operational === 'qualification' ? [
            text('Blocker: None. All requirements implemented and verified.'),
            text('Commit dichiarato: `fedcba9`.'),
            { type: 'tool', id: 'todos', name: 'todowrite', state: { status: 'completed', metadata: {
              todos: [{ content: 'Verifica bundle', status: 'completed' }],
            } } },
            { type: 'tool', name: 'shell', id: 'detached', state: { status: 'completed',
              input: { command: 'unsupported command' }, metadata: { status: 'running', shellID: 'sh-fixture' } } },
          ] : []),
          ...(operational ? [text('**Il progetto non è completato.** I servizi rispondono sul predecessore.\n**Autorizzi una nuova finestra produttiva?**')] : []),
          { ...shell('bun test tests/later.test.mjs', updates.exit), id: 'later',
            state: { status: updates.exit === null ? 'running' : 'completed',
              input: { command: 'bun test tests/later.test.mjs' }, metadata: { exit: updates.exit } } },
          { ...shell('unsupported command', updates.exit), id: 'unlisted',
            state: { status: updates.exit === null ? 'running' : 'completed',
              input: { command: 'unsupported command' }, metadata: { exit: updates.exit } } },
        ] }),
        record('resume', 17, { type: 'synthetic', text: 'NOT A USER MANDATE' }),
        record('compact', operational === 'qualification' ? 16 : 13,
          { type: 'compaction', status: operational === 'qualification' ? 'failed' : 'completed', summary: 'DO_NOT_COPY' }),
        ...(operational === 'qualification' && updates.go ? [record('shell-done', 25, { type: 'synthetic',
          metadata: { source: 'shell', state: 'completed', exit: 0, shellID: 'sh-fixture' } })] : []),
        ...input].sort((a, b) => b.time.created - a.time.created) };
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
  assert.match(copies[0], /mandato originale della sessione \(contesto\).*Incarico precedente/);
  assert.doesNotMatch(copies[0], /NOT A USER MANDATE/);
});

test('keeps both review blockers, canceled mandates and the operational gate distinct', async () => {
  const { commands, copies } = fixture({ operational: true });
  await commands['handoff-sessione'].run();
  await commands['handoff-sessione-json'].run();
  await commands['handoff-json'].run();
  const full = JSON.parse(copies[1]), latest = JSON.parse(copies[2]);
  for (const blocker of ['A pruned candidate image', 'The age cap can expire']) {
    assert.ok(copies[0].includes(blocker), blocker);
    assert.ok(full.subagents.find(({ session }) => session === 'done').evidence.some(({ data }) => data.text?.includes(blocker)));
  }
  assert.equal(full.mandates.find(({ ref }) => ref.message === 'wrong').disposition, 'annullato');
  assert.equal(latest.currentMandate.ref.message, 'current');
  assert.equal(latest.lastControl.data.mandate.message, 'current');
  assert.doesNotMatch(copies[0] + copies[1], /Criterio annullato/);
  assert.equal(latest.mandates.some(({ ref }) => ref.message === 'wrong'), false);
  assert.ok(full.operational.some(({ data }) => data.text?.includes('non è completato')));
  assert.ok(full.residualGates.some(({ data }) => data.text?.includes('Autorizzi una nuova finestra')));
  assert.ok(full.evidence.some(({ data }) => data.command === 'pytest tests/test_report.py' && data.laterPass));
  assert.ok(full.evidence.some(({ data }) => data.command === 'python -m unittest' && data.testsRun === 1 && data.laterPass));
  assert.ok(full.evidence.some(({ data }) => data.command === 'npm test' && data.result === 'FAIL' && !data.laterPass));
  assert.ok(full.evidence.some(({ data }) => data.cases?.includes('suite.Backup.test_other_scope') && !data.laterPass));
  assert.doesNotMatch(copies[0], /permessi in attesa.*count: 0/);
});

test('retains technical identifiers and moves resolved recovery to history with its native reference', async () => {
  const { commands, copies } = fixture({ operational: 'closed' });
  await commands.handoff.run();
  await commands['handoff-json'].run();
  const report = JSON.parse(copies[1]);
  for (const symbol of ['rolled_back', 'finalize', 'export_controller_dependencies()', 'scripts.shared_jobs']) assert.ok(copies[0].includes(symbol), symbol);
  assert.doesNotMatch(copies.join('\n'), /random_opaque_value_with_no_technical_context/);
  assert.equal(report.residualGates.some(({ ref }) => ref.message === 'final'), false);
  assert.equal(report.evidence.find(({ kind, ref }) => kind === 'aperto' && ref.message === 'final').data.supersededBy.message, 'closed');
  assert.equal(copies[0].match(/Prima di un nuovo tentativo serve verificare/g)?.length, 1);
});

test('the latest recovery report supersedes an older request for GO without implying a new action', async () => {
  const { commands, copies } = fixture({ operational: 'recovery' });
  await commands['handoff-json'].run();
  const report = JSON.parse(copies[0]);
  assert.equal(report.nextStep.kind, 'attività documentata in corso');
  assert.equal(report.nextStep.ref.message, 'final');
  assert.ok(report.residualGates.some(({ kind, ref }) => kind === 'aperto' && ref.message === 'final'));
  assert.equal(report.residualGates.some(({ kind }) => kind === 'GO mancante'), false);
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

test('the same pre-export checkpoint yields equivalent command outputs, including a GO and a background transition', async () => {
  const start = fixture({ operational: 'qualification' });
  start.updates.background = true;
  await start.commands['handoff-sessione-json'].run();
  const checkpoint = structuredClone(start.checkpoints);
  for (const [md, json] of [['handoff', 'handoff-json'], ['handoff-sessione', 'handoff-sessione-json'],
    ['handoff-incrementale', 'handoff-incrementale-json']]) {
    const a = fixture({ operational: 'qualification', checkpoints: structuredClone(checkpoint) });
    const b = fixture({ operational: 'qualification', checkpoints: structuredClone(checkpoint) });
    for (const item of [a, b]) Object.assign(item.updates, { go: true, background: true, exit: 0 });
    await a.commands[md].run();
    await b.commands[json].run();
    const report = JSON.parse(b.copies[0]);
    assert.equal(a.copies[0], renderMarkdown(report));
    assert.equal(report.nextStep.confidence, 'UNKNOWN');
    assert.ok(!report.residualGates.some(({ kind }) => kind === 'GO mancante'));
    assert.match(a.copies[0], /Solo verifica; nessun secondo fermo/);
    assert.ok(!report.evidence.some(({ data, kind }) => kind === 'bloccato' && data.text?.startsWith('None')));
    assert.equal(report.context.lastDeclaredCommit.revision, 'fedcba9');
    assert.equal(report.todos[0].data.items[0].status, 'completed');
    if (md === 'handoff-incrementale') {
      assert.equal(report.execution.subagents.observed, 0);
      assert.equal(report.sessionExecution.subagents.observed, 3);
      assert.ok(report.evidence.some(e => e.ref.job === 'job-fixture' && e.data.state === 'cancelled'));
      assert.ok(report.evidence.some(e => e.ref.call === 'detached' && e.data.confirmedBy?.message === 'shell-done' && e.data.exit === 0));
    } else {
      assert.ok(report.evidence.some(e => e.kind === 'compaction' && e.data.state === 'failed'));
    }
  }
});
