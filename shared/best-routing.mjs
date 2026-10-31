// shared/best-routing.mjs — scoped BEST routing aid, no model traffic
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const KIND_COMMANDS = {
  scan: ['scan'], analysis: ['analyze', 'scan'], coding: ['code', 'codeOpenai'],
  small: ['small', 'code'], complex: ['codeComplex', 'codeOpenai', 'code'],
  architecture: ['architect'], debug: ['debug'], security: ['architect'],
  review: ['reviewCritical'], visual: ['visual', 'visualFallback'],
};
const KINDS = Object.keys(KIND_COMMANDS);
const VALID_WEIGHTS = [1, 3, 5];
const ALLOWED = ['opencode-go', 'openai'];
const OUTCOMES = ['passed', 'failed', 'blocked'];
const HIGH_RISK = ['architecture', 'debug', 'security', 'review'];
const VISUAL_SKILLS = ['frontend-design', 'accessibility', 'make-interfaces-feel-better'];
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const ENTRY_KEYS = new Set(['id', 'kind', 'weight', 'provider', 'model', 'agent', 'duration_ms', 'outcome', 'tokens', 'fallback']);
const base = (m) => (m ? m.split('#')[0] : '');
const providerOf = (cfg, cmd) => cfg.commands?.[cmd]?.model?.split('/')[0] || '';

function isProviderAllowed(provider, policies) {
  if (!ALLOWED.includes(provider)) return false;
  if (!policies || !policies.length) return false;
  let allowed = false;
  for (const p of policies) {
    if (p.action !== 'provider.use') continue;
    if (p.resource !== '*' && p.resource !== provider) continue;
    allowed = p.effect === 'allow';
  }
  return allowed;
}

function isCmdAvailable(cmd, config, availability) {
  if (!config.commands?.[cmd]?.model) return false;
  const b = base(config.commands[cmd].model);
  const provider = b.split('/')[0];
  const conn = availability.connected || [];
  if (!conn.includes(provider)) return false;
  const norm = (arr) => (arr || []).map(base);
  const exhausted = norm(availability.exhausted);
  const unavailable = norm(availability.unavailable);
  if (exhausted.includes(provider) || exhausted.includes(b)) return false;
  if (unavailable.includes(provider) || unavailable.includes(b)) return false;
  const models = norm(availability.models);
  if (!models.includes(b)) return false;
  return isProviderAllowed(provider, config.policies);
}

function deficit(ledger) {
  let go = 0, openai = 0;
  for (const e of ledger) {
    if (e.outcome !== 'passed') continue;
    if (e.provider === 'opencode-go') go += e.weight;
    else if (e.provider === 'openai') openai += e.weight;
  }
  return go - openai;
}

function select(kind, available, config, ledger) {
  if (HIGH_RISK.includes(kind)) return available.find((c) => providerOf(config, c) === 'openai') || null;
  if (kind !== 'coding' && kind !== 'complex') return available[0];
  const go = available.find((c) => providerOf(config, c) === 'opencode-go');
  const openai = available.find((c) => providerOf(config, c) === 'openai');
  return (go && openai) ? (deficit(ledger) > 0 ? openai : go) : available[0];
}

export function chooseRoute(kind, weight, config, availability, ledger) {
  config = config || {}; availability = availability || {}; ledger = ledger || [];
  if (!KINDS.includes(kind) || !VALID_WEIGHTS.includes(weight))
    return { blocked: true, reason: 'invalid-input', nativeCommand: null, weight, quotaUnknown: true };
  const cmds = KIND_COMMANDS[kind] || [];
  const available = cmds.filter((c) => isCmdAvailable(c, config, availability));
  if (!available.length)
    return { blocked: true, reason: 'no-available-candidate', nativeCommand: cmds[0] || null, weight, quotaUnknown: true };
  const cmd = select(kind, available, config, ledger);
  if (!cmd)
    return { blocked: true, reason: 'no-eligible-candidate', nativeCommand: cmds[0] || null, weight, quotaUnknown: true };
  const def = config.commands[cmd], primary = cmds[0];
  const reason = HIGH_RISK.includes(kind) ? 'high-risk-forces-openai'
    : kind === 'visual' ? (cmd === primary ? 'visual' : 'visual-fallback')
    : (kind === 'coding' || kind === 'complex') ? 'balanced'
    : cmd === primary ? 'go-only' : 'go-fallback';
  return {
    nativeCommand: cmd, agent: def.agent, model: def.model,
    provider: def.model.split('/')[0], weight, fallback: cmd !== primary && !available.includes(primary),
    skills: kind === 'visual' ? VISUAL_SKILLS : undefined, reason, quotaUnknown: true,
  };
}

export function readLedger(file) {
  if (!file) return [];
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!content.trim()) return [];
  const seen = new Set();
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line.trim()); }
    catch { throw new Error('malformed JSON in ledger'); }
    const err = validateEntry(parsed, seen);
    if (err) throw new Error('invalid ledger entry: ' + err);
    seen.add(parsed.id);
    entries.push(parsed);
  }
  return entries;
}

