import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tool } from "./plugin-api.js";
import { runProcessAsync } from "./process-async.js";

const SSH = "/usr/bin/ssh";
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "StrictHostKeyChecking=yes"];
const SIMPLE_PROGRAMS = new Set(["uptime", "free", "df", "ps"]);
const FORBIDDEN = /^(?:rm|mv|cp|chmod|chown|touch|mkdir|rmdir|tee|dd|truncate|kill|pkill|killall|scp|sftp|rsync|bash|sh|zsh|python|python3|perl|ruby|node|eval|env|apt|apt-get|dpkg|sed)$/;
const SAFE_VALUE = /^(?:--|[A-Za-z0-9_./:@%+=,-]+)$/;
const UNIT = /^[A-Za-z0-9@_.-]+(?:\.service|\.socket|\.timer|\.target)?$/;
const NAME = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GIT_REF = /^(?!-)(?!.*(?:\.\.|@\{|\.lock$))[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const gitArgs = (args) => {
  const [subcommand, ...rest] = args;
  if (!new Set(["status", "log", "diff", "show"]).has(subcommand)) return false;
  const allowed = {
    status: new Set(["-s", "--short", "-b", "--branch", "--porcelain", "--untracked-files=no", "--ignored=no"]),
    log: new Set(["--oneline", "--decorate", "--graph", "--all", "--no-patch", "--stat", "-n", "--max-count"]),
    diff: new Set(["--stat", "--name-only", "--name-status", "--cached", "--staged"]),
    show: new Set(["--stat", "--name-only", "--name-status", "--no-patch"]),
  }[subcommand];
  let values = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "-n" || arg === "--max-count") return /^[1-9][0-9]{0,3}$/.test(rest[index + 1] || "") && index + 2 === rest.length;
    if (arg.startsWith("-")) { if (!allowed.has(arg)) return false; continue; }
    if (subcommand === "status" || subcommand === "diff" || !GIT_REF.test(arg) || ++values > 1) return false;
  }
  return true;
};
const dockerArgs = (args) => {
  const [subcommand, ...rest] = args;
  if (subcommand === "stats") return rest.length === 1 && rest[0] === "--no-stream";
  if (subcommand === "info" || subcommand === "images") return rest.length === 0;
  if (subcommand === "ps") return rest.every((arg) => ["-a", "--all", "-q", "--quiet", "--no-trunc"].includes(arg));
  if (subcommand === "inspect") return rest.length > 0 && rest.every(NAME.test.bind(NAME));
  if (subcommand !== "logs" || !NAME.test(rest[0] || "")) return false;
  return rest.slice(1).every((arg, index, values) => arg === "--timestamps" || (arg === "--tail" && /^[0-9]{1,5}$/.test(values[index + 1] || "")) || (/^[0-9]{1,5}$/.test(arg) && values[index - 1] === "--tail"));
};
const systemctlArgs = (args) => {
  const [subcommand, ...rest] = args;
  if (!new Set(["status", "show", "is-active", "is-enabled"]).has(subcommand)) return false;
  const properties = new Set(["ActiveState", "SubState", "LoadState", "UnitFileState", "MainPID", "ExecMainStatus", "MemoryCurrent", "CPUUsageNSec"]);
  const units = rest.filter((arg) => UNIT.test(arg));
  const requestedProperties = rest.filter((arg) => arg.startsWith("--property="));
  if (!units.length || (subcommand === "show" && !requestedProperties.length)) return false;
  return rest.every((arg) => arg === "--no-pager" || UNIT.test(arg) || (subcommand === "show" && /^--property=(.+)$/.test(arg) && properties.has(arg.slice(11))));
};
const journalctlArgs = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index], value = args[index + 1];
    if (arg === "--no-pager") continue;
    if (["-u", "--unit"].includes(arg) && UNIT.test(value || "")) { index += 1; continue; }
    if (["-n", "--lines"].includes(arg) && /^[1-9][0-9]{0,4}$/.test(value || "")) { index += 1; continue; }
    if (["--since", "--until"].includes(arg) && /^[A-Za-z0-9T:+-]+$/.test(value || "")) { index += 1; continue; }
    if (["-b", "--boot"].includes(arg) && (!value || value.startsWith("-") || /^-?[0-9]+$/.test(value))) { if (value && !value.startsWith("-")) index += 1; continue; }
    if (["-p", "--priority"].includes(arg) && /^(?:0|1|2|3|4|5|6|7|emerg|alert|crit|err|warning|notice|info|debug)$/.test(value || "")) { index += 1; continue; }
    return false;
  }
  return true;
};
const kubectlArgs = (args) => {
  const [subcommand, resource, ...rest] = args;
  if (!new Set(["get", "describe", "logs", "top"]).has(subcommand) || !new Set(["pods", "deployments", "services", "nodes", "namespaces", "events", "jobs", "cronjobs", "daemonsets", "statefulsets"]).has(resource)) return false;
  if (subcommand === "logs" && resource !== "pods") return false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index], value = rest[index + 1];
    if (NAME.test(arg)) continue;
    if (["-n", "--namespace"].includes(arg) && NAMESPACE.test(value || "")) { index += 1; continue; }
    if (arg === "--all-namespaces" && subcommand === "get") continue;
    if (arg === "--timestamps" && subcommand === "logs") continue;
    if (arg === "--tail" && /^[0-9]{1,5}$/.test(value || "")) { index += 1; continue; }
    return false;
  }
  return subcommand !== "logs" || rest.some(NAME.test.bind(NAME));
};
const simpleArgs = (program, args) => {
  const options = { uptime: new Set(["-p", "-s"]), df: new Set(["-h", "-H", "-k", "-m", "--local"]), free: new Set(["-h", "-b", "-k", "-m", "-g"]), ps: new Set(["-e", "-f", "-ef"])}[program];
  return args.every((arg) => SAFE_VALUE.test(arg) && (!arg.startsWith("-") || options.has(arg)));
};
const allowsArgs = (program, args) => {
  if (SIMPLE_PROGRAMS.has(program)) return simpleArgs(program, args);
  if (program === "git") return gitArgs(args);
  if (program === "docker") return dockerArgs(args);
  if (program === "kubectl") return kubectlArgs(args);
  if (program === "systemctl") return systemctlArgs(args);
  if (program === "journalctl") return journalctlArgs(args);
  return false;
};
const sudoAllowed = (program, args) => (program === "systemctl" && ["status", "show", "is-active", "is-enabled"].includes(args[0])) || program === "journalctl";

