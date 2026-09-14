import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEX_REQUIRED, CODEX_SUCCESS, TERRA_FALLBACK, readPolicy } from "./codex-authority.js";
import { isAllowlistedVerificationCommand, verificationCommandCategory } from "./execution-policy.js";
import { createHash } from "node:crypto";
import { listWorkPackets } from "./work-packet.js";

const READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "webfetch", "todowrite", "skill", "skill_mcp",
  "task", "docs", "documentation",
  "lsp_diagnostics", "lsp_symbols", "lsp_definition", "lsp_references", "lsp_hover", "lsp_workspace_symbols",
  "openai_remote_read",
  "session_list", "session_read", "session_search", "session_info",
  "background_output", "background_cancel", "look_at",
  "serena_initial_instructions", "serena_get_symbols_overview", "serena_find_symbol",
  "serena_find_declaration", "serena_find_implementations", "serena_find_referencing_symbols",
  "serena_get_diagnostics_for_file", "serena_search_for_pattern", "serena_list_memories",
  "serena_read_memory", "serena_get_current_config", "serena_list_mcp_resources",
  "serena_read_mcp_resource",
]);

const UNBOUNDED_EXECUTION = new Set(["bash", "interactive_bash", "shell", "command"]);
const NATIVE_MUTATIONS = new Set([
  "apply_patch", "edit", "write", "delete", "rename", "file_create", "file_delete", "file_rename",
  "create_file", "remove_file", "move_file", "multi_edit", "write_file", "patch",
]);
const SERENA_MUTATION_PREFIXES = [
  "serena_replace_", "serena_insert_", "serena_rename_", "serena_delete_", "serena_write_",
  "serena_safe_delete_", "serena_edit_",
];
const FALLBACK_MUTATION_TOOLS = new Set([
  ...NATIVE_MUTATIONS, ...UNBOUNDED_EXECUTION,
  "serena_replace_content", "serena_replace_in_files", "serena_replace_symbol_body",
  "serena_insert_before_symbol", "serena_insert_after_symbol", "serena_rename_symbol",
  "serena_safe_delete_symbol", "serena_write_memory", "serena_edit_memory",
]);
const GUARDED_AGENTS = new Set([
  "openai_orchestrator", "codex_executor", "openai_explore", "openai_librarian", "openai_ops", "reviewer", "reviewer_critical", "specialist",
]);

const stateRoot = () => process.env.OPENAI_TEAM_STATE_ROOT;
const logPath = () => join(stateRoot() || "/tmp", "logs", "authorship-guard.log");
const arrayValue = (value) => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

const isSerenaMutation = (toolName) => SERENA_MUTATION_PREFIXES.some((prefix) => toolName.startsWith(prefix));
const isCustomMutation = (toolName) => /(?:mutat|write|edit|patch|delete|remove|rename|create|move|exec|bash|shell|command)/.test(toolName);
const isDangerous = (toolName) => UNBOUNDED_EXECUTION.has(toolName) || NATIVE_MUTATIONS.has(toolName) || isSerenaMutation(toolName) || isCustomMutation(toolName);
const isKnownTool = (toolName) => READ_ONLY_TOOLS.has(toolName) || toolName === "openai_run_codex" || UNBOUNDED_EXECUTION.has(toolName) || NATIVE_MUTATIONS.has(toolName) || isSerenaMutation(toolName);

const resolveAgent = async (pluginInput, input) => {
  if (input.agent) return input.agent;
  try {
    const response = await pluginInput.client?.session.messages({ path: { id: input.sessionID } });
    const agents = (response?.data || []).map((message) => message.info?.agent).filter(Boolean);
    return [...new Set(agents)].length === 1 ? agents[0] : null;
  } catch {
    return null;
  }
};

const record = async (event, input, agent, authorityState, action) => {
  const path = logPath();
  await mkdir(dirname(path), { recursive: true });
  const line = [new Date().toISOString(), event, input.sessionID || "-", agent || "unknown", input.tool || "-", authorityState || "NONE", action].join(" ");
  await appendFile(path, `${line}\n`, { mode: 0o600 });
};

