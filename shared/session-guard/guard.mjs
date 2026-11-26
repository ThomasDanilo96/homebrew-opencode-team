const projectLabel = /^(?:project|progetto)$/i;
const repoLabel = /^(?:repo|repository)$/i;
const mandateLabel = /^(?:mandate|mandato)$/i;
const contextLabel = /^(?:context|contesto|per contesto|(?:here are the |ecco i )?logs?|output|transcript|trascrizione|examples?|esemp(?:io|i)|references?|riferimenti)$/i;

const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ' ').trim();

function repository(value) {
  const remote = value.match(/^(?:https?:\/\/|ssh:\/\/|git@)(?:[^@/:]+@)?([\w.-]+)[/:]([\w.-]+\/[\w.-]+)\/?$/i);
  if (remote) return { host: remote[1].toLowerCase(), name: remote[2].toLowerCase().replace(/\.git$/, '') };
  if (/^(?:~\/|\/|\.\.?\/)(?:[\w.-]+\/)*[\w.-]+\/?$/.test(value)) {
    return repository(value.replace(/\/$/, '').split('/').at(-1));
  }
  if (!/^[\w.-]+(?:\/[\w.-]+)?$/.test(value) || value.startsWith('.')) return;
  return { name: value.toLowerCase().replace(/\.git$/, '') };
}

function sameRepository(a, b) {
  if (a.host && b.host && a.host !== b.host) return false;
  if (a.name.includes('/') && b.name.includes('/')) return a.name === b.name;
  return a.name.split('/').at(-1) === b.name.split('/').at(-1);
}

function scopeOf(text) {
  if (typeof text !== 'string') return;
  if (/^\s*# OpenCode Team AI Handoff(?:\s|$)/i.test(text)) return;
  const scope = {};
  let fence, contextLevel, assignmentTitle, objective;
  for (const raw of text.split(/\r?\n/)) {
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (/^(?: {4}|\t|\s*>)/.test(raw)) continue;
    const heading = raw.match(/^ {0,3}(#{1,6})[ \t]+(.*)$/);
    const level = heading?.[1].length;
    if (contextLevel !== undefined) {
      if (!level || level > contextLevel) continue;
      contextLevel = undefined;
    }
    const line = (heading?.[2] ?? raw.trim()).replace(/^[-*][ \t]+/, '').replace(/\*\*/g, '');
    if (level === 1 && !assignmentTitle) assignmentTitle = /^([\p{L}\p{N}][\p{L}\p{N} ._-]{0,60})\s+[—–]\s+([\p{L}\p{N}][\p{L}\p{N} ._'’&/-]{0,119})$/u.exec(line);
    if (level && /^(?:obiettivo|objective)$/i.test(line)) objective = true;
    const separator = line.indexOf(':');
    const label = (separator === -1 ? line : line.slice(0, separator)).trim();
    if (contextLabel.test(label)) {
      contextLevel = level ?? 0;
      continue;
    }
    if (separator === -1) continue;
    const value = line.slice(separator + 1).trim().replace(/^`([^`]+)`$/, '$1');
    const field = projectLabel.test(label) ? 'project' : repoLabel.test(label) ? 'repo' : mandateLabel.test(label) ? 'mandate' : undefined;
    if (!field || !value || value.length > 120) continue;
    const identity = field === 'repo' ? repository(value) :
      /^[\p{L}\p{N}][\p{L}\p{N} ._'’&-]*$/u.test(value) ? normalize(value.replace(/\.$/, '')) : undefined;
    if (!identity) continue;
    const previous = scope[field];
    if (previous && !(field === 'repo' ? sameRepository(previous, identity) : previous === identity)) {
      // Competing declarations may be a comparison, not an instruction.
      return {};
    }
    // A shorthand repeat must not erase the owner or host of a repository.
    if (!previous || (field === 'repo' && ((!previous.host && identity.host) || !previous.name.includes('/')))) {
      scope[field] = identity;
    }
  }
  if (assignmentTitle && (objective || scope.repo || scope.mandate)) {
    scope.project ??= normalize(assignmentTitle[1]);
    scope.mandate ??= normalize(assignmentTitle[2]);
  }
  return Object.keys(scope).length ? scope : undefined;
}

function mismatch(active, incoming) {
  // Repositories are more specific than display project names.
  const sameProject = active.repo && incoming.repo ? sameRepository(active.repo, incoming.repo) :
    active.project && incoming.project ? active.project === incoming.project : undefined;
  if (sameProject === false) return { blocked: true, reason: 'Il prompt dichiara un progetto o repository diverso da quello della sessione.' };
  if (!sameProject || !active.mandate || !incoming.mandate) return;
  // Do not interrupt refinements, reformulations, or single-word labels.
  const words = (label) => new Set(label.match(/[\p{L}\p{N}]{3,}/gu));
  const previous = words(active.mandate);
  const next = words(incoming.mandate);
  if (previous.size >= 2 && next.size >= 2 && ![...next].some((word) => previous.has(word))) {
    return { blocked: false, reason: 'Il prompt dichiara un mandato distinto per lo stesso progetto.' };
  }
}

export function registerGuard({ client, ui }) {
  return ui.prompt?.beforeSubmit(async ({ sessionID, text, revertMessageID }) => {
    if (!sessionID) return true; // A new composer has no session history.
    const incoming = scopeOf(text);
    if (!incoming?.project && !incoming?.repo) return true;

    let history;
    try {
      const page = await client.message.list({ sessionID, order: 'desc',
        ...(revertMessageID ? { limit: 80 } : { type: 'user', limit: 20 }) },
        { signal: AbortSignal.timeout(1500) });
      history = page.data;
    } catch {
      return true; // No reliable evidence; do not infer a mismatch.
    }
    if (!Array.isArray(history)) return true;
    if (revertMessageID) {
      // The native page is ordered by durable sequence, not by message ID.
      const boundary = history.findIndex(({ id }) => id === revertMessageID);
      if (boundary === -1) return true;
      history = history.slice(boundary + 1);
    }
    let active;
    for (const message of history) {
      if (message.type === 'user' && (active = scopeOf(message.text))) break;
    }
    const decision = active && mismatch(active, incoming);
    if (!decision) return true;

    const isCurrent = () => {
      const route = ui.router.current();
      return route.type === 'session' && route.sessionID === sessionID;
    };
    if (!isCurrent()) return false;
    try {
      const confirmed = await ui.dialog.prompt({
        title: decision.blocked ? 'Session Guard — prompt bloccato' : 'Session Guard — prompt sospeso',
        description: `${decision.reason}\nNessun prompt inviato. Scrivi INVIA per inviare qui una sola volta, oppure Esc per annullare.`,
        placeholder: 'INVIA',
      });
      return confirmed === 'INVIA' && isCurrent();
    } catch {
      return false; // A known mismatch is never approved by a dialog failure.
    }
  });
}
