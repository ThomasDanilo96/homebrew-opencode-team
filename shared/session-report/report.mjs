const redacted = '[omesso]';
const sensitive = /(?:\b(?:authorization|bearer|password|passwd|creden[tz]ial\w*|api[ _-]?key|token|secret\w*|segret\w*|private[ _-]?key|chiave privata)\b|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[\w-]{8,}|\b[\w-]{18,}\b|https?:\/\/|\S+@\S+|(?:^|[\s/])(?:~\/|\/|\.env\b)|\.(?:pem|key|p12)\b|[\p{C}])/iu;
const pathPattern = '[\\w.-]+(?:/[\\w.-]+)*';
const relativePath = new RegExp(`^${pathPattern}$`);
const testCommand = new RegExp(
  `^(?:node --test(?: ${pathPattern})*|bun test(?: ${pathPattern})*|(?:npm|pnpm) test|(?:python3? -m |uv run )?pytest(?: ${pathPattern})*|bash tests/${pathPattern}\\.sh(?: profile|best-native)?|go test (?:\\./\\.\\.\\.|${pathPattern})|cargo test)$`,
);

// Extract short prose, never fenced/indented code, a raw transcript or tool output.
function proseLines(value) {
  let fence;
  return (value ?? '').split(/\r?\n/).flatMap((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return [];
    }
    return fence || /^(?: {4}|\t|>)/.test(line) ? [] : [line.trim()];
  }).filter(Boolean);
}

function excerpt(value) {
  const line = value.trim();
  if (!line || sensitive.test(line) || /[`<>[\]{}\\|]/.test(line)) return redacted;
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

function shortText(value) {
  const line = proseLines(value).find((line) => !/^(?:#+\s|[-*]\s*$)/.test(line));
  if (!line) return 'non disponibile';
  const clean = excerpt(line.replace(/^[-*]\s+/, ''));
  return clean.split(/(?<=[.!?])\s/, 1)[0];
}

function status(session, active, messages) {
  if (active[session.id] || (session.time?.busy ?? 0) > (session.time?.idle ?? 0)) return 'in esecuzione';
  const latest = messages.find((m) => ['idle', 'user'].includes(m.type));
  if (latest?.type === 'user' && latest.time?.created > (session.time?.idle ?? 0)) return 'non confermato';
  const outcome = latest?.type === 'idle' ? latest.outcome : session.outcome;
  return { succeeded: 'concluso', failed: 'fallito', interrupted: 'interrotto' }[outcome] ?? 'non confermato';
}

function latestText(messages) {
  const message = messages.find((m) => m.type === 'assistant' && m.time?.completed && !m.error &&
    m.content.some((part) => part.type === 'text'));
  return (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

function evidence(messages) {
  const files = new Set(), commits = new Set(), tests = new Map();
  let open = 0, completed = 0, blocked = 0;
  function shell(command, exit, running, failed, output = '') {
    if (typeof command !== 'string') return;
    if (testCommand.test(command) && !sensitive.test(command) && !tests.has(command)) {
      tests.set(command, running ? 'in esecuzione' : Number.isInteger(exit) ?
        `${exit === 0 ? 'PASS' : 'FAIL'} (exit ${exit})` : 'esito non verificabile');
    }
    if (running) open++;
    else if (failed || (Number.isInteger(exit) && exit !== 0)) blocked++;
    else if (exit === 0) completed++;
    if (exit !== 0 || running || failed) return;
    if (/^git (?:rev-parse --verify HEAD|show -s --format=%H HEAD)$/.test(command)) {
      const hash = /^([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(output)?.[1];
      if (hash) commits.add(hash);
    } else if (/^git commit(?: [^\n;&|<>`$]*)?$/.test(command)) {
      const hash = /^\[[\w./-]+ (?:\(root-commit\) )?([0-9a-f]{7,64})\] /m.exec(output)?.[1];
      if (hash) commits.add(hash);
    }
  }
  for (const message of messages) {
    if (message.type === 'shell') {
      shell(message.command, message.exit, message.status === 'running', message.status !== 'exited', message.output?.output);
    }
    if (message.type !== 'assistant') continue;
    for (const file of message.snapshot?.files ?? []) {
      if (relativePath.test(file) && !sensitive.test(file) &&
          !/(?:^|\/)(?:\.git|auth\.json|credentials?|secrets?|\.\.)(?:\/|$)/i.test(file) &&
          !/\.(?:db|sqlite3?|log|jks|pfx|crt)$/i.test(file)) files.add(file);
    }
    for (const part of message.content) {
      // `executed` marks provider-hosted tools, not local tool completion.
      if (part.type !== 'tool' || part.executed === true) continue;
      const { status, input, metadata, content } = part.state;
      if (part.name === 'shell') {
        shell(input?.command, metadata?.exit, status === 'running' || metadata?.status === 'running',
          status === 'error' || metadata?.interrupted || metadata?.timeout || metadata?.killed,
          content?.find((item) => item.type === 'text')?.text);
      } else if (status === 'error') blocked++;
    }
  }
  return { files, commits, tests, completed, open, blocked };
}