function validateEntry(entry, ids) {
  if (!entry || typeof entry !== 'object') return 'invalid-entry';
  if (Array.isArray(entry)) return 'invalid-entry';
  for (const k of Object.keys(entry)) if (!ENTRY_KEYS.has(k)) return 'unknown-field';
  if (typeof entry.id !== 'string' || !entry.id) return 'missing-id';
  if (ids.has(entry.id)) return 'duplicate-id';
  if (!KINDS.includes(entry.kind)) return 'invalid-kind';
  if (!Number.isInteger(entry.weight) || !VALID_WEIGHTS.includes(entry.weight)) return 'invalid-weight';
  if (typeof entry.provider !== 'string' || !ALLOWED.includes(entry.provider)) return 'invalid-provider';
  if (typeof entry.model !== 'string' || !entry.model.startsWith(entry.provider + '/')) return 'invalid-model';
  if (typeof entry.agent !== 'string' || !entry.agent) return 'missing-agent';
  if (typeof entry.duration_ms !== 'number' || !Number.isFinite(entry.duration_ms) || entry.duration_ms < 0) return 'invalid-duration';
  if (!OUTCOMES.includes(entry.outcome)) return 'invalid-outcome';
  if (entry.fallback !== undefined && typeof entry.fallback !== 'boolean') return 'invalid-fallback';
  if (entry.tokens != null) {
    if (typeof entry.tokens !== 'object' || Array.isArray(entry.tokens)) return 'invalid-tokens';
    if (Object.keys(entry.tokens).some(k => !TOKEN_KEYS.includes(k))) return 'unknown-token-field';
    for (const k of TOKEN_KEYS) {
      const v = entry.tokens[k];
      if (v != null && (!Number.isInteger(v) || v < 0)) return 'invalid-tokens-' + k;
    }
  }
  return null;
}

export function appendRecord(file, entry) {
  if (!file) return { ok: false, error: 'missing-file' };
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { ok: false, error: 'symlink-rejected' };
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: 'unsafe-path' };
  }
  const lock = file + '.lock';
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
    const existing = readLedger(file);
    const err = validateEntry(entry, new Set(existing.map((e) => e.id)));
    if (err) return { ok: false, error: err };
    const separator = existing.length && !fs.readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, separator + JSON.stringify(entry) + '\n', { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, error: 'locked' };
    throw e;
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

const blank = () => ({
  jobs: 0, passed: 0, passedWeight: 0, fallback: 0, tokenSamples: 0,
  input: null, output: null, cacheRead: null, cacheWrite: null, durationMs: 0,
});
function addTokens(m, t) {
  for (const k of TOKEN_KEYS)
    if (typeof t[k] === 'number') { if (m[k] === null) m[k] = 0; m[k] += t[k]; }
}

export function metrics(ledger) {
  const totals = blank(), perProvider = Object.create(null), perModel = Object.create(null), perAgent = Object.create(null);
  for (const e of ledger) {
    const { provider: p, model, weight: w, outcome: o, fallback: fb, duration_ms: d, tokens: tk, agent: a } = e;
    if (!perProvider[p]) perProvider[p] = blank();
    if (!perModel[model]) perModel[model] = blank();
    if (!perAgent[a]) perAgent[a] = blank();
    const pass = o === 'passed';
    totals.jobs++; perProvider[p].jobs++; perModel[model].jobs++; perAgent[a].jobs++;
    if (pass) {
      totals.passed++; totals.passedWeight += w;
      perProvider[p].passed++; perProvider[p].passedWeight += w;
      perModel[model].passed++; perModel[model].passedWeight += w;
      perAgent[a].passed++; perAgent[a].passedWeight += w;
    }
    if (fb) { totals.fallback++; perProvider[p].fallback++; perModel[model].fallback++; perAgent[a].fallback++; }
    totals.durationMs += d || 0; perProvider[p].durationMs += d || 0;
    perModel[model].durationMs += d || 0; perAgent[a].durationMs += d || 0;
    if (tk) {
      totals.tokenSamples++; perProvider[p].tokenSamples++; perModel[model].tokenSamples++; perAgent[a].tokenSamples++;
      addTokens(totals, tk); addTokens(perProvider[p], tk); addTokens(perModel[model], tk); addTokens(perAgent[a], tk);
    }
  }
  totals.completionPct = totals.jobs ? (totals.passed / totals.jobs) * 100 : 0;
  const tw = totals.passedWeight;
  const share = (m) => (tw > 0 ? { ...m, weightedSharePct: m.passedWeight / tw * 100 } : { ...m, weightedSharePct: null });
  for (const k of Object.keys(perProvider)) perProvider[k] = share(perProvider[k]);
  totals.weightedSharePct = null;
  totals.quotaUnknown = true;
  return { totals, perProvider, perModel, perAgent };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readStdin = () => { try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; } };
const getArg = (a, f) => { const i = a.indexOf(f); return i >= 0 && i + 1 < a.length ? a[i + 1] : null; };

function main() {
  const a = process.argv.slice(2), cmd = a[0];
  if (cmd === 'route') {
      const r = chooseRoute(a[1], Number(a[2]),
      readJson(getArg(a, '--config')), readJson(getArg(a, '--availability')),
      getArg(a, '--work') ? readLedger(getArg(a, '--work')) : []);
    console.log(JSON.stringify(r, null, 2)); if (r.blocked) process.exitCode = 1;
  } else if (cmd === 'record' || cmd === 'report') {
    const work = getArg(a, '--work');
    if (!work) { console.log(JSON.stringify({ ok: false, error: 'missing-work' })); process.exitCode = 1; return; }
    if (cmd === 'report') { console.log(JSON.stringify(metrics(readLedger(work)), null, 2)); return; }
    let entry; try { entry = JSON.parse(readStdin()); } catch { console.log('{"ok":false,"error":"invalid-json"}'); process.exitCode = 1; return; }
    const r = appendRecord(work, entry); console.log(JSON.stringify(r)); if (!r.ok) process.exitCode = 1;
  } else { console.error('Usage: best-routing.mjs <route|record|report> ...'); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
