import test from "node:test";
import assert from "node:assert/strict";

import {
  isBestRouterInternalMessage,
  routeGuidanceFor,
} from "../teams/best/best-router-plugin.js";

test("BEST route guidance defines the exact first native task contract", () => {
  const guidance = ["EXPLORE", "LIBRARIAN", "BOTH"].map(routeGuidanceFor);
  assert.match(guidance[0], /exactly one native task\(subagent_type="explore", run_in_background=true\)/);
  assert.match(guidance[1], /exactly one native task\(subagent_type="librarian", run_in_background=true\)/);
  assert.match(guidance[2], /exactly two native task calls/);
  assert.match(guidance[2], /one task\(subagent_type="explore", run_in_background=true\)/);
  assert.match(guidance[2], /one task\(subagent_type="librarian", run_in_background=true\)/);
  for (const text of guidance) {
    assert.match(text, /do not use general/i);
    assert.match(text, /do not launch (?:a )?duplicate/i);
  }
});

test("BEST router ignores OMO no-reply internal continuation", () => {
  assert.equal(
    isBestRouterInternalMessage([
      {
        type: "text",
        text: `<system-reminder>
[BACKGROUND TASK COMPLETED]
</system-reminder>
<!-- OMO_INTERNAL_INITIATOR -->
<!-- OMO_INTERNAL_NOREPLY -->`,
      },
    ]),
    true,
  );
});

test("BEST router ignores OMO background completion reminder without NOREPLY", () => {
  assert.equal(
    isBestRouterInternalMessage([
      {
        type: "text",
        text: `<system-reminder>
[BACKGROUND TASK COMPLETED]
[ALL BACKGROUND TASKS COMPLETE]

Completed:
- bg_test: Inspect README

All sibling background tasks are complete.
</system-reminder>
<!-- OMO_INTERNAL_INITIATOR -->`,
      },
    ]),
    true,
  );
});

test("BEST router does not ignore genuine user requests", () => {
  for (const text of [
    "Inspect README.md and explain its purpose.",
    "Tell me whether all background tasks complete successfully.",
    "<system-reminder>This is literal documentation text.</system-reminder>",
    "[BACKGROUND TASK COMPLETED]",
    "<!-- OMO_INTERNAL_INITIATOR -->",
  ]) {
    assert.equal(
      isBestRouterInternalMessage([
        {
          type: "text",
          text,
        },
      ]),
      false,
      text,
    );
  }
});