function render(parent, children, active, permissions, partial) {
  const parentStatus = status(parent.session, active, parent.messages);
  const summary = parentStatus === 'concluso' ? latestText(parent.messages) : '';
  const lines = proseLines(summary);
  const label = (pattern) => {
    for (const line of lines) {
      const value = pattern.exec(line.replace(/^[-*]\s+/, '').replaceAll('**', ''))?.[1];
      if (value && excerpt(value) !== redacted) return excerpt(value);
    }
  };
  const { files, commits, tests, completed, open, blocked } = evidence(
    [parent, ...children].flatMap(({ messages }) => messages).sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0)),
  );
  const list = (values, fallback) => values.size ? [...values].slice(0, 8).map((value) => `\`${value}\``).join(', ') : fallback;
  const linesOut = [
    '# Resoconto della sessione',
    '',
    `- **Obiettivo originale:** ${shortText(parent.objective)}`,
    `- **Stato nativo:** ${parentStatus} (non attesta installazione o recovery).`,
    `- **Risultato dichiarato:** ${label(/^(?:risultato|result|outcome):\s*(.+)$/i) ?? shortText(summary)}`,
    `- **File rilevati negli snapshot:** ${list(files, 'nessuno nei dati letti')}`,
    `- **Commit rilevati con Git:** ${list(commits, 'non verificati nei dati letti')}`,
    '',
    '## Test tecnici',
    ...(tests.size ? [...tests].slice(0, 8).map(([command, result]) => `- \`${command}\` — ${result}`) :
      ['- Nessun esito riconoscibile nei dati letti.']),
    '',
    '## Subagenti',
    ...(children.length ? children.map(({ session, messages }) => {
      const state = status(session, active, messages);
      return `- ${excerpt(session.agent ?? 'ruolo non disponibile')} — ${shortText(session.title)} — ${state}` +
        (state === 'concluso' ? `: ${shortText(latestText(messages))}` : '');
    }) : ['- Nessuna sessione figlia rilevata.']),
    '',
    '## Operazioni e GO',
    `- **Evidenze tecniche:** ${completed} shell con exit 0, ${open} ancora aperte nei dati letti, ${blocked} chiamate con errore o exit non zero.`,
    ...[
      ['Completato (dichiarato)', /^(?:completat[oi]|completed):\s*(.+)$/i],
      ['Aperto (dichiarato)', /^(?:apert[oi]|open|pending):\s*(.+)$/i],
      ['Bloccato (dichiarato)', /^(?:bloccat[oi]|blocked):\s*(.+)$/i],
    ].flatMap(([name, pattern]) => {
      const value = label(pattern);
      return value ? [`- **${name}:** ${value}`] : [];
    }),
    `- **GO mancanti:** ${label(/^(?:GO mancant[ei]|missing GO):\s*(.+)$/i) ?? 'non attestati'}; ${permissions.length} permessi nativi in attesa nella sessione padre.`,
    `- **Prossimo passo:** ${label(/^(?:prossimo passo|next step):\s*(.+)$/i) ??
      (permissions.length ? 'Esaminare i permessi in attesa nella sessione padre.' :
        parentStatus === 'in esecuzione' || children.some(({ session, messages }) => status(session, active, messages) === 'in esecuzione')
        ? 'Ricopiare il resoconto dopo la conclusione delle esecuzioni attive.'
        : 'Controllare nella sessione le verifiche e le approvazioni non attestate prima di procedere.')}`,
  ];
  if (partial) linesOut.push('', '_Resoconto parziale: finestra recente o dati figlio non disponibili._');
  return `${linesOut.join('\n')}\n`;
}

export function registerReport({ client, ui, keymap }, writeClipboard) {
  const { session, message, permission } = client;
  const current = () => ui.router.current();
  keymap.layer(() => ({
    mode: 'global',
    commands: [{
      id: 'opencode-team.copy-report',
      title: 'Copia resoconto',
      group: 'Sessione',
      palette: true,
      slash: { name: 'copia-resoconto' },
      enabled: () => current().type === 'session',
      async run() {
        const route = current();
        if (route.type !== 'session') return;
        let markdown;
        try {
          const options = { signal: AbortSignal.timeout(8000) };
          const currentSession = await session.get({ sessionID: route.sessionID }, options);
          const sessionID = currentSession.parentID ?? route.sessionID;
          const [parent, objective, recent, children, permissions] = await Promise.all([
            currentSession.parentID ? session.get({ sessionID }, options) : currentSession,
            message.list({ sessionID, type: 'user', order: 'asc', limit: 1 }, options),
            message.list({ sessionID, order: 'desc', limit: 80 }, options),
            session.list({ parentID: sessionID, limit: 12 }, options),
            permission.list({ sessionID }, options),
          ]);
          let partial = Boolean(recent.cursor?.next || children.cursor?.next);
          const family = await Promise.all(children.data.map(async (child) => {
            try {
              const page = await message.list({ sessionID: child.id, order: 'desc', limit: 24 }, options);
              partial ||= Boolean(page.cursor?.next);
              return { session: child, messages: page.data };
            } catch {
              partial = true;
              return { session: child, messages: [] };
            }
          }));
          const active = await session.active(options);
          markdown = render({ session: parent, objective: objective.data[0]?.text, messages: recent.data },
            family, active, permissions, partial);
        } catch {
          ui.toast.show({ variant: 'error', message: 'Resoconto non disponibile: lettura della sessione fallita.' });
          return;
        }
        try {
          await writeClipboard(markdown);
          ui.toast.show({ variant: 'success', message: 'Resoconto copiato negli appunti.' });
        } catch {
          ui.toast.show({ variant: 'error', message: 'Impossibile copiare il resoconto negli appunti.' });
        }
      },
    }],
  }));
}
