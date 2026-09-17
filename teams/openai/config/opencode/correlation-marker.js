const MARKER = /<!-- OPENAI_TASK_PACKET:([^>]*) -->/gi;
const valid = (id) => /^[a-f0-9]{64}$/i.test(String(id || ""));

export const appendTaskPacketMarker = (objective, packetID) => {
  const text = String(objective || "").trim();
  if (!valid(packetID)) throw new Error("INVALID_TASK_PACKET_ID");
  if (MARKER.test(text)) { MARKER.lastIndex = 0; throw new Error("TASK_PACKET_MARKER_INJECTED"); }
  MARKER.lastIndex = 0;
  return `${text}\n\n<!-- OPENAI_TASK_PACKET:${String(packetID).toLowerCase()} -->`;
};

export const extractTaskPacketMarker = (value) => {
  const text = String(value || "");
  MARKER.lastIndex = 0;
  const matches = [...text.matchAll(MARKER)];
  MARKER.lastIndex = 0;
  if (!matches.length) return { present: false, valid: true, packetID: null, before: text.trim() };
  if (matches.length !== 1 || !valid(matches[0][1])) return { present: true, valid: false, packetID: null, before: null };
  return { present: true, valid: true, packetID: matches[0][1].toLowerCase(), before: text.slice(0, matches[0].index).trim() };
};

export const objectiveBeforeMarker = (value) => {
  const result = extractTaskPacketMarker(value);
  return result.present && result.valid ? result.before : String(value || "").trim();
};
