function responseData(response) {
  return response?.data;
}

function taskPartsForCurrentTurn(messages, parts) {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return [];
  const tasks = [];
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (message?.role !== "assistant" || message.parentID !== messages[userIndex]?.id) continue;
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
    for (const task of taskPartsForCurrentTurn(sessionMessages, parts)) {
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
