import { createHash } from 'node:crypto';

const redacted = '[omesso]';
const sensitive = /(?:\b(?:authorization|bearer|password|passwd|creden[tz]ial\w*|api[ _-]?key|token|secret\w*|segret\w*|private[ _-]?key|chiave privata|cookie|sessionid)\b|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[\w-]{8,}|\b[\w-]{32,}\b|\b(?=[\w-]{18,}\b)(?=[\w-]*\d)[\w-]+\b|https?:\/\/|\S+@\S+|(?:^|[\s/])(?:~\/|\/|\.env\b)|\.(?:pem|key|p12)\b|[\p{C}])/iu;
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
    if ((sensitive.test(line) || credentialAssignment.test(line)) && /[:=]\s*$/.test(line)) { hideNext = true; return []; }
    return [line.trim()];
  }).filter(Boolean);
}

function scrubInline(value) {
  return value.trim().replace(/`([^`]+)`/g, (_, code) =>
    (safePath(code) && /[/.]/.test(code)) || testCommand.test(code) ||
    (/^[0-9a-f]{7,12}$/.test(code) && /\b(?:commit|git|branch|master|HEAD)\b/i.test(value)) ||
    /^(?:complete|prepared|finalized|promoted|idle|running|blocked|succeeded|failed)$/i.test(code) ||
    (/^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|HTTP \d{3})$/.test(code) && !sensitive.test(code)) ? code : '…');
}

function excerpt(value, limit = 180) {
  const line = scrubInline(value);
  if (!line || sensitive.test(line) || credentialAssignment.test(line) || /[`<>[\]{}\\|]/.test(line)) return redacted;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function shortText(value) {
  const line = proseLines(value).find((line) => !/^(?:#+\s|[-*]\s*$)/.test(line));
  if (!line) return undefined;
  const clean = excerpt(line.replace(/^[-*]\s+/, ''));
  return clean.split(/(?<=[.!?])\s/, 1)[0];
}

function safePath(file) {
  return typeof file === 'string' && file.length <= 120 && relativePath.test(file) && !sensitive.test(file) &&
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
  if (/^(?:AUTORIZZO\b|GO\s*[:—-]|approvo\b)/i.test(line)) return 'autorizzazione storica';
  if (/^(?:puoi procedere[.!]?$|prosegui\b|continua\b|riprendi\b|dobbiamo concludere questo lavoro\b|bene.*incarico.*originari)/i.test(line)) return 'continuazione';
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
    if (kind === 'mandato' || (kind === 'continuazione' && lines.some((line) => /^\d+[.)]\s/.test(line)))) current = row;
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
  const hideArgs = test && (command.length > 180 || sensitive.test(command));
  const head = gitHead.test(command);
  const commit = /^(?:git add [\w .\/-]+ && (?:git diff --cached --check && )?)?git commit(?: [^\n;&|<>`$]*)?$/.test(command);
  const cherry = /^git cherry-pick ([0-9a-f]{7,64})$/.exec(command);
  const checksumPath = /^(?:shasum -a 256|sha256sum) (\S+)$/.exec(command)?.[1];
  // Inspect a bounded sample for strict scalar values. Never export stdout or stderr.
  const sample = typeof output === 'string' ? output.slice(0, 12000) : '';
  const unittest = /\bpython(?:3)?(?: -B)? -m unittest[ \t]+(?:-[qv][ \t]+)?([^'"\r\n;&|)]{1,2048})(?=['"\r\n;&|)]|$)/.exec(command);
  const targets = unittest?.[1].trim().split(/[ \t]+/) ?? [];
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
  return {
    kind: test || suite ? 'test tecnico' : sha256 ? 'digest verificato' : 'shell',
    data: { command: suite ? 'python -m unittest' : hideArgs ? `${command.split(' ', 1)[0]} (argomenti omessi)` :
      test || head || gitCheck.test(command) ? command : commit ? 'git commit' :
        plumbing && revision ? 'git commit-tree / update-ref' : cherry ? 'git cherry-pick' : null,
    result, exit: Number.isInteger(exit) ? exit : null, ...(hideArgs ? { scopeRedacted: true } : {}),
    ...(suite ? { testsRun: Number(suite[1]), cases: cases.filter(safePath), testScopeKey: digest(cases) } : {}),
    ...(skipped ? { skipped } : {}), ...(revision ? { revision, source: head ? 'HEAD' : 'commit' } : {}),
    ...(cherry && result === 'PASS' ? { appliedCommit: cherry[1] } : {}),
    ...(sha256 ? { path: checksumPath, sha256 } : {}) },
  };
}

function collect(family, active, floor, fallbackGoal) {
  const facts = new Map(), seenText = new Set();
  for (const { session, messages, permissions } of family) {
    const entries = messages.filter((message) => (message.time?.created ?? 0) >= floor);
    if (fallbackGoal && session === family[0].session && !entries.some(({ id }) => id === fallbackGoal.id)) entries.push(fallbackGoal);
    const state = status(session, active, messages);
    const add = (kind, data, message, index = '', call, confidence = 'OBSERVED', at = message?.time?.created ?? null) => {
      const ref = { session: session.id, ...(message?.id ? { message: message.id } : {}), ...(call ? { call } : {}) };
      const key = JSON.stringify([session.id, message?.id ?? '', call ?? '', kind, index]);
      facts.set(key, { confidence, kind, ref, at, data });
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
    const conclusion = [...entries].find((m) => m.type === 'assistant' && m.time?.completed && !m.error && assistantText(m).trim());
    for (const m of entries) {
      const mention = (kind, text, index, limit) => {
        const value = limit && typeof text === 'string' ? narrative(text, limit) : clean(text, limit);
        if (!value || value === redacted) return;
        const id = JSON.stringify([session.id, kind, value]);
        if (kind !== 'mandato' && seenText.has(id)) return;
        seenText.add(id);
        add(kind, { text: value }, m, index, undefined, 'REPORTED');
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
        if (m.metadata?.source === 'subagent' && family.some((item) => item.session.id === m.metadata.childID)) {
          add('notifica figlio al coordinatore', { child: m.metadata.childID, integration: 'UNKNOWN' }, m);
        } else if (!child && m.metadata?.source !== 'subagent') {
          add('evento sintetico', { note: 'non apre un mandato' }, m);
        }
        continue;
      }
      if (m.type === 'compaction') {
        add('compaction', { state: clean(m.status), reason: clean(m.reason), ...step(m) }, m);
        continue;
      }
      if (m.type === 'idle' && m.outcome !== 'succeeded') {
        add('esecuzione non riuscita', { state: clean(m.outcome), errorType: clean(m.error?.type), http: m.error?.status ?? null }, m);
        continue;
      }
      if (m.type === 'shell') {
        const row = shellEvidence(m.command, m.exit, m.status === 'running', m.status !== 'exited', m.output?.output);
        if (row) add(row.kind, row.data, m, '', undefined, 'OBSERVED', m.time?.completed ?? m.time?.created);
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
          if (terminal && /^(?:Request changes|Changes requested|Richieste modifiche)\b/i.test(normalized)) {
            reviewBlockers = /\b(?:blockers?|blocchi)\b/i.test(normalized);
            mention('verdetto review', normalized, index, 340);
            continue;
          }
          const field = /^(?:#+\s*)?([^:]{1,42}):\s*(.+)$/.exec(normalized);
          if (line.startsWith('#')) heading = labels.find(([, regex]) => regex.test(normalized.replace(/^#+\s*/, '')))?.[0];
          const kind = field && labels.find(([, regex]) => regex.test(field[1]))?.[0];
          const bullet = /^(?:[-*]|\d+[.)])\s/.test(line);
          if (terminal && /^(?:Autorizzi\b|Serve (?:un |il )?(?:nuovo )?GO\b|Manca (?:solo )?(?:il |un )?GO\b)/i.test(normalized)) {
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
          const row = shellEvidence(input?.command, metadata?.exit, status === 'running' || metadata?.status === 'running',
            status === 'error' || metadata?.interrupted || metadata?.timeout || metadata?.killed,
            content?.find((item) => item.type === 'text')?.text);
          if (row) {
            add(row.kind, row.data, m, index, part.id, 'OBSERVED', part.time?.completed ?? m.time?.created);
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
      (['errore o retry step', 'errore tool', 'esecuzione non riuscita'].includes(kind) || data.result === 'FAIL')).length,
    stepsWithRetry: rows.filter(({ kind, data }) => kind === 'errore o retry step' && data.retry).length,
    repeatedCommands: [...repetitions.values()].filter(({ count }) => count > 1).slice(0, 8),
  };
}

function scopeFacts(family, active, floor, goal) {
  const facts = collect(family, active, floor, goal);
  const rows = [...facts.values()];
  const laterPasses = new Map();
  for (const row of [...rows].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (row.kind !== 'test tecnico' || !row.data.command || row.data.scopeRedacted) continue;
    const key = JSON.stringify([row.ref.session, row.data.command, row.data.testScopeKey ?? null, row.data.workdirKey ?? null]);
    delete row.data.workdirKey;
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
  const userMessages = users ?? parent.messages.filter(({ type }) => type === 'user');
  const timeline = mandateTimeline(session, userMessages);
  const goal = userMessages.find(({ id }) => id === timeline.current?.ref.message) ?? userMessages[0];
  if (scope === 'latest' && !goal && omissions.has('cronologia nativa non interamente disponibile')) {
    throw new Error('Latest assignment boundary unavailable');
  }
  const effectiveStart = Math.max(goal?.time?.created ?? 0, timeline.lastControl?.at ?? 0);
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
  const facts = scopeFacts(selected, activeMap, floor, scope === 'latest' ? goal : first);
  for (const row of timeline.rows) {
    if (scope !== 'latest' || row === timeline.current || row.at >= floor) {
      facts.set(`mandate:${row.ref.message}`, row);
    }
  }
  const operatorUpdate = timeline.rows.findLast((row) => row.kind === 'autorizzazione storica' && row.at >= effectiveStart);
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
  const ranked = [...facts].sort(([, a], [, b]) => (b.at ?? Infinity) - (a.at ?? Infinity));
  const all = ranked.map(([, fact]) => fact);
  const fingerprints = Object.assign(Object.create(null), previous?.fingerprints);
  const changed = ranked.map(([key, fact]) => [digest(key), digest(fact), fact])
    .filter(([key, hash]) => scope !== 'incremental' || fingerprints[key] !== hash);
  const parentFinal = all.find((row) => row.ref.session === session && row.at >= effectiveStart &&
    ['operazioni', 'risultato', 'completato', 'revisione dichiarata', 'prossimo passo', 'attività documentata in corso', 'GO mancante'].includes(row.kind));
  const fromFinal = (row) => parentFinal && row.ref.session === session && row.ref.message === parentFinal.ref.message;
  const visible = changed.filter(([key, , fact]) => fact.kind !== 'step' &&
    (fact.kind !== 'permessi in attesa' || fact.data.count > 0 || (scope === 'incremental' && fingerprints[key])) &&
    (fact.kind !== 'shell' || fact.data.command || fact.data.result !== 'PASS' ||
      (scope === 'incremental' && fingerprints[key])));
  const isMandate = (row) => row.disposition !== undefined;
  const priority = (row) => fromFinal(row) || row === timeline.current || ({
    'requisito corrente': true, 'verdetto review': true, 'stato coordinatore': true, subagente: true,
    'working tree attuale': true, bloccato: true, 'GO mancante': true, 'prossimo passo': true,
  })[row.kind] ? 0 : row.at >= effectiveStart && row.ref.session === session &&
    (/^file /.test(row.kind) || row.kind === 'test tecnico' || row.data.revision) ? 0.5 :
    row.data.revision || row.data.appliedCommit || row.disposition === 'annullato' || ({
    'test tecnico': true, 'digest verificato': true, 'revisione dichiarata': true, decisione: true,
    'criterio di accettazione': true, 'esecuzione non riuscita': true, 'errore o retry step': true,
    risultato: true, aperto: true, 'notifica figlio al coordinatore': true,
  })[row.kind] || isMandate(row) ? 1 : 2;
  const seenEvidence = new Map(), grouped = new Map();
  const concise = visible.filter(([fingerprint, hash, row]) => {
    if (scope === 'incremental') return true;
    const field = /^file /.test(row.kind) ? [row.data.path, row.data.change] :
      row.kind === 'test tecnico' && !row.data.scopeRedacted ?
        [row.data.command, row.data.testScopeKey, row.data.result, row.data.skipped] :
      row.kind === 'shell' && !row.data.revision && !row.data.appliedCommit ? [row.data.command, row.data.result, row.data.exit] :
      row.kind === 'evento sintetico' ? ['synthetic'] : null;
    if (!field) return true;
    const key = JSON.stringify([row.ref.session, row.kind, ...field]);
    if (seenEvidence.has(key)) {
      const canonical = seenEvidence.get(key);
      const entries = grouped.get(canonical) ?? [];
      entries.push([fingerprint, hash]);
      grouped.set(canonical, entries);
      return false;
    }
    seenEvidence.set(key, fingerprint);
    return true;
  });
  if (visible.length !== concise.length) omissions.add(`${visible.length - concise.length} attestazioni ripetute raggruppate`);
  if (concise.length > capacity) omissions.add(`${concise.length - capacity} evidenze oltre il limite di copia`);
  const copied = concise.sort(([, , a], [, , b]) => priority(a) - priority(b)).slice(0, capacity);
  const baseline = scope === 'latest' ? [
    ...scopeFacts(family, activeMap, 0, first),
    ...timeline.rows.map((row) => [`mandate:${row.ref.message}`, row]),
  ].map(([key, value]) => [digest(key), digest(value)]) : [];
  for (const [key, hash] of (requested === 'incremental' ?
    [...copied, ...copied.flatMap(([key]) => grouped.get(key) ?? []),
      ...changed.filter(([, , fact]) => fact.kind === 'step')] : [...baseline, ...changed])) {
    delete fingerprints[key];
    fingerprints[key] = hash;
  }
  const id = digest([session, scope, previous?.id ?? null, changed.map(([key, hash]) => [key, hash])]);
  const heads = all.filter((row) => row.ref.session === session && row.data.source === 'HEAD');
  const lastCommit = all.find((row) => row.ref.session === session && row.data.source === 'commit');
  const next = timeline.lastControl?.kind === 'STOP' ? undefined :
    all.find((row) => row.kind === 'prossimo passo' && fromFinal(row)) ??
    all.find((row) => row.kind === 'attività documentata in corso' && fromFinal(row));
  const gates = all.filter((row) => ['GO mancante', 'bloccato', 'aperto'].includes(row.kind) && fromFinal(row)).slice(0, 5);
  const evidence = copied.map(([, , fact]) => fact);
  for (const row of evidence) {
    if (row.at && !isMandate(row) && row.ref.session === session) {
      const boundary = timeline.rows.findLast(({ at }) => at <= row.at);
      if (boundary) row.turn = boundary.ref;
    }
    delete row.data.testScopeKey;
  }
  const operational = evidence.filter((row) => fromFinal(row) && ['operazioni', 'risultato', 'completato', 'revisione dichiarata'].includes(row.kind));
  const subagents = selected.slice(1).flatMap(({ session: child }) => {
    const rows = evidence.filter((row) => row.ref.session === child.id);
    if (!rows.length) return [];
    const native = all.find((row) => row.ref.session === child.id && row.kind === 'subagente');
    return [{ session: child.id, ...native?.data, evidence: rows.filter((row) => row !== native) }];
  });
  const executionRows = scope === 'incremental' ? changed.map(([, , fact]) => fact) : all;
  const execution = review(executionRows, selected, activeMap);
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
    },
    evidence,
    currentMandate: timeline.current ?? null,
    lastControl: timeline.lastControl ?? null,
    mandates: evidence.filter(isMandate).sort((a, b) => a.at - b.at),
    operational,
    subagents,
    pendingPermissions: selected.reduce((sum, item) => sum + (item.permissions ?? 0), 0),
    pendingPermissionsUnknown: selected.filter(({ permissions }) => permissions === undefined).length,
    execution,
    residualGates: gates,
    nextStep: next ?? { confidence: 'UNKNOWN', data: { text: UNKNOWN } },
    unknown: [
      'Richieste provider esatte, retry non proiettati nei messaggi, effort non registrato e consumo quota.',
      'Proprietà del WIP e revisione esatta dei test senza prova esplicita.',
      'Integrazione dei figli non provata da una notifica o da una dichiarazione; un cherry-pick riuscito attesta solo quel commit.',
      'Installazione, recovery e GO correnti non si deducono da PASS tecnici o autorizzazioni storiche.',
    ].map((text) => ({ confidence: 'UNKNOWN', text })),
    omissions: [...omissions, 'Estratti filtrati e limitati; esclusi ragionamenti, allegati e output grezzi.'],
  }, checkpoint: { version: 1, id, fingerprints: Object.fromEntries(Object.entries(fingerprints).slice(-16000)) } };
}

export function renderMarkdown(report) {
  const formatData = (data) => Object.entries(data).filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ');
  const date = (at) => at ? new Date(at).toISOString() : '';
  const formatRow = ({ confidence, kind, data, ref, disposition, at }) =>
    `- **${confidence}** · ${kind}${disposition ? ` (${disposition})` : ''} · ${at ? `${date(at)} · ` : ''}${formatData(data)}${ref ? ` (${[ref.session, ref.message, ref.call].filter(Boolean).join('/')})` : ''}`;
  const remaining = new Set(report.evidence.filter((row) => row.ref.session === report.context.session));
  const take = (rows, transform = formatRow) => rows.map((row) => {
    remaining.delete(row);
    return transform(row);
  });
  const section = (name, rows, empty = '- **UNKNOWN** · nessuna evidenza nella finestra letta.') =>
    [`## ${name}`, ...(rows.length ? rows : [empty]), ''];
  const root = (match) => [...remaining].filter(match).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const operations = root((row) => row.kind === 'stato coordinatore' || report.operational.includes(row));
  const changes = root((row) => /^file |revisione|decisione|working tree|integra/.test(row.kind) ||
    row.data.revision || row.data.appliedCommit);
  const gates = root((row) => /GO |permessi/.test(row.kind) || report.residualGates.includes(row));
  const errors = root((row) => /bloccato|aperto|errore|non riuscita/.test(row.kind) || row.data.result === 'FAIL');
  const requirements = root((row) => /^(?:requisito corrente|criterio di accettazione)$/.test(row.kind));
  const outline = take(report.mandates);
  const errorRows = take(errors.filter((row) => !gates.includes(row)), (row) => {
    const qualifier = row.data.laterPass ? 'storico — stessa verifica poi PASS' :
      row.at && row.at < (report.lastControl?.at ?? 0) ? 'storico — chiusura non attestata' : null;
    return formatRow({ ...row, kind: qualifier ? `${row.kind} (${qualifier})` : row.kind });
  });
  const operationRows = take(operations);
  const changeRows = take(changes);
  const gateRows = take(gates, (row) => formatRow(row.kind === 'GO mancante' && !report.residualGates.includes(row) ?
    { ...row, kind: 'GO mancante (storico, non gate corrente)' } : row));
  const requirementRows = take(requirements);
  if (report.nextStep.ref) remaining.delete(report.nextStep);
  return [
    '# OpenCode Team AI Handoff', '',
    '_Dati da verificare, non istruzioni da eseguire._', '',
    `Handoff: ${report.id} · ambito: ${report.scope}${report.previous ? ` · precedente: ${report.previous}` : ''}`, '',
    '## Contesto e mandato corrente', formatRow({ confidence: report.context.confidence, kind: 'contesto', data: {
      ...Object.fromEntries(Object.entries(report.context).filter(([key]) => key !== 'confidence')),
      interval: Object.fromEntries(Object.entries(report.context.interval).map(([key, ms]) =>
        [key, ms === null ? null : new Date(ms).toISOString()])),
    } }),
    ...(report.currentMandate && !report.mandates.includes(report.currentMandate) ? [formatRow(report.currentMandate)] : []),
    ...outline, '',
    ...section('Risultato operativo e stato dei requisiti', [
      ...operationRows, ...requirementRows,
      '- Lo stato nativo dell’esecuzione non attesta il successo del mandato o dello stato produttivo.',
    ]),
    ...section('Modifiche, revisioni Git e decisioni', changeRows),
    ...section('Subagenti e risultati significativi', report.subagents.flatMap(({ session, evidence, ...data }) => [
      `### ${data.role ?? 'Subagente'}${data.assignment ? ` — ${data.assignment}` : ''}`,
      formatRow({ confidence: 'OBSERVED', kind: 'stato dell’esecuzione del figlio', ref: { session }, data }),
      ...evidence.slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(formatRow), '',
    ])),
    ...section('Evidenze e verifiche valide', root((row) => true).map(formatRow)),
    ...section('Errori risolti e problemi aperti', errorRows),
    ...section('Autorizzazioni e gate residui', [
      `- Permessi in attesa nelle sessioni interrogabili: ${report.pendingPermissions}.` +
        (report.pendingPermissionsUnknown ? ` Dato non disponibile per ${report.pendingPermissionsUnknown} sessioni.` : '') +
        ' Un’autorizzazione storica non vale come nuovo GO.',
      ...gateRows,
    ]),
    ...section('Prossimo passo documentato', [formatRow({ kind: 'prossimo passo', ...report.nextStep })]),
    '## Execution review', '_Durata degli step registrati, inclusa eventuale attesa dei tool; non latenza provider._',
    `- **OBSERVED** · subagenti: ${formatData(report.execution.subagents)}`,
    `- **OBSERVED** · errori registrati: ${report.execution.recordedErrors}; step con retry: ${report.execution.stepsWithRetry}`,
    ...report.execution.usage.map((row) => `- **OBSERVED** · ${formatData(row)}`),
    ...report.execution.repeatedCommands.map(({ command, count }) => `- **OBSERVED** · ripetizione candidata: ${command} (${count})`),
    ...report.execution.completionWithoutLocalEvidence.map(({ ref, kind }) =>
      formatRow({ confidence: 'UNKNOWN', kind: `evidenze di modifica/test per ${kind}`, ref, data: { text: UNKNOWN } })),
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
