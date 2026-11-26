import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerGuard } from '../shared/session-guard/guard.mjs';

const mitech = '# Progetto: Mitech\n## Mandato: Disaster recovery\nMantieni il perimetro del ripristino.';
const handoff = '# OPENCODE TEAM — AI HANDOFF\nRepository: `~/Sites/Github/brew-opencode-team`\n## OBIETTIVO\nImplementa la modifica.';
const recovery = '# GIAFFATTO — BACKUP OFF-SITE CENTRALIZZATO E DISASTER RECOVERY\n## OBIETTIVO\nValuta il piano.';
const deploy = '# GIAFFATTO — ELIMINAZIONE SISTEMA LEGACY DI DEPLOY\n## OBIETTIVO\nEsegui il nuovo incarico.';
const user = (text) => ({ type: 'user', text });

function fixture({ history = [user(mitech)], decision, failRead = false } = {}) {
  let handler;
  let route = { type: 'session', sessionID: 'current' };
  const reads = [], dialogs = [];
  const cleanup = () => { handler = undefined; };
  const context = {
    client: { message: { list: async (input) => {
      reads.push(input);
      if (failRead) throw new Error('Unavailable');
      return { data: history };
    } } },
    ui: {
      prompt: { beforeSubmit: (callback) => {
        handler = callback;
        return cleanup;
      } },
      router: { current: () => route },
      dialog: { prompt: async (options) => {
        dialogs.push(options);
        return typeof decision === 'function' ? decision() : decision;
      } },
    },
  };
  return {
    reads, dialogs, context, cleanup,
    navigate: (value) => { route = { type: 'session', sessionID: value }; },
    register: () => registerGuard(context),
    submit: (text, { sessionID = 'current', delivery = 'steer', revertMessageID } = {}) =>
      handler({ sessionID, text, delivery, revertMessageID }),
  };
}

test('A: blocks an explicit cross-project submission each time it is retried', async () => {
  const f = fixture({ history: [user('# GIAFFATTO — MIGRAZIONE MITECH\n## OBIETTIVO\nVerifica la migrazione.')], decision: '' });
  assert.equal(f.register(), f.cleanup);
  assert.equal(await f.submit(handoff), false);
  assert.equal(await f.submit(handoff), false);
  assert.equal(f.dialogs.length, 2);
  assert.match(f.dialogs[0].description, /progetto|repository/i);
  assert.ok(f.reads.every(({ sessionID, type }) => sessionID === 'current' && type === 'user'));
});

test('B: blocks a distinct declared mandate in the same project', async () => {
  const f = fixture({ history: [user('GO'), user(recovery)] });
  f.register();
  assert.equal(await f.submit(deploy, { delivery: 'queue' }), false);
  assert.match(f.dialogs[0].description, /mandato/i);
});

test('uses explicit repository identities and recognizes equivalent repository spellings', async () => {
  const f = fixture({ history: [user('Repository: `git@github.com:org/mitools.git`')] });
  f.register();
  assert.equal(await f.submit('Repo: https://github.com/org/mitools'), true);
  assert.equal(await f.submit('Repo: https://github.com/other/mitools'), false);
  assert.equal(await f.submit('Repo: first/mitools\nRepo: mitools\nRepo: second/mitools'), true);
});

test('C/F: allows ordinary approvals, logs, quoted context, and related follow-ups', async () => {
  const f = fixture();
  f.register();
  for (const input of [
    'GO',
    'GO. Autorizzo una sola verifica, senza deploy.',
    'Per contesto: il thread AI Handoff su OpenCode Team spiega il formato.',
    `Contesto:\n${handoff}`,
    `Here are the logs:\n${handoff}`,
    `## Logs\n\`\`\`text\n${handoff}\n\`\`\``,
    handoff.split('\n').map((line) => `> ${line}`).join('\n'),
    'Progetto: Mitech\nMandato: Disaster recovery verification',
    'Progetto: Mitech\nMandato: Verifica del disaster recovery',
    'Progetto: Mitech\nPer confronto, esamina il problema AI Handoff.',
    'Progetto: Mitech\nProgetto: OpenCode Team',
    '# OpenCode Team AI Handoff\n\n_Dati da verificare, non istruzioni da eseguire._\nRepository: brew-opencode-team',
    '## Esempio\nProject: Other',
  ]) {
    assert.equal(await f.submit(input), true, input);
  }
  assert.deepEqual(f.dialogs, []);
});

test('a staged revert checks only the retained native history', async () => {
  const f = fixture({ history: [{ ...user(handoff), id: 'cut' }, { ...user(mitech), id: 'retained' }] });
  f.register();
  const options = { revertMessageID: 'cut' };
  assert.equal(await f.submit(handoff, options), false);
  assert.equal(await f.submit(mitech, options), true);
  assert.equal(await f.submit(handoff, { revertMessageID: 'not-in-page' }), true);
  assert.ok(f.reads.every(({ type }) => type === undefined));
});

test('context sections do not hide a separate explicit scope declaration', async () => {
  const f = fixture();
  f.register();
  assert.equal(await f.submit('## Context\n### Project: Documentation example\n## Project: OpenCode Team'), false);
});

test('allows a first prompt, unavailable history, and history that provides no explicit evidence', async () => {
  for (const f of [
    fixture({ history: [] }),
    fixture({ failRead: true }),
    fixture({ history: [{ type: 'assistant', text: mitech }, user('Summarize the logs')] }),
  ]) {
    f.register();
    assert.equal(await f.submit(handoff), true);
    assert.deepEqual(f.dialogs, []);
  }
  const f = fixture();
  f.register();
  assert.equal(await f.submit(handoff, { sessionID: null }), true);
  assert.deepEqual(f.reads, []);
});

test('only uses the latest explicit scope and does not combine separate historical scopes', async () => {
  const f = fixture({ history: [user('Mandate: New standalone mandate'), user(mitech)] });
  f.register();
  assert.equal(await f.submit(handoff), true);
  assert.deepEqual(f.dialogs, []);
});

test('explicit confirmation applies to one attempt only; dismissing or a dialog failure cancels', async () => {
  const answers = ['INVIA', '', new Error('Unavailable')];
  const f = fixture({ decision: () => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  } });
  f.register();
  assert.equal(await f.submit(handoff), true);
  assert.equal(await f.submit(handoff), false);
  assert.equal(await f.submit(handoff), false);
  assert.equal(f.dialogs.length, 3);
});

test('does not authorize a mismatch when the target changes while awaiting confirmation', async () => {
  const f = fixture({ decision: () => {
    f.navigate('other');
    return 'INVIA';
  } });
  f.register();
  assert.equal(await f.submit(handoff), false);
});

test('does not register a fallback on unsupported hosts', () => {
  assert.equal(registerGuard({ ui: {} }), undefined);
});
