function responseData(response) {
  return response?.data;
}

function isInjectedSystemUser(parts) {
  return parts.some((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return false;
    return /<system-reminder>|<!--\s*OMO_INTERNAL_(?:INITIATOR|NOREPLY)\s*-->|<BEST_ROUTER_ROUTE>/.test(part.text);
  });
}

function isLogicalTurnUser(message, parts) {
  if (message?.role !== "user") return false;
  const messageParts = parts.get(message.id) ?? [];
  if (!messageParts.length) return true;
  if (isInjectedSystemUser(messageParts)) return false;
  return messageParts.some((part) => part?.type === "text" && !part.synthetic && !part.ignored);
}

function taskPartsForLogicalResponse(messages, parts) {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isLogicalTurnUser(messages[index], parts)) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return [];
  const logicalUserIDs = new Set();
  for (let index = userIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (index !== userIndex && isLogicalTurnUser(message, parts)) break;
    logicalUserIDs.add(message.id);
  }
  const tasks = [];
  for (const message of messages) {
    if (message?.role !== "assistant" || !logicalUserIDs.has(message.parentID)) continue;
    for (const part of parts.get(message.id) ?? []) {
      if (part?.type === "tool" && part.tool === "task") tasks.push(part);
    }
  }
  return tasks;
}

export async function loadResponseGraph(api, parentSessionID) {
  const sessions = new Map();
  const messages = new Map();
  const parts = new Map();
  const statuses = new Map();
  const visited = new Set();

  async function loadSession(sessionID, expectedParentID) {
    if (visited.has(sessionID)) return;
    visited.add(sessionID);
    const session = responseData(await api.client.session.get({ sessionID }));
    if (!session || (expectedParentID && session.parentID !== expectedParentID)) return;
    sessions.set(sessionID, session);
    const entries = responseData(await api.client.session.messages({ sessionID })) ?? [];
    const sessionMessages = [];
    for (const entry of entries) {
      if (!entry?.info) continue;
      sessionMessages.push(entry.info);
      parts.set(entry.info.id, entry.parts ?? []);
    }
    messages.set(sessionID, sessionMessages);
    for (const task of taskPartsForLogicalResponse(sessionMessages, parts)) {
      const childID = task.state?.metadata?.sessionId;
      const taskParentID = task.state?.metadata?.parentSessionId;
      if (typeof childID !== "string" || (taskParentID && taskParentID !== sessionID)) continue;
      await loadSession(childID, sessionID);
    }
  }

  await loadSession(parentSessionID);
  const statusResponse = responseData(await api.client.session.status()) ?? {};
  for (const sessionID of sessions.keys()) statuses.set(sessionID, statusResponse[sessionID]);
  return {
    parentSession: sessions.get(parentSessionID),
    sessions,
    messages,
    parts,
    statuses,
  };
}
