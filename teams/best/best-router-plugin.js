import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { guardToolExecution } from "../../shared/tool-output-guard.js";

const PROFILE_ROOT = dirname(fileURLToPath(import.meta.url));
const ROUTER = process.env.BEST_ROUTER_PATH ?? join(PROFILE_ROOT, "router-classify.sh");
const STATE_ROOT = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const LOG = process.env.BEST_ROUTER_LOG ?? join(STATE_ROOT, "opencode-team", "best", "router-plugin.log");
const ROUTES = new Set([
  "<BEST_ROUTER_ROUTE>EXPLORE</BEST_ROUTER_ROUTE>",
  "<BEST_ROUTER_ROUTE>LIBRARIAN</BEST_ROUTER_ROUTE>",
  "<BEST_ROUTER_ROUTE>BOTH</BEST_ROUTER_ROUTE>"
]);
const ROUTE_STATE = new Map();
const PENDING_TASKS = new Map();
const BLOCKED_TOOLS = new Set(["bash", "glob", "grep", "read", "webfetch"]);
const GATE_MESSAGE = "BEST ROUTING GATE: complete the required native task delegation before direct repository or research tools may be used.";
const SEMANTIC_GUIDANCE_MARKER = "<BEST_SEMANTIC_TOOL_GUIDANCE>";
const SEMANTIC_GUIDANCE = {
  explore: `${SEMANTIC_GUIDANCE_MARKER}
For semantic code navigation involving symbols, declarations, implementations,
references, structure, or diagnostics, use Serena first.

Use grep for exact literal/text searches.
Use glob for filename/path discovery.
Use read for known bounded files.

Serena is preferred for semantic navigation, not required for every search.
</BEST_SEMANTIC_TOOL_GUIDANCE>`,
  librarian: `${SEMANTIC_GUIDANCE_MARKER}
Use Serena for semantic code navigation when symbols, references,
implementations, structure, or diagnostics are relevant.

For documentation, README/config content, exact text, and file paths,
use the appropriate normal tools.
</BEST_SEMANTIC_TOOL_GUIDANCE>`
};

const KNOWN_READ_FILES = new Set([
  "teams/best/patch-omo-core.py",
  "teams/best/best-router-plugin.js",
  "teams/best/router-classify.sh",
  "teams/best/opencode.jsonc.template",
  "tests/config-parity.sh"
]);

function safeGitCommand(command) {
  return /^(?:git (?:status(?: --short)?|diff(?: (?:--check|--stat))?|rev-parse [^\s]+|branch --show-current|log(?: [^\n]*)?)|test --?[^;&|]+|command -v [^;&|]+|printf [^;&|]+)$/i.test(command)
    && !/[;&|<>`$()]/.test(command);
}

function mutatesRepository(command) {
  return /\b(?:git\s+(?:add|commit|checkout|reset|restore|clean|push)|rm|mv|cp|sed\s+-i|perl\s+-pi|patch)\b/i.test(command)
    || /[;&|<>`$()]/.test(command);
}

