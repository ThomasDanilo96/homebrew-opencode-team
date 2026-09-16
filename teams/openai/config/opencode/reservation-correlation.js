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

export const bindExactChildReservation = async (pending, childID, { readTask, advanceTask, updateWorkPacket, updateWorkPacketByID, packetPatch = {} } = {}) => {
  if (!pending || typeof childID !== "string" || !childID) throw new Error("BINDING_MISSING_CHILD");
  if (pending.child_session_id && pending.child_session_id !== childID) throw new Error("CHILD_SESSION_ID_CONFLICT");
  if (pending.provisional_child_session_id && pending.provisional_child_session_id !== childID) throw new Error("PROVISIONAL_CHILD_SESSION_ID_CONFLICT");
  const task = pending.task_fingerprint && readTask ? await readTask(pending.task_fingerprint) : null;
  if (!task) throw new Error("BINDING_TASK_MISSING");
  if (task.agent !== pending.role && task.agent !== pending.agent) throw new Error("BINDING_TASK_IDENTITY_MISMATCH");
  if (task.parent_session_id !== pending.master_parent_session_id && task.parent_session_id !== pending.parent_session_id) throw new Error("BINDING_TASK_IDENTITY_MISMATCH");
  if (task.packet_id !== pending.packet_id || task.attempt !== pending.attempt || task.lease_id !== pending.task_lease_id) throw new Error("BINDING_TASK_IDENTITY_MISMATCH");
  if (task?.child_session_id && task.child_session_id !== childID) throw new Error("CHILD_SESSION_ID_CONFLICT");
  const state = String(task.state || "").toUpperCase();
  if (["CLAIMED", "ADMITTED"].includes(state)) {
    await advanceTask(pending, "BOUND", { child_session_id: childID });
  } else if (!["BOUND", "RUNNING", "PENDING_REVIEW", "PENDING_VERIFICATION", "COMPLETED"].includes(state)) {
    throw new Error("BINDING_TASK_STATE_INVALID");
  }
  const packet = pending.packet_id && updateWorkPacketByID
    ? await updateWorkPacketByID(pending.packet_id, { child_session_id: childID, ...packetPatch })
    : updateWorkPacket && pending.task_call_id ? await updateWorkPacket(pending.task_call_id, { child_session_id: childID, ...packetPatch }) : null;
  if (!packet) throw new Error("BINDING_PACKET_UPDATE_FAILED");
  pending.child_session_id = childID;
  delete pending.provisional_child_session_id;
  return pending;
};
