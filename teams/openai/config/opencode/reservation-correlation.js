export const childSessionIdFromAfter = (metadata) => {
  for (const key of ["sessionId", "sessionID", "session_id"]) {
    if (typeof metadata?.[key] === "string" && metadata[key].length > 0) return metadata[key];
  }
  return null;
};

export const sessionCreatedCorrelationDecision = ({ background, explicitCallID, candidateCallIDs = [] } = {}) => {
  if (explicitCallID) return candidateCallIDs.includes(explicitCallID) ? "durable" : "rejected";
  if (candidateCallIDs.length !== 1) return "none";
  return background ? "durable" : "provisional";
};

export const reservationEligibleForSessionCreated = (pending) => Boolean(pending && !pending.child_session_id && !pending.provisional_child_session_id);

export const bindExactChildReservation = async (pending, childID, { readTask, advanceTask, updateWorkPacket, packetPatch = {} } = {}) => {
  if (!pending || typeof childID !== "string" || !childID) throw new Error("BINDING_MISSING_CHILD");
  if (pending.child_session_id && pending.child_session_id !== childID) throw new Error("CHILD_SESSION_ID_CONFLICT");
  if (pending.provisional_child_session_id && pending.provisional_child_session_id !== childID) throw new Error("PROVISIONAL_CHILD_SESSION_ID_CONFLICT");
  const task = pending.task_fingerprint && readTask ? await readTask(pending.task_fingerprint) : null;
  if (!task) throw new Error("BINDING_TASK_MISSING");
  if (task?.child_session_id && task.child_session_id !== childID) throw new Error("CHILD_SESSION_ID_CONFLICT");
  await advanceTask(pending, "BOUND", { child_session_id: childID });
  const packet = updateWorkPacket && pending.task_call_id ? await updateWorkPacket(pending.task_call_id, { child_session_id: childID, ...packetPatch }) : null;
  if (!packet) throw new Error("BINDING_PACKET_UPDATE_FAILED");
  pending.child_session_id = childID;
  delete pending.provisional_child_session_id;
  return pending;
};
