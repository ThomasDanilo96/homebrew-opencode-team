import { createHash } from 'node:crypto';

const redacted = '[omesso]';
const sensitive = /(?:\b(?:authorization|bearer|password|passwd|creden[tz]ial\w*|api[ _-]?key|token|secret\w*|segret\w*|private[ _-]?key|chiave privata|cookie|sessionid)\b|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[\w-]{8,}|https?:\/\/|\S+@\S+|(?:^|[\s/])(?:~\/|\/|\.env\b)|\.(?:pem|key|p12)\b|[\p{C}])/iu;
const opaque = /\b[\w-]{32,}\b|\b(?=[\w-]{18,}\b)(?=[\w-]*\d)[\w-]+\b/u;
const credentialAssignment = /\b[\w.-]*(?:password|passwd|token|secret|api[_-]?key|credential|private[_-]?key|cookie)[\w.-]*\s*[:=]/i;
const pathPattern = '[\\w.-]+(?:/[\\w.-]+)*';
const relativePath = new RegExp(`^${pathPattern}$`);
const testPath = `(?!-)${pathPattern}`;
const testCommand = new RegExp(
  `^(?:node --test(?: ${testPath})*|bun test(?: ${testPath})*|(?:npm|pnpm) test|(?:python3? -m |uv run )?pytest(?: ${testPath})*|bash tests/${testPath}\\.sh(?: (?:all|profile|best-native|qualification|packaging|smoke|compatibility))?|go test (?:\\./\\.\\.\\.|${testPath})|cargo test)$`,
);
const gitHead = /^git (?:rev-parse (?:--verify )?HEAD|show -s --format=%H HEAD)$/;
const gitCheck = /^git (?:status(?: --short(?: --branch)?| -sb| --porcelain)?|diff --check|log -[1-9][0-9]? --oneline)$/;
const UNKNOWN = 'non disponibile o non dimostrabile';
const technicalCall = /\b(?:[a-z_][a-z0-9_]{0,23}\.)*[a-z][a-z0-9]{0,23}(?:_[a-z][a-z0-9]{0,23}){1,8}\(\)/g;
const credentialComponent = /(?:^|[._-])(?:auth|password|passwd|token|secret|api[_-]?key|credential[s]?|cookie|sessionid)(?=$|[._-])/i;
const recoveryCompleted = /\brecovery (?:nativo )?(?:(?:è stato|è) )?(?:completat[oa]|conclus[oa]|completed)\b/i;
const bundleRevision = /\b(?:bundle|export)(?: (?:complet[oa]|effettiv[oa]|del controller|verificat[oa]|revision[ei])){0,3}\s*:?\s*`?([0-9a-f]{7,12})`?\b/i;
const labels = [
  ['risultato', /^(?:risultato|result|outcome|esito)$/i],
  ['completato', /^(?:completat[oi]|completed|modifiche principali)$/i],
  ['aperto', /^(?:apert[oi]|open|pending|incomplet[oi]|problemi aperti)$/i],
  ['bloccato', /^(?:bloccat[oi]|blocked|blockers?|blocchi|criticità|findings|rilievi)$/i],
  ['decisione', /^(?:decision[ei]|decision|scelta|motivazione|scartat[ao]|alternativa)$/i],
  ['vincolo', /^(?:vincol[oi](?: da preservare)?|constraint|preservare)$/i],
  ['errore', /^(?:error[ei]|failure|tentativo fallito|correzione)$/i],
  ['operazioni', /^(?:deploy|installazione|recovery|migrazion[ei]|backup|pulizia|rollback|stato operativo)$/i],
  ['validazione', /^(?:test|verifich[ea](?: riutilizzabili)?|qualification|qualifica|regressioni|evidenz[ae](?: riutilizzabili)?|ricevut[ae]|digest)$/i],
  ['GO mancante', /^(?:GO mancant[ei]|missing GO|autorizzazioni mancanti)$/i],
  ['GO dichiarato (storico)', /^(?:GO|approvat[oa]|autorizzazion[ei](?: ricevut[ae])?)$/i],
  ['prossimo passo', /^(?:prossim[oi] pass[oi]|next steps?|dipendenz[ae])$/i],
  ['integrazione dichiarata', /^(?:integrazione|risultat[oi] integrat[oi])$/i],
];

// Extract short prose, never fenced/indented code, a raw transcript or tool output.
function proseLines(value) {
  let fence;
  let hideNext = false;
  return (value ?? '').split(/\r?\n/).flatMap((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return [];
    }
    if (fence || /^(?: {4}|\t|>)/.test(line)) return [];
    if (hideNext && line.trim()) { hideNext = false; return []; }
    if ((sensitive.test(line) || opaque.test(line) || credentialAssignment.test(line)) && /[:=]\s*$/.test(line)) { hideNext = true; return []; }
    return [line.trim()];
  }).filter(Boolean);
}

