import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const unsafe = /(?:[|;&<>`]|\$\(|\|\||\r|\n)/;
const safePath = (value) => /^(?:tests\/)?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..") && !value.startsWith("/");
const testFilePath = (value) => safePath(value) && /(?:^|\/)(?:tests?|spec)\//.test(value) || safePath(value) && /(?:test|spec)\.[A-Za-z0-9]+$/.test(value);
const commandCategory = (command) => {
  if (unsafe.test(command) || /\s-c(?:\s|$)|\bnode\s+-e\b/.test(command)) return null;
  const argv = command.trim().split(/\s+/);
  if (!argv.length || argv.some((part) => !part)) return null;
  if (argv[0] === "node" && argv[1] === "--check" && argv.length === 3 && safePath(argv[2])) return "node_check";
  if (argv[0] === "node" && argv[1] === "--test" && (argv.length === 2 || argv.slice(2).every((part) => safePath(part) || part === "--watch=false"))) return "node_test";
  if (argv[0] === "node" && argv.length === 2 && testFilePath(argv[1])) return "node_tests";
  if (["npm", "pnpm", "yarn"].includes(argv[0]) && ((argv[1] === "test" && argv.length === 2) || (argv[1] === "run" && ["test", "lint", "typecheck", "build"].includes(argv[2]) && argv.length === 3))) return `${argv[0]}_${argv[argv.length - 1]}`;
  if (argv[0] === "pytest" && argv.slice(1).every((part) => safePath(part) || part === "-q")) return "pytest";
  if (argv[0] === "python" && argv[1] === "-m" && argv[2] === "pytest" && argv.slice(3).every((part) => safePath(part) || part === "-q")) return "pytest";
  if (argv[0] === "go" && argv[1] === "test" && argv.slice(2).every((part) => part === "./..." || safePath(part))) return "go_test";
  if (argv[0] === "cargo" && ["test", "check"].includes(argv[1]) && argv.length === 2) return `cargo_${argv[1]}`;
  if (argv[0] === "bash" && argv[1] === "-n" && argv.length === 3 && safePath(argv[2])) return "bash_check";
  if (argv[0] === "bash" && argv.length === 2 && testFilePath(argv[1])) return "bash_test";
  if (argv[0] === "bun" && argv[1] === "test" && argv.length === 2) return "bun_test";
  if (argv[0] === "dotnet" && argv[1] === "test" && argv.length === 2) return "dotnet_test";
  if (["mvn", "mvnw", "gradle", "gradlew"].includes(argv[0]) && argv.length === 2 && /^(test|check)$/.test(argv[1])) return `${argv[0]}_${argv[1]}`;
  if (argv[0] === "phpunit" && argv.length >= 1 && argv.slice(1).every((part) => safePath(part) || part === "--testsuite")) return "phpunit";
  if (argv[0] === "rspec" && argv.length >= 1 && argv.slice(1).every((part) => safePath(part))) return "rspec";
  if (argv[0] === "tsc" && (argv.length === 1 || (argv[1] === "--noEmit" && argv.length === 2) || (argv[1] === "-p" && argv.length === 3 && safePath(argv[2])) || (argv[1] === "--noEmit" && argv[2] === "-p" && argv.length === 4 && safePath(argv[3])))) return "tsc";
  if (argv[0] === "eslint" && argv.slice(1).length && argv.slice(1).every((part) => part === "--fix-dry-run" || safePath(part))) return "eslint";
  return null;
};

export const verificationCommandCategory = (command) => commandCategory(command);
export const isAllowlistedVerificationCommand = (command) => commandCategory(command) !== null;

const MAX_EVIDENCE_BYTES = 128 * 1024;
const MAX_EVIDENCE_EVENTS = 64;
const MAX_EVIDENCE_SAMPLE = 8;
export const parseVerificationEvidence = (jsonl) => {
  const raw = String(jsonl || "");
  const input_truncated = raw.length > MAX_EVIDENCE_BYTES;
  const lines = raw.slice(0, MAX_EVIDENCE_BYTES).split(/\r?\n/);
  const event_truncated = lines.length > MAX_EVIDENCE_EVENTS;
  const sample = [];
  let recognized_count = 0;
  let passed_count = 0;
  let failed_count = 0;
  for (const line of lines.slice(0, MAX_EVIDENCE_EVENTS)) {
    try {
      const event = JSON.parse(line);
      const item = event?.item || event;
      if (item?.type !== "command_execution") continue;
      const command = String(item.command ?? item.cmd ?? item.command_line ?? "");
      const command_name = commandCategory(command);
      const exit = Number(item.exit_code ?? item.exitCode ?? item.status);
      if (!command_name || !Number.isInteger(exit)) continue;
      recognized_count += 1;
      if (exit === 0) passed_count += 1; else failed_count += 1;
      if (sample.length < MAX_EVIDENCE_SAMPLE) {
        const duration = Number(item.duration_ms ?? item.durationMs ?? item.duration);
        sample.push({ command_hash: hash(command), command_name, exit_code: exit, ...(Number.isFinite(duration) && duration >= 0 ? { duration_ms: duration } : {}) });
      }
    } catch {}
  }
  // Sampling limits retained telemetry only; the evidence stream is complete
  // until it exceeds an input/event cap.
  const truncated_count = input_truncated || event_truncated ? 1 : 0;
  const status = input_truncated || event_truncated ? "incomplete" : recognized_count === 0 ? "missing" : failed_count > 0 ? "failed" : "passed";
  Object.defineProperty(sample, "summary", { value: { recognized_count, passed_count, failed_count, truncated_count, status }, enumerable: false });
  return sample;
};

export const postExecutionPolicy = ({ classification, complexity = null, risk = "low", review_required = false, verification_evidence = [], codex_outcome } = {}) => {
  const evidence = Array.isArray(verification_evidence) ? verification_evidence : [];
  const recognized = evidence.filter((entry) => typeof entry?.command_name === "string" && entry.command_name.length > 0 && Number.isInteger(Number(entry.exit_code)));
  const summary = verification_evidence?.summary;
  const verification_status = ["missing", "passed", "failed", "incomplete"].includes(summary?.status) ? summary.status : recognized.length === 0 ? "missing" : recognized.every((entry) => Number(entry.exit_code) === 0) ? "passed" : "failed";
  const verified = verification_status === "passed";
  const risky = risk === "high" || risk === "critical";
  const reviewer_route = risk === "critical" ? "reviewer_critical" : review_required ? "reviewer" : "specialist";
  if (classification !== "MUTATING") return { next_agents: [], reasons: ["read_only_no_post_agent"], reviewer_route: review_required ? "specialist" : null, complexity, verification_status: "not_applicable" };
  if (codex_outcome !== "success") return { next_agents: [], reasons: ["codex_not_successful"], reviewer_route: null, complexity, verification_status };
  const next_agents = risk === "critical" ? ["reviewer_critical", "tester"] : risky ? ["reviewer", "tester"] : verified ? [] : ["tester"];
  const reasons = risky ? ["risky_mutation_requires_reviewer", "risky_mutation_requires_tester"] : verified ? ["focused_verification_passed"] : ["focused_verification_missing_or_failed"];
  return { next_agents, reasons, reviewer_route, complexity, verification_status };
};
