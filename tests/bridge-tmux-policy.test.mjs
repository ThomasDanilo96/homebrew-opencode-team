import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const policy = fileURLToPath(new URL("../core/lib/bridge-tmux-policy.sh", import.meta.url));
const bridge = readFileSync(new URL("../core/lib/bridge-tmux.sh", import.meta.url), "utf8");

const label = (agent, title = "") => {
  const result = spawnSync("bash", ["-c", 'source "$1"; bridge_agent_label "$2" "$3"', "bridge-test", policy, agent, title], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const noAttachAction = (agent, nativeUiAgents) => {
  const result = spawnSync("bash", ["-c", 'source "$1"; NATIVE_UI_ONLY_AGENTS="$2" bridge_no_attach_action "$3"', "bridge-test", policy, nativeUiAgents, agent], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("tmux bridge identifies implementation, review, and Go research workers", () => {
  assert.equal(label("openai-coder-1", "Plan workflow refactor"), "Coder-1");
  assert.equal(label("openai-coder-2", "Plan Docker runtime refactor"), "Coder-2");
  assert.equal(label("openai-reviewer", "Review implementation"), "Reviewer");
  assert.equal(label("explore", "Inspect Go project"), "Explore");
  assert.equal(label("librarian", "Research docs"), "Librarian");
  assert.equal(noAttachAction("openai-coder-1", "explore,librarian,openai-reviewer"), "tmux-visible");
  assert.equal(noAttachAction("explore", "explore,librarian,openai-reviewer"), "native-ui-only");
  assert.equal(noAttachAction("explore", ""), "tmux-visible");
  assert.match(bridge, /source .*bridge-tmux-policy\.sh/);
  assert.match(bridge, /no-attach handoff accepted by tmux policy; attaching pane/);
});

test("BEST coder workers are attached to visible tmux panes rather than hidden as native-only", () => {
  const runtime = readFileSync(new URL("../teams/best/team-runtime.conf.template", import.meta.url), "utf8");
  const agents = runtime.match(/^NATIVE_UI_ONLY_AGENTS=(.*)$/m)?.[1] || "";
  assert.equal(agents.includes("openai-coder-1"), false);
  assert.equal(agents.includes("openai-coder-2"), false);
});
