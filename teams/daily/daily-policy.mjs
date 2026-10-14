const tier = (model, input, cached, output) => ({ model, input_per_million: input, cached_per_million: cached, output_per_million: output });

export const TRIVIAL = 0;
export const NORMAL = 1;
export const COMPLEX = 2;
export const HEAVY = 3;
export const EXTREME = 3;

export const DAILY_FANOUT = Object.freeze({ TRIVIAL, NORMAL, COMPLEX, HEAVY, EXTREME });
export const DAILY_COMPLEXITY_TO_GUARDRAIL = Object.freeze({ TRIVIAL: "quick", NORMAL: "normal", COMPLEX: "complex", HEAVY: "long", EXTREME: "long" });

export const DAILY_INVESTIGATION_LIMITS = Object.freeze({
  TRIVIAL: Object.freeze({ minutes: 3, toolCalls: 5 }),
  NORMAL: Object.freeze({ minutes: 8, toolCalls: 12 }),
  COMPLEX: Object.freeze({ minutes: 20, toolCalls: 20 }),
  HEAVY: Object.freeze({ minutes: 35, toolCalls: 30 }),
  EXTREME: Object.freeze({ minutes: 45, toolCalls: 40 }),
});

export const dailyInvestigationLimits = (complexity = "NORMAL") => DAILY_INVESTIGATION_LIMITS[String(complexity).toUpperCase()] ?? DAILY_INVESTIGATION_LIMITS.NORMAL;

export const shouldStopDaily = ({ answerSupported = false, materialContradiction = false, remainingEvidence = "unknown", exhaustiveRequested = false } = {}) =>
  exhaustiveRequested !== true && answerSupported === true && materialContradiction !== true && remainingEvidence === "confirmatory";

export const DAILY_AGENT_MODELS = Object.freeze({
  openai_orchestrator: "openai/gpt-6-luna",
  openai_explore: "openai/gpt-6-luna",
  openai_librarian: "openai/gpt-6-luna",
  openai_ops: "openai/gpt-6-luna",
  tester: "openai/gpt-6-luna",
  reviewer: "openai/gpt-5.6-terra",
  reviewer_critical: "openai/gpt-6-sol",
  specialist: "openai/gpt-5.6-terra",
  codex_executor: "openai/gpt-6-luna",
});

export const DAILY_ALLOWED_PROVIDER = "openai";
export const DAILY_ALLOWED_MODELS = Object.freeze([
  "gpt-6-luna",
  "gpt-5.6-terra",
  "gpt-6-sol",
]);

export const dailyModelIdentity = (model = "") => {
  const value = String(model || "").trim();
  const separator = value.indexOf("/");
  return separator < 1 ? { provider: "", model: value } : { provider: value.slice(0, separator), model: value.slice(separator + 1) };
};

export const assertDailyProviderModel = ({ provider = "", model = "" } = {}) => {
  const identity = provider ? { provider: String(provider), model: String(model) } : dailyModelIdentity(model);
  if (identity.provider !== DAILY_ALLOWED_PROVIDER) {
    const error = new Error(`OPENAI_DAILY_PROVIDER_FORBIDDEN: ${identity.provider || "(missing)"}`);
    error.code = "OPENAI_DAILY_PROVIDER_FORBIDDEN";
    throw error;
  }
  if (!DAILY_ALLOWED_MODELS.includes(identity.model)) {
    const error = new Error(`OPENAI_DAILY_MODEL_FORBIDDEN: ${identity.model || "(missing)"}`);
    error.code = "OPENAI_DAILY_MODEL_FORBIDDEN";
    throw error;
  }
  return Object.freeze(identity);
};

export const DAILY_PRICING = Object.freeze({
  effective_date: "2026-09-16",
  source: "https://platform.openai.com/docs/pricing",
  models: Object.freeze({
    "gpt-6-luna": tier("gpt-6-luna", 0.2, 0.02, 1.2),
    "gpt-5.6-terra": tier("gpt-5.6-terra", 2, 0.2, 12),
    "gpt-6-sol": tier("gpt-6-sol", 4, 0.4, 20),
  }),
});

export const dailyFanout = (complexity) => DAILY_FANOUT[String(complexity || "NORMAL").toUpperCase()] ?? NORMAL;

export const dailyCost = ({ model, input = 0, cached = 0, output = 0 } = {}) => {
  const pricing = DAILY_PRICING.models[String(model || "")];
  if (!pricing || [input, cached, output].some((value) => !Number.isFinite(value) || value < 0)) return null;
  return Number(((input * pricing.input_per_million + cached * pricing.cached_per_million + output * pricing.output_per_million) / 1_000_000).toFixed(6));
};
