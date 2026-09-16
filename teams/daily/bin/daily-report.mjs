#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DAILY_PRICING, dailyCost } from "../daily-policy.mjs";

const MODELS = Object.freeze({ Luna: "gpt-5.6-luna", Terra: "gpt-5.6-terra", Sol: "gpt-5.6-sol" });
const COMPLEXITIES = Object.freeze(["TRIVIAL", "NORMAL", "COMPLEX", "HEAVY", "EXTREME"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const token = (packet, field) => packet[field] === undefined ? 0 : finite(packet[field]);
const sum = (packets, field) => {
  const values = packets.map((packet) => finite(packet[field])).filter((value) => value !== null);
  return values.length === packets.length ? values.reduce((total, value) => total + value, 0) : null;
};
const tokenMetric = (packet, metric) => {
  const codexInput = token(packet, "codex_input_tokens");
  const codexCached = token(packet, "codex_cached_input_tokens");
  const opencodeInput = token(packet, "opencode_input_tokens");
  const opencodeCached = token(packet, "opencode_cached_input_tokens");
  if (metric === "cached_input_tokens") return codexCached === null || opencodeCached === null ? null : codexCached + opencodeCached;
  if (metric === "uncached_input_tokens") return codexInput === null || codexCached === null || opencodeInput === null || opencodeCached === null ? null : codexInput - codexCached + opencodeInput - opencodeCached;
  const fields = { output_tokens: ["codex_output_tokens", "opencode_output_tokens"], reasoning_tokens: ["codex_reasoning_tokens", "opencode_reasoning_tokens"] }[metric];
  if (!fields) return null;
  const values = fields.map((field) => token(packet, field));
  return values.some((value) => value === null) ? null : values.reduce((total, value) => total + value, 0);
};
const sumMetric = (packets, metric) => {
  const values = packets.map((packet) => tokenMetric(packet, metric));
  return values.length && values.every((value) => value !== null) ? values.reduce((total, value) => total + value, 0) : null;
};
const modelName = (packet) => {
  const model = String(packet.executed_model || packet.requested_model || "").toLowerCase().replace(/^openai\//, "");
  return Object.entries(MODELS).find(([, value]) => model === value)?.[0] || "Unknown";
};
const packetCost = (packet) => {
  const model = MODELS[modelName(packet)];
  if (!model) return null;
  const codexInput = token(packet, "codex_input_tokens");
  const codexCached = token(packet, "codex_cached_input_tokens");
  const opencodeInput = token(packet, "opencode_input_tokens");
  const opencodeCached = token(packet, "opencode_cached_input_tokens");
  const output = [finite(packet.codex_output_tokens), finite(packet.opencode_output_tokens)];
  if ([codexInput, codexCached, opencodeInput, opencodeCached, ...output].some((value) => value === null)) return null;
  return dailyCost({ model, input: codexInput - codexCached + opencodeInput - opencodeCached, cached: codexCached + opencodeCached, output: output.reduce((total, value) => total + value, 0) });
};
const percentile = (values, percentileValue) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
};
const groupReport = (packets) => ({
  completed_tasks: packets.length,
  estimated_total_usd: packets.length && packets.every((packet) => packetCost(packet) !== null) ? Number(packets.reduce((total, packet) => total + packetCost(packet), 0).toFixed(6)) : null,
  cached_input_tokens: sumMetric(packets, "cached_input_tokens"),
  uncached_input_tokens: sumMetric(packets, "uncached_input_tokens"),
  output_tokens: sumMetric(packets, "output_tokens"),
  reasoning_tokens: sumMetric(packets, "reasoning_tokens"),
  retry_count: sum(packets, "retry_count"),
  compaction_count: sum(packets, "compaction_count"),
  p50_duration_ms: percentile(packets.map((packet) => finite(packet.duration_ms)).filter((value) => value !== null), 0.5),
  p95_duration_ms: percentile(packets.map((packet) => finite(packet.duration_ms)).filter((value) => value !== null), 0.95),
});

export const summarizeDailyPackets = (packets) => {
  const completed = packets.filter((packet) => ["completed", "success"].includes(packet.outcome));
  const parentCounts = new Map();
  for (const packet of completed) if (packet.parent_session_id) parentCounts.set(packet.parent_session_id, (parentCounts.get(packet.parent_session_id) || 0) + 1);
  const subagentCounts = completed.map((packet) => parentCounts.get(packet.parent_session_id)).filter((value) => Number.isInteger(value));
  const totals = groupReport(completed);
  const allInput = [totals.cached_input_tokens, totals.uncached_input_tokens];
  const cacheRatio = allInput.every((value) => value !== null) && allInput[0] + allInput[1] > 0 ? Number((allInput[0] / (allInput[0] + allInput[1]) * 100).toFixed(3)) : null;
  const byModel = Object.fromEntries([...Object.keys(MODELS), "Unknown"].map((value) => [value, groupReport(completed.filter((packet) => modelName(packet) === value))]));
  const byComplexity = Object.fromEntries(COMPLEXITIES.map((value) => [value, groupReport(completed.filter((packet) => String(packet.complexity || "").toUpperCase() === value))]));
  return { ...totals, estimated_usd_per_task: totals.estimated_total_usd === null || !completed.length ? null : Number((totals.estimated_total_usd / completed.length).toFixed(6)), cache_ratio_pct: cacheRatio, avg_subagents: subagentCounts.length === completed.length && completed.length ? Number((subagentCounts.reduce((total, value) => total + value, 0) / subagentCounts.length).toFixed(3)) : null, max_subagents: subagentCounts.length === completed.length && completed.length ? Math.max(...subagentCounts) : null, sol_escalation_count: completed.filter((packet) => modelName(packet) === "Sol").length, by_model: byModel, by_complexity: byComplexity, pricing_source: DAILY_PRICING.source, pricing_effective_date: DAILY_PRICING.effective_date };
};

const loadPackets = (stateRoot) => {
  const packetRoot = `${stateRoot}/work-packets`;
  if (!existsSync(packetRoot)) return [];
  return readdirSync(packetRoot).filter((name) => /^[a-f0-9]{64}\.json$/i.test(name)).flatMap((name) => {
    try { const packet = JSON.parse(readFileSync(`${packetRoot}/${name}`, "utf8")); return packet && typeof packet === "object" ? [packet] : []; } catch { return []; }
  });
};

const renderMarkdown = (report) => `# OpenAI Daily report\n\n- Completed tasks: ${report.completed_tasks}\n- Estimated total USD: ${report.estimated_total_usd ?? "unmeasured"}\n- Estimated USD/task: ${report.estimated_usd_per_task ?? "unmeasured"}\n- Cache ratio: ${report.cache_ratio_pct ?? "unmeasured"}%\n- P50/P95 duration: ${report.p50_duration_ms ?? "unmeasured"}/${report.p95_duration_ms ?? "unmeasured"} ms\n- Sol escalations: ${report.sol_escalation_count}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const markdown = process.argv.includes("--markdown");
  const stateRoot = process.env.OPENAI_TEAM_STATE_ROOT || "/tmp";
  const report = summarizeDailyPackets(loadPackets(stateRoot));
  process.stdout.write(markdown ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
}
