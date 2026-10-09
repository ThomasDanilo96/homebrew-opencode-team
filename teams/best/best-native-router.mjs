import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { classifyToolCommand } from "../../shared/tool-output-guard.js";
import { routeGuidanceFor } from "./best-router-contract.mjs";

const PROFILE_ROOT = dirname(fileURLToPath(import.meta.url));
const ROUTER = process.env.BEST_ROUTER_PATH ?? join(PROFILE_ROOT, "router-classify.sh");
const STATE_ROOT = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const DEFAULT_LOG = join(STATE_ROOT, "opencode-team", "best", "native-router.log");
const ROUTE_MARKER = /<BEST_ROUTER_ROUTE>(EXPLORE|LIBRARIAN|BOTH|FOUR)<\/BEST_ROUTER_ROUTE>/;
const ROUTE_AGENTS = {
  EXPLORE: ["explore"],
  LIBRARIAN: ["librarian"],
  BOTH: ["explore", "librarian"],
  FOUR: ["explore", "librarian", "openai-architect", "openai-reviewer"],
};

function log(entry) {
  try {
    const logPath = process.env.BEST_ROUTER_LOG ?? DEFAULT_LOG;
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // Logging must never change a routing or permission decision.
  }
}

function classifyPrompt(prompt, cwd) {
  const result = spawnSync("/bin/bash", [ROUTER], {
    cwd,
    input: JSON.stringify({ session_id: "native", prompt }),
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`router exited with status ${result.status}`);
  }
  const match = result.stdout.trim().match(ROUTE_MARKER);
  return match?.[1] ?? "DIRECT";
}

function gateMessage(state) {
  const remaining = state.requiredAgents.filter((agent) =>
    !state.pendingAgents.includes(agent) && !state.launchedAgents.includes(agent));
  if (remaining.length === 1) {
    return `BEST ROUTING GATE: route ${state.route} still requires task(subagent_type="${remaining[0]}", run_in_background=true).`;
  }
  if (remaining.length > 1) {
    return `BEST ROUTING GATE: route ${state.route} requires native task delegation to ${remaining.join(" and ")} before direct work.`;
  }
  const pending = state.requiredAgents.filter((agent) => state.pendingAgents.includes(agent));
  return `BEST ROUTING GATE: required task launch is pending for ${pending.join(" and ")}; do not duplicate it or start direct work.`;
}

function memoryCircuitOpen() {
  const liveRss = Number(process.env.BEST_MEMORY_LIVE_RSS_BYTES) || process.memoryUsage().rss;
  const blockRss = Number(process.env.BEST_MEMORY_BLOCK_RSS_BYTES) || 1536 * 1024 * 1024;
  return liveRss >= blockRss;
}

export function createBestNativeRouter({ classify = classifyPrompt, logger = log } = {}) {
  const routes = new Map();
  const pendingTasks = new Map();

  return (pi) => {
    pi.on("input", async (event, ctx) => {
      if (event.source === "extension" || /BEST_ROUTER_(?:CONTEXT|ROUTE)/.test(event.text)) {
        return { action: "continue" };
      }

      let route;
      try {
        route = await classify(event.text, ctx.cwd);
      } catch (error) {
        logger({ event: "route_classifier_error", error: String(error) });
        return { action: "continue" };
      }

      const requiredAgents = ROUTE_AGENTS[route];
      if (!requiredAgents) {
        logger({ event: "input_classified", route: "DIRECT", session_id: ctx.sessionManager.getSessionId() });
        return { action: "continue" };
      }

      const sessionID = ctx.sessionManager.getSessionId();
      routes.set(sessionID, { route, requiredAgents, pendingAgents: [], launchedAgents: [] });
      logger({ event: "route_registered", route, required_agents: requiredAgents, session_id: sessionID });
      return {
        action: "transform",
        text: `${event.text}\n\n${routeGuidanceFor(route)}\n<BEST_ROUTER_ROUTE>${route}</BEST_ROUTER_ROUTE>`,
        images: event.images,
      };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "bash") {
        const guard = classifyToolCommand("bash", event.input);
        if (guard.decision === "DENY") {
          logger({ event: "tool_rejected", tool: event.toolName, reason: guard.reasonCode });
          return { block: true, reason: guard.reasonCode === "UNBOUNDED_ROOT_FIND"
            ? "Refused unbounded filesystem scan. Restrict find to an explicit project directory and use -maxdepth."
            : "Refused unsafe binary-text recursive scan. Use normal ripgrep binary detection or restrict the search to explicit text file globs/directories." };
        }
      }

      if (event.toolName === "call_omo_agent") {
        return { block: true, reason: "BEST ROUTING POLICY: use the native task tool; legacy call_omo_agent is disabled." };
      }

      const sessionID = ctx.sessionManager.getSessionId();
      const state = routes.get(sessionID);
      if (!state) return undefined;

      if (event.toolName === "task") {
        if (memoryCircuitOpen()) {
          return { block: true, reason: "BEST MEMORY SAFETY: delegation paused while native memory pressure is high." };
        }
        const agent = typeof event.input.subagent_type === "string" ? event.input.subagent_type : "";
        if (!state.requiredAgents.includes(agent)) {
          logger({ event: "task_rejected_wrong_agent", session_id: sessionID, route: state.route, agent });
          return { block: true, reason: gateMessage(state) };
        }
        if (state.pendingAgents.includes(agent) || state.launchedAgents.includes(agent)) {
          logger({ event: "task_rejected_duplicate", session_id: sessionID, route: state.route, agent });
          return { block: true, reason: gateMessage(state) };
        }
        if (event.input.run_in_background !== true) {
          event.input.run_in_background = true;
          logger({ event: "task_background_normalized", session_id: sessionID, route: state.route, agent });
        }
        state.pendingAgents.push(agent);
        pendingTasks.set(`${sessionID}:${event.toolCallId}`, { sessionID, agent });
        logger({ event: "task_pending", session_id: sessionID, route: state.route, agent });
        return undefined;
      }

      logger({ event: "tool_rejected_by_route_gate", session_id: sessionID, route: state.route, tool: event.toolName });
      return { block: true, reason: gateMessage(state) };
    });

    pi.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "task") return undefined;
      const sessionID = ctx.sessionManager.getSessionId();
      const key = `${sessionID}:${event.toolCallId}`;
      const pending = pendingTasks.get(key);
      if (!pending) return undefined;
      pendingTasks.delete(key);

      const state = routes.get(sessionID);
      if (!state) return undefined;
      state.pendingAgents = state.pendingAgents.filter((agent) => agent !== pending.agent);
      if (event.isError) {
        logger({ event: "task_launch_failed", session_id: sessionID, route: state.route, agent: pending.agent });
        return undefined;
      }

      if (!state.launchedAgents.includes(pending.agent)) state.launchedAgents.push(pending.agent);
      logger({ event: "task_launch_succeeded", session_id: sessionID, route: state.route, agent: pending.agent });
      if (state.requiredAgents.every((agent) => state.launchedAgents.includes(agent))) {
        routes.delete(sessionID);
        logger({ event: "route_gate_open", session_id: sessionID, route: state.route });
      }
      return undefined;
    });
  };
}

export default createBestNativeRouter();