function safeKnownRead(args) {
  const candidate = args?.filePath ?? args?.path;
  if (typeof candidate !== "string" || candidate.includes("*") || candidate.includes("..")) return false;
  return KNOWN_READ_FILES.has(candidate.replace(/^\.\//, ""));
}

function safeTargetedSearch(args, kind) {
  const pattern = args?.pattern;
  const scope = args?.path ?? args?.directory;
  if (typeof pattern !== "string" || !pattern.trim() || typeof scope !== "string") return false;
  if (scope === "." || scope === "" || scope === "/" || scope.includes("..") || /[*?]/.test(scope)) return false;
  if (kind === "glob") return pattern !== "**/*" && pattern !== "**" && pattern.length <= 160;
  return pattern.length <= 240;
}

export function isSafeRootInspection(tool, args = {}) {
  const name = String(tool || "").toLowerCase();
  if (name === "bash") return safeGitCommand(args.command ?? args.cmd ?? "");
  if (name === "read") return safeKnownRead(args);
  if (name === "grep" || name === "glob") return safeTargetedSearch(args, name);
  return false;
}

function appendSemanticGuidance(agent, output) {
  const guidance = SEMANTIC_GUIDANCE[agent];
  if (!guidance || output.parts.some((part) => part.type === "text" && part.text?.includes(SEMANTIC_GUIDANCE_MARKER))) return;
  const source = output.parts.find((part) => part.type === "text");
  if (!source) return;
  output.parts.push({ ...source, id: `${source.id}:best-semantic-guidance`, text: guidance, synthetic: true });
}

mkdirSync(dirname(LOG), { recursive: true });

function log(entry) {
  appendFileSync(LOG, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

log({ event: "plugin_loaded" });

function classify(input, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [ROUTER], { cwd: input.directory ?? process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`router exited with ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify({
      session_id: input.sessionID,
      agent: "OpenCode-Builder",
      prompt
    }));
  });
}

export default async function bestRouterPlugin(input) {
  return {
    "chat.message": async (hookInput, output) => {
      const agent = hookInput.agent ?? output.message?.agent ?? "";
      const sessionID = hookInput.sessionID;
      appendSemanticGuidance(agent, output);
      if (agent !== "OpenCode-Builder") {
        log({ event: "chat.message", session_id: sessionID, agent, classification: "SKIPPED_CHILD", route_appended: false });
        return;
      }

      const textParts = output.parts.filter((part) => part.type === "text" && part.text);
      if (textParts.some((part) => /<BEST_ROUTER_ROUTE>(EXPLORE|LIBRARIAN|BOTH)<\/BEST_ROUTER_ROUTE>/.test(part.text))) {
        log({ event: "chat.message", session_id: sessionID, agent, classification: "ALREADY_TAGGED", route_appended: false });
        return;
      }
      const originalParts = textParts.filter((part) => part.synthetic !== true);
      const prompt = originalParts.map((part) => part.text).join("\n");

      let route;
      try {
        route = await classify({ ...hookInput, directory: input.directory }, prompt);
      } catch {
        log({ event: "chat.message", session_id: sessionID, agent, classification: "ROUTER_ERROR", route_appended: false });
        return;
      }
      const classification = ROUTES.has(route) ? route.match(/<BEST_ROUTER_ROUTE>(EXPLORE|LIBRARIAN|BOTH)<\/BEST_ROUTER_ROUTE>/)[1] : "DIRECT";
      if (!ROUTES.has(route)) {
        log({ event: "chat.message", session_id: sessionID, agent, classification, route_appended: false });
        return;
      }

      const source = originalParts[originalParts.length - 1];
      if (!source) {
        log({ event: "chat.message", session_id: sessionID, agent, classification, route_appended: false });
        return;
      }
      output.parts.push({
        ...source,
        id: `${source.id}:best-router`,
        type: "text",
        text: route,
        synthetic: true
      });
      const required_agents = classification === "BOTH" ? ["explore", "librarian"] : [classification.toLowerCase()];
      ROUTE_STATE.set(sessionID, { route: classification, required_agents, pending_agents: [], launched_agents: [] });
      log({ event: "route_registered", session_id: sessionID, agent, route: classification, required_agents, pending_agents: [], launched_agents: [], gate_action: "armed" });
      log({ event: "chat.message", session_id: sessionID, agent, classification, route_appended: true });
    }
    ,
    "tool.execute.before": async (toolInput, output) => {
      const tool = String(toolInput.tool ?? "").toLowerCase();
      if (tool === "call_omo_agent") {
        throw new Error('BEST ROUTING POLICY: call_omo_agent is disabled. Use native task(subagent_type="...", run_in_background=true).');
      }
      guardToolExecution({ team: "best", input: toolInput, output });
      const state = ROUTE_STATE.get(toolInput.sessionID);
      if (!state) return;
      if (tool === "task") {
        const subagent = typeof output.args?.subagent_type === "string" ? output.args.subagent_type : "";
        const background = output.args?.run_in_background;
        const details = {
          session_id: toolInput.sessionID,
          route: state.route,
          requested_agent: subagent,
          required_agents: state.required_agents,
          pending_agents: state.pending_agents,
          launched_agents: state.launched_agents,
          call_id: toolInput.callID
        };
        if (!state.required_agents.includes(subagent)) {
          log({ event: "task_rejected_wrong_agent", ...details, gate_action: "reject" });
          throw new Error(buildGateMessage(state));
        }
        if (state.pending_agents.includes(subagent) || state.launched_agents.includes(subagent)) {
          log({ event: "task_rejected_duplicate", ...details, gate_action: "reject" });
          throw new Error(buildGateMessage(state));
        }
        if (background !== true) {
          throw new Error(GATE_MESSAGE);
        }
        state.pending_agents.push(subagent);
        PENDING_TASKS.set(`${toolInput.sessionID}:${toolInput.callID}`, { sessionID: toolInput.sessionID, agent: subagent });
        log({ event: "task_pending", ...details, pending_agents: state.pending_agents, gate_action: "allow" });
        return;
      }
      if (tool === "bash" && mutatesRepository(output.args?.command ?? output.args?.cmd ?? "")) {
        throw new Error(GATE_MESSAGE);
      }
      if (tool.startsWith("serena_")) {
        throw new Error(buildGateMessage(state));
      }
      if (BLOCKED_TOOLS.has(tool) && !isSafeRootInspection(tool, output.args)) {
        const covered = state.required_agents.every((agent) =>
          state.pending_agents.includes(agent) || state.launched_agents.includes(agent)
        );
        if (!covered) throw new Error(buildGateMessage(state));
      }
    },
    "tool.execute.after": async (toolInput, output) => {
      if (toolInput.tool.toLowerCase() !== "task") return;
      const key = `${toolInput.sessionID}:${toolInput.callID}`;
      const pending = PENDING_TASKS.get(key);
      if (!pending) return;
      PENDING_TASKS.delete(key);
      const state = ROUTE_STATE.get(toolInput.sessionID);
      if (!state || !state.required_agents.includes(pending.agent)) return;
      const failed = output.metadata?.error !== undefined || output.metadata?.status === "error" || output.metadata?.success === false;
      state.pending_agents = state.pending_agents.filter((agent) => agent !== pending.agent);
      if (failed) {
        log({ event: "task_launch_failed", session_id: toolInput.sessionID, route: state.route, required_agents: state.required_agents, pending_agents: state.pending_agents, launched_agents: state.launched_agents, call_id: toolInput.callID, gate_action: pending.agent });
        return;
      }
      if (!state.launched_agents.includes(pending.agent)) state.launched_agents.push(pending.agent);
      log({ event: "task_launch_succeeded", session_id: toolInput.sessionID, route: state.route, required_agents: state.required_agents, pending_agents: state.pending_agents, launched_agents: state.launched_agents, call_id: toolInput.callID, gate_action: pending.agent });
      if (state.required_agents.every((agent) => state.launched_agents.includes(agent))) {
        log({ event: "route_gate_open", session_id: toolInput.sessionID, route: state.route, required_agents: state.required_agents, pending_agents: state.pending_agents, launched_agents: state.launched_agents, call_id: toolInput.callID, gate_action: "open" });
        ROUTE_STATE.delete(toolInput.sessionID);
      }
    }
  };
}

function buildGateMessage(state) {
  const remaining = state.required_agents.filter((agent) => !state.pending_agents.includes(agent) && !state.launched_agents.includes(agent));
  if (remaining.length === 1) {
    return `BEST ROUTING GATE: Route ${state.route} still requires native task(subagent_type="${remaining[0]}"). General or duplicate tasks do not satisfy this route.`;
  }
  if (remaining.length > 1) {
    return `BEST ROUTING GATE: Route ${state.route} requires native task delegation to ${remaining.join(" and ")}. Use those required agents before any other task or direct work.`;
  }
  const pending = state.required_agents.filter((agent) => state.pending_agents.includes(agent));
  return `BEST ROUTING GATE: Required delegation is already pending for ${pending.join(" and ")}. Do not launch a duplicate task; direct work may continue while background delegation runs.`;
}
