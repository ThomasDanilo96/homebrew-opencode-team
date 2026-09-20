import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const DAILY_CONTRACT = Object.freeze({
  profile: "daily",
  agents: Object.freeze({
    orchestrator: "openai/gpt-5.6-luna",
    explore: "openai/gpt-5.6-luna",
    librarian: "openai/gpt-5.6-luna",
    ops: "openai/gpt-5.6-luna",
    tester: "openai/gpt-5.6-luna",
    reviewer: "openai/gpt-5.6-terra",
    reviewer_critical: "openai/gpt-5.6-sol",
    specialist: "openai/gpt-5.6-terra",
    codex_executor: "openai/gpt-5.6-luna",
  }),
  codex: Object.freeze({
    quick: Object.freeze(["gpt-5.6-luna", "gpt-5.6-terra"]),
    standard: Object.freeze(["gpt-5.6-terra", "gpt-5.6-sol"]),
    complex: Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra"]),
  }),
  forbiddenModels: Object.freeze(["gpt-6-astra", "gpt-5.6-astra"]),
});

export const OPENAI_CONTRACT = Object.freeze({
  profile: "openai",
  source: "teams/openai/config/opencode/openai-team-tools.js",
  note: "OPENAI is the comparison profile; its current premium assignments are not a DAILY contract.",
});

export function sourceFingerprint() {
  const files = ["teams/daily/daily-policy.mjs", "teams/daily/runtime-env.sh", "teams/openai/config/opencode/codex-models.js"];
  return createHash("sha256").update(files.map((file) => readFileSync(join(ROOT, file))).join("\n")).digest("hex");
}

export function verifyDailyContract() {
  const policy = readFileSync(join(ROOT, "teams/daily/daily-policy.mjs"), "utf8");
  const runtime = readFileSync(join(ROOT, "teams/daily/runtime-env.sh"), "utf8");
  const failures = [];
  for (const [agent, model] of Object.entries(DAILY_CONTRACT.agents)) {
    if (!policy.includes(`${agent}: "${model}"`)) failures.push(`agent:${agent}`);
  }
  for (const [profile, [primary, fallback]] of Object.entries(DAILY_CONTRACT.codex)) {
    const prefix = profile.toUpperCase();
    if (!runtime.includes(`OPENAI_CODEX_${prefix}_PRIMARY:-${primary}`)) failures.push(`codex:${profile}:primary`);
    if (!runtime.includes(`OPENAI_CODEX_${prefix}_FALLBACK:-${fallback}`)) failures.push(`codex:${profile}:fallback`);
  }
  if (DAILY_CONTRACT.forbiddenModels.some((model) => policy.includes(model) || runtime.includes(model))) failures.push("forbidden-model");
  return { passed: failures.length === 0, failures, fingerprint: sourceFingerprint() };
}
