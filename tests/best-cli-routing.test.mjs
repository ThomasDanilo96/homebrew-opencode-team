import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cli = await readFile(new URL("../bin/opencode-team", import.meta.url), "utf8");

test("BEST OpenCode profile is the default and best-opencode alias", () => {
  assert.match(cli, /if \[ "\$team" = best \]; then\s+start_team best "\$@"/);
  assert.match(cli, /elif \[ "\$team" = best-opencode \]; then\s+start_team best "\$@"/);
  assert.match(cli, /best\)\s+shift\s+start_team best "\$@"/);
});

test("BEST Native remains available as a separate command", () => {
  assert.match(cli, /elif \[ "\$team" = best-native \]; then\s+start_best_native "\$@"/);
  assert.match(cli, /best-native\)\s+shift\s+start_best_native "\$@"/);
});
