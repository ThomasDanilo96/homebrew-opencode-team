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

test("BEST selects the mandatory implementation workflow for both complex and small changes", () => {
  assert.equal(
    classify("Implementa una feature end-to-end che integra più moduli e aggiorna il flusso."),
    "<BEST_ROUTER_ROUTE>FANOUT</BEST_ROUTER_ROUTE>",
  );
  assert.equal(classify("Fix the typo in one configuration file"), "<BEST_ROUTER_ROUTE>FANOUT</BEST_ROUTER_ROUTE>");
  assert.equal(classify("Implement a small helper"), "<BEST_ROUTER_ROUTE>FANOUT</BEST_ROUTER_ROUTE>");
});

test("BEST does not send planning-only refactor requests to implementation coders", () => {
  assert.equal(classify("Plan the workflow refactor across several packages and runtime components"), "<BEST_ROUTER_ROUTE>FOUR</BEST_ROUTER_ROUTE>");
  assert.equal(classify("Plan the Docker runtime refactor across several services and packages"), "<BEST_ROUTER_ROUTE>FOUR</BEST_ROUTER_ROUTE>");
  assert.equal(classify("Plan a simple one-file rename"), "");
  assert.equal(
    classify("Plan and implement a multi-file workflow refactor"),
    "<BEST_ROUTER_ROUTE>FANOUT</BEST_ROUTER_ROUTE>",
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
