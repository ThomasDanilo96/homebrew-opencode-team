import { homedir } from "node:os";

const BINARY_RIPGREP = /(?:^|[;&|]\s*)(?:env\s+)?(?:command\s+)?(?:rg|ripgrep)\b[^;&|\n]*(?:^|\s)(?:-a|--text)(?:\s|$)/i;
const BINARY_GREP = /(?:^|[;&|]\s*)(?:env\s+)?(?:command\s+)?grep\b[^;&|\n]*(?:^|\s)(?:-a|--text|--binary-files=text)(?:\s|$)/i;
const RECURSIVE_GREP = /(?:^|\s)(?:-[^-\s]*r|--recursive)(?:\s|$)/i;
const HOME_PATH_PATTERN = homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BROAD_FIND = new RegExp(`(?:^|[;&|]\\s*)(?:env\\s+)?(?:command\\s+)?find\\s+(?:\\/(?:\\s|$)|~(?:\\s|\\/|$)|\\/Users\\/?(?:\\s|$)|\\/Volumes\\/?(?:\\s|$)|${HOME_PATH_PATTERN}\\/?(?:\\s|$))`, "i");
const NARROW_TEXT_GLOB = /--glob(?:=|\s+)["']?\*?\.(?:c|cc|cpp|css|go|html?|java|js|json|md|py|rb|rs|sh|sql|swift|toml|ts|tsx|txt|xml|ya?ml)["']?/i;

function hasBroadScope(command) {
  return /(?:^|\s)(?:\.|\.\.|\/|~|[A-Za-z0-9_.-]+\/)(?:\s|$)/.test(command);
}

export function classifyToolCommand(tool, args = {}) {
  const name = String(tool || "").toLowerCase();
  if (name !== "bash" && name !== "test") return { classification: "UNKNOWN", decision: "ALLOW" };

  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  if (!command.trim()) return { classification: "UNKNOWN", decision: "ALLOW" };

  if (BINARY_RIPGREP.test(command)) {
    if (NARROW_TEXT_GLOB.test(command) && !hasBroadScope(command)) {
      return { classification: "KNOWN_SAFE", decision: "ALLOW" };
    }
    return { classification: "KNOWN_UNSAFE", decision: "DENY", reasonCode: "BINARY_TEXT_RECURSIVE_SCAN" };
  }

  if (BINARY_GREP.test(command) && (RECURSIVE_GREP.test(command) || hasBroadScope(command))) {
    return { classification: "KNOWN_UNSAFE", decision: "DENY", reasonCode: "BINARY_TEXT_RECURSIVE_SCAN" };
  }

  if (BROAD_FIND.test(command)) {
    return { classification: "KNOWN_UNSAFE", decision: "DENY", reasonCode: "UNBOUNDED_ROOT_FIND" };
  }

  if (/\b(?:rg|ripgrep|grep)\b/i.test(command) || /(?:^|\s)find\s/i.test(command)) {
    return { classification: "KNOWN_SAFE", decision: "ALLOW" };
  }

  return { classification: "UNKNOWN", decision: "ALLOW" };
}

export function guardToolExecution({ team, input = {}, output = {} } = {}) {
  const result = classifyToolCommand(input.tool, output.args);
  if (result.decision !== "DENY") return result;

  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    team: team || "unknown",
    agent: input.agent || "unknown",
    tool: String(input.tool || "unknown"),
    classification: result.classification,
    decision: result.decision,
    reason_code: result.reasonCode,
  }));

  throw new Error(
    result.reasonCode === "UNBOUNDED_ROOT_FIND"
      ? "Refused unbounded filesystem scan. Restrict find to an explicit project directory and use -maxdepth."
      : "Refused unsafe binary-text recursive scan. Use normal ripgrep binary detection or restrict the search to explicit text file globs/directories.",
  );
}
