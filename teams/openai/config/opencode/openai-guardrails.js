import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_GUARDRAIL_LIMITS = Object.freeze({ minutes: 15, toolCalls: 20, delegations: 1 });
const CLASS_LIMITS = Object.freeze({ quick: { minutes: 5, toolCalls: 8, delegations: 1 }, normal: { minutes: 15, toolCalls: 20, delegations: 1 }, complex: { minutes: 45, toolCalls: 50, delegations: 2 }, long: { minutes: 120, toolCalls: 100, delegations: 2 } });
const BOUNDS = { minutes: [1, 120], toolCalls: [1, 100], delegations: [1, 2] };
const STOP = /\b(?:stop|halt|cancel|abort|fermati|ferma|basta|arresta|annulla)\b/i;
const RESUME = /\b(?:resume|restart|start|continue|riprendi|ripart(?:i|ire)|avvia|ricomincia)\b/i;
const INTERNAL = /OMO_INTERNAL_INITIATOR|OH-MY-OPENCODE/i;
const LONG = /\b(?:authorize|authorise|approved?|consent(?:ed)?)\b[^\n]{0,40}\b(?:long[- ]work|long[- ]running|duration|hours?)\b|\b(?:long[- ]work|long[- ]running|duration|hours?)\b[^\n]{0,40}\b(?:authorize|authorise|approved?|consent)\b/i;
const COMPLEX = /\b(?:complex|multi[- ]step|cross[- ](?:service|repository)|end[- ]to[- ]end|integration|migrat|refactor|architecture)\b/i;
const QUICK = /\b(?:quick(?:ly)?|simple|small|brief|just\s+(?:tell|show|read|check)|what\s+is|how\s+do\s+i)\b/i;
const CATEGORIES = Object.freeze({ push: /\bpush(?:ing)?\b/i, deploy: /\bdeploy(?:ment|ing)?\b/i, cron: /\bcron(?:tab|job)?\b/i, vps_ssh: /\b(?:vps|ssh)\b/i, destructive: /\b(?:destruct(?:ive|ion)|delete|remove|drop|reset|rm)\b/i });
const bounded = (value, fallback, [min, max]) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
export const readGuardrailLimits = (env = process.env, base = DEFAULT_GUARDRAIL_LIMITS) => ({
  minutes: bounded(env.OPENAI_GUARDRAIL_MINUTES ?? env.OPENAI_REQUEST_MAX_MINUTES, base.minutes, BOUNDS.minutes),
  toolCalls: bounded(env.OPENAI_GUARDRAIL_TOOL_CALLS ?? env.OPENAI_MAX_TOOL_CALLS, base.toolCalls, BOUNDS.toolCalls),
  delegations: bounded(env.OPENAI_GUARDRAIL_DELEGATIONS ?? env.OPENAI_MAX_DELEGATIONS, base.delegations, BOUNDS.delegations),
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
export const updateStopLatch = (state = { stopped: false }, text, genuine = true) => !genuine || isInternalContinuation(text) ? { ...state } : isStopText(text) ? { ...state, stopped: true } : state.stopped && isExplicitResumeText(text) ? { ...state, stopped: false } : { ...state };
export const beginRequestCycle = (state = createGuardrailState(), text, now = Date.now(), env = process.env) => {
  if (isInternalContinuation(text)) return state;
  const classification = classifyRequest(text), base = CLASS_LIMITS[classification], override = requestOverrides(text);
  const limits = readGuardrailLimits({ ...env, ...(override.minutes ? { OPENAI_GUARDRAIL_MINUTES: override.minutes } : {}), ...(override.toolCalls ? { OPENAI_GUARDRAIL_TOOL_CALLS: override.toolCalls } : {}) }, base);
  const resumed = isExplicitResumeText(text);
  return { ...state, objective: String(text || "").trim(), limits, startedAt: now, toolCalls: 0, weightedUnits: 0, delegations: 0, activeDelegation: false, verificationTerminal: false, budgetTerminal: false, classification, checkpointed: classification === "long", stopped: resumed ? false : Boolean(state.stopped) || isStopText(text) };
};
export const confirmationCategory = (operation) => Object.entries(CATEGORIES).find(([, pattern]) => pattern.test(String(operation || "")))?.[0] || null;
export const explicitlyConfirms = (request, category) => Boolean(category && CATEGORIES[category] && !/\b(?:continue|go ahead|proceed)\b/i.test(String(request || "")) && /\b(?:authorize|authorise|confirm|explicitly|approved?|consent|yes|do)\b/i.test(String(request || "")) && CATEGORIES[category].test(String(request || "")));
export const requiresExplicitConfirmation = (operation) => confirmationCategory(operation) !== null;
export class GuardrailPolicyError extends Error { constructor(reason, details = {}) { super(`OPENAI_GUARDRAIL_${reason}: stop and report state; do not create todos or retry.`); this.name = "GuardrailPolicyError"; this.code = `OPENAI_GUARDRAIL_${reason}`; this.policy = { type: "policy_error", reason, stop: true, retry: false, ...details }; } }
export const objectiveIsBound = (authoritative, delegated) => { const a = String(authoritative || "").trim().replace(/\s+/g, " ").toLowerCase(), d = String(delegated || "").trim().replace(/\s+/g, " ").toLowerCase(); return Boolean(a && d && (a === d || d.includes(a) || a.includes(d))); };
export const createGuardrailState = (env = process.env, now = Date.now()) => ({ limits: readGuardrailLimits(env), startedAt: now, toolCalls: 0, weightedUnits: 0, delegations: 0, activeDelegation: false, stopped: false, verificationTerminal: false, budgetTerminal: false, classification: "normal", checkpointed: false, objective: null });
const toolWeight = (tool) => /^(read|search|glob|grep|lsp_|serena_(find|search|get)|diagnostic)/i.test(String(tool || "")) ? 0.5 : String(tool || "").trim() ? 1 : 0;
export const admitToolCall = (state, tool = "tool", now = Date.now()) => { if (typeof tool === "number") { now = tool; tool = "tool"; } if (state.stopped) throw new GuardrailPolicyError("STOPPED"); if (state.verificationTerminal) throw new GuardrailPolicyError("VERIFICATION_TERMINAL"); if (state.budgetTerminal) throw new GuardrailPolicyError("BUDGET_EXHAUSTED"); if (now - state.startedAt >= state.limits.minutes * 60000) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } const weight = toolWeight(tool), units = (state.weightedUnits || 0) + weight; if (units > state.limits.toolCalls) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } return { ...state, toolCalls: state.toolCalls + (weight ? 1 : 0), weightedUnits: units }; };
export const admitDelegation = (state, objective, { review = false, explicitlyRequestedReview = false } = {}) => { if (state.stopped) throw new GuardrailPolicyError("STOPPED"); if (state.verificationTerminal) throw new GuardrailPolicyError("VERIFICATION_TERMINAL"); if (state.activeDelegation) throw new GuardrailPolicyError("CONCURRENT_DELEGATION"); if (state.delegations >= state.limits.delegations) throw new GuardrailPolicyError("DELEGATION_LIMIT"); if (!objectiveIsBound(state.objective, objective)) throw new GuardrailPolicyError("OBJECTIVE_UNBOUND"); if (review && !explicitlyRequestedReview) throw new GuardrailPolicyError("REVIEW_NOT_REQUESTED"); const units = (state.weightedUnits || 0) + 2; if (units > state.limits.toolCalls) { state.budgetTerminal = true; throw new GuardrailPolicyError("BUDGET_EXHAUSTED", { terminal: true }); } return { ...state, weightedUnits: units, delegations: state.delegations + 1, activeDelegation: true }; };
export const finishDelegation = (state, verification = false) => ({ ...state, activeDelegation: false, verificationTerminal: state.verificationTerminal || verification });
const latchPath = (root, session) => join(root || "/tmp", "guardrails", `${String(session).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
export const readStopLatch = async (root, session) => { try { return JSON.parse(await readFile(latchPath(root, session), "utf8")); } catch { return { stopped: false }; } };
export const writeStopLatch = async (root, session, state) => { const path = latchPath(root, session); await mkdir(join(path, ".."), { recursive: true, mode: 0o700 }); const tmp = `${path}.${Date.now()}.tmp`; await writeFile(tmp, `${JSON.stringify({ stopped: Boolean(state.stopped) })}\n`, { mode: 0o600 }); await rename(tmp, path); return state; };
