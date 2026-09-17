import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DAILY_COMPLEXITY_TO_GUARDRAIL, dailyFanout } from "../../../daily/daily-policy.mjs";
import { analyzeObjective } from "./openai-routing.js";

export const DEFAULT_GUARDRAIL_LIMITS = Object.freeze({ minutes: 15, toolCalls: 20, delegations: 1 });
const CLASS_LIMITS = Object.freeze({ quick: { minutes: 5, toolCalls: 8, delegations: 1 }, normal: { minutes: 15, toolCalls: 20, delegations: 1 }, complex: { minutes: 45, toolCalls: 50, delegations: 2 }, long: { minutes: 120, toolCalls: 100, delegations: 2 } });
const DAILY_CLASS_LIMITS = Object.freeze({ quick: { minutes: 5, toolCalls: 8 }, normal: { minutes: 15, toolCalls: 20 }, complex: { minutes: 45, toolCalls: 50 }, long: { minutes: 120, toolCalls: 100 } });
const BOUNDS = { minutes: [1, 120], toolCalls: [1, 100], delegations: [1, 2] };
const DAILY_BOUNDS = { minutes: [1, 120], toolCalls: [1, 100], delegations: [0, 10] };
const STOP = /\b(?:stop|halt|cancel|abort|fermati|ferma|basta|arresta|annulla)\b/i;
const RESUME = /\b(?:resume|restart|start|continue|riprendi|ripart(?:i|ire)|avvia|ricomincia)\b/i;
const INTERNAL = /OMO_INTERNAL_INITIATOR|OH-MY-OPENCODE/i;
const LONG = /\b(?:authorize|authorise|approved?|consent(?:ed)?)\b[^\n]{0,40}\b(?:long[- ]work|long[- ]running|duration|hours?)\b|\b(?:long[- ]work|long[- ]running|duration|hours?)\b[^\n]{0,40}\b(?:authorize|authorise|approved?|consent)\b/i;
const COMPLEX = /\b(?:complex|multi[- ]step|cross[- ](?:service|repository)|end[- ]to[- ]end|integration|migrat|refactor|architecture)\b/i;
const QUICK = /\b(?:quick(?:ly)?|simple|small|brief|just\s+(?:tell|show|read|check)|what\s+is|how\s+do\s+i)\b/i;
const CATEGORIES = Object.freeze({ push: /\bpush(?:ing)?\b/i, deploy: /\bdeploy(?:ment|ing)?\b/i, cron: /\bcron(?:tab|job)?\b/i, vps_ssh: /\b(?:vps|ssh|remote)\b/i, destructive: /(?:\b(?:destruct(?:ive|ion)|delet(?:e|ing|ed|ion)|remov(?:e|ing|ed)|drop(?:ping|ped)?|reset(?:ting|ted)?|rm)\b|删除|移除|丢弃|重置|消除|\b(?:elimina|eliminare|rimuovi|rimuovere|cancella|cancellare|reimposta|eliminar|borrar|borra)\b)/iu });
const bounded = (value, fallback, [min, max]) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
export const readGuardrailLimits = (env = process.env, base = DEFAULT_GUARDRAIL_LIMITS, bounds = BOUNDS) => ({
  minutes: bounded(env.OPENAI_GUARDRAIL_MINUTES ?? env.OPENAI_REQUEST_MAX_MINUTES, base.minutes, bounds.minutes),
  toolCalls: bounded(env.OPENAI_GUARDRAIL_TOOL_CALLS ?? env.OPENAI_MAX_TOOL_CALLS, base.toolCalls, bounds.toolCalls),
  delegations: bounded(env.OPENAI_GUARDRAIL_DELEGATIONS ?? env.OPENAI_MAX_DELEGATIONS, base.delegations, bounds.delegations),
});
export const classifyRequest = (text) => LONG.test(String(text || "") ) ? "long" : COMPLEX.test(String(text || "")) ? "complex" : QUICK.test(String(text || "")) ? "quick" : "normal";
const requestOverrides = (text) => {
  const value = String(text || "");
  const minutes = value.match(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/i)?.[1];
  const toolCalls = value.match(/\b(\d{1,3})\s*(?:tool[- ]?(?:calls?|units?)|units?)\b/i)?.[1];
  return { minutes, toolCalls };
};
export const isInternalContinuation = (text) => INTERNAL.test(String(text || ""));
export const isStopText = (text) => !isInternalContinuation(text) && STOP.test(String(text || ""));
export const isExplicitResumeText = (text) => !isInternalContinuation(text) && RESUME.test(String(text || ""));
export const backgroundDelegationAllowed = (env = process.env) => env.OPENAI_DAILY_PROFILE === "1";
export const updateStopLatch = (state = { stopped: false }, text, genuine = true) => !genuine || isInternalContinuation(text) ? { ...state } : isStopText(text) ? { ...state, stopped: true } : state.stopped && isExplicitResumeText(text) ? { ...state, stopped: false } : { ...state };
export const beginRequestCycle = (state = createGuardrailState(), text, now = Date.now(), env = process.env, { preserveVerificationTerminal = false, preserveCodexFailureTerminal = false, preserveVerificationGate = false } = {}) => {
  if (isInternalContinuation(text)) return state;
  if (state.verificationTerminal && preserveVerificationTerminal) return state;
  const analysis = env.OPENAI_DAILY_PROFILE === "1" ? analyzeObjective(text) : null;
  const classification = analysis ? DAILY_COMPLEXITY_TO_GUARDRAIL[analysis.complexity] : classifyRequest(text), limitsByClass = analysis ? DAILY_CLASS_LIMITS : CLASS_LIMITS, base = analysis ? { ...limitsByClass[classification], delegations: dailyFanout(analysis.complexity) } : limitsByClass[classification], override = requestOverrides(text);
  const configuredLimits = readGuardrailLimits({ ...env, ...(override.minutes ? { OPENAI_GUARDRAIL_MINUTES: override.minutes } : {}), ...(override.toolCalls ? { OPENAI_GUARDRAIL_TOOL_CALLS: override.toolCalls } : {}) }, base, analysis ? DAILY_BOUNDS : BOUNDS);
  const limits = analysis ? { ...configuredLimits, delegations: Math.min(configuredLimits.delegations, analysis.fanout_limit) } : configuredLimits;
  const resumed = isExplicitResumeText(text);
  return { ...state, objective: String(text || "").trim(), authoritativeObjective: preserveVerificationTerminal ? state.authoritativeObjective || state.objective || null : String(text || "").trim(), limits, startedAt: now, toolCalls: 0, weightedUnits: 0, delegations: 0, activeDelegations: 0, activeDelegation: false, verificationTerminal: false, budgetTerminal: false, codexFailureTerminal: preserveCodexFailureTerminal ? Boolean(state.codexFailureTerminal) : false, pendingVerificationPacketID: preserveVerificationGate ? state.pendingVerificationPacketID || null : null, pendingTesterActive: preserveVerificationGate ? Boolean(state.pendingTesterActive) : false, classification, complexity: analysis?.complexity ?? null, fanoutLimit: analysis?.fanout_limit ?? null, checkpointed: classification === "long", stopped: resumed ? false : Boolean(state.stopped) || isStopText(text) };
};
export const recoverRootRequestState = (state = createGuardrailState(), objective, now = Date.now(), env = process.env) => {
  const existing = state || createGuardrailState(env, now);
  const derived = beginRequestCycle(createGuardrailState(env, now), objective, now, env);
  const activeDelegations = Math.max(existing.activeDelegations || 0, existing.activeDelegation ? 1 : 0);
  return {
    ...derived,
    limits: derived.limits,
    startedAt: Math.min(Number.isFinite(existing.startedAt) ? existing.startedAt : now, derived.startedAt),
    toolCalls: Math.max(existing.toolCalls || 0, derived.toolCalls || 0),
    weightedUnits: Math.max(existing.weightedUnits || 0, derived.weightedUnits || 0),
    delegations: Math.max(existing.delegations || 0, derived.delegations || 0),
    activeDelegations,
    activeDelegation: activeDelegations > 0,
    delegationScopes: [...new Set([...(existing.delegationScopes || []), ...(derived.delegationScopes || [])])],
    stopped: Boolean(existing.stopped || derived.stopped),
    verificationTerminal: Boolean(existing.verificationTerminal || derived.verificationTerminal),
    budgetTerminal: Boolean(existing.budgetTerminal || derived.budgetTerminal),
    codexFailureTerminal: Boolean(existing.codexFailureTerminal),
    pendingVerificationPacketID: existing.pendingVerificationPacketID || null,
    pendingTesterActive: Boolean(existing.pendingTesterActive),
  };
};
export const confirmationCategory = (operation) => Object.entries(CATEGORIES).find(([, pattern]) => pattern.test(String(operation || "")))?.[0] || null;
const negatedCategoryAction = (request, category) => category === "destructive" && /(?:(?:\b(?:do\s+not|don['’]t|must\s+not|never|no)\b|不(?:要|得)?|禁止|别|\bnon\b|\bno\b)[^\n]{0,40}(?:\b(?:destruct(?:ive|ion)|delet(?:e|ing|ed|ion)|remov(?:e|ing|ed)|drop(?:ping|ped)?|reset(?:ting|ted)?|rm)\b|删除|移除|丢弃|重置|消除|\b(?:elimina|eliminare|rimuovi|rimuovere|cancella|cancellare|reimposta|eliminar|elimine|rimuovere|borrar|borra)\b))/iu.test(String(request || ""));
export const explicitlyConfirms = (request, category) => Boolean(category && CATEGORIES[category] && !/\b(?:continue|go ahead|proceed)\b/i.test(String(request || "")) && !negatedCategoryAction(request, category) && /(?:\b(?:authorize|authorise|confirm|explicitly|approved?|consent|yes|conferma|confermato|approva|autorizza)\b|确认|同意|批准)/iu.test(String(request || "")) && CATEGORIES[category].test(String(request || "")));
const DAILY_SHELL_TOOLS = new Set(["bash", "interactive_bash", "shell", "command"]);
const SAFE_SSH_PROBE = /^\s*(?:command\s+-v\s+ssh|ssh\s+-V|ssh\s+-G\s+[A-Za-z0-9._-]+)\s*$/i;
const shellStages = (operation) => {
  const stages = [];
  let stage = "";
  let quote = null;
  let escaped = false;
  for (const character of operation) {
    if (escaped) { stage += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { stage += character; escaped = true; continue; }
    if (quote) {
      stage += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { stage += character; quote = character; continue; }
    if (character === ";" || character === "|" || character === "&" || character === "\n") {
      stages.push(stage);
      stage = "";
    } else stage += character;
  }
  stages.push(stage);
  return stages;
};
const DAILY_SHELL_MUTATION = /^(?:(["'])(patch|apply_patch)\1|(patch|apply_patch))(?=\s|$|<)/i;
const hasDailyShellMutation = (operation) => shellStages(operation).some((stage) => DAILY_SHELL_MUTATION.test(stage.trim()));
export const allowsDailyOrchestratorShell = (tool, command, authoritativeObjective, env = process.env) => {
  if (env.OPENAI_DAILY_PROFILE !== "1" || !DAILY_SHELL_TOOLS.has(String(tool || "").toLowerCase())) return false;
  const objective = String(authoritativeObjective || "");
  const operation = String(command || "");
  if (hasDailyShellMutation(operation)) return false;
  const category = confirmationCategory(operation);
  if (category === "vps_ssh" && SAFE_SSH_PROBE.test(operation)) return true;
  if (category === "vps_ssh" && !CATEGORIES.vps_ssh.test(objective)) return false;
  if (["push", "deploy", "cron", "destructive"].includes(category) && !explicitlyConfirms(objective, category)) return false;
  return true;
};
export const requiresExplicitConfirmation = (operation) => confirmationCategory(operation) !== null;
export class GuardrailPolicyError extends Error { constructor(reason, details = {}) { super(`OPENAI_GUARDRAIL_${reason}: stop and report state; do not create todos or retry.`); this.name = "GuardrailPolicyError"; this.code = `OPENAI_GUARDRAIL_${reason}`; this.policy = { type: "policy_error", reason, stop: true, retry: false, ...details }; } }
export const objectiveIsBound = (authoritative, delegated) => { const a = String(authoritative || "").trim().replace(/\s+/g, " ").toLowerCase(), d = String(delegated || "").trim().replace(/\s+/g, " ").toLowerCase(); return Boolean(a && d && (a === d || d.includes(a) || a.includes(d))); };
const GENERIC_OBJECTIVE_TOKENS = new Set(["a", "an", "and", "add", "adding", "all", "apply", "change", "code", "command", "commands", "concise", "convention", "conventions", "create", "delete", "do", "edit", "existing", "file", "files", "finding", "findings", "fix", "for", "identify", "implement", "in", "inspect", "inspection", "into", "location", "make", "modify", "not", "of", "on", "or", "package", "path", "paths", "patch", "read", "recommended", "refactor", "relevant", "rename", "return", "review", "task", "test", "tests", "the", "to", "update", "with", "work", "workspace"]);
const GENERIC_FILENAME_COMPONENTS = new Set(["c", "cc", "cpp", "css", "h", "hpp", "html", "java", "js", "json", "jsx", "mjs", "py", "rb", "rs", "sh", "sql", "test", "tests", "ts", "tsx", "xml"]);
const safePathBasename = (path) => {
  const basename = path.split(/[\\/]/u).filter(Boolean).pop() || "";
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]*\.[\p{L}\p{N}]+$/u.test(basename) ? basename : "";
};
const quotedAbsolutePath = /(["'])((?:[A-Za-z]:[\\/]|\/)[^"']+)\1/gu;
const absolutePath = /(^|[\s("'`=:])((?:[A-Za-z]:[\\/]|\/)[^\s"'`;,)\]}]+)/gu;
const stripAbsolutePaths = (value) => String(value || "").replace(quotedAbsolutePath, (_, _quote, path) => safePathBasename(path)).replace(absolutePath, (_, prefix, path) => `${prefix}${safePathBasename(path)}`);
const normalizedScopeText = (value) => stripAbsolutePaths(String(value || "").normalize("NFKC")).trim().replace(/^[;,.:\-]+\s*|\s*[;,.:\-]+$/gu, "").replace(/\s+/gu, " ").toLowerCase();
const RESPONSE_FORMAT_CLAUSES = /\b(?:otherwise\s+return|return\s+exactly|return\s+nothing\s+else|return[^\n.!?]*?\band\s+nothing\s+else|do\s+not\s+include)\b[^\n]*(?:(?:[.!?])(?=\s+(?:[A-Z]|[\p{Lu}])|$)|$)/giu;
const stripResponseFormatClauses = (value) => String(value || "").replace(RESPONSE_FORMAT_CLAUSES, (clause) => clause.match(/\bif\b[\s\S]*/iu)?.[0] || " ");
const normalizedDomainText = (value) => normalizedScopeText(stripResponseFormatClauses(value));
const SCOPE_ACTION_WORDS = /\b(?:add(?!\s*\()|create|modify|change|implement|refactor|patch|delete|remove|drop|reset|rm|rename|update|fix|deploy|review|inspect|verify|approve|reject|confirm|completed?|work|run|write|operations?|agents?|otherwise|reason|but|include)\b|新增|添加|修改|更改|实现|重构|补丁|删除|移除|丢弃|重置|修复|确认|同意|批准|\b(?:aggiungi|crea|modifica|cambia|implementa|rifattorizza|elimina|rimuovi|reimposta|correggi|recensisci|verifica|approva|rifiuta|revisar|revisa|eliminar|elimina|borrar|borra)\b/giu;
const objectiveTokens = (value) => normalizedDomainText(value).replace(SCOPE_ACTION_WORDS, " ").match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu)?.flatMap((token) => token.split(/[._-]/u).filter((component) => component.length > 2 && !GENERIC_FILENAME_COMPONENTS.has(component))).filter((token) => !GENERIC_OBJECTIVE_TOKENS.has(token)) || [];
const canonicalParts = (value) => String(value || "").match(/^Parent objective \(verbatim\):\n([\s\S]*?)\nDelegated scope:\n([\s\S]*)$/);
const MUTATING_INTENT = /(?:\b(?:add(?!\s*\()|create|modify|change|implement|refactor|patch|delete|remove|drop|reset|rm|rename|update|fix|deploy)\b|新增|添加|修改|更改|实现|重构|补丁|删除|移除|丢弃|重置|修复|\b(?:aggiungi|crea|modifica|cambia|implementa|rifattorizza|elimina|rimuovi|reimposta|correggi|revisar|revisa|eliminar|elimina|borrar|borra)\b)/iu;
const DESTRUCTIVE_INTENT = /(?:\b(?:delet(?:e|ing|ed|ion)|remov(?:e|ing|ed)|drop(?:ping|ped)?|reset(?:ting|ted)?|rm|destroy|erase)\b|删除|移除|丢弃|重置|消除|\b(?:elimina|eliminare|rimuovi|rimuovere|cancella|cancellare|reimposta|eliminar|borrar|borra)\b)/iu;
const REVIEW_TASK_ID = /\breview_task_id\s*=\s*[a-f0-9]{64}\b/iu;
const REVIEW_PROTOCOL_WORDS = new Set(["approve", "approves", "approved", "completed", "critical", "findings", "finding", "inspect", "inspection", "reject", "rejects", "result", "results", "review", "reviewed", "verify", "verification", "work"]);
const pureReviewProtocolScope = (value) => {
  const text = normalizedScopeText(value);
  if (!REVIEW_TASK_ID.test(text)) return false;
  const protocol = text.replace(REVIEW_TASK_ID, " ");
  const tokens = protocol.match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu) || [];
  return tokens.length > 0 && tokens.every((token) => REVIEW_PROTOCOL_WORDS.has(token));
};
export const delegatedScopeIsBound = (parentObjective, normalizedScope, { targetBound = false } = {}) => {
  const parent = normalizedScopeText(parentObjective);
  const scope = normalizedScopeText(normalizedScope);
  if (!parent || !scope) return false;
  if (parent === scope) return true;
  const parentAnalysis = analyzeObjective(parent);
  const scopeAnalysis = analyzeObjective(scope);
  if (scopeAnalysis.classification === "MUTATING" && parentAnalysis.classification !== "MUTATING") return false;
  const parentMutating = parentAnalysis.classification === "MUTATING" || MUTATING_INTENT.test(parent);
  const childMutating = scopeAnalysis.classification === "MUTATING" || MUTATING_INTENT.test(scope);
  const parentDestructive = DESTRUCTIVE_INTENT.test(parent) && explicitlyConfirms(parent, "destructive");
  const childDestructive = DESTRUCTIVE_INTENT.test(scope);
  if (childDestructive && !parentDestructive) return false;
  if (childMutating && !parentMutating) return false;
  if (targetBound) return pureReviewProtocolScope(scope);
  const parentDomain = normalizedDomainText(parent.replace(SCOPE_ACTION_WORDS, " "));
  const scopeDomain = normalizedDomainText(scope.replace(SCOPE_ACTION_WORDS, " "));
  const parentTokens = new Set(objectiveTokens(parent));
  const childTokens = objectiveTokens(scope);
  if (/\btests?\b/iu.test(parentDomain)) {
    parentTokens.add("tests");
    if (/\btests?\b/iu.test(scopeDomain)) childTokens.push("tests");
  }
  if (!scopeDomain || childTokens.length === 0) return false;
  if (parentDomain === scopeDomain) return true;
  if (parentDomain.includes(scopeDomain)) return true;
  if (scopeDomain.includes(parentDomain)) return parentTokens.size >= 2 || scopeAnalysis.classification === "READ_ONLY";
  if (scopeAnalysis.classification === "AMBIGUOUS") return false;
  if (parentTokens.size < 2) return childTokens.length > 0 && childTokens.every((token) => parentTokens.has(token));
  const sharedTokens = new Set(childTokens.filter((token) => parentTokens.has(token)));
  return sharedTokens.size >= 2 || (scopeAnalysis.classification === "READ_ONLY" && childTokens.every((token) => parentTokens.has(token)));
};
export const canonicalDelegatedObjective = (parentObjective, childScope, { targetBound = false } = {}) => {
  const parent = String(parentObjective || "");
  let child = String(childScope || "");
  if (!parent.trim() || !child.trim()) return "";
  const parts = canonicalParts(child);
  if (parts && parts[1] === parent) child = parts[2];
  else if (child !== parent && child.includes(parent)) child = `${child.slice(0, child.indexOf(parent))} ${child.slice(child.indexOf(parent) + parent.length)}`;
  const normalizedScope = normalizedScopeText(child);
  if (!delegatedScopeIsBound(parent, normalizedScope, { targetBound })) return "";
  return `Parent objective (verbatim):\n${parent}\nDelegated scope:\n${normalizedScope}`;
};
export const delegationScope = (objective) => normalizedScopeText(canonicalParts(objective)?.[2] || objective);
export const createGuardrailState = (env = process.env, now = Date.now()) => ({ limits: readGuardrailLimits(env), startedAt: now, toolCalls: 0, weightedUnits: 0, delegations: 0, activeDelegations: 0, activeDelegation: false, delegationScopes: [], stopped: false, verificationTerminal: false, budgetTerminal: false, codexFailureTerminal: false, pendingVerificationPacketID: null, pendingTesterActive: false, classification: "normal", checkpointed: false, objective: null, authoritativeObjective: null });
export const preserveChildGuardState = (state, rootState = null, authoritativeObjective = null) => {
  const child = state || createGuardrailState();
  const rootLimits = rootState?.limits || {};
  const childLimits = child.limits || {};
  const limits = { ...childLimits };
  for (const key of ["minutes", "toolCalls", "delegations"]) {
    if (Number.isFinite(rootLimits[key]) && Number.isFinite(childLimits[key])) limits[key] = Math.min(rootLimits[key], childLimits[key]);
  }
  const rootStarted = Number.isFinite(rootState?.startedAt) ? rootState.startedAt : null;
  const childStarted = Number.isFinite(child.startedAt) ? child.startedAt : null;
  const activeDelegations = Math.max(child.activeDelegations || 0, rootState?.activeDelegations || 0, 1);
  return {
    ...child,
    limits,
    startedAt: rootStarted == null ? childStarted : childStarted == null ? rootStarted : Math.min(rootStarted, childStarted),
    stopped: Boolean(child.stopped || rootState?.stopped),
    budgetTerminal: Boolean(child.budgetTerminal || rootState?.budgetTerminal),
    verificationTerminal: Boolean(child.verificationTerminal || rootState?.verificationTerminal),
    toolCalls: Math.max(child.toolCalls || 0, rootState?.toolCalls || 0),
    weightedUnits: Math.max(child.weightedUnits || 0, rootState?.weightedUnits || 0),
    delegations: Math.max(child.delegations || 0, rootState?.delegations || 0),
    activeDelegations,
    activeDelegation: activeDelegations > 0,
    authoritativeObjective: authoritativeObjective || rootState?.authoritativeObjective || child.authoritativeObjective || null,
    codexFailureTerminal: Boolean(child.codexFailureTerminal || rootState?.codexFailureTerminal),
    pendingVerificationPacketID: rootState?.pendingVerificationPacketID || child.pendingVerificationPacketID || null,
    pendingTesterActive: Boolean(rootState?.pendingTesterActive || child.pendingTesterActive),
  };
};
export const verificationGateDecision = (state, tool, agent, prompt, activeTester = false) => {
  const packetID = state?.pendingVerificationPacketID;
  if (!packetID) return { allowed: true };
  const name = String(tool || "").toLowerCase();
  if (["bash", "interactive_bash", "shell", "command"].includes(name) && agent === "openai_orchestrator") return { allowed: false, reason: "MANDATORY_TESTER_GATE" };
  if (name !== "task") return { allowed: false, reason: "MANDATORY_TESTER_GATE" };
  const exact = String(prompt || "").match(/\btest_task_id=([^\s]+)/i)?.[1];
  if (agent !== "tester" || exact !== packetID) return { allowed: false, reason: "MANDATORY_TESTER_GATE" };
  if (state.pendingTesterActive || activeTester) return { allowed: false, reason: "TESTER_ALREADY_ACTIVE" };
  return { allowed: true, testerGate: true };
};
export const settleVerificationGateState = (state, packetID, taskState) => state?.pendingVerificationPacketID === packetID && ["COMPLETED", "FAILED"].includes(taskState)
  ? { ...state, pendingVerificationPacketID: null, pendingTesterActive: false } : state;
const toolWeight = (tool) => /^(read|search|glob|grep|lsp_|serena_(find|search|get)|diagnostic)/i.test(String(tool || "")) ? 0.5 : String(tool || "").trim() ? 1 : 0;
export const admitToolCall = (state, tool = "tool", now = Date.now()) => { if (typeof tool === "number") { now = tool; tool = "tool"; } if (state.stopped) throw new GuardrailPolicyError("STOPPED"); if (state.verificationTerminal) throw new GuardrailPolicyError("VERIFICATION_TERMINAL"); if (state.budgetTerminal) throw new GuardrailPolicyError("BUDGET_EXHAUSTED"); if (now - state.startedAt >= state.limits.minutes * 60000) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } const weight = toolWeight(tool), units = (state.weightedUnits || 0) + weight; if (units > state.limits.toolCalls) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } return { ...state, toolCalls: state.toolCalls + (weight ? 1 : 0), weightedUnits: units }; };
export const admitDelegation = (state, objective, { review = false, explicitlyRequestedReview = false } = {}) => { if (state.stopped) throw new GuardrailPolicyError("STOPPED"); if (state.verificationTerminal) throw new GuardrailPolicyError("VERIFICATION_TERMINAL"); if (state.activeDelegation && state.limits.delegations <= 2) throw new GuardrailPolicyError("CONCURRENT_DELEGATION"); if (state.delegations >= state.limits.delegations) throw new GuardrailPolicyError("DELEGATION_LIMIT"); if (!objectiveIsBound(state.objective, objective)) throw new GuardrailPolicyError("OBJECTIVE_UNBOUND"); if (review && !explicitlyRequestedReview) throw new GuardrailPolicyError("REVIEW_NOT_REQUESTED"); const scope = delegationScope(objective); if (state.limits.delegations > 1 && state.delegationScopes?.includes(scope)) throw new GuardrailPolicyError("DUPLICATE_DELEGATION_SCOPE"); const units = (state.weightedUnits || 0) + 2; if (units > state.limits.toolCalls) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } const activeDelegations = (state.activeDelegations || 0) + 1; return { ...state, weightedUnits: units, delegations: state.delegations + 1, activeDelegations, activeDelegation: activeDelegations > 0, delegationScopes: [...(state.delegationScopes || []), scope] }; };
export const finishDelegation = (state, verification = false, scope = null) => { const activeDelegations = Math.max(0, (state.activeDelegations || (state.activeDelegation ? 1 : 0)) - 1); const scopes = [...(state.delegationScopes || [])]; const index = scope ? scopes.indexOf(scope) : 0; if (index >= 0) scopes.splice(index, 1); return { ...state, activeDelegations, activeDelegation: activeDelegations > 0, delegationScopes: scopes, verificationTerminal: state.verificationTerminal || verification }; };
const latchPath = (root, session) => join(root || "/tmp", "guardrails", `${String(session).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
export const readStopLatch = async (root, session) => { try { return JSON.parse(await readFile(latchPath(root, session), "utf8")); } catch { return { stopped: false }; } };
export const writeStopLatch = async (root, session, state) => { const path = latchPath(root, session); await mkdir(join(path, ".."), { recursive: true, mode: 0o700 }); const tmp = `${path}.${Date.now()}.tmp`; await writeFile(tmp, `${JSON.stringify({ stopped: Boolean(state.stopped) })}\n`, { mode: 0o600 }); await rename(tmp, path); return state; };