export const OpenAIAuthorshipGuard = async (pluginInput = {}) => ({
  "tool.execute.before": async (input, output = {}) => {
    const toolName = String(input.tool || "").toLowerCase();
    if (toolName === "openai_run_codex") {
      // This must be independently verifiable: input.agent is caller supplied
      // and cannot authorize native execution on its own.
      const agent = await resolveAgent(pluginInput, { ...input, agent: undefined });
      const policy = agent === "codex_executor" && typeof input.sessionID === "string" && input.sessionID ? await readPolicy(input.sessionID) : null;
      const canonicalPolicy = policy?.schema_version === 1 && policy.session_id === input.sessionID && policy.agent === "codex_executor" && policy.status === CODEX_REQUIRED;
      if (!canonicalPolicy) {
        await record("codex_tool_blocked", input, agent, policy?.status || "NONE", "BLOCK");
        throw new Error("OPENAI AUTHORSHIP POLICY: openai_run_codex requires verified codex_executor session attribution and canonical CODEX_REQUIRED policy.");
      }
      await record("codex_tool_allowed", input, agent, CODEX_REQUIRED, "ALLOW");
      return;
    }
    if (READ_ONLY_TOOLS.has(toolName)) return;

    const agent = await resolveAgent(pluginInput, input);
    if (agent === "tester" && toolName === "bash") {
      const command = output.args?.command ?? output.args?.cmd ?? input.args?.command ?? input.args?.cmd ?? "";
      const reservation = typeof input.sessionID === "string"
        ? (await listWorkPackets()).find((packet) => packet.child_session_id === input.sessionID
          && packet.agent === "tester" && ["pending", "required"].includes(packet.tester_status))
        : null;
      const targetID = typeof reservation?.test_task_id === "string" && /^[a-f0-9]{64}$/i.test(reservation.test_task_id) ? reservation.test_task_id.toLowerCase() : null;
      const target = targetID ? (await listWorkPackets()).find((packet) => packet.packet_id === targetID) : null;
      const expected = new Set([
        ...arrayValue(target?.verification_commands),
        ...arrayValue(target?.verification_evidence).map((entry) => entry?.command_hash),
        ...arrayValue(target?.expected_verification_hashes),
      ].filter((value) => typeof value === "string" && isAllowlistedVerificationCommand(value)
        ? true : typeof value === "string" && /^[a-f0-9]{64}$/i.test(value))
        .map((value) => /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : createHash("sha256").update(value).digest("hex")));
      const commandHash = typeof command === "string" ? createHash("sha256").update(command).digest("hex") : "";
      if (reservation != null && targetID != null && target != null && typeof command === "string" && isAllowlistedVerificationCommand(command)
        && expected.has(commandHash)) {
        await record("tester_verification_bash_allowed", input, agent, "NONE", `ALLOW:${verificationCommandCategory(command)}`);
        return;
      }
      await record("tester_verification_bash_blocked", input, agent, "NONE", "BLOCK");
      throw new Error("OPENAI AUTHORSHIP POLICY: Tester bash is restricted to allowlisted verification commands.");
    }
    // The custom-name heuristic remains a second line of defense and is never
    // used to expand the read-only allowlist.
    const mutationLookingTool = isCustomMutation(toolName);
    const unknownTool = !isKnownTool(toolName);
    // Attribution is itself an authority boundary.  A mutation-capable tool
    // must never become available merely because session metadata is absent,
    // null, ambiguous, or names an unrecognised agent.
    if (!GUARDED_AGENTS.has(agent) && agent !== "tester") {
      await record("unattributed_mutation_blocked", input, agent, "NONE", "BLOCK");
      throw new Error(`OPENAI AUTHORSHIP POLICY: ${unknownTool ? "UNKNOWN_TOOL_DENIED: " : ""}Mutation-capable tools require verified codex_executor attribution and structured TERRA_FALLBACK authority.`);
    }

    const policy = agent === "codex_executor" ? await readPolicy(input.sessionID) : null;
    const authorityState = policy?.status || "NONE";
    if (agent === "codex_executor" && authorityState === TERRA_FALLBACK && FALLBACK_MUTATION_TOOLS.has(toolName)) {
      await record("terra_fallback_mutation_allowed", input, agent, authorityState, "ALLOW");
      return;
    }

    if (agent === "tester") {
      await record("tester_mutation_blocked", input, agent, authorityState, "BLOCK");
      throw new Error("OPENAI AUTHORSHIP POLICY: Tester is read-only and may not invoke mutation-capable or unbounded execution tools.");
    }

    if (unknownTool || (agent === "codex_executor" && authorityState === TERRA_FALLBACK && !FALLBACK_MUTATION_TOOLS.has(toolName))) {
      await record("unknown_tool_denied", input, agent, authorityState, "BLOCK");
      throw new Error("OPENAI AUTHORSHIP POLICY: UNKNOWN_TOOL_DENIED");
    }

    const event = UNBOUNDED_EXECUTION.has(toolName) ? "unbounded_execution_blocked" : mutationLookingTool ? "mutation_blocked" : "unknown_tool_denied";
    await record(event, input, agent, authorityState, "BLOCK");
    if (agent === "openai_orchestrator") {
      throw new Error("OPENAI AUTHORSHIP POLICY: Repository mutations must be delegated through the native codex_executor task. The orchestrator is read/orchestration only.");
    }
    throw new Error("OPENAI AUTHORSHIP POLICY: Native repository mutation is denied until structured TERRA_FALLBACK authority exists.");
  },
});

export default { server: OpenAIAuthorshipGuard };
