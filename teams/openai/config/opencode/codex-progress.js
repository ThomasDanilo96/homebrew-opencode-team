const MAX_LINE_CHARS = 64 * 1024;
const MAX_LABEL_CHARS = 180;
const MAX_DETAIL_CHARS = 240;
const DEFAULT_MAX_EVENTS = 5;

const clampText = (value, limit) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
};

export const redactCodexProgressText = (value, limit = MAX_DETAIL_CHARS) => {
  let text = String(value ?? "");
  text = text
    .replace(/\b([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}\b/gi, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|credential)\b\s*(?:=|:|\s)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/--(api[_-]?key|token|password|secret|credential)(?:=|\s+)\S+/gi, "--$1=[REDACTED]");
  return clampText(text, limit);
};

const concisePath = (value) => {
  const raw = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, "").slice(-2048);
  const clean = raw.replace(/^\.\//, "");
  if (!clean) return "";
  const pieces = clean.split("/").filter(Boolean);
  const concise = pieces.length > 4 ? `…/${pieces.slice(-4).join("/")}` : clean;
  return redactCodexProgressText(concise, 160);
};

const eventTime = (record) => {
  const value = record?.timestamp ?? record?.created_at ?? record?.time;
  const parsed = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const commandCategory = (command) => {
  if (/\b(?:pytest|unittest|jest|vitest|mocha|rspec|phpunit|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test)\b/i.test(command)) return ["TEST", "running tests", "tests"];
  if (/\b(?:lint|eslint|ruff|mypy|pyright|typecheck|check|validate|bash\s+-n|node\s+--check)\b/i.test(command)) return ["VALIDATION", "validating", "validation"];
  if (/\b(?:rg|grep|find|fd)\b/i.test(command)) return ["SEARCH", "searching", "search"];
  if (/\b(?:cat|sed|head|tail|less)\b/i.test(command)) return ["READ", "inspecting", "inspection"];
  return ["COMMAND", "running command", "command"];
};

const resultStatus = (item, recordType = "") => {
  if (item?.status === "failed" || (Number.isInteger(item?.exit_code) && item.exit_code !== 0)) return "failed";
  if (item?.status === "completed" || item?.status === "success" || item?.exit_code === 0) return "completed";
  if (/\.failed$/.test(recordType)) return "failed";
  if (/\.completed$/.test(recordType)) return "completed";
  return "running";
};

export const parseCodexProgressRecord = (record) => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const type = String(record.type || "");
  const item = record.item && typeof record.item === "object" ? record.item : record;
  const itemType = String(item.type || "");
  // These records may contain model-authored text. They are never display input.
  if (/reasoning|agent_message|message|assistant/i.test(type) || /reasoning|agent_message|message|assistant/i.test(itemType)) return null;
  const base = { id: clampText(item.id || record.id || "", 100), timestamp: eventTime(record) };
  if (type === "thread.started") return { ...base, category: "PHASE", phase: "starting", status: "running", label: "Codex started", detail: "", important: true };
  if (type === "turn.started") return { ...base, category: "PHASE", phase: "working", status: "running", label: "working", detail: "", important: true };
  if (type === "turn.completed") return { ...base, category: "TERMINAL", phase: "completed", status: "completed", label: "Codex turn completed", detail: "", important: true };
  if (type === "turn.failed" || type === "error") return { ...base, category: "TERMINAL", phase: "failed", status: "failed", label: "Codex turn failed", detail: "", important: true };
  if (/compact/i.test(type) || /compact/i.test(itemType)) return { ...base, category: "COMPACTION", phase: "compacting", status: resultStatus(item, type), label: "compacting context", detail: "", important: true };
  if (/retry/i.test(type) || /retry/i.test(itemType)) return { ...base, category: "RETRY", phase: "retrying", status: "running", label: "retrying Codex operation", detail: "", important: true };

  if (itemType === "command_execution") {
    const command = redactCodexProgressText(item.command || item.cmd || "", 220);
    if (!command) return null;
    const [category, label, phase] = commandCategory(command);
    const status = resultStatus(item, type);
    return { ...base, category, phase, status, label: status === "failed" ? `${label} failed` : label, detail: command, important: category === "TEST" || category === "VALIDATION" || status === "failed" };
  }
  if (itemType === "file_change" || /(?:file_)?(?:edit|write|patch)/i.test(itemType)) {
    const change = Array.isArray(item.changes) ? item.changes[0] : null;
    const path = concisePath(change?.path || item.path || item.file_path || item.file || "");
    const action = redactCodexProgressText(change?.kind || item.action || itemType.replace(/^file_/, ""), 48) || "edit";
    if (!path) return null;
    return { ...base, category: "EDIT", phase: "editing", status: resultStatus(item, type), label: `${action} ${path}`, detail: path, important: true };
  }
  if (itemType === "web_search" || /search/i.test(itemType)) {
    const query = redactCodexProgressText(item.query || item.name || "", MAX_LABEL_CHARS);
    return query ? { ...base, category: "SEARCH", phase: "searching", status: resultStatus(item, type), label: `searching ${query}`, detail: "", important: false } : null;
  }
  if (itemType === "mcp_tool_call" || /tool_call/i.test(itemType)) {
    const tool = redactCodexProgressText(item.tool || item.name || item.server || "tool", 100);
    const path = concisePath(item.path || item.file_path || "");
    return { ...base, category: "TOOL", phase: "working", status: resultStatus(item, type), label: `using ${tool}`, detail: path, important: false };
  }
  return null;
};

