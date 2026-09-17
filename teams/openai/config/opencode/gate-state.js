export const lifecycleCleanupOptions = (eventType, options = {}) => eventType === "session.idle"
  ? { ...options, packet: false, taskAction: null }
  : options;

export const gateTerminalPacketPatch = (packet = {}, passed = true) => passed
  ? { phase: "foreground_completion", outcome: "completed", codex_outcome: "success", verification_status: "passed", review_status: packet.review_status === "pending" ? "approved" : (packet.review_status || "not_required"), tester_status: ["pending", "required"].includes(packet.tester_status) ? "passed" : (packet.tester_status || "not_required") }
  : { phase: "foreground_completion", outcome: "failed", codex_outcome: "failed" };
