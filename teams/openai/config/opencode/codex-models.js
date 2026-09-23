// Pure model selection; keep this separate so profile policy is testable
// without loading the OpenCode plugin.
import { assertDailyProviderModel } from "../../../daily/daily-policy.mjs";
const profiles = {
  quick: ["OPENAI_CODEX_QUICK_PRIMARY", "OPENAI_CODEX_QUICK_FALLBACK", "gpt-5.3-codex-spark", "gpt-5.6-terra"],
  standard: ["OPENAI_CODEX_STANDARD_PRIMARY", "OPENAI_CODEX_STANDARD_FALLBACK", "gpt-5.6-terra", "gpt-5.6-sol"],
  complex: ["OPENAI_CODEX_COMPLEX_PRIMARY", "OPENAI_CODEX_COMPLEX_FALLBACK", "gpt-5.6-sol", "gpt-5.6-terra"],
};
export const resolveCodexModels = (codexProfile, env = process.env) => {
  const profile = profiles[codexProfile] ? codexProfile : "standard";
  const [primaryKey, fallbackKey, defaultPrimary, defaultFallback] = profiles[profile];
  const requested_model = String(env.OPENAI_CODEX_MODEL || env[primaryKey] || defaultPrimary);
  const candidate = String(env.OPENAI_CODEX_FALLBACK_MODEL || env[fallbackKey] || defaultFallback);
  if (env.OPENAI_DAILY_PROFILE === "1") {
    assertDailyProviderModel({ model: `openai/${requested_model}` });
    assertDailyProviderModel({ model: `openai/${candidate}` });
  }
  return { profile, requested_model, fallback_model: candidate && candidate !== requested_model ? candidate : null };
};
