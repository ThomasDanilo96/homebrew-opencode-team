export const childSessionIdFromAfter = (metadata) => {
  for (const key of ["sessionId", "sessionID", "session_id"]) {
    if (typeof metadata?.[key] === "string" && metadata[key].length > 0) return metadata[key];
  }
  return null;
};
