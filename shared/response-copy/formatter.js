function clean(value) {
  return String(value ?? "").trim();
}

export function modelLabel(session, message) {
  const provider = message?.providerID ?? session?.model?.providerID ?? "unknown-provider";
  const model = message?.modelID ?? session?.model?.id ?? "unknown-model";
  return `${provider}/${model}`;
}

export function formatTranscript({ parent, parentVisible, children, final }) {
  const sections = [];
  const parentHeader = `=== ORCHESTRATOR · ${clean(parent?.agent || "unknown-agent")} · ${modelLabel(parent, parent?.lastMessage)} ===`;
  if (parentVisible.length) sections.push([parentHeader, ...parentVisible].join("\n\n"));

  for (const child of children) {
    if (!child.text.length) continue;
    sections.push([
      `=== SUBAGENT: ${clean(child.agent || "unknown-agent")} · ${modelLabel(child.session, child.lastMessage)} ===`,
      ...child.text,
    ].join("\n\n"));
  }

  if (final.length) sections.push(["=== FINAL RESPONSE ===", ...final].join("\n\n"));
  return sections.join("\n\n").trim();
}
