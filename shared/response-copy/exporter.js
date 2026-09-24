import { eligiblePartText } from "./safe-parts.js";
import { formatTranscript } from "./formatter.js";

function idOf(value) {
  return value?.id ?? "";
}

function timeOf(value) {
  const time = value?.state?.time ?? value?.time;
  const raw = time?.start ?? time?.created ?? time?.end;
  const numeric = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function chronological(values) {
  return values.map((value, index) => ({ value, index })).sort((left, right) => {
    const leftTime = timeOf(left.value);
    const rightTime = timeOf(right.value);
    if (leftTime === undefined || rightTime === undefined) return left.index - right.index;
    return leftTime - rightTime || left.index - right.index;
  }).map(({ value }) => value);
}

function messagesOf(source, sessionID) {
  if (typeof source === "function") return chronological([...(source(sessionID) ?? [])]);
  if (source instanceof Map) return chronological([...(source.get(sessionID) ?? [])]);
  return chronological([...(source?.[sessionID] ?? [])]);
}

function partsOf(source, messageID) {
  if (typeof source === "function") return chronological([...(source(messageID) ?? [])]);
  if (source instanceof Map) return chronological([...(source.get(messageID) ?? [])]);
  return chronological([...(source?.[messageID] ?? [])]);
}

function hasPartRecord(source, messageID) {
  if (typeof source === "function") return true;
  if (source instanceof Map) return source.has(messageID);
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, messageID));
}

function isInjectedSystemUser(parts) {
  const marker = /<system-reminder>|<!--\s*OMO_INTERNAL_(?:INITIATOR|NOREPLY)\s*-->|<BEST_ROUTER_ROUTE>/;
  const textParts = parts.filter((part) => part?.type === "text" && typeof part.text === "string");
  return textParts.some((part) => marker.test(part.text)) && !textParts.some((part) => !part.synthetic && !part.ignored && !marker.test(part.text));
}

function isLogicalTurnUser(message, partsSource) {
  if (message?.role !== "user") return false;
  const parts = partsOf(partsSource, idOf(message));
  if (!parts.length) return true;
  if (isInjectedSystemUser(parts)) return false;
  return parts.some((part) => part?.type === "text" && !part.synthetic && !part.ignored);
}

function currentAssistantMessages(messages, partsSource) {
  const hasPersistedUserParts = messages.some((message) => message?.role === "user" && hasPartRecord(partsSource, idOf(message)));
  let boundary;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((!hasPersistedUserParts && messages[index]?.role === "user") || isLogicalTurnUser(messages[index], partsSource)) {
      boundary = { message: messages[index], index };
      break;
    }
  }
  if (!boundary) return { user: undefined, assistants: [] };
  const logicalUserIDs = new Set();
  for (let index = boundary.index; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (index !== boundary.index && isLogicalTurnUser(message, partsSource)) break;
    logicalUserIDs.add(idOf(message));
  }
  const assistants = [];
  for (const message of messages) {
    if (message?.role === "assistant" && logicalUserIDs.has(message.parentID)) assistants.push(message);
  }
  return { user: boundary.message, assistants };
}

function childSessionID(part) {
  return typeof part?.state?.metadata?.sessionId === "string" ? part.state.metadata.sessionId : undefined;
}

function taskParentSessionID(part) {
  return typeof part?.state?.metadata?.parentSessionId === "string" ? part.state.metadata.parentSessionId : undefined;
}

function taskParts(parts) {
  return parts.filter((part) => part?.type === "tool" && part.tool === "task");
}

function taskOrder(parts, messageIndex, prefix = []) {
  return taskParts(parts).map((part, index) => ({ part, order: [...prefix, messageIndex, index] }));
}

function sessionIsBusy(status) {
  return status?.type === "busy" || status?.type === "retry";
}

function describeChild(session, messagesSource, partsSource, sessions, statuses, visited, launchOrder) {
  if (!session || visited.has(session.id)) return undefined;
  visited.add(session.id);
  const { assistants } = currentAssistantMessages(messagesOf(messagesSource, session.id), partsSource);
  const text = [];
  const nested = [];
  let lastMessage;
  for (const [index, message] of assistants.entries()) {
    lastMessage = message;
    const parts = partsOf(partsSource, message.id);
    text.push(...eligiblePartText(parts));
    for (const task of taskOrder(parts, index, launchOrder)) {
      const childID = childSessionID(task.part);
      const child = childID ? sessions.get(childID) : undefined;
      if (child?.parentID !== session.id) continue;
      if (taskParentSessionID(task.part) && taskParentSessionID(task.part) !== session.id) continue;
       const described = describeChild(child, messagesSource, partsSource, sessions, statuses, visited, task.order);
      if (described) nested.push(described);
    }
  }
  const child = { session, agent: session.agent, lastMessage, text, launchOrder, busy: sessionIsBusy(statuses.get(session.id)), nested };
  return child;
}

function flattenChildren(children) {
  return children.flatMap((child) => [child, ...flattenChildren(child.nested)]);
}

export function exportLatestResponse({ parentSession, messages, parts, sessions = new Map(), statuses = new Map() }) {
  const parentMessages = messagesOf(messages, parentSession.id);
  const { user, assistants } = currentAssistantMessages(parentMessages, parts);
  const parentTexts = [];
  const finalTexts = [];
  const selectedChildren = [];
  const visited = new Set([parentSession.id]);
  const parentTaskOrder = [];

  assistants.forEach((message, index) => {
    const messageParts = partsOf(parts, message.id);
    const texts = eligiblePartText(messageParts);
    if (index === assistants.length - 1) finalTexts.push(...texts);
    else parentTexts.push(...texts);
    parentTaskOrder.push(...taskOrder(messageParts, index));
  });

  for (const task of parentTaskOrder) {
    const childID = childSessionID(task.part);
    const child = childID ? sessions.get(childID) : undefined;
    if (child?.parentID !== parentSession.id) continue;
    if (taskParentSessionID(task.part) && taskParentSessionID(task.part) !== parentSession.id) continue;
    const described = describeChild(child, messages, parts, sessions, statuses, visited, task.order);
    if (described) selectedChildren.push(described);
  }

  const children = flattenChildren(selectedChildren).sort((a, b) => {
    const length = Math.max(a.launchOrder.length, b.launchOrder.length);
    for (let index = 0; index < length; index += 1) {
      const left = a.launchOrder[index] ?? -1;
      const right = b.launchOrder[index] ?? -1;
      if (left !== right) return left - right;
    }
    return a.launchOrder.length - b.launchOrder.length;
  });
  if (children.some((child) => child.busy)) return { status: "busy", text: "", user, children };

  const final = finalTexts.filter((text, index, all) => !parentTexts.includes(text) && all.indexOf(text) === index);
  const text = formatTranscript({
    parent: { ...parentSession, lastMessage: assistants.at(-1) },
    parentVisible: parentTexts,
    children,
    final,
  });
  return { status: text ? "ready" : "empty", text, user, children };
}