function scrubInline(value) {
  return value.trim().replace(/`([^`]+)`/g, (_, code, offset, line) => {
    if (/\b(?:piano|plan)\s*$/i.test(line.slice(0, offset)) &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(code)) return `${code.slice(0, 8)}…`;
    return !sensitive.test(code) && !credentialComponent.test(code) && (
      (safePath(code) && /[/.]/.test(code)) ||
      (!opaque.test(code) && (testCommand.test(code) || gitCheck.test(code) || gitHead.test(code))) ||
      (/^[0-9a-f]{7,12}$/.test(code) && (/\b(?:commit|git|branch|master|HEAD)\b/i.test(value) ||
        bundleRevision.exec(line)?.[1] === code)) ||
      /^(?:complete|prepare[d]?|finalize[d]?|promoted|idle|running|blocked|succeeded|failed|rolled_back|rollback|preflight|switch|git archive|fleet status)$/i.test(code) ||
      (/^[1-5]\d{2}$/.test(code) && /\bHTTP\s*$/.test(line.slice(0, offset))) ||
      (/^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|HTTP \d{3})$/.test(code) && !opaque.test(code)) ||
      (code.length <= 100 && code.replace(technicalCall, '') === '')) ? code : '…';
  });
}

function excerpt(value, limit = 180) {
  const line = scrubInline(value).replace(/\b(piano|plan)\s+([a-f0-9]{8})-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\b/gi, '$1 $2…');
  if (!line || sensitive.test(line) || credentialAssignment.test(line) || /[`<>[\]{}\\|]/.test(line) ||
      opaque.test(line.replace(technicalCall, (call) => credentialComponent.test(call.slice(0, -2)) ? call : ''))) return redacted;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function shortText(value) {
  const line = proseLines(value).find((line) => !/^(?:#+\s|[-*]\s*$)/.test(line));
  if (!line) return undefined;
  const clean = excerpt(line.replace(/^[-*]\s+/, ''));
  return clean.split(/(?<=[.!?])\s/, 1)[0];
}

function safePath(file) {
  return typeof file === 'string' && file.length <= 120 && relativePath.test(file) && !sensitive.test(file) && !opaque.test(file) &&
    !/(?:^|\/)(?:\.git|auth\.json|credentials?|secrets?|\.\.)(?:\/|$)/i.test(file) &&
    !/\.(?:db|sqlite3?|log|jks|pfx|crt)$/i.test(file);
}

function clean(value, limit) {
  if (typeof value !== 'string') return null;
  const text = excerpt(value, limit);
  return text === redacted ? null : text;
}

function narrative(value, limit) {
  const paragraph = clean(value, limit);
  if (paragraph) return paragraph;
  const clauses = [];
  for (const sentence of scrubInline(value).split(/(?<=[.!?])\s+/)) {
    const safe = clean(sentence, limit);
    if (!safe) break;
    clauses.push(safe);
  }
  return clean(clauses.join(' '), limit);
}

function directive(text) {
  const line = proseLines(text)[0]?.replace(/^[#*\s]+/, '') ?? '';
  if (/^(?:ho sbagliato.*(?:prompt|invi|annull)|annulla\b|cancel (?:the )?(?:previous|last))/i.test(line)) return 'annullamento';
  if (/^(?:STOP\b|FERMATI\b|INTERROMPI\b|la devo fermare\b)/i.test(line)) return 'STOP';
  if (/^(?:AUTORIZZO\b|GO[.!]\s*AUTORIZZO\b|GO\s*[:—-]|approvo\b)/i.test(line)) return 'autorizzazione storica';
  if (/^(?:puoi procedere[.!]?$|procedi[.!]?$|prosegui\b|continua\b|riprendi\b|dobbiamo concludere questo lavoro\b|bene.*incarico.*originari)/i.test(line)) return 'continuazione';
  if (/^(?:\?|(?:ma\s+)?(?:cos['’]è|come mai|è normale|quant['’]è|dove|per?c?h[éeè]|quanto)\b)/i.test(line) || /\?$/.test(line)) return 'chiarimento';
  return 'mandato';
}

function mandateTimeline(session, userMessages) {
  const rows = [];
  let current, lastControl;
  for (const m of [...userMessages].sort((a, b) => a.time.created - b.time.created)) {
    const kind = directive(m.text);
    const lines = proseLines(m.text);
    const title = lines.find((line) => /^#\s+/.test(line))?.replace(/^#+\s*/, '');
    const summary = clean(title ?? lines[0], 230);
    const row = { kind, confidence: 'REPORTED', ref: { session, message: m.id }, at: m.time.created,
      data: { text: summary }, disposition: kind === 'mandato' ? 'storico' : 'contestuale' };
    if (kind === 'autorizzazione storica') {
      const scope = lines.slice(1, 7).map((line) => clean(line, 240)).filter(Boolean);
      if (scope.length) row.data.scope = scope;
    }
    if (kind === 'mandato') current = row;
    if (kind === 'annullamento' && rows.at(-1)?.kind === 'mandato' &&
        /prompt|precedente|previous|last|quello che hai fatto/i.test(lines[0] ?? '')) {
      const canceled = rows.at(-1);
      canceled.disposition = 'annullato';
      row.data.target = canceled.ref;
      if (current === canceled) current = rows.findLast((r) => r.kind === 'mandato' && r.disposition !== 'annullato');
    }
    if (['mandato', 'STOP', 'continuazione'].includes(kind)) lastControl = row;
    if (current && current !== row) row.data.mandate = current.ref;
    rows.push(row);
  }
  if (current) current.disposition = lastControl?.kind === 'STOP' ? 'sospeso' : 'corrente';
  return { rows, current, lastControl };
}

function status(session, active, messages) {
  if (active[session.id] || (session.time?.busy ?? 0) > (session.time?.idle ?? 0)) return 'in esecuzione';
  const latest = messages.find((m) => ['idle', 'user'].includes(m.type));
  if (latest?.type === 'user' && latest.time?.created > (session.time?.idle ?? 0)) return 'non confermato';
  const outcome = latest?.type === 'idle' ? latest.outcome : session.outcome;
  return { succeeded: 'concluso', failed: 'fallito', interrupted: 'interrotto' }[outcome] ?? 'non confermato';
}

function assistantText(message) {
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

function step(message) {
  const { model, time, tokens } = message;
  return {
    agent: clean(message.agent),
    model: model && [clean(model.providerID), clean(model.id)].filter(Boolean).join('/') || null,
    effort: clean(model?.variant),
    durationMs: time?.completed >= time?.created ? time.completed - time.created : null,
    tokens: Object.fromEntries(Object.entries({
      input: tokens?.input, output: tokens?.output, reasoning: tokens?.reasoning,
      cacheRead: tokens?.cache?.read, cacheWrite: tokens?.cache?.write,
    }).filter(([, value]) => Number.isFinite(value))),
  };
}

function shellEvidence(command, exit, running, failed, output) {
  if (typeof command !== 'string') return null;
  command = command.replace(/^\/opt\/homebrew\/opt\/node@22\/bin\/node (?=--test(?: |$))/, 'node ');
  const test = command.length <= 1024 && testCommand.test(command);
  const hideArgs = test && (command.length > 180 || sensitive.test(command) || opaque.test(command));
  const head = gitHead.test(command);
  const commit = /^(?:git add [\w .\/-]+ && (?:git diff --cached --check && )?)?git commit(?: [^\n;&|<>`$]*)?$/.test(command);
  const cherry = /^git cherry-pick ([0-9a-f]{7,64})$/.exec(command);
  const checksumPath = /^(?:shasum -a 256|sha256sum) (\S+)$/.exec(command)?.[1];
  // Inspect a bounded sample for strict scalar values. Never export stdout or stderr.
  const sample = typeof output === 'string' ? output.slice(0, 12000) : '';
  const unittest = [...command.matchAll(/\bpython(?:3)?(?: -B)? -m unittest[ \t]+(?:-[qv][ \t]+)?([^'"\r\n;&|)]{1,2048})(?=['"\r\n;&|)]|$)/g)];
  const targets = unittest.length === 1 ? unittest[0][1].trim().split(/[ \t]+/) : [];
  const cases = targets.length <= 20 && targets.every((value) => /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)) ? targets : [];
  const unittestResults = [...sample.matchAll(/^Ran (\d{1,6}) tests? in [\d.]+s\s*\r?\n\s*(OK|FAILED)(?: \(([^\r\n]{1,100})\))?\r?$/gm)];
  const suite = cases.length && unittestResults.length === 1 ? unittestResults[0] : null;
  const plumbing = /git\(['"]commit-tree['"]/.test(command) &&
    /git\(['"]update-ref['"][^\r\n]*['"]refs\/heads\/[\w./-]+['"]/.test(command) &&
    /\bprint\(commit\s*[,)]/.test(command);
  const printedCommit = plumbing ? [...sample.matchAll(/^([0-9a-f]{40}|[0-9a-f]{64}) [0-9a-f]{40,64}\r?$/gm)] : [];
  const revision = exit === 0 && !failed && (head ?
    /^([0-9a-f]{40}|[0-9a-f]{64})\r?$/m.exec(sample)?.[1] : commit ?
    /^\[[\w./-]+ (?:\(root-commit\) )?([0-9a-f]{7,64})\] /m.exec(sample)?.[1] :
    printedCommit.length === 1 ? printedCommit[0][1] : undefined);
  const checksum = safePath(checksumPath) && exit === 0 && !failed ?
    /^([0-9a-f]{64})[ \t]+([^\r\n]+)\r?$/m.exec(sample) : null;
  const sha256 = checksum?.[2] === checksumPath ? checksum?.[1] : undefined;
  const skipped = suite ? Number(/\bskipped=(\d{1,6})\b/.exec(suite[3] ?? '')?.[1] ?? 0) : test ? Number(/^# skipped (\d{1,6})$/m.exec(sample)?.[1] ??
    /^=+ [^\r\n=]{0,100}?\b(\d{1,6}) skipped\b[^\r\n=]*=+$/m.exec(sample)?.[1] ?? 0) : 0;
  const allSkipped = skipped > 0 && (Number(/^# tests (\d{1,6})$/m.exec(sample)?.[1]) === skipped ||
    /^=+ \d{1,6} skipped in \d+(?:\.\d+)?s =+$/m.test(sample) || Number(suite?.[1]) === skipped);
  const result = running ? 'in esecuzione' : failed || suite?.[2] === 'FAILED' || (Number.isInteger(exit) && exit !== 0) ?
    'FAIL' : exit === 0 ? (allSkipped ? 'SKIP' : 'PASS') : 'UNKNOWN';
  const missingModule = /^ModuleNotFoundError: No module named '([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)'/m.exec(sample)?.[1];
  const diagnostic = result === 'FAIL' ? (safePath(missingModule) && !credentialComponent.test(missingModule) ?
    `ModuleNotFoundError: ${missingModule}` :
    /\b(?:Permission denied \(publickey\)|No such file or directory|Connection refused|Connection timed out|command not found|ModuleNotFoundError|FileNotFoundError|AssertionError|CalledProcessError)(?=\W|$)/m
      .exec(sample)?.[0]) : undefined;
  const commandFamily = result === 'FAIL' ? /^(python3?|ssh|scp|rsync|git|bash|docker|tar|node|pytest)(?=\s|$)/.exec(command)?.[1] : undefined;
  return {
    kind: test || suite ? 'test tecnico' : sha256 ? 'digest verificato' : 'shell',
    data: { command: suite ? 'python -m unittest' : hideArgs ? `${command.split(' ', 1)[0]} (argomenti omessi)` :
      test || head || gitCheck.test(command) ? command : commit ? 'git commit' :
        plumbing && revision ? 'git commit-tree / update-ref' : cherry ? 'git cherry-pick' : null,
    result, exit: Number.isInteger(exit) ? exit : null, ...(hideArgs ? { scopeRedacted: true } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(commandFamily ? { commandFamily } : {}),
    ...(suite ? { testsRun: Number(suite[1]), cases: cases.filter((name) => name.length <= 240 &&
      !sensitive.test(name) && !credentialComponent.test(name) && name.split('.').every((part) =>
        !opaque.test(part) || /^test(?:_[a-z][a-z0-9]{0,23}){2,16}$/.test(part))),
    testScopeKey: digest([command, cases]) } : test && !hideArgs &&
      /(?:\.test\.[\w]+|(?:^|\s)(?:tests?\/|\S+\.py(?:\s|$)))/.test(command) ? { testScopeKey: digest(command) } : {}),
    ...(skipped ? { skipped } : {}), ...(revision ? { revision, source: head ? 'HEAD' : 'commit' } : {}),
    ...(cherry && result === 'PASS' ? { appliedCommit: cherry[1] } : {}),
    ...(sha256 ? { path: checksumPath, sha256 } : {}) },
  };
}

function collect(family, active, floor, fallbackGoal) {
  const facts = new Map(), seenText = new Map();
  for (const { session, messages, permissions } of family) {
    const entries = messages.filter((message) => (message.time?.created ?? 0) >= floor);
    const shellNotices = new Map(messages.filter((m) => m.type === 'synthetic' && m.metadata?.source === 'shell' &&
      m.metadata.shellID && ['completed', 'cancelled', 'error'].includes(m.metadata.state)).reverse()
      .map((m) => [m.metadata.shellID, m]));
    if (fallbackGoal && session === family[0].session && !entries.some(({ id }) => id === fallbackGoal.id)) entries.push(fallbackGoal);
    const state = status(session, active, messages);
    const add = (kind, data, message, index = '', call, confidence = 'OBSERVED', at = message?.time?.created ?? null) => {
      const ref = { session: session.id, ...(message?.id ? { message: message.id } : {}), ...(call ? { call } : {}) };
      const key = JSON.stringify([session.id, message?.id ?? '', call ?? '', kind, index]);
      const row = { confidence, kind, ref, at, data };
      facts.set(key, row);
      return row;
    };
    const child = Boolean(session.parentID) || session !== family[0].session;
    const recordedStep = entries.find((m) => m.type === 'assistant' && m.model);
    add(child ? 'subagente' : 'stato coordinatore', {
      state, ...(child ? { parent: session.parentID ?? family[0].session.id,
        role: clean(recordedStep?.agent ?? session.agent),
        assignment: clean(session.title),
        model: recordedStep ? step(recordedStep).model : null, effort: recordedStep ? step(recordedStep).effort : null } : {}),
    });
    if (permissions !== undefined) add('permessi in attesa', { count: permissions });
    const todoMessage = messages.find((m) => m.type === 'assistant' && m.content.some((part) =>
      part.type === 'tool' && part.name === 'todowrite' && part.state.status === 'completed' &&
      Array.isArray(part.state.metadata?.todos)));
    const todo = todoMessage?.content.findLast((part) => part.type === 'tool' && part.name === 'todowrite' &&
      part.state.status === 'completed' && Array.isArray(part.state.metadata?.todos));
    if (todo) {
      const items = todo.state.metadata.todos.slice(0, 40).flatMap((item) => {
        const text = clean(item.content, 200);
        return text && ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) ?
          [{ text, status: item.status }] : [];
      });
      const counts = Object.fromEntries(['pending', 'in_progress', 'completed', 'cancelled'].map((status) =>
        [status, todo.state.metadata.todos.filter((item) => item.status === status).length]));
      add('TODO nativi', { items, total: todo.state.metadata.todos.length, counts }, todoMessage, '', todo.id,
        'OBSERVED', todo.time?.completed ?? todoMessage.time?.created);
    }
    const conclusion = [...entries].find((m) => m.type === 'assistant' && m.time?.completed && !m.error && assistantText(m).trim());
    for (const m of entries) {
      const mention = (kind, text, index, limit) => {
        const value = limit && typeof text === 'string' ? narrative(text, limit) : clean(text, limit);
        if (!value || value === redacted) return;
        if (['bloccato', 'aperto'].includes(kind) && /^(?:none|no blockers?|nessuno|nessun blocc[oa])[.!]?(\s|$)/i.test(value)) {
          kind = 'risultato';
        }
        const id = JSON.stringify([session.id, kind, value]);
        const prior = seenText.get(id);
        if (prior && kind !== 'criterio di accettazione') {
          if (m.id !== prior.ref.message && !prior.relatedRefs?.some((ref) => ref.message === m.id)) {
            (prior.relatedRefs ??= []).push({ session: session.id, message: m.id });
          }
          return;
        }
        seenText.set(id, add(kind, { text: value }, m, index, undefined, 'REPORTED'));
      };
      if (m.type === 'user') {
        if (child) mention('incarico figlio', shortText(m.text), '');
        if (!child && directive(m.text) !== 'mandato') continue;
        for (const [i, line] of proseLines(m.text).slice(0, 40).entries()) {
          const authorization = /^(?:GO|Autorizzazione ricevuta)\s*:\s*(.+)$/i.exec(line);
          if (authorization) mention('GO dichiarato (storico)', authorization[1], i);
        }
        const criteria = proseLines(m.text).join('\n').split(/^(?:#+\s*)?(?:criteri di accettazione|criterio di accettazione|acceptance criteria)\s*:?\s*$/im)[1];
        if (criteria) criteria.split(/^\s*#/m)[0].split('\n').filter((line) => /^(?:[-*]|\d+\.)\s/.test(line))
          .slice(0, 6).forEach((line, i) => mention('criterio di accettazione', line.replace(/^(?:[-*]|\d+\.)\s+/, ''), i));
        continue;
      }
      if (m.type === 'synthetic') {
        if (m.metadata?.source === 'shell' && shellNotices.get(m.metadata.shellID) === m) {
          add('esito shell in background', { state: m.metadata.state, shellID: m.metadata.shellID,
            exit: Number.isInteger(m.metadata.exit) ? m.metadata.exit : null }, m);
        } else if (m.metadata?.source === 'subagent' && family.some((item) => item.session.id === m.metadata.childID)) {
          add('notifica figlio al coordinatore', { child: m.metadata.childID, integration: 'UNKNOWN' }, m);
        } else if (!child && m.metadata?.source !== 'subagent') {
          add('evento sintetico', { note: 'non apre un mandato' }, m);
        }
        continue;
      }
      if (m.type === 'compaction') {
        add('compaction', { state: clean(m.status), reason: clean(m.reason), errorType: clean(m.error?.type), ...step(m) }, m);
        continue;
      }
      if (m.type === 'idle' && m.outcome !== 'succeeded') {
        add('esecuzione non riuscita', { state: clean(m.outcome), errorType: clean(m.error?.type), http: m.error?.status ?? null }, m);
        continue;
      }
      if (m.type === 'shell') {
        const row = shellEvidence(m.command, m.exit, m.status === 'running', m.status !== 'exited', m.output?.output);
        if (row) add(row.kind, { ...row.data, state: clean(m.status) }, m, '', undefined, 'OBSERVED', m.time?.completed ?? m.time?.created);
        continue;
      }
      if (m.type !== 'assistant') continue;
      add('step', step(m), m);
      if (m.retry || m.error) add('errore o retry step', {
        retry: m.retry?.attempt ?? null, errorType: clean((m.retry?.error ?? m.error)?.type),
        http: (m.retry?.error ?? m.error)?.status ?? null, retryAt: m.retry?.at ?? null,
      }, m);
      const files = [...new Set(m.snapshot?.files?.filter(safePath))].sort();
      for (const file of files.slice(0, 24)) add('file snapshot', { path: file }, m, file);
      if (files.length > 24) add('limite snapshot', { omitted: files.length - 24 }, m);
      if (m.time?.completed && !m.error) {
        const prose = assistantText(m);
        const terminal = m.finish === 'stop' || (!m.finish && m === conclusion && state !== 'in esecuzione');
        let heading;
        let reviewBlockers = false;
        let excerpts = 0;
        for (const [index, line] of proseLines(prose).slice(0, 80).entries()) {
          const normalized = line.replace(/^(?:[-*]|\d+[.)])\s+/, '').replaceAll('**', '');
          if (/^\s*\|/.test(line)) continue;
          if (terminal && !child && bundleRevision.test(normalized)) {
            const statement = narrative(normalized, 410);
            const revision = statement && bundleRevision.exec(statement)?.[1];
            if (revision) add('revisione bundle dichiarata', { revision }, m, index, undefined, 'REPORTED');
          }
          if (terminal && /^(?:Request changes|Changes requested|Richieste modifiche)\b/i.test(normalized)) {
            reviewBlockers = /\b(?:blockers?|blocchi)\b/i.test(normalized);
            mention('verdetto review', normalized, index, 340);
            continue;
          }
          const field = /^(?:#+\s*)?([^:]{1,42}):\s*(.+)$/.exec(normalized);
          if (line.startsWith('#')) heading = labels.find(([, regex]) => regex.test(normalized.replace(/^#+\s*/, '')))?.[0];
          const kind = field && labels.find(([, regex]) => regex.test(field[1]))?.[0];
          const bullet = /^(?:[-*]|\d+[.)])\s/.test(line);
          if (terminal && /(?:^Autorizzi\b|\b(?<!non )(?:serve|manca) (?:solo )?(?:un |il )?(?:nuovo )?GO\b)/i.test(normalized)) {
            mention('GO mancante', normalized, index, 400);
            mention('prossimo passo', normalized, index, 400);
            continue;
          }
          if (terminal && /\b(?:il prossimo passo è|the next step is|prima di un nuovo tentativo (?:serve|occorre))\b/i.test(normalized)) {
            mention('prossimo passo', normalized, index, 400);
          }
          if (terminal && !child && /\b(?:passerà|procederà) (?:subito )?(?:da|solo se)\b/i.test(normalized) &&
              /\b(?:solo se|a condizione che|dopo)\b/i.test(normalized)) {
            mention('prossimo passo', normalized, index, 410);
          }
          if (terminal && !child && /\brecovery\b[^.!?]{0,55}\bin corso\b/i.test(normalized)) {
            mention('attività documentata in corso', normalized, index, 410);
            if (/\bnon è (?:ancora )?confermat[oa]\b/i.test(normalized)) mention('aperto', normalized, index, 410);
          }
          if (kind) {
            mention(kind, field[2], index, terminal ? 410 : 180);
          } else if (bullet && (heading || reviewBlockers)) {
            mention(heading ?? 'bloccato', normalized, index, 450);
          } else if (terminal && !line.startsWith('#') && excerpts < (child ? 4 : 6) && narrative(normalized, 410)) {
            excerpts++;
          const operational = !child && /\b(?:recovery|fleet|promozion[ei]|non (?:è )?completat[oa]|produzion[ei]|stato operativo|servizi rispondono)\b/i.test(normalized);
            mention(/^(?:correzione su|commit|revisione)\s/i.test(normalized) ? 'revisione dichiarata' :
              operational ? 'operazioni' : 'risultato', normalized, index, 410);
          }
        }
      }
      for (const [index, part] of m.content.entries()) {
        // `executed` marks provider-hosted tools, not local tool completion.
        if (part.type !== 'tool' || part.executed === true) continue;
        const { status, input, metadata, content, error } = part.state;
        if (part.name === 'shell') {
          const notice = shellNotices.get(metadata?.shellID);
          const shellState = notice?.metadata.state ?? metadata?.status;
          const row = shellEvidence(input?.command, notice?.metadata.exit ?? metadata?.exit,
            !notice && (status === 'running' || shellState === 'running'),
            status === 'error' || metadata?.interrupted || ['timeout', 'killed', 'cancelled', 'error'].includes(shellState) ||
              metadata?.timeout || metadata?.killed,
            content?.find((item) => item.type === 'text')?.text);
          if (row) {
            if (['running', 'exited', 'timeout', 'killed', 'completed', 'cancelled', 'error'].includes(shellState)) row.data.state = shellState;
            if (metadata?.interrupted === true) row.data.state = 'interrupted';
            if (notice) row.data.confirmedBy = { session: session.id, message: notice.id };
            add(row.kind, row.data, m, index, part.id, 'OBSERVED', notice?.time.created ?? part.time?.completed ?? m.time?.created);
            if (row.kind === 'test tecnico') row.data.workdirKey = digest(input?.workdir ?? null);
          }
        } else if (part.name === 'patch' && status === 'completed' && Array.isArray(metadata?.files)) {
          for (const item of metadata.files.slice(0, 24)) {
            if (safePath(item?.file)) add('file patch', { path: item.file, change: clean(item.status) }, m, item.file, part.id);
          }
          if (metadata.files.length > 24) add('limite patch', { omitted: metadata.files.length - 24 }, m, index, part.id);
        } else if (status === 'error') {
          add('errore tool', { tool: clean(part.name), errorType: clean(error?.type) }, m, index, part.id);
        }
      }
    }
  }
  return facts;
}

async function pages(list, input, options, limit) {
  const data = [];
  let cursor;
  do {
    let page;
    try {
      page = await list({ ...input, ...(cursor ? { cursor } : { order: 'desc' }),
        limit: Math.min(80, limit - data.length) }, options);
    } catch (error) {
      if (!data.length) throw error;
      return { data, partial: true };
    }
    data.push(...page.data);
    const next = page.cursor?.next;
    if (next === cursor) break;
    cursor = next;
  } while (cursor && data.length < limit);
  return { data, partial: Boolean(cursor) };
}

async function readFamily(client, sessionID, signal) {
  const { session, message, permission } = client;
  const options = { signal };
  const omissions = new Set();
  const family = [];
  let root = await session.get({ sessionID }, options);
  const visited = new Set([root.id ?? sessionID]);
  while (root.parentID && !visited.has(root.parentID) && visited.size < 16) {
    visited.add(root.parentID);
    root = await session.get({ sessionID: root.parentID }, options);
  }
  const discovered = new Set([root.id]);
  async function read(entry) {
    const request = { sessionID: entry.id };
    const row = { session: entry, messages: [] };
    const [history, children, permissions] = await Promise.allSettled([
      pages(message.list, request, options, entry === root ? 240 : 120),
      pages(session.list, { parentID: entry.id }, options, 24),
      permission.list(request, options),
    ]);
    if (history.status === 'fulfilled') row.messages = history.value.data;
    row.partialHistory = history.status !== 'fulfilled' || history.value.partial;
    if (history.status === 'rejected' || history.value.partial) omissions.add('cronologia nativa non interamente disponibile');
    if (permissions.status === 'fulfilled') row.permissions = permissions.value.length;
    else omissions.add('permessi nativi non interamente disponibili');
    if (children.status === 'rejected' || children.value.partial) omissions.add('gerarchia figli non interamente disponibile');
    return { row, children: children.value?.data ?? [] };
  }
  let level = [root];
  while (level.length) {
    const result = await Promise.all(level.map(read));
    family.push(...result.map(({ row }) => row));
    level = [];
    for (const entry of result.flatMap(({ children }) => children)) {
      if (entry.fork || discovered.has(entry.id)) continue;
      if (discovered.size >= 25) { omissions.add('limite di 24 sessioni figlie'); break; }
      discovered.add(entry.id);
      level.push(entry);
    }
  }
  const directory = root.location?.directory;
  const [active, vcs, tree, first, users] = await Promise.allSettled([
    session.active(options),
    directory && client.vcs?.get({ location: { directory } }, options),
    directory && client.vcs?.status({ location: { directory } }, options),
    message.list({ sessionID: root.id, type: 'user', order: 'asc', limit: 1 }, options),
    message.list({ sessionID: root.id, type: 'user', order: 'desc', limit: 60 }, options),
  ]);
  const activeSessions = active.value;
  if (!activeSessions) omissions.add('stato delle esecuzioni attive non disponibile');
  const currentBranch = clean(vcs.value?.data?.branch?.current);
  const workingTree = Array.isArray(tree.value?.data) ? {
    changed: tree.value.data.length,
    paths: tree.value.data.filter(({ file }) => safePath(file)).map(({ file, status }) => ({ file, status: clean(status) }))
      .sort((a, b) => a.file.localeCompare(b.file)).slice(0, 12),
  } : null;
  if (workingTree?.changed > workingTree?.paths.length) omissions.add('elenco working tree parziale o redatto');
  if (!users.value || users.value.cursor?.next) omissions.add('cronologia mandati parziale (ultimi 60 messaggi utente)');
  return { family, active: activeSessions, omissions, first: first.value?.data[0], users: users.value?.data,
    project: clean(directory?.split('/').at(-1)), currentBranch, workingTree };
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capacity = 110;
const metrics = new Set(['step', 'compaction']);

function review(rows, family, active) {
  const models = new Map(), repetitions = new Map();
  for (const row of rows) {
    const data = row.data;
    if (metrics.has(row.kind)) {
      const key = JSON.stringify([data.agent, data.model, data.effort]);
      const value = models.get(key) ?? { agent: data.agent, model: data.model, effort: data.effort,
        steps: 0, compactions: 0, durationMs: null, tokens: {} };
      value[row.kind === 'step' ? 'steps' : 'compactions']++;
      if (data.durationMs !== null) value.durationMs = (value.durationMs ?? 0) + data.durationMs;
      for (const [name, count] of Object.entries(data.tokens)) value.tokens[name] = (value.tokens[name] ?? 0) + count;
      models.set(key, value);
    }
    if (data.command && !data.scopeRedacted) {
      const key = JSON.stringify([data.command, data.testScopeKey ?? null]);
      const entry = repetitions.get(key) ?? { command: data.command, count: 0, ...(data.testsRun ? { testsRun: data.testsRun } : {}) };
      entry.count++;
      repetitions.set(key, entry);
    }
  }
  const childStates = family.slice(1).map(({ session, messages }) => status(session, active, messages));
  return {
    confidence: 'OBSERVED',
    usage: [...models.values()],
    subagents: { observed: childStates.length, completed: childStates.filter((s) => s === 'concluso').length,
      failed: childStates.filter((s) => s === 'fallito').length,
      running: childStates.filter((s) => s === 'in esecuzione').length,
      interrupted: childStates.filter((s) => s === 'interrotto').length },
    recordedErrors: rows.filter(({ confidence, kind, data }) => confidence === 'OBSERVED' &&
      (['errore o retry step', 'errore tool', 'esecuzione non riuscita'].includes(kind) || data.result === 'FAIL' ||
        kind === 'compaction' && data.state === 'failed')).length,
    stepsWithRetry: rows.filter(({ kind, data }) => kind === 'errore o retry step' && data.retry).length,
    repeatedCommands: [...repetitions.values()].filter(({ count }) => count > 1).slice(0, 8),
  };
}

function scopeFacts(family, active, floor, goal) {
  const facts = collect(family, active, floor, goal);
  const rows = [...facts.values()];
  const laterPasses = new Map();
  const completedRecovery = new Map();
  for (const row of [...rows].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    const text = row.data.text ?? '';
    const closure = completedRecovery.get(row.ref.session);
    if (row.confidence === 'REPORTED' && recoveryCompleted.test(text)) {
      completedRecovery.set(row.ref.session, row);
    } else if (closure?.at > row.at && /\brecovery\b[^.!?]{0,55}\bin corso\b/i.test(text) &&
      (!/\b(?:gate|scheduler)\b/i.test(text) ||
        /\b(?:gate(?: dello scheduler)?|scheduler) (?:(?:è stato|è) )?ripristinat[oa]\b/i.test(closure.data.text))) {
      row.data.supersededBy = closure.ref;
    }
    if (row.kind !== 'test tecnico' || !row.data.testScopeKey) continue;
    const key = JSON.stringify([row.ref.session, row.data.testScopeKey, row.data.workdirKey ?? null]);
    const pass = laterPasses.get(key);
    if (row.data.result === 'PASS') laterPasses.set(key, row);
    if (row.data.result === 'FAIL' && pass?.at > row.at) row.data.laterPass = pass.ref;
  }
  for (const row of rows) delete row.data.workdirKey;
  const parents = new Map(family.slice(1).map(({ session }) => [session.id, session.parentID ?? family[0].session.id]));
  for (const applied of rows.filter(({ data }) => data.appliedCommit)) {
    const candidates = rows.filter(({ ref, data }) => parents.get(ref.session) === applied.ref.session &&
      data.source === 'commit' && (data.revision.startsWith(applied.data.appliedCommit) ||
        applied.data.appliedCommit.startsWith(data.revision)));
    if (candidates.length !== 1) continue;
    const [source] = candidates;
    facts.set(JSON.stringify(['integrated', applied.ref, source.ref]), {
      confidence: 'OBSERVED', kind: 'commit figlio integrato', ref: applied.ref, at: applied.at,
      data: { commit: applied.data.appliedCommit, source: source.ref },
    });
  }
  return facts;
}

export async function buildHandoff(client, sessionID, requested, { profile, checkpoints = {} } = {}) {
  const { family, active, omissions, first, users, project, currentBranch, workingTree } =
    await readFamily(client, sessionID, AbortSignal.timeout(12000));
  const [parent] = family;
  const session = parent.session.id;
  const saved = checkpoints[session];
  const previous = saved?.version === 1 && /^[0-9a-f]{64}$/.test(saved.id) && saved.fingerprints ? saved : null;
  const scope = requested === 'incremental' && !previous ? 'session' : requested;
  if (scope !== requested) omissions.add('checkpoint precedente assente o non valido: export sessione');
  if (scope === 'incremental' && typeof previous.through !== 'number') {
    omissions.add('checkpoint precedente senza limite temporale: le differenze non attestano quando è avvenuto un evento');
  }
  const userMessages = users ?? parent.messages.filter(({ type }) => type === 'user');
  const timeline = mandateTimeline(session, userMessages);
  const goal = userMessages.find(({ id }) => id === timeline.current?.ref.message) ?? userMessages[0];
  if (scope === 'latest' && !goal && omissions.has('cronologia nativa non interamente disponibile')) {
    throw new Error('Latest assignment boundary unavailable');
  }
  const effectiveStart = Math.max(goal?.time?.created ?? 0, timeline.lastControl?.at ?? 0);
  const operatorUpdate = timeline.rows.findLast((row) => row.kind === 'autorizzazione storica' &&
    row.at >= (timeline.current?.at ?? effectiveStart));
  // Later instructions make earlier requests historical; a GO does not prove any gate was met.
  const currentSince = Math.max(effectiveStart, operatorUpdate?.at ?? 0);
  const floor = scope === 'latest' ? effectiveStart : 0;
  const scoped = new Set([session]);
  for (const item of family.slice(1)) {
    const created = item.session.time?.created ?? -1;
    const linked = family.some(({ messages }) => messages.some((m) => (m.time?.created ?? 0) >= floor &&
      (m.metadata?.childID === item.session.id || (m.type === 'assistant' && m.content.some((part) =>
        part.type === 'tool' && part.name === 'subagent' &&
        [part.state.input?.sessionID, part.state.metadata?.sessionID].includes(item.session.id))))));
    if (!floor || created >= floor || linked || item.messages.some((m) => (m.time?.created ?? 0) >= floor)) scoped.add(item.session.id);
  }
  for (const { session: child } of family.slice(1).reverse()) {
    if (child.parentID && scoped.has(child.id)) scoped.add(child.parentID);
  }
  const selected = family.filter((item) => scoped.has(item.session.id));
  const activeMap = active ?? {};
  const history = scope === 'latest' ? scopeFacts(family, activeMap, 0, first) : null;
  const facts = scopeFacts(selected, activeMap, floor, scope === 'latest' ? goal : first);
  const operationalKinds = ['operazioni', 'risultato', 'completato', 'revisione dichiarata', 'prossimo passo',
    'attività documentata in corso', 'GO mancante'];
  const parentFinal = [...(history ?? facts).values()].filter((row) => row.ref.session === session &&
    operationalKinds.includes(row.kind) && parent.messages.some((m) => m.id === row.ref.message && !m.error &&
      m.type === 'assistant' && m.time?.completed && (!m.finish || m.finish === 'stop')))
    .sort((a, b) => b.at - a.at)[0];
  const fromFinal = (row) => parentFinal && row.ref.session === session && row.ref.message === parentFinal.ref.message;
  const inherited = Boolean(parentFinal && parentFinal.at < currentSince);
  if (history && inherited) {
    for (const [key, row] of history) if (fromFinal(row) && operationalKinds.includes(row.kind)) facts.set(key, row);
  }
  const canceled = new Set(timeline.rows.filter((row) => row.disposition === 'annullato').map(({ ref }) => ref.message));
  for (const [key, row] of facts) {
    if (row.kind === 'criterio di accettazione' && row.ref.session === session && canceled.has(row.ref.message)) facts.delete(key);
  }
  for (const row of timeline.rows) {
    if (scope !== 'latest' || row === timeline.current || row.at >= floor) {
      facts.set(`mandate:${row.ref.message}`, row);
    }
  }
  const taskDirective = operatorUpdate ?? timeline.lastControl;
  const resume = userMessages.find(({ id }) => id === taskDirective?.ref.message);
  if (resume && timeline.lastControl?.kind !== 'STOP') {
    const numbered = proseLines(resume.text).filter((line) => /^\d+[.)]\s/.test(line));
    const guidance = numbered.length ? numbered : proseLines(goal?.text).filter((line) => /^\d+[.)]\s/.test(line));
    for (const [i, line] of guidance.slice(0, 10).entries()) {
      const text = clean(line.replace(/^\d+[.)]\s+/, ''), 240);
      if (text) facts.set(`requirement:${resume.id}:${i}`, {
        confidence: 'REPORTED', kind: 'requisito corrente',
        ref: numbered.length ? taskDirective.ref : timeline.current.ref,
        at: numbered.length ? taskDirective.at : timeline.current.at,
        data: { text },
      });
    }
  }
  facts.set('workingTree', {
    confidence: workingTree || currentBranch ? 'OBSERVED' : 'UNKNOWN',
    kind: 'working tree attuale', ref: { session }, at: null, data: { branch: currentBranch, ...workingTree },
  });
  if (client.experimental?.job) {
    try {
      const jobs = await client.experimental.job.list({ sessionID: session, kind: 'shell', descendants: true },
        { signal: AbortSignal.timeout(3000) });
      const shellJobs = jobs.filter((job) => job.kind === 'shell' && scoped.has(job.sessionID) &&
        (job.status === 'running' || (job.time?.completed ?? job.time?.started ?? 0) >= floor))
        .sort((a, b) => (b.time?.completed ?? b.time?.started ?? 0) - (a.time?.completed ?? a.time?.started ?? 0));
      if (shellJobs.length > 40) omissions.add('lista dei lavori in background limitata');
      for (const job of shellJobs.slice(0, 40)) facts.set(`job:${job.id}`, {
        confidence: 'OBSERVED', kind: 'lavoro in background', ref: { session: job.sessionID, job: job.id },
        at: job.time?.completed ?? job.time?.started ?? null,
        data: { state: job.status, started: job.time?.started ?? null, completed: job.time?.completed ?? null },
      });
    } catch {
      omissions.add('stato nativo dei lavori in background non disponibile');
    }
  }
  const ranked = [...facts].sort(([, a], [, b]) => (b.at ?? Infinity) - (a.at ?? Infinity));
  const all = ranked.map(([, fact]) => fact);
  const fingerprints = Object.assign(Object.create(null), previous?.fingerprints);
  const todoFacts = ranked.filter(([, row]) => row.kind === 'TODO nativi');
  const changed = ranked.map(([key, fact]) => fact.kind === 'TODO nativi' ?
    [digest(`todo-state:${fact.ref.session}`), digest(fact.data), fact, digest(key)] : [digest(key), digest(fact), fact])
    .filter(([key, hash, row, legacy]) => scope !== 'incremental' || (fingerprints[key] !== hash &&
      !(legacy && !fingerprints[key] && (fingerprints[legacy] === digest(row) ||
        (previous.through != null && row.at <= previous.through)))));
  const visible = changed.filter(([key, , fact]) => fact.kind !== 'step' &&
    (fact.kind !== 'permessi in attesa' || fact.data.count > 0 || (scope === 'incremental' && fingerprints[key])) &&
    (fact.kind !== 'shell' || fact.data.command || fact.data.result !== 'PASS' ||
      (scope === 'incremental' && fingerprints[key])));
  const isMandate = (row) => row.disposition !== undefined;
  const childResults = new Map();
  for (const row of all) {
    if (row.ref.session !== session && ['risultato', 'completato', 'verdetto review'].includes(row.kind) &&
        !childResults.has(row.ref.session)) childResults.set(row.ref.session, row);
  }
  const priority = (row) => fromFinal(row) || row === timeline.current || ({
    'requisito corrente': true, 'stato coordinatore': true, 'working tree attuale': true, 'TODO nativi': true,
    'lavoro in background': true, 'esito shell in background': true,
  })[row.kind] ? 0 : !row.data.supersededBy && (row.at >= effectiveStart || row.ref.session !== session) &&
    ['bloccato', 'verdetto review'].includes(row.kind) ? 0.25 :
    childResults.get(row.ref.session) === row ? 0.4 : row.at >= effectiveStart && row.ref.session === session &&
    (/^file /.test(row.kind) || row.kind === 'test tecnico' || row.data.revision) ? 0.5 :
    row.data.revision || row.data.appliedCommit || row.data.diagnostic || recoveryCompleted.test(row.data.text ?? '') ||
    row.kind === 'compaction' && row.data.state === 'failed' ||
    row.disposition === 'annullato' || ({
    'test tecnico': true, 'digest verificato': true, 'revisione dichiarata': true, decisione: true,
    'criterio di accettazione': true, 'esecuzione non riuscita': true, 'errore o retry step': true,
    risultato: true, aperto: true, subagente: true, 'notifica figlio al coordinatore': true,
  })[row.kind] || isMandate(row) ? 1 : 2;
  const seenEvidence = new Map(), grouped = new Map();
  const concise = visible.filter(([fingerprint, hash, row]) => {
    if (scope === 'incremental') return true;
    const field = /^file /.test(row.kind) ? [row.data.path, row.data.change] :
      row.kind === 'test tecnico' && !row.data.scopeRedacted ?
        [row.data.command, row.data.testScopeKey, row.data.result, row.data.skipped, row.data.laterPass] :
      row.kind === 'shell' && !row.data.revision && !row.data.appliedCommit ?
        [row.data.command, row.data.result, row.data.exit, row.data.diagnostic, row.data.commandFamily, row.data.state] :
      row.kind === 'evento sintetico' ? ['synthetic'] : null;
    if (!field) return true;
    const key = JSON.stringify([row.ref.session, row.kind, ...field]);
    if (seenEvidence.has(key)) {
      const canonical = seenEvidence.get(key);
      const entries = grouped.get(canonical) ?? [];
      entries.push([fingerprint, hash, row]);
      grouped.set(canonical, entries);
      return false;
    }
    seenEvidence.set(key, fingerprint);
    return true;
  });
  if (visible.length !== concise.length) omissions.add(`${visible.length - concise.length} attestazioni ripetute raggruppate`);
  if (concise.length > capacity) omissions.add(`${concise.length - capacity} evidenze oltre il limite di copia`);
  const copied = concise.sort(([, , a], [, , b]) => priority(a) - priority(b)).slice(0, capacity);
  const baseline = history ? [
    ...history,
    ...timeline.rows.map((row) => [`mandate:${row.ref.message}`, row]),
  ].map(([key, value]) => [digest(key), digest(value)]) : [];
  for (const [key, hash] of (requested === 'incremental' ?
    [...copied, ...copied.flatMap(([key]) => grouped.get(key) ?? []),
      ...changed.filter(([, , fact]) => fact.kind === 'step')] : [...baseline, ...changed])) {
    delete fingerprints[key];
    fingerprints[key] = hash;
  }
  for (const [, row] of todoFacts) {
    const key = digest(`todo-state:${row.ref.session}`);
    if (!changed.some(([changedKey]) => changedKey === key)) fingerprints[key] = digest(row.data);
  }
  const id = digest([session, scope, previous?.id ?? null, changed.map(([key, hash]) => [key, hash])]);
  const revisions = history ? [...history.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) : all;
  const heads = revisions.filter((row) => row.ref.session === session && row.data.source === 'HEAD');
  const lastCommit = revisions.find((row) => row.ref.session === session && row.data.source === 'commit');
  const next = inherited || timeline.lastControl?.kind === 'STOP' ? undefined :
    all.find((row) => row.kind === 'prossimo passo' && fromFinal(row)) ??
    all.find((row) => row.kind === 'attività documentata in corso' && fromFinal(row));
  const gates = all.filter((row) => ['GO mancante', 'bloccato', 'aperto'].includes(row.kind) && fromFinal(row) &&
    !inherited && !row.data.supersededBy).slice(0, 5);
  const evidence = copied.map(([, , fact]) => fact);
  for (const [key, , row] of copied) {
    const refs = [...new Map([...(row.relatedRefs ?? []),
      ...(grouped.get(key) ?? []).map(([, , item]) => item.ref)]
      .map((ref) => [JSON.stringify(ref), ref]).filter(([ref]) => ref !== JSON.stringify(row.ref))).values()];
    if (refs.length) row.relatedRefs = refs;
  }
  for (const row of evidence) {
    if (row.at && !isMandate(row) && row.ref.session === session) {
      const boundary = timeline.rows.findLast(({ at }) => at <= row.at);
      if (boundary) row.turn = boundary.ref;
      if (['GO mancante', 'prossimo passo', 'attività documentata in corso', 'operazioni', 'risultato',
        'aperto', 'bloccato'].includes(row.kind) && (row.at < currentSince || !fromFinal(row))) row.historical = true;
    }
  }
  const operational = (scope === 'incremental' ? all : evidence).filter((row) => fromFinal(row) &&
    ['operazioni', 'risultato', 'completato'].includes(row.kind));
  const subagents = selected.slice(1).flatMap(({ session: child }) => {
    const rows = evidence.filter((row) => row.ref.session === child.id);
    if (!rows.length) return [];
    const native = all.find((row) => row.ref.session === child.id && row.kind === 'subagente');
    return [{ session: child.id, ...native?.data, evidence: rows.filter((row) => row !== native) }];
  });
  const executionRows = scope === 'incremental' ? changed.map(([, , fact]) => fact) : all;
  const changedSessions = new Set(changed.filter(([key, , row]) =>
    row.kind === 'subagente' && previous?.fingerprints[key] ||
    typeof previous?.through === 'number' && row.at > previous.through).map(([, , row]) => row.ref.session));
  const execution = review(executionRows, scope === 'incremental' ?
    [parent, ...selected.slice(1).filter(({ session }) => changedSessions.has(session.id))] : selected, activeMap);
  const sessionExecution = scope === 'incremental' ? review(all, selected, activeMap) : null;
  for (const row of evidence) delete row.data.testScopeKey;
  execution.scope = scope === 'incremental' ? 'eventi nuovi o aggiornati' : scope;
  if (scope === 'incremental') {
    for (const [key, , row] of copied) {
      row.change = previous.fingerprints[key] ? 'aggiornato' :
        previous.through == null || row.at == null || row.at <= previous.through ? 'non presente nel checkpoint' : 'nuovo';
    }
  }
  const declaration = revisions.find((row) => row.ref.session === session && row.kind === 'revisione dichiarata' &&
    /\b[0-9a-f]{7,12}\b/i.test(row.data.text));
  const declaredBundle = revisions.find((row) => row.ref.session === session && row.kind === 'revisione bundle dichiarata');
  const revisionReport = (row, revision) => row ? { revision, ref: row.ref, at: row.at, confidence: 'REPORTED' } : null;
  const lastDeclaredCommit = revisionReport(declaration, declaration && /\b[0-9a-f]{7,12}\b/i.exec(declaration.data.text)[0]);
  const lastDeclaredBundle = revisionReport(declaredBundle, declaredBundle?.data.revision);
  const rootTodo = todoFacts.find(([, row]) => row.ref.session === session)?.[1];
  const todoItem = !next && rootTodo?.at >= (goal?.time.created ?? 0) ?
    rootTodo.data.items.find((item) => item.status === 'in_progress') ??
    rootTodo.data.items.find((item) => item.status === 'pending') : null;
  const summarizeCoverage = (items) => {
    const times = items.flatMap(({ messages }) => messages.map((m) => m.time?.created).filter((at) => at >= floor));
    return { sessions: items.length, messages: times.length, partialSessions: items.filter((item) => item.partialHistory).length,
      from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null };
  };
  execution.completionWithoutLocalEvidence = executionRows.filter((row) => (row.kind === 'completato' ||
    row.kind === 'subagente' && row.data.state === 'concluso') && !all.some((other) =>
    other.ref.session === row.ref.session && (/^file /.test(other.kind) || other.kind === 'test tecnico' ||
      other.data.source === 'commit'))).slice(0, 8).map(({ ref, kind }) => ({ ref, kind }));
  return { report: {
    version: 1, id, scope, previous: scope === 'incremental' ? previous.id : null,
    context: {
      confidence: 'OBSERVED', session, projectID: /^[0-9a-f]{40,64}$/.test(parent.session.projectID) ?
        parent.session.projectID : clean(parent.session.projectID), project, profile: profile ?? null,
      interval: { from: floor || first?.time?.created || parent.session.time?.created || null,
        to: Math.max(...selected.map((item) => item.messages[0]?.time?.created ?? 0)) || null },
      firstRecordedHead: heads.at(-1)?.data.revision ?? null,
      lastRecordedHead: heads[0]?.data.revision ?? null,
      lastRecordedCommit: lastCommit?.data.revision ?? null,
      currentHead: { confidence: 'UNKNOWN', reason: 'L’API VCS non espone lo SHA del HEAD corrente.' },
      lastDeclaredCommit,
      lastDeclaredBundle,
      lastDeclaredRevision: (lastDeclaredBundle?.at ?? -1) >= (lastDeclaredCommit?.at ?? -1) && lastDeclaredBundle ?
        { ...lastDeclaredBundle, kind: 'bundle' } : lastDeclaredCommit ? { ...lastDeclaredCommit, kind: 'commit' } : null,
    },
    evidence,
    currentMandate: timeline.current ?? null,
    originalMandate: first ? { ref: { session, message: first.id },
      text: clean(proseLines(first.text)[0]?.replace(/^#+\s*/, ''), 230) } : null,
    lastControl: timeline.lastControl ?? null,
    latestAuthorization: operatorUpdate ?? null,
    mandates: evidence.filter(isMandate).sort((a, b) => a.at - b.at),
    operational,
    operationalInherited: inherited || scope === 'incremental' && Boolean(parentFinal) && !evidence.some(fromFinal),
    todos: (scope === 'incremental' ? evidence : all).filter((row) => row.kind === 'TODO nativi'),
    todoContext: todoFacts.map(([, row]) => ({ ref: row.ref, at: row.at, total: row.data.total, counts: row.data.counts })),
    nextTodo: todoItem ? { ...todoItem, ref: rootTodo.ref, confidence: 'OBSERVED', authorization: 'UNKNOWN' } : null,
    subagents,
    pendingPermissions: selected.reduce((sum, item) => sum + (item.permissions ?? 0), 0),
    pendingPermissionsUnknown: selected.filter(({ permissions }) => permissions === undefined).length,
    execution,
    coverage: { root: summarizeCoverage([parent]), children: summarizeCoverage(selected.slice(1)),
      hierarchyPartial: omissions.has('gerarchia figli non interamente disponibile') || omissions.has('limite di 24 sessioni figlie') },
    ...(sessionExecution ? { sessionExecution } : {}),
    residualGates: gates,
    nextStep: next ?? { confidence: 'UNKNOWN', data: { text: UNKNOWN } },
    unknown: [
      'Richieste provider esatte, retry non proiettati nei messaggi, effort non registrato e consumo quota.',
      'Proprietà del WIP e revisione esatta dei test senza prova esplicita.',
      'Integrazione dei figli non provata da una notifica o da una dichiarazione; un cherry-pick riuscito attesta solo quel commit.',
      'Installazione, recovery e GO correnti non si deducono da PASS tecnici o autorizzazioni storiche.',
    ].map((text) => ({ confidence: 'UNKNOWN', text })),
    omissions: [...omissions, 'Estratti filtrati e limitati; esclusi ragionamenti, allegati e output grezzi.'],
  }, checkpoint: { version: 1, id, through: Math.max(previous?.through ?? 0, ...all.map((fact) => fact.at ?? 0)),
    fingerprints: Object.fromEntries(Object.entries(fingerprints).slice(-16000)) } };
}

export function renderMarkdown(report) {
  const formatData = (data) => Object.entries(data).filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ');
  const date = (at) => at ? new Date(at).toISOString() : '';
  const coverageLine = ({ sessions, messages, partialSessions, from, to }) =>
    `${messages} messaggi da ${sessions} sessioni; ${partialSessions} con lettura parziale` +
      (from ? `; da ${date(from)} a ${date(to)}` : '');
  const refText = (ref, owner = report.context.session) =>
    [ref.session !== owner || !(ref.message || ref.job) ? ref.session : null, ref.message, ref.call, ref.job].filter(Boolean).join('/');
  const formatRow = ({ confidence, kind, data, ref, relatedRefs, disposition, at, change, historical }) =>
    `- **${confidence}** · ${kind}${disposition ? ` (${disposition})` : ''}${data.supersededBy ? ' (storico, superato)' :
      historical ? ' (storico)' : ''}${change ? ` · ${change}` : ''} · ` +
    `${at ? `${date(at)} · ` : ''}${formatData(data)}${ref ? ` (${[ref, ...(relatedRefs ?? [])].map((item) => refText(item, ref.session)).join('; ')})` : ''}`;
  const rowKey = (row) => JSON.stringify([row.kind, row.ref, row.at, row.data]);
  const includes = (rows, row) => rows.some((r) => rowKey(r) === rowKey(row));
  const remaining = new Map(report.evidence.filter((row) => row.ref.session === report.context.session)
    .map((row) => [rowKey(row), row]));
  const take = (rows, transform = formatRow) => rows.map((row) => {
    remaining.delete(rowKey(row));
    return transform(row);
  });
  const section = (name, rows, empty = '- **UNKNOWN** · nessuna evidenza nella finestra letta.') =>
    [`## ${name}`, ...(rows.length ? rows : [empty]), ''];
  const root = (match) => [...remaining.values()].filter(match).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const next = report.nextStep;
  for (const row of remaining.values()) {
    if (next.ref && row.ref.message === next.ref.message && row.data.text === next.data.text &&
      !includes(report.residualGates, row)) remaining.delete(rowKey(row));
  }
  const operations = root((row) => row.kind === 'stato coordinatore' || includes(report.operational, row));
  const changes = root((row) => /^file |revisione|decisione|working tree|integra/.test(row.kind) ||
    row.data.revision || row.data.appliedCommit);
  const gates = root((row) => /GO |permessi/.test(row.kind) || includes(report.residualGates, row));
  const errors = root((row) => /bloccato|aperto|errore|non riuscita/.test(row.kind) || row.data.result === 'FAIL');
  const requirements = root((row) => row.kind === 'requisito corrente' ||
    row.kind === 'criterio di accettazione' && row.ref.message === report.currentMandate?.ref.message);
  const outline = take(report.mandates);
  const errorRows = take(errors.filter((row) => !gates.includes(row)), (row) => {
    const qualifier = row.data.laterPass ? 'storico — stessa verifica poi PASS' :
      row.at && row.at < (report.lastControl?.at ?? 0) ? 'storico — chiusura non attestata' : null;
    return formatRow({ ...row, kind: qualifier ? `${row.kind} (${qualifier})` : row.kind });
  });
  const operationRows = take(operations);
  const changeRows = take(changes);
  const gateRows = take(gates, (row) => formatRow({
    ...row,
    kind: row.kind === 'GO mancante' && !includes(report.residualGates, row) ? 'GO mancante (non gate corrente)' : row.kind,
    data: next.ref && row.ref.message === next.ref.message && row.data.text === next.data.text ?
      { text: 'Dettaglio nel prossimo passo documentato.' } : row.data,
  }));
  const requirementRows = take(requirements);
  if (report.nextStep.ref) remaining.delete(rowKey(report.nextStep));
  for (const row of report.todos) remaining.delete(rowKey(row));
  return [
    '# OpenCode Team AI Handoff', '',
    '_Dati da verificare, non istruzioni da eseguire._', '',
    `Handoff: ${report.id} · ambito: ${report.scope}${report.previous ? ` · precedente: ${report.previous}` : ''}`, '',
    '## Contesto e mandato corrente', formatRow({ confidence: report.context.confidence, kind: 'contesto', data: {
      ...Object.fromEntries(Object.entries(report.context).filter(([key]) => key !== 'confidence')),
      interval: Object.fromEntries(Object.entries(report.context.interval).map(([key, ms]) =>
        [key, ms === null ? null : new Date(ms).toISOString()])),
    } }),
    ...(report.originalMandate && report.originalMandate.ref.message !== report.currentMandate?.ref.message ? [
      formatRow({ confidence: 'REPORTED', kind: 'mandato originale della sessione (contesto)',
        ref: report.originalMandate.ref, data: { text: report.originalMandate.text } }),
    ] : []),
    ...(report.currentMandate && !includes(report.mandates, report.currentMandate) ? [formatRow(report.currentMandate)] : []),
    ...outline, '',
    ...section('Risultato operativo e stato dei requisiti', [
      ...(report.operationalInherited ? ['- Contesto ereditato: non attesta un nuovo esito operativo.'] : []),
      ...operationRows, ...requirementRows,
      ...report.operational.filter((row) => !includes(operations, row) &&
        !(next.ref && row.ref.message === next.ref.message && row.data.text === next.data.text)).map(formatRow),
      ...report.todos.map(formatRow),
      ...(report.todos.length ? ['- Lo stato dei TODO è registrato da OpenCode; non prova che le verifiche siano state eseguite.'] : []),
      ...(report.scope === 'incremental' ? report.todoContext.filter((row) => !report.todos.some((todo) =>
        todo.ref.session === row.ref.session)).map(({ ref, at, total, counts }) =>
        formatRow({ confidence: 'OBSERVED', kind: 'stato TODO (contesto, non delta)', ref, at, data: { total, counts } })) : []),
      '- Lo stato nativo dell’esecuzione non attesta il successo del mandato o dello stato produttivo.',
    ]),
    ...section('Modifiche, revisioni Git e decisioni', changeRows),
    ...section('Subagenti e risultati significativi', report.subagents.flatMap(({ session, evidence, ...data }) => [
      `### ${data.role ?? 'Subagente'}${data.assignment ? ` — ${data.assignment}` : ''}`,
      formatRow({ confidence: 'OBSERVED', kind: 'stato dell’esecuzione del figlio', ref: { session }, data }),
      ...evidence.filter((row) => row.kind !== 'TODO nativi').sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(formatRow), '',
    ])),
    ...section('Evidenze e verifiche valide', root((row) => true).map(formatRow)),
    ...section('Errori risolti e problemi aperti', errorRows),
    ...section('Autorizzazioni e gate residui', [
      `- Permessi in attesa nelle sessioni interrogabili: ${report.pendingPermissions}.` +
        (report.pendingPermissionsUnknown ? ` Dato non disponibile per ${report.pendingPermissionsUnknown} sessioni.` : '') +
        ' Un’autorizzazione storica non vale come nuovo GO.',
      ...(report.latestAuthorization && !includes(report.mandates, report.latestAuthorization) ?
        [formatRow({ ...report.latestAuthorization, kind: 'ultima autorizzazione riportata (contesto)' })] : []),
      ...gateRows,
    ]),
    ...section('Prossimo passo documentato', [
      formatRow({ kind: 'prossimo passo', ...report.nextStep }),
      ...(report.nextTodo ? [formatRow({ confidence: report.nextTodo.confidence, kind: 'TODO candidato (non autorizzazione)',
        ref: report.nextTodo.ref, data: { text: report.nextTodo.text, status: report.nextTodo.status } })] : []),
    ]),
    '## Execution review', `_Ambito: ${report.execution.scope}. Durata e token degli step registrati; non latenza o quota provider._`,
    `- Copertura letta — padre: ${coverageLine(report.coverage.root)}.`,
    `- Copertura letta — figli: ${coverageLine(report.coverage.children)}${report.coverage.hierarchyPartial ? '; gerarchia parziale' : ''}.`,
    '- Sono conteggi della finestra letta, non totali assoluti; possono calare se una lettura successiva copre meno eventi.',
    `- **OBSERVED** · subagenti: ${formatData(report.execution.subagents)}`,
    `- **OBSERVED** · errori registrati: ${report.execution.recordedErrors}; step con retry: ${report.execution.stepsWithRetry}`,
    ...report.execution.usage.map((row) => `- **OBSERVED** · ${formatData(row)}`),
    ...report.execution.repeatedCommands.map(({ command, count }) => `- **OBSERVED** · ripetizione candidata: ${command} (${count})`),
    ...report.execution.completionWithoutLocalEvidence.map(({ ref, kind }) =>
      formatRow({ confidence: 'UNKNOWN', kind: `evidenze di modifica/test per ${kind}`, ref, data: { text: UNKNOWN } })),
    ...(report.sessionExecution ? [
      '', '### Conteggi della sessione (solo finestra letta)',
      `- **OBSERVED** · subagenti: ${formatData(report.sessionExecution.subagents)}`,
      `- **OBSERVED** · errori registrati: ${report.sessionExecution.recordedErrors}; step con retry: ${report.sessionExecution.stepsWithRetry}`,
      ...report.sessionExecution.usage.map((row) => `- **OBSERVED** · ${formatData(row)}`),
    ] : []),
    '', '## Limiti dell’estrazione', ...report.unknown.map(({ confidence, text }) => `- **${confidence}** · ${text}`),
    ...report.omissions.map((value) => `- ${value}`), '',
  ].join('\n');
}

export function registerReport({ client, ui, keymap }, writeClipboard, settings = {}) {
  const current = () => ui.router.current();
  let copying = false;
  keymap.layer(() => ({
    mode: 'global',
    commands: [
      ['latest', 'ultimo incarico', 'handoff'],
      ['session', 'intera sessione', 'handoff-sessione'],
      ['incremental', 'incrementale', 'handoff-incrementale'],
    ].flatMap(([scope, title, name]) => [false, true].map((json) => ({
      id: scope === 'latest' && !json ? 'opencode-team.copy-report' : `opencode-team.${name}${json ? '-json' : ''}`,
      title: `AI Handoff: ${title}${json ? ' (JSON)' : ''}`,
      group: 'Sessione',
      palette: true,
      // Also intercept a manually typed or pasted slash command before native prompt submission.
      slash: { name: `${name}${json ? '-json' : ''}`, arguments: true,
        ...(scope === 'latest' && !json ? { aliases: ['copia-resoconto'] } : {}) },
      enabled: () => current().type === 'session',
      async run() {
        const route = current();
        if (route.type !== 'session' || copying) return;
        copying = true;
        try {
          const { report, checkpoint } = await buildHandoff(client, route.sessionID, scope, settings);
          const confirmed = await writeClipboard(json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
          if (confirmed === false) {
            ui.toast.show({ variant: 'warning', message: 'Copia inviata al terminale, non confermata. Checkpoint invariato.' });
            return;
          }
          try {
            await settings.saveCheckpoint?.(report.context.session, checkpoint);
            ui.toast.show({ variant: 'success', message: 'Handoff copiato negli appunti.' });
          } catch {
            ui.toast.show({ variant: 'warning', message: 'Handoff copiato; checkpoint non salvato.' });
          }
        } catch {
          ui.toast.show({ variant: 'error', message: 'Handoff non copiato: lettura o appunti non disponibili.' });
        } finally {
          copying = false;
        }
      },
    }))),
  }));
}