export const createCodexProgressParser = ({ maxEvents = DEFAULT_MAX_EVENTS } = {}) => {
  let carry = "";
  const recent = [];
  const seen = new Set();
  const add = (event) => {
    const key = event.id ? `${event.id}\0${event.status}` : `${event.category}\0${event.status}\0${event.label}\0${event.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 64) seen.delete(seen.values().next().value);
    recent.push(event);
    while (recent.length > maxEvents) recent.shift();
    return true;
  };
  return {
    push(chunk) {
      const lines = (carry + String(chunk ?? "")).split(/\r?\n/);
      carry = lines.pop() || "";
      if (carry.length > MAX_LINE_CHARS) carry = carry.slice(-MAX_LINE_CHARS);
      const events = [];
      for (const line of lines) {
        if (!line.trim() || line.length > MAX_LINE_CHARS) continue;
        try {
          const event = parseCodexProgressRecord(JSON.parse(line));
          if (event && add(event)) events.push(event);
        } catch {}
      }
      return events;
    },
    recent: () => recent.map((event) => ({ ...event })),
    bufferedChars: () => carry.length,
  };
};

const duration = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
};

export const createCodexProgressTracker = ({ model = "codex", now = Date.now, emit = () => {}, minRefreshMs = 500, quietAfterMs = 5_000, stalledAfterMs = 30_000, maxEvents = DEFAULT_MAX_EVENTS } = {}) => {
  const startedAt = now();
  let lastUsefulAt = startedAt;
  let lastEmitAt = -Infinity;
  let alive = true;
  let dirty = false;
  let phase = "starting";
  let eventCount = 0;
  let lastProgressAt = null;
  const recent = [];
  const publish = (activity, detail = "") => {
    if (!alive && activity !== "TERMINAL_SUCCESS" && activity !== "TERMINAL_FAILURE") return false;
    const current = now();
    lastEmitAt = current;
    dirty = false;
    const quiet = activity === "QUIET_BUT_ALIVE" || activity === "STALLED";
    const state = activity === "TERMINAL_SUCCESS" ? "TERMINAL_SUCCESS"
      : activity === "TERMINAL_FAILURE" ? "TERMINAL_FAILURE"
        : quiet ? "RUNNING_QUIET" : "RUNNING_ACTIVE";
    const metadata = {
      kind: "codex_live_progress", status: alive ? "running" : (activity === "TERMINAL_SUCCESS" ? "completed" : "failed"),
      state, activity, phase, elapsed_seconds: Math.floor((current - startedAt) / 1000), elapsed_ms: Math.max(0, current - startedAt), event_count: eventCount,
      last_progress_at: lastProgressAt, last_event_at: lastProgressAt, last_activity_age_ms: Math.max(0, current - lastUsefulAt),
      detail: clampText(detail, MAX_DETAIL_CHARS), recent_events: recent.map(({ category, status, label, detail: eventDetail }) => ({ category, status, label, detail: eventDetail })),
    };
    const elapsed = duration(current - startedAt);
    const title = activity === "TERMINAL_SUCCESS"
      ? `Codex completed · ${elapsed}`
      : activity === "TERMINAL_FAILURE"
        ? `Codex failed · ${elapsed}`
        : `Codex · ${model} · ${elapsed} · ${clampText(detail || activity, 100)}`;
    emit({ title, metadata });
    return true;
  };
  return {
    start() { return publish("ACTIVE", "Codex started"); },
    setModel(value) { model = clampText(value || model, 80); },
    ingest(event) {
      if (!alive || !event) return false;
      const current = now();
      const eventTimestamp = Number(event.timestamp);
      const safeEvent = {
        category: clampText(event.category || "ACTION", 32),
        status: clampText(event.status || "running", 32),
        label: redactCodexProgressText(event.label || "working", MAX_LABEL_CHARS),
        detail: redactCodexProgressText(event.detail || "", MAX_DETAIL_CHARS),
      };
      eventCount += 1;
      lastUsefulAt = current;
      lastProgressAt = new Date(Number.isFinite(eventTimestamp) ? eventTimestamp : current).toISOString();
      phase = clampText(event.phase || phase, 48);
      recent.push(safeEvent);
      while (recent.length > maxEvents) recent.shift();
      dirty = true;
      if (event.important || current - lastEmitAt >= minRefreshMs) return publish("ACTIVE", safeEvent.label);
      return false;
    },
    tick() {
      if (!alive) return false;
      const current = now();
      if (dirty && current - lastEmitAt >= minRefreshMs) return publish("ACTIVE", recent.at(-1)?.label || "working");
      const quietFor = current - lastUsefulAt;
      if (quietFor < quietAfterMs || current - lastEmitAt < minRefreshMs) return false;
      const activity = quietFor >= stalledAfterMs ? "STALLED" : "QUIET_BUT_ALIVE";
      return publish(activity, `Still working · last activity ${Math.floor(quietFor / 1000)}s ago`);
    },
    finish({ success, reason = "" }) {
      if (!alive) return false;
      alive = false;
      phase = success ? "completed" : "failed";
      return publish(success ? "TERMINAL_SUCCESS" : "TERMINAL_FAILURE", success ? `Codex completed · ${duration(now() - startedAt)}` : `Codex failed · ${redactCodexProgressText(reason || "terminal failure", 120)}`);
    },
    isAlive: () => alive,
    snapshot: () => ({ alive, phase, eventCount, recent: recent.map((event) => ({ ...event })) }),
  };
};
