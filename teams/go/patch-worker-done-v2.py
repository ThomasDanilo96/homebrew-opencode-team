#!/usr/bin/env python3
"""V2: patches markForNotification to emit worker_done for terminal tasks."""
import sys

PATCHED_SENTINEL = 'const _GO_WORKER_DONE_COMPLETION_PATCH_V2 = true;'
V1_SENTINEL = "const _GO_WORKER_DONE_COMPLETION_PATCH_V1 = true;"
TAG = "[GO_WORKER_DONE]"

OLD_MARK = '  markForNotification(task2) {\n    const queue = this.notifications.get(task2.parentSessionId) ?? [];\n    queue.push(task2);\n    this.notifications.set(task2.parentSessionId, queue);\n  }'

NEW_MARK = '  markForNotification(task2) {\n    const queue = this.notifications.get(task2.parentSessionId) ?? [];\n    queue.push(task2);\n    this.notifications.set(task2.parentSessionId, queue);\n    const _GO_WORKER_DONE_COMPLETION_PATCH_V2 = true;\n    if (["completed","interrupt","error","cancelled"].includes(task2.status)\n      && typeof task2.sessionId === "string" && task2.sessionId.startsWith("ses_")\n      && typeof task2.parentSessionId === "string" && task2.parentSessionId.startsWith("ses_")) {\n      try {\n        const _fs = __require("fs"), _path = __require("path"), _os = __require("os");\n        const _goSandbox = process.env.SANDBOX || _path.join(_os.homedir(), ".opencode-go-team-v2-visible");\n        const _runsDir = _path.join(_goSandbox, "state", "runs");\n        if (_fs.existsSync(_runsDir)) {\n          let _matchCount = 0;\n          let _matchedDir = "";\n          for (const _re of _fs.readdirSync(_runsDir)) {\n            const _f = _path.join(_runsDir, _re, "parent_session_id");\n            if (_fs.existsSync(_f) && _fs.readFileSync(_f, "utf8").trim() === task2.parentSessionId) {\n              _matchCount++;\n              _matchedDir = _path.join(_runsDir, _re);\n            }\n          }\n          if (_matchCount === 1) {\n            const _dd = _path.join(_matchedDir, "worker_done");\n            try { _fs.mkdirSync(_dd, { recursive: true }); _fs.writeFileSync(_path.join(_dd, task2.sessionId), ""); } catch (_e) { log2("[GO_WORKER_DONE] write failed:", { error: String(_e) }); }\n          } else if (_matchCount === 0) {\n            log2("[GO_WORKER_DONE] no matching GO run for parent", { parentSessionId: task2.parentSessionId });\n          } else {\n            log2("[GO_WORKER_DONE] ambiguous: multiple GO runs match parent", { parentSessionId: task2.parentSessionId, matchCount: _matchCount });\n          }\n        }\n      } catch (_e) { log2("[GO_WORKER_DONE] filesystem error:", { error: String(_e) }); }\n    }\n  }'

if len(sys.argv) != 2:
    print("Usage: apply_go_worker_done_patch_v2.py <file>", file=sys.stderr)
    sys.exit(1)

filepath = sys.argv[1]
with open(filepath, "r") as f:
    content = f.read()

v2_count = content.count(PATCHED_SENTINEL)
if v2_count == 1:
    CONTRACT = [
        PATCHED_SENTINEL, "process.env.SANDBOX", ".opencode-go-team-v2-visible", "worker_done",
        "task2.sessionId", "task2.parentSessionId", 'startsWith("ses_")',
        "_matchCount === 1", "_matchCount === 0",
        "no matching GO run for parent", "ambiguous: multiple GO runs match parent",
        "write failed", "filesystem error",
    ]
    missing = [s for s in CONTRACT if s not in content]
    if not missing:
        print("ALREADY_PATCHED")
        sys.exit(0)
    print(f"REFUSED: V2 sentinel present but contract incomplete (missing: {missing[0]})", file=sys.stderr)
    sys.exit(1)
elif v2_count > 1:
    print(f"REFUSED: V2 sentinel appears {v2_count} times", file=sys.stderr)
    sys.exit(1)

if V1_SENTINEL in content:
    print("ERROR: V1 sentinel still present. Restore from pristine first.", file=sys.stderr)
    sys.exit(1)

if OLD_MARK not in content:
    print("ERROR: pristine markForNotification not found", file=sys.stderr)
    sys.exit(1)

count = content.count(OLD_MARK)
if count != 1:
    print(f"ERROR: markForNotification matched {count} times", file=sys.stderr)
    sys.exit(1)

content = content.replace(OLD_MARK, NEW_MARK, 1)

with open(filepath, "w") as f:
    f.write(content)

if PATCHED_SENTINEL not in content:
    print("ERROR: sentinel not present after patch", file=sys.stderr)
    sys.exit(1)

print("PATCHED")
sys.exit(0)
