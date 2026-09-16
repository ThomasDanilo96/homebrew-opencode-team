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
const CATEGORIES = Object.freeze({ push: /\bpush(?:ing)?\b/i, deploy: /\bdeploy(?:ment|ing)?\b/i, cron: /\bcron(?:tab|job)?\b/i, vps_ssh: /\b(?:vps|ssh)\b/i, destructive: /\b(?:destruct(?:ive|ion)|delete|remove|drop|reset|rm)\b/i });
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
export const beginRequestCycle = (state = createGuardrailState(), text, now = Date.now(), env = process.env, { preserveVerificationTerminal = false } = {}) => {
  if (isInternalContinuation(text)) return state;
  if (state.verificationTerminal && preserveVerificationTerminal) return state;
  const analysis = env.OPENAI_DAILY_PROFILE === "1" ? analyzeObjective(text) : null;
  const classification = analysis ? DAILY_COMPLEXITY_TO_GUARDRAIL[analysis.complexity] : classifyRequest(text), limitsByClass = analysis ? DAILY_CLASS_LIMITS : CLASS_LIMITS, base = analysis ? { ...limitsByClass[classification], delegations: dailyFanout(analysis.complexity) } : limitsByClass[classification], override = requestOverrides(text);
  const configuredLimits = readGuardrailLimits({ ...env, ...(override.minutes ? { OPENAI_GUARDRAIL_MINUTES: override.minutes } : {}), ...(override.toolCalls ? { OPENAI_GUARDRAIL_TOOL_CALLS: override.toolCalls } : {}) }, base, analysis ? DAILY_BOUNDS : BOUNDS);
  const limits = analysis ? { ...configuredLimits, delegations: Math.min(configuredLimits.delegations, analysis.fanout_limit) } : configuredLimits;
  const resumed = isExplicitResumeText(text);
  return { ...state, objective: String(text || "").trim(), authoritativeObjective: preserveVerificationTerminal ? state.authoritativeObjective || state.objective || null : String(text || "").trim(), limits, startedAt: now, toolCalls: 0, weightedUnits: 0, delegations: 0, activeDelegations: 0, activeDelegation: false, verificationTerminal: false, budgetTerminal: false, classification, complexity: analysis?.complexity ?? null, fanoutLimit: analysis?.fanout_limit ?? null, checkpointed: classification === "long", stopped: resumed ? false : Boolean(state.stopped) || isStopText(text) };
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
  };
};
export const confirmationCategory = (operation) => Object.entries(CATEGORIES).find(([, pattern]) => pattern.test(String(operation || "")))?.[0] || null;
export const explicitlyConfirms = (request, category) => Boolean(category && CATEGORIES[category] && !/\b(?:continue|go ahead|proceed)\b/i.test(String(request || "")) && /\b(?:authorize|authorise|confirm|explicitly|approved?|consent|yes|do)\b/i.test(String(request || "")) && CATEGORIES[category].test(String(request || "")));
export const requiresExplicitConfirmation = (operation) => confirmationCategory(operation) !== null;
export class GuardrailPolicyError extends Error { constructor(reason, details = {}) { super(`OPENAI_GUARDRAIL_${reason}: stop and report state; do not create todos or retry.`); this.name = "GuardrailPolicyError"; this.code = `OPENAI_GUARDRAIL_${reason}`; this.policy = { type: "policy_error", reason, stop: true, retry: false, ...details }; } }
export const objectiveIsBound = (authoritative, delegated) => { const a = String(authoritative || "").trim().replace(/\s+/g, " ").toLowerCase(), d = String(delegated || "").trim().replace(/\s+/g, " ").toLowerCase(); return Boolean(a && d && (a === d || d.includes(a) || a.includes(d))); };
export const delegationScope = (objective) => String(objective || "").trim().replace(/\s+/g, " ").toLowerCase();
export const createGuardrailState = (env = process.env, now = Date.now()) => ({ limits: readGuardrailLimits(env), startedAt: now, toolCalls: 0, weightedUnits: 0, delegations: 0, activeDelegations: 0, activeDelegation: false, delegationScopes: [], stopped: false, verificationTerminal: false, budgetTerminal: false, classification: "normal", checkpointed: false, objective: null, authoritativeObjective: null });
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
  };
};
const toolWeight = (tool) => /^(read|search|glob|grep|lsp_|serena_(find|search|get)|diagnostic)/i.test(String(tool || "")) ? 0.5 : String(tool || "").trim() ? 1 : 0;
export const admitToolCall = (state, tool = "tool", now = Date.now()) => { if (typeof tool === "number") { now = tool; tool = "tool"; } if (state.stopped) throw new GuardrailPolicyError("STOPPED"); if (state.verificationTerminal) throw new GuardrailPolicyError("VERIFICATION_TERMINAL"); if (state.budgetTerminal) throw new GuardrailPolicyError("BUDGET_EXHAUSTED"); if (now - state.startedAt >= state.limits.minutes * 60000) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } const weight = toolWeight(tool), units = (state.weightedUnits || 0) + weight; if (units > state.limits.toolCalls) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } return { ...state, toolCalls: state.toolCalls + (weight ? 1 : 0), weightedUnits: units }; };
export const admitDelegation = (state, objective, { review = false, explicitlyRequestedReview = false } = {}) => { if (state.stopped) throw new GuardrailPolicyError("STOPPED"); if (state.verificationTerminal) throw new GuardrailPolicyError("VERIFICATION_TERMINAL"); if (state.activeDelegation && state.limits.delegations <= 2) throw new GuardrailPolicyError("CONCURRENT_DELEGATION"); if (state.delegations >= state.limits.delegations) throw new GuardrailPolicyError("DELEGATION_LIMIT"); if (!objectiveIsBound(state.objective, objective)) throw new GuardrailPolicyError("OBJECTIVE_UNBOUND"); if (review && !explicitlyRequestedReview) throw new GuardrailPolicyError("REVIEW_NOT_REQUESTED"); const scope = delegationScope(objective); if (state.limits.delegations > 1 && state.delegationScopes?.includes(scope)) throw new GuardrailPolicyError("DUPLICATE_DELEGATION_SCOPE"); const units = (state.weightedUnits || 0) + 2; if (units > state.limits.toolCalls) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } const activeDelegations = (state.activeDelegations || 0) + 1; return { ...state, weightedUnits: units, delegations: state.delegations + 1, activeDelegations, activeDelegation: activeDelegations > 0, delegationScopes: [...(state.delegationScopes || []), scope] }; };
export const finishDelegation = (state, verification = false, scope = null) => { const activeDelegations = Math.max(0, (state.activeDelegations || (state.activeDelegation ? 1 : 0)) - 1); const scopes = [...(state.delegationScopes || [])]; const index = scope ? scopes.indexOf(scope) : 0; if (index >= 0) scopes.splice(index, 1); return { ...state, activeDelegations, activeDelegation: activeDelegations > 0, delegationScopes: scopes, verificationTerminal: state.verificationTerminal || verification }; };
const latchPath = (root, session) => join(root || "/tmp", "guardrails", `${String(session).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
export const readStopLatch = async (root, session) => { try { return JSON.parse(await readFile(latchPath(root, session), "utf8")); } catch { return { stopped: false }; } };
export const writeStopLatch = async (root, session, state) => { const path = latchPath(root, session); await mkdir(join(path, ".."), { recursive: true, mode: 0o700 }); const tmp = `${path}.${Date.now()}.tmp`; await writeFile(tmp, `${JSON.stringify({ stopped: Boolean(state.stopped) })}\n`, { mode: 0o600 }); await rename(tmp, path); return state; };
