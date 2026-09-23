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

const textArg = (args = {}) => [args.pattern, args.query, args.command, args.cmd, args.path, args.directory, args.cwd]
  .filter((value) => typeof value === "string")
  .join(" ")
  .trim();

export const dailySearchDecision = ({ tool = "", args = {}, seen = new Set() } = {}) => {
  const name = String(tool).toLowerCase();
  const text = textArg(args);
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const scope = String(args.path || args.directory || args.cwd || "").trim();
  const signature = `${name}:${normalized}`;
  if (seen.has(signature)) return { allowed: false, reason: "DUPLICATE_SEARCH" };
  if (name === "glob" && /(?:^|[/ ])\*\*\/?(?:\*|$)/.test(normalized) && (!scope || [".", "./", "/"].includes(scope))) return { allowed: false, reason: "ROOT_GLOB_STARSTAR" };
  if ((name === "grep" || name === "rg") && (!scope || [".", "./", "/"].includes(scope))) return { allowed: false, reason: "UNTARGETED_REPOSITORY_SEARCH" };
  if (/package-lock\.json/.test(normalized) && !/package-lock\.json$/.test(String(args.path || "").toLowerCase())) return { allowed: false, reason: "PACKAGE_LOCK_NOISE" };
  if (name === "bash" && /(?:^|[;&|\s])strings\s+[^;&|\n]*\b(?:bin|opencode|\.dylib|\.so)\b/i.test(text)) return { allowed: false, reason: "BINARY_STRINGS_SCAN" };
  return { allowed: true, signature };
};

export const dailyInvestigationLimits = (complexity = "NORMAL") => DAILY_INVESTIGATION_LIMITS[String(complexity).toUpperCase()] ?? DAILY_INVESTIGATION_LIMITS.NORMAL;

export const shouldStopDaily = ({ answerSupported = false, materialContradiction = false, remainingEvidence = "unknown" } = {}) =>
  answerSupported === true && materialContradiction !== true && remainingEvidence === "confirmatory";

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