const expandHome = (value) => value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
const includeFiles = (pattern, baseDir) => {
  const expanded = expandHome(pattern);
  const absolute = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  return globSync(absolute, { nodir: true }).sort();
};

const configuredAliases = (configPath = join(homedir(), ".ssh", "config"), seen = new Set()) => {
  const absolute = resolve(configPath);
  if (seen.has(absolute) || !existsSync(absolute)) return new Set();
  seen.add(absolute);
  const aliases = new Set();
  for (const rawLine of readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const match = line.match(/^Host\s+(.+)$/i);
    if (match) {
      for (const alias of match[1].split(/\s+/)) {
        if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) aliases.add(alias);
      }
      continue;
    }
    const include = line.match(/^Include\s+(.+)$/i);
    if (include) for (const pattern of include[1].split(/\s+/)) {
      for (const file of includeFiles(pattern, dirname(absolute))) {
        for (const alias of configuredAliases(file, seen)) aliases.add(alias);
      }
    }
  }
  return aliases;
};

const validHost = (host, aliases) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) && aliases.has(host);
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const remoteCommand = (program, args, sudo) => [sudo ? "sudo" : null, sudo ? "-n" : null, program, ...args].filter(Boolean).map(shellQuote).join(" ");

export const validateRemoteRead = ({ host, program, args = [], sudo = false }, aliases = configuredAliases()) => {
  if (typeof host !== "string" || !validHost(host, aliases)) throw new Error("REMOTE OPS DENIED: host is not an explicit SSH config alias.");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || /[\r\n\t;|&$`><(){}\\\"“”]/.test(arg))) throw new Error("REMOTE OPS DENIED: invalid command argument.");
  if (typeof program !== "string" || !/^[a-z][a-z0-9._-]*$/.test(program) || FORBIDDEN.test(program)) throw new Error("REMOTE OPS DENIED: program is not read-only.");
  if (!allowsArgs(program, args)) throw new Error("REMOTE OPS DENIED: mutating subcommand, option, or unsupported argv grammar.");
  if (sudo && !sudoAllowed(program, args)) throw new Error("REMOTE OPS DENIED: sudo is restricted to exact observability commands.");
  return { host, argv: [...SSH_OPTIONS, host, remoteCommand(program, args, Boolean(sudo))] };
};

export const createRemoteReadTool = (run = runProcessAsync, aliases = configuredAliases()) => tool({
  description: "Run a strictly read-only diagnostic command on an explicitly configured SSH host.",
  args: {
    host: tool.schema.string().describe("Explicit alias from ~/.ssh/config."),
    program: tool.schema.string().describe("Read-only program from the approved catalog."),
    args: tool.schema.array(tool.schema.string()).optional().describe("Approved read-only arguments."),
    sudo: tool.schema.boolean().optional().describe("Use sudo -n for the same read-only command."),
  },
  async execute(input, context) {
    if (context.agent !== "openai_ops") throw new Error("openai_remote_read is restricted to the openai_ops agent.");
    const request = validateRemoteRead(input, aliases);
    const result = await run(SSH, request.argv, { env: process.env, cwd: context.directory, timeoutMs: 15000, signal: context.abort });
    return JSON.stringify({ ...result, host: request.host, program: input.program });
  },
});

export { configuredAliases, remoteCommand, SSH_OPTIONS };
