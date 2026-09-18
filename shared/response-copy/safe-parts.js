export function visibleTextParts(parts = []) {
  return parts
    .filter((part) => part?.type === "text" && !part.ignored && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);
}

const MAX_PATCH_OUTPUT = 200000;
const MAX_CODE_OUTPUT = 200000;
const MAX_COMMAND_OUTPUT = 12000;
const MAX_SEARCH_OUTPUT = 12000;
const KNOWN_TOOLS = new Set(["edit", "write", "create", "bash", "test", "read", "grep", "glob"]);

function redact(value) {
  return String(value ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s\n]+/gi, "$1<redacted>")
    .replace(/\b(bearer\s+)[^\s\n]+/gi, "$1<redacted>")
    .replace(/\b((?:GH|GITHUB)_TOKEN|API[_ -]?KEY|PASSWORD|COOKIE)\s*[:=]\s*([^\s\n]+)/gi, "$1=<redacted>")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|PASSWORD|COOKIE|PRIVATE_KEY))\s*=\s*([^\s\n]+)/gi, "$1=<redacted>")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "<redacted private key>");
}

function bounded(value, limit) {
  const text = redact(value).trim();
  return text.length > limit ? `${text.slice(0, limit)}\n[tool output truncated]` : text;
}

function pathOf(input) {
  return input?.filePath || input?.path || "unknown path";
}

function diff(oldString, newString) {
  return ["```diff", ...String(oldString ?? "").split("\n").map((line) => `-${redact(line)}`), ...String(newString ?? "").split("\n").map((line) => `+${redact(line)}`), "```"].join("\n");
}

function formatTool(part) {
  const tool = String(part.tool || "").toLowerCase().split(".").at(-1);
  const input = part.state?.input ?? {};
  const metadata = part.state?.metadata ?? {};
  const result = part.state?.error ?? part.state?.output ?? metadata.output;
  if (typeof metadata.diff === "string" && Array.isArray(metadata.files)) {
    const files = metadata.files.filter((file) => typeof file === "string").join(", ") || pathOf(input);
    return `← Patched ${files}\n\n${bounded(metadata.diff, MAX_PATCH_OUTPUT)}`;
  }
  if (typeof input.patchText === "string") return `← Applied patch\n\n${bounded(input.patchText, MAX_PATCH_OUTPUT)}`;
  if (typeof input.oldString === "string" && typeof input.newString === "string") {
    return `← Patched ${pathOf(input)}\n\n${bounded(diff(input.oldString, input.newString), MAX_PATCH_OUTPUT)}`;
  }
  if (typeof input.content === "string" && (tool === "write" || tool === "create" || input.filePath || input.path)) {
    const content = bounded(input.content, MAX_CODE_OUTPUT);
    return `# Created ${pathOf(input)}${content ? `\n\n${content}` : ""}`;
  }
  if (!KNOWN_TOOLS.has(tool) && typeof input.command !== "string") return undefined;
  if (tool === "edit") return `← Patched ${pathOf(input)}\n\n${bounded(diff(input.oldString, input.newString), MAX_PATCH_OUTPUT)}`;
  if (tool === "write" || tool === "create") {
    const content = bounded(input.content, MAX_CODE_OUTPUT);
    return `# Created ${pathOf(input)}${content ? `\n\n${content}` : ""}`;
  }
  if (tool === "bash" || tool === "test") {
    const command = bounded(input.command, MAX_COMMAND_OUTPUT);
    return `$ ${command}${result ? `\n\n${bounded(result, MAX_COMMAND_OUTPUT)}` : ""}`;
  }
  if (tool === "read") return `→ Read ${pathOf(input)}${result ? `\n\n${bounded(result, MAX_SEARCH_OUTPUT)}` : ""}`;
  if (tool === "grep") return `✱ Grep "${redact(input.pattern)}" in ${redact(input.path || ".")}${result ? `\n\n${bounded(result, MAX_SEARCH_OUTPUT)}` : ""}`;
  if (tool === "glob") return `✱ Glob "${redact(input.pattern)}" in ${redact(input.path || ".")}${result ? `\n\n${bounded(result, MAX_SEARCH_OUTPUT)}` : ""}`;
  return `$ ${bounded(input.command, MAX_COMMAND_OUTPUT)}${result ? `\n\n${bounded(result, MAX_COMMAND_OUTPUT)}` : ""}`;
}

export function safeVisibleToolParts(parts = []) {
  return parts
    .filter((part) => part?.type === "tool" && part.tool !== "task" && !part.ignored)
    .map(formatTool)
    .filter(Boolean);
}

export function eligiblePartText(parts = []) {
  return parts.flatMap((part) => {
    if (part?.type === "text" && !part.ignored && typeof part.text === "string") return [redact(part.text).trim()].filter(Boolean);
    if (part?.type === "tool") return safeVisibleToolParts([part]);
    return [];
  });
}

export function isReasoningOrInternalPart(part) {
  return ["reasoning", "snapshot", "patch", "step-start", "step-finish", "compaction", "retry"].includes(part?.type);
}
