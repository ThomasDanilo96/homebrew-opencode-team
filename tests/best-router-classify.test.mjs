import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const router = fileURLToPath(new URL("../teams/best/router-classify.sh", import.meta.url));

function classify(prompt) {
  const result = spawnSync("/bin/bash", [router], {
    input: JSON.stringify({ session_id: "ses_test", prompt }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("BEST selects four agents for an articulated implementation request", () => {
  assert.equal(
    classify("Implementa una feature end-to-end che integra più moduli e aggiorna il flusso."),
    "<BEST_ROUTER_ROUTE>FOUR</BEST_ROUTER_ROUTE>",
  );
});

test("BEST preserves selective routing for simple exploration and direct requests", () => {
  assert.equal(
    classify("Dove si trova la configurazione del router BEST in questo repository?"),
    "<BEST_ROUTER_ROUTE>EXPLORE</BEST_ROUTER_ROUTE>",
  );
  assert.equal(classify("Spiegami in breve il significato di questo comando."), "");
});

test("BEST complex route maps two agents to each provider", () => {
  const config = readFileSync(new URL("../teams/best/opencode.jsonc.template", import.meta.url), "utf8");
  assert.match(config, /"explore": \{\s+"model": "opencode-go\//);
  assert.match(config, /"librarian": \{\s+"model": "opencode-go\//);
  assert.match(config, /"openai-architect": \{\s+"mode": "subagent",\s+"model": "openai\//);
  assert.match(config, /"openai-reviewer": \{\s+"mode": "subagent",\s+"model": "openai\//);
});
