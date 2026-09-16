const tier = (model, input, cached, output) => ({ model, input_per_million: input, cached_per_million: cached, output_per_million: output });

export const TRIVIAL = 0;
export const NORMAL = 1;
export const COMPLEX = 3;
export const HEAVY = 6;
export const EXTREME = 10;

export const DAILY_FANOUT = Object.freeze({ TRIVIAL, NORMAL, COMPLEX, HEAVY, EXTREME });
export const DAILY_COMPLEXITY_TO_GUARDRAIL = Object.freeze({ TRIVIAL: "quick", NORMAL: "normal", COMPLEX: "complex", HEAVY: "long", EXTREME: "long" });

export const DAILY_AGENT_MODELS = Object.freeze({
  openai_orchestrator: "openai/gpt-5.6-luna",
  openai_explore: "openai/gpt-5.6-luna",
  openai_librarian: "openai/gpt-5.6-luna",
  openai_ops: "openai/gpt-5.6-luna",
  tester: "openai/gpt-5.6-luna",
  reviewer: "openai/gpt-5.6-terra",
  reviewer_critical: "openai/gpt-5.6-sol",
  specialist: "openai/gpt-5.6-terra",
  codex_executor: "openai/gpt-5.6-luna",
});

export const DAILY_PRICING = Object.freeze({
  effective_date: "2026-09-16",
  source: "https://platform.openai.com/docs/pricing",
  models: Object.freeze({
    "gpt-5.6-luna": tier("gpt-5.6-luna", 0.2, 0.02, 1.2),
    "gpt-5.6-terra": tier("gpt-5.6-terra", 2, 0.2, 12),
    "gpt-5.6-sol": tier("gpt-5.6-sol", 4, 0.4, 20),
  }),
});

export const dailyFanout = (complexity) => DAILY_FANOUT[String(complexity || "NORMAL").toUpperCase()] ?? NORMAL;

export const dailyCost = ({ model, input = 0, cached = 0, output = 0 } = {}) => {
  const pricing = DAILY_PRICING.models[String(model || "")];
  if (!pricing || [input, cached, output].some((value) => !Number.isFinite(value) || value < 0)) return null;
  return Number(((input * pricing.input_per_million + cached * pricing.cached_per_million + output * pricing.output_per_million) / 1_000_000).toFixed(6));
};
