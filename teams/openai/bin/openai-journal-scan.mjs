#!/usr/bin/env node
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

const [file, offsetText, maxBytesText, maxEventsText] = process.argv.slice(2);
const offset = Number(offsetText), maxBytes = Number(maxBytesText), maxEvents = Number(maxEventsText);
if (!file || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1) process.exit(2);
const mutationEvent = (event) => {
  const source = event?.item ?? event?.event ?? event;
  const eventType = String(event?.type ?? event?.event?.type ?? "").toLowerCase();
  const itemType = String(source?.type ?? "").toLowerCase();
  const mutationCapable = itemType === "command_execution" || itemType === "command" || itemType === "file_change"
    || eventType.includes("command_execution") || eventType.includes("file_change") || eventType.includes("tool");
  if (!mutationCapable) return null;
  const completed = eventType.includes("completed") || eventType.includes("finished") || source?.status === "completed";
  const started = eventType.includes("started") || eventType.includes("start") || source?.status === "in_progress" || source?.status === "started";
  if (!completed && !started) return { unknown: true };
  const command = source?.command ?? source?.command_line;
  const malformedExit = [source, event].some((record) => record && typeof record === "object" && (
    (Object.hasOwn(record, "exit_code") && record.exit_code !== null && !Number.isInteger(record.exit_code)) ||
    (Object.hasOwn(record, "signal") && record.signal !== null && typeof record.signal !== "string") ||
    (Object.hasOwn(record, "timed_out") && typeof record.timed_out !== "boolean")
  ));
  const id = event?.id ?? source?.id ?? source?.command_id ?? source?.call_id ?? command ?? JSON.stringify(source);
  return {
    id: String(id), started: !completed, completed,
    mutation: itemType === "file_change" || itemType === "command_execution" || itemType === "command",
    command: typeof command === "string" && command.trim() ? command : null,
    incomplete: malformedExit || (itemType !== "file_change" && (typeof command !== "string" || !command.trim())),
    evidence: itemType === "file_change" ? JSON.stringify(source) : command,
  };
};
// Deliberately conservative: a completed command is only excluded when it is
// proven read-only.  At present no command parser is trusted enough for that
// proof, so every completed command is journaled by its normalized hash.
const info = await stat(file);
if (offset > info.size) process.stdout.write(JSON.stringify({ offset: info.size, hashes: [], incomplete: true, partial_tail: false }));
else {
  const bytes = Math.min(maxBytes, info.size - offset), handle = await open(file, "r"), buffer = Buffer.alloc(bytes);
  try { await handle.read(buffer, 0, bytes, offset); } finally { await handle.close(); }
  const hashes = []; const unfinished = new Set(); let events = 0; let cursor = 0; let incomplete = info.size - offset > maxBytes; let partial_tail = false;
  while (cursor < bytes) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) { partial_tail = cursor < bytes; break; } // Keep an unterminated UTF-8 JSON line for the next scan.
    const line = buffer.subarray(cursor, newline);
    const text = line.toString("utf8").trim();
    if (text) {
      if (events >= maxEvents) { incomplete = true; break; }
      events += 1;
      try {
        const event = mutationEvent(JSON.parse(text));
        if (event?.unknown) incomplete = true;
        if (event?.incomplete) incomplete = true;
        if (event?.started) unfinished.add(event.id);
        if (event?.completed) {
          unfinished.delete(event.id);
          if (event.evidence) hashes.push(createHash("sha256").update(event.evidence.replace(/[\n\t]/g, " ").replace(/\s+/g, " ").trim()).digest("hex"));
        }
      } catch { incomplete = true; }
    }
    cursor = newline + 1;
  }
  if (unfinished.size) incomplete = true;
  process.stdout.write(JSON.stringify({ offset: offset + cursor, hashes: [...new Set(hashes)], incomplete, partial_tail }));
}
