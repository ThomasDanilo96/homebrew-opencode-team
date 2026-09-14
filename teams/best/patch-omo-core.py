#!/usr/bin/env python3
"""
apply_best_omo_patch.py — Build candidate OMO for BEST from unpatched 4.19.4 baseline.
Applies: four no_attach sentinels + Builder task:allow.
Does NOT apply: V2 worker_done (BEST uses router completion), fg_only, clickability.
"""
import sys, os

NATIVE_SENTINEL = "const _GO_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;"
TASK_SENTINEL = "const _GO_TASK_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;"
BG_TASK_SENTINEL = "const _GO_TASK_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;"
BG_CALL_OMO_SENTINEL = "const _GO_CALL_OMO_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;"
OLD_V1_SENTINEL = "_GO_FOREGROUND_WORKER_DONE_PATCH_V1"
BG_V2_SENTINEL = "_GO_WORKER_DONE_COMPLETION_PATCH_V2"
FG_ONLY_SENTINEL = "_GO_CALL_OMO_FG_ONLY_V1"
BUILDER_TASK_SENTINEL = "_GO_BUILDER_TASK_ALLOW_V1"

BEST_SANDBOX = os.path.realpath(os.path.expanduser("~/.opencode-best-team"))

if len(sys.argv) != 2:
    print("Usage: apply_best_omo_patch.py <file>", file=sys.stderr); sys.exit(1)

filepath = os.path.realpath(sys.argv[1])
if filepath.startswith(os.path.abspath(BEST_SANDBOX)):
    print("REFUSED: write target is inside BEST sandbox", file=sys.stderr); sys.exit(1)

with open(filepath, "r") as f:
    src = f.read()

v1_count = src.count(OLD_V1_SENTINEL)
if v1_count != 0:
    print("REFUSED: old foreground V1 sentinel present", file=sys.stderr); sys.exit(1)

nc = src.count(NATIVE_SENTINEL)
tc = src.count(TASK_SENTINEL)
bc = src.count(BG_TASK_SENTINEL)
cc = src.count(BG_CALL_OMO_SENTINEL)
bt = src.count(BUILDER_TASK_SENTINEL)

all_native = [nc, tc, bc, cc]
if all(x == 1 for x in all_native) and bt == 1:
    print("ALREADY_PATCHED"); sys.exit(0)
elif not all(x == 0 for x in all_native):
    print(f"REFUSED: partial native patch state native={nc} task={tc} bg={bc} call_omo_bg={cc}", file=sys.stderr); sys.exit(1)

def patch(anchor, replacement, label):
    global src
    c = src.count(anchor)
    if c != 1:
        print(f"ERROR: {label} anchor matched {c} times", file=sys.stderr); sys.exit(1)
    src = src.replace(anchor, replacement, 1)

# PATCH A: call_omo_agent executeSync (no_attach)
patch(
    'async function executeSync(args, toolContext, ctx, deps = defaultDeps7, fallbackChain, spawnReservation, model) {\n  let sessionID;\n  let createdSessionForExecution = false;\n  let appliedFallbackChain = false;\n  try {\n    const session = await deps.createOrGetSession(args, toolContext, ctx, model);',
    'async function executeSync(args, toolContext, ctx, deps = defaultDeps7, fallbackChain, spawnReservation, model) {\n  const _GO_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;\n  let sessionID;\n  let createdSessionForExecution = false;\n  let appliedFallbackChain = false;\n  let _noAttachHoldOwner = null;\n  let _noAttachRunDir = null;\n  let _noAttachRetainHold = false;\n  try {\n    {\n      const _fs = __require("fs"), _path = __require("path"), _os = __require("os");\n      const _goSandbox = _path.join(_os.homedir(), ".opencode-best-team");\n      const _runsDir = _path.join(_goSandbox, "state", "runs");\n      if (!_fs.existsSync(_runsDir)) {\n        throw new Error("[GO_NATIVE_UI] GO runs directory not found");\n      }\n      if (typeof toolContext.sessionID !== "string" || !toolContext.sessionID.startsWith("ses_")) {\n        throw new Error("[GO_NATIVE_UI] invalid or missing parent session ID");\n      }\n      let _matchCount = 0, _matchedDir = "";\n      for (const _re of _fs.readdirSync(_runsDir)) {\n        const _f = _path.join(_runsDir, _re, "parent_session_id");\n        if (_fs.existsSync(_f) && _fs.readFileSync(_f, "utf8").trim() === toolContext.sessionID) {\n          _matchCount++;\n          _matchedDir = _path.join(_runsDir, _re);\n        }\n      }\n      if (_matchCount !== 1) {\n        throw new Error(`[GO_NATIVE_UI] run resolution failed: match_count=${_matchCount}, parent=${toolContext.sessionID}`);\n      }\n      _noAttachRunDir = _matchedDir;\n      _noAttachHoldOwner = __require("crypto").randomUUID();\n      _fs.mkdirSync(_path.join(_matchedDir, "attach_holds"), { recursive: true });\n      _fs.mkdirSync(_path.join(_matchedDir, "no_attach"), { recursive: true });\n      const _holdPath = _path.join(_matchedDir, "attach_holds", _noAttachHoldOwner + ".hold");\n      _fs.writeFileSync(_holdPath, "");\n      log2("[GO_NATIVE_UI] attach_hold created", { owner: _noAttachHoldOwner, runDir: _matchedDir });\n    }\n    const session = await deps.createOrGetSession(args, toolContext, ctx, model);',
    "A1:func"
)

patch(
    '  } finally {\n    if (sessionID && appliedFallbackChain) {',
    '  } finally {\n    if (_noAttachRunDir && _noAttachHoldOwner && !_noAttachRetainHold) {\n      try {\n        const _fs = __require("fs"), _path = __require("path");\n        const _holdPath = _path.join(_noAttachRunDir, "attach_holds", _noAttachHoldOwner + ".hold");\n        if (_fs.existsSync(_holdPath)) _fs.unlinkSync(_holdPath);\n      } catch (_e) {}\n    }\n    if (sessionID && appliedFallbackChain) {',
    "A2:fin"
)

patch(
    '    if (session.isNew) {\n      spawnReservation?.commit();\n    }\n    if (fallbackChain && fallbackChain.length > 0) {',
    '    if (session.isNew) {\n      spawnReservation?.commit();\n    }\n    if (_noAttachRunDir && _noAttachHoldOwner && sessionID && typeof sessionID === "string" && sessionID.startsWith("ses_")) {\n      const _fs = __require("fs"), _path = __require("path");\n      const _holdPath = _path.join(_noAttachRunDir, "attach_holds", _noAttachHoldOwner + ".hold");\n      const _noAttachPath = _path.join(_noAttachRunDir, "no_attach", sessionID + ".marker");\n      try {\n        _fs.renameSync(_holdPath, _noAttachPath);\n        log2("[GO_NATIVE_UI] atomic transition hold\\u2192no_attach complete", { owner: _noAttachHoldOwner, childId: sessionID });\n      } catch (_renameErr) {\n        log2("[GO_NATIVE_UI] atomic rename FAILED, attempting fail-closed recovery", { error: String(_renameErr), childId: sessionID });\n        try {\n          if (typeof ctx.client.session.abort === "function") {\n            await ctx.client.session.abort({ path: { id: sessionID } }).catch(() => {});\n          }\n        } catch (_abortErr) {}\n        let _recoveryOk = false;\n        try {\n          const _wdDir = _path.join(_noAttachRunDir, "worker_done");\n          _fs.mkdirSync(_wdDir, { recursive: true });\n          _fs.writeFileSync(_path.join(_wdDir, sessionID), "");\n          _recoveryOk = true;\n          log2("[GO_NATIVE_UI] fail-closed: worker_done recovery written", { childId: sessionID });\n        } catch (_wdErr) {\n          log2("[GO_NATIVE_UI] FAIL-CLOSED: worker_done recovery also failed, retaining hold", { error: String(_wdErr), childId: sessionID });\n          _noAttachRetainHold = true;\n        }\n        if (_recoveryOk) {\n          throw new Error(`[GO_NATIVE_UI] no_attach publication failed, worker_done recovery applied for ${sessionID}`);\n        } else {\n          throw new Error(`[GO_NATIVE_UI] FAIL-CLOSED: no_attach and worker_done both failed for ${sessionID}`);\n        }\n      }\n    }\n    if (fallbackChain && fallbackChain.length > 0) {',
    "A3:ren"
)

# PATCH B: task executeSyncTask (no_attach)
patch(
    'async function executeSyncTask(args, ctx, executorCtx, parentContext, agentToUse, categoryModel, systemContent, modelInfo, fallbackChain, deps = syncTaskDeps) {\n  const { client: client3, directory, syncPollTimeoutMs } = executorCtx;\n  const toastManager = getTaskToastManager();\n  let taskId;\n  let syncSessionID;\n  let spawnReservation;\n  try {\n    const spawn5 = await reserveSyncSubagentSpawn(executorCtx, parentContext);\n    spawnReservation = spawn5.reservation;\n    const { spawnContext } = spawn5;\n    const createSessionResult = await deps.createSyncSession(client3, {\n      parentSessionID: parentContext.sessionID,\n      agentToUse,\n      description: args.description,\n      defaultDirectory: directory,\n      categoryModel\n    });',
    'async function executeSyncTask(args, ctx, executorCtx, parentContext, agentToUse, categoryModel, systemContent, modelInfo, fallbackChain, deps = syncTaskDeps) {\n  const _GO_TASK_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;\n  const { client: client3, directory, syncPollTimeoutMs } = executorCtx;\n  const toastManager = getTaskToastManager();\n  let taskId;\n  let syncSessionID;\n  let spawnReservation;\n  let _taskHoldOwner = null;\n  let _taskRunDir = null;\n  let _taskRetainHold = false;\n  try {\n    {\n      const _fs = __require("fs"), _path = __require("path"), _os = __require("os");\n      const _goSandbox = _path.join(_os.homedir(), ".opencode-best-team");\n      const _runsDir = _path.join(_goSandbox, "state", "runs");\n      if (!_fs.existsSync(_runsDir)) {\n        throw new Error("[GO_TASK_NATIVE_UI] GO runs directory not found");\n      }\n      if (typeof parentContext.sessionID !== "string" || !parentContext.sessionID.startsWith("ses_")) {\n        throw new Error("[GO_TASK_NATIVE_UI] invalid or missing parent session ID");\n      }\n      let _matchCount = 0, _matchedDir = "";\n      for (const _re of _fs.readdirSync(_runsDir)) {\n        const _f = _path.join(_runsDir, _re, "parent_session_id");\n        if (_fs.existsSync(_f) && _fs.readFileSync(_f, "utf8").trim() === parentContext.sessionID) {\n          _matchCount++;\n          _matchedDir = _path.join(_runsDir, _re);\n        }\n      }\n      if (_matchCount !== 1) {\n        throw new Error(`[GO_TASK_NATIVE_UI] run resolution failed: match_count=${_matchCount}, parent=${parentContext.sessionID}`);\n      }\n      _taskRunDir = _matchedDir;\n      _taskHoldOwner = __require("crypto").randomUUID();\n      _fs.mkdirSync(_path.join(_matchedDir, "attach_holds"), { recursive: true });\n      _fs.mkdirSync(_path.join(_matchedDir, "no_attach"), { recursive: true });\n      const _holdPath = _path.join(_matchedDir, "attach_holds", _taskHoldOwner + ".hold");\n      _fs.writeFileSync(_holdPath, "");\n      log2("[GO_TASK_NATIVE_UI] attach_hold created", { owner: _taskHoldOwner, runDir: _matchedDir });\n    }\n    const spawn5 = await reserveSyncSubagentSpawn(executorCtx, parentContext);\n    spawnReservation = spawn5.reservation;\n    const { spawnContext } = spawn5;\n    const createSessionResult = await deps.createSyncSession(client3, {\n      parentSessionID: parentContext.sessionID,\n      agentToUse,\n      description: args.description,\n      defaultDirectory: directory,\n      categoryModel\n    });',
    "B1:func"
)

patch(
    '    const sessionID = createSessionResult.sessionID;\n    spawnReservation?.commit();\n    syncSessionID = sessionID;',
    '    const sessionID = createSessionResult.sessionID;\n    spawnReservation?.commit();\n    syncSessionID = sessionID;\n    if (_taskRunDir && _taskHoldOwner && sessionID && typeof sessionID === "string" && sessionID.startsWith("ses_")) {\n      const _fs = __require("fs"), _path = __require("path");\n      const _holdPath = _path.join(_taskRunDir, "attach_holds", _taskHoldOwner + ".hold");\n      const _noAttachPath = _path.join(_taskRunDir, "no_attach", sessionID + ".marker");\n      try {\n        _fs.renameSync(_holdPath, _noAttachPath);\n        log2("[GO_TASK_NATIVE_UI] atomic transition hold\\u2192no_attach complete", { owner: _taskHoldOwner, childId: sessionID });\n      } catch (_renameErr) {\n        log2("[GO_TASK_NATIVE_UI] atomic rename FAILED, attempting fail-closed recovery", { error: String(_renameErr), childId: sessionID });\n        try {\n          if (typeof client3.session.abort === "function") {\n            await client3.session.abort({ path: { id: sessionID } }).catch(() => {});\n          }\n        } catch (_abortErr) {}\n        let _recoveryOk = false;\n        try {\n          const _wdDir = _path.join(_taskRunDir, "worker_done");\n          _fs.mkdirSync(_wdDir, { recursive: true });\n          _fs.writeFileSync(_path.join(_wdDir, sessionID), "");\n          _recoveryOk = true;\n          log2("[GO_TASK_NATIVE_UI] fail-closed: worker_done recovery written", { childId: sessionID });\n        } catch (_wdErr) {\n          log2("[GO_TASK_NATIVE_UI] FAIL-CLOSED: worker_done recovery also failed, retaining hold", { error: String(_wdErr), childId: sessionID });\n          _taskRetainHold = true;\n        }\n        if (_recoveryOk) {\n          throw new Error(`[GO_TASK_NATIVE_UI] no_attach publication failed, worker_done recovery applied for ${sessionID}`);\n        } else {\n          throw new Error(`[GO_TASK_NATIVE_UI] FAIL-CLOSED: no_attach and worker_done both failed for ${sessionID}`);\n        }\n      }\n    }',
    "B3:ren"
)

patch(
    '  } finally {\n    if (syncSessionID) {\n      cleanupSyncSessionSideEffects(syncSessionID, executorCtx);',
    '  } finally {\n    if (_taskRunDir && _taskHoldOwner && !_taskRetainHold) {\n      try {\n        const _fs = __require("fs"), _path = __require("path");\n        const _holdPath = _path.join(_taskRunDir, "attach_holds", _taskHoldOwner + ".hold");\n        if (_fs.existsSync(_holdPath)) _fs.unlinkSync(_holdPath);\n      } catch (_e) {}\n    }\n    if (syncSessionID) {\n      cleanupSyncSessionSideEffects(syncSessionID, executorCtx);',
    "B4:fin"
)

# PATCH C: task executeBackgroundTask (no_attach)
patch(
    'async function executeBackgroundTask(args, ctx, executorCtx, parentContext, agentToUse, categoryModel, systemContent, fallbackChain) {\n  const { manager } = executorCtx;\n  try {',
    'async function executeBackgroundTask(args, ctx, executorCtx, parentContext, agentToUse, categoryModel, systemContent, fallbackChain) {\n  const _GO_TASK_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;\n  const { manager } = executorCtx;\n  let _bgHoldOwner = null;\n  let _bgRunDir = null;\n  let _bgRetainHold = false;\n  try {\n    {\n      const _fs = __require("fs"), _path = __require("path"), _os = __require("os");\n      const _goSandbox = _path.join(_os.homedir(), ".opencode-best-team");\n      const _runsDir = _path.join(_goSandbox, "state", "runs");\n      if (!_fs.existsSync(_runsDir)) {\n        throw new Error("[GO_TASK_BG_NATIVE_UI] GO runs directory not found");\n      }\n      if (typeof parentContext.sessionID !== "string" || !parentContext.sessionID.startsWith("ses_")) {\n        throw new Error("[GO_TASK_BG_NATIVE_UI] invalid or missing parent session ID");\n      }\n      let _matchCount = 0, _matchedDir = "";\n      for (const _re of _fs.readdirSync(_runsDir)) {\n        const _f = _path.join(_runsDir, _re, "parent_session_id");\n        if (_fs.existsSync(_f) && _fs.readFileSync(_f, "utf8").trim() === parentContext.sessionID) {\n          _matchCount++;\n          _matchedDir = _path.join(_runsDir, _re);\n        }\n      }\n      if (_matchCount !== 1) {\n        throw new Error(`[GO_TASK_BG_NATIVE_UI] run resolution failed: match_count=${_matchCount}, parent=${parentContext.sessionID}`);\n      }\n      _bgRunDir = _matchedDir;\n      _bgHoldOwner = __require("crypto").randomUUID();\n      _fs.mkdirSync(_path.join(_matchedDir, "attach_holds"), { recursive: true });\n      _fs.mkdirSync(_path.join(_matchedDir, "no_attach"), { recursive: true });\n      const _holdPath = _path.join(_matchedDir, "attach_holds", _bgHoldOwner + ".hold");\n      _fs.writeFileSync(_holdPath, "");\n      log2("[GO_TASK_BG_NATIVE_UI] attach_hold created", { owner: _bgHoldOwner, runDir: _matchedDir });\n    }',
    "C1:func"
)

patch(
    '    if (sessionId) {\n      registerBackgroundSessionContext({',
    '    if (!sessionId) {\n      _bgRetainHold = true;\n      log2("[GO_TASK_BG_NATIVE_UI] FAIL-CLOSED: no valid sessionId after all resolution, retaining hold");\n      throw new Error("[GO_TASK_BG_NATIVE_UI] FAIL-CLOSED: no valid child session ID available, task may not have created a child session");\n    }\n    if (sessionId && _bgRunDir && _bgHoldOwner && typeof sessionId === "string" && sessionId.startsWith("ses_")) {\n      const _fs = __require("fs"), _path = __require("path");\n      const _holdPath = _path.join(_bgRunDir, "attach_holds", _bgHoldOwner + ".hold");\n      const _noAttachPath = _path.join(_bgRunDir, "no_attach", sessionId + ".marker");\n      try {\n        _fs.renameSync(_holdPath, _noAttachPath);\n        log2("[GO_TASK_BG_NATIVE_UI] atomic transition hold\\u2192no_attach complete", { owner: _bgHoldOwner, childId: sessionId });\n      } catch (_renameErr) {\n        log2("[GO_TASK_BG_NATIVE_UI] atomic rename FAILED, fail-closed recovery", { error: String(_renameErr), childId: sessionId });\n        try {\n          const _wdDir = _path.join(_bgRunDir, "worker_done");\n          _fs.mkdirSync(_wdDir, { recursive: true });\n          _fs.writeFileSync(_path.join(_wdDir, sessionId), "");\n          log2("[GO_TASK_BG_NATIVE_UI] worker_done recovery written", { childId: sessionId });\n        } catch (_wdErr) {\n          log2("[GO_TASK_BG_NATIVE_UI] FAIL-CLOSED: worker_done also failed, retaining hold", { error: String(_wdErr), childId: sessionId });\n          _bgRetainHold = true;\n        }\n        if (!_bgRetainHold) {\n          try { const _hp = _path.join(_bgRunDir, "attach_holds", _bgHoldOwner + ".hold"); if (_fs.existsSync(_hp)) _fs.unlinkSync(_hp); } catch (_e) {}\n          throw new Error(`[GO_TASK_BG_NATIVE_UI] no_attach publication failed, worker_done recovery applied for ${sessionId}`);\n        } else {\n          throw new Error(`[GO_TASK_BG_NATIVE_UI] FAIL-CLOSED: no_attach and worker_done both failed for ${sessionId}`);\n        }\n      }\n    }\n    if (sessionId) {\n      registerBackgroundSessionContext({',
    "C2:ren"
)

patch(
    '      category: args.category\n    });\n  }\n}',
    '      category: args.category\n    });\n  } finally {\n    if (_bgRunDir && _bgHoldOwner && !_bgRetainHold) {\n      try {\n        const _fs = __require("fs"), _path = __require("path");\n        const _holdPath = _path.join(_bgRunDir, "attach_holds", _bgHoldOwner + ".hold");\n        if (_fs.existsSync(_holdPath)) _fs.unlinkSync(_holdPath);\n      } catch (_e) {}\n    }\n  }\n}',
    "C3:fin"
)

# PATCH D: call_omo_agent executeBackground (no_attach — keep for safety, but fg-only enforced at schema)
patch(
    'async function executeBackground(args, toolContext, manager, client3, fallbackChain, model) {\n  try {\n    const messageDir = getMessageDir(toolContext.sessionID);',
    'async function executeBackground(args, toolContext, manager, client3, fallbackChain, model) {\n  const _GO_CALL_OMO_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1 = true;\n  let _callBgHoldOwner = null;\n  let _callBgRunDir = null;\n  let _callBgRetainHold = false;\n  try {\n    {\n      const _fs = __require("fs"), _path = __require("path"), _os = __require("os");\n      const _goSandbox = _path.join(_os.homedir(), ".opencode-best-team");\n      const _runsDir = _path.join(_goSandbox, "state", "runs");\n      if (!_fs.existsSync(_runsDir)) {\n        throw new Error("[GO_CALL_OMO_BG] GO runs directory not found");\n      }\n      if (typeof toolContext.sessionID !== "string" || !toolContext.sessionID.startsWith("ses_")) {\n        throw new Error("[GO_CALL_OMO_BG] invalid or missing parent session ID");\n      }\n      let _matchCount = 0, _matchedDir = "";\n      for (const _re of _fs.readdirSync(_runsDir)) {\n        const _f = _path.join(_runsDir, _re, "parent_session_id");\n        if (_fs.existsSync(_f) && _fs.readFileSync(_f, "utf8").trim() === toolContext.sessionID) {\n          _matchCount++;\n          _matchedDir = _path.join(_runsDir, _re);\n        }\n      }\n      if (_matchCount !== 1) {\n        throw new Error(`[GO_CALL_OMO_BG] run resolution failed: match_count=${_matchCount}, parent=${toolContext.sessionID}`);\n      }\n      _callBgRunDir = _matchedDir;\n      _callBgHoldOwner = __require("crypto").randomUUID();\n      _fs.mkdirSync(_path.join(_matchedDir, "attach_holds"), { recursive: true });\n      _fs.mkdirSync(_path.join(_matchedDir, "no_attach"), { recursive: true });\n      const _holdPath = _path.join(_matchedDir, "attach_holds", _callBgHoldOwner + ".hold");\n      _fs.writeFileSync(_holdPath, "");\n      log2("[GO_CALL_OMO_BG] attach_hold created", { owner: _callBgHoldOwner, runDir: _matchedDir });\n    }\n    const messageDir = getMessageDir(toolContext.sessionID);',
    "D1:func"
)

# D2: Anchor matches PRISTINE certified V2 (no hold logic present yet)
patch(
    '    await toolContext.metadata?.({\n      title: args.description,\n      metadata: { sessionId: sessionId ?? "pending" }\n    });\n    return `Background agent task launched successfully.',
    '      if (!sessionId && _callBgRunDir && _callBgHoldOwner) {\n        log2("[GO_CALL_OMO_BG] no sessionId resolved, retaining hold");\n        _callBgRetainHold = true;\n      }\n      if (sessionId && _callBgRunDir && _callBgHoldOwner && typeof sessionId === "string" && sessionId.startsWith("ses_")) {\n        const _fs = __require("fs"), _path = __require("path");\n        const _holdPath = _path.join(_callBgRunDir, "attach_holds", _callBgHoldOwner + ".hold");\n        const _noAttachPath = _path.join(_callBgRunDir, "no_attach", sessionId + ".marker");\n        try {\n          _fs.renameSync(_holdPath, _noAttachPath);\n          log2("[GO_CALL_OMO_BG] atomic transition hold\\u2192no_attach complete", { owner: _callBgHoldOwner, childId: sessionId });\n        } catch (_renameErr) {\n          _callBgRetainHold = true;\n          log2("[GO_CALL_OMO_BG] atomic rename FAILED, retaining hold", { error: String(_renameErr), childId: sessionId });\n          throw new Error(`[GO_CALL_OMO_BG] FAIL-CLOSED: rename failed for ${sessionId}, hold retained`);\n        }\n      }\n      await toolContext.metadata?.({\n      title: args.description,\n      metadata: { sessionId: sessionId ?? "pending" }\n    });\n    return `Background agent task launched successfully.',
    "D2:ren"
)

patch(
    '  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error);\n    return `Failed to launch background agent task: ${message}`;\n  }\n}',
    '  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error);\n    return `Failed to launch background agent task: ${message}`;\n  } finally {\n    if (_callBgRunDir && _callBgHoldOwner && !_callBgRetainHold) {\n      try {\n        const _fs = __require("fs"), _path = __require("path");\n        const _holdPath = _path.join(_callBgRunDir, "attach_holds", _callBgHoldOwner + ".hold");\n        if (_fs.existsSync(_holdPath)) _fs.unlinkSync(_holdPath);\n      } catch (_e) {}\n    }\n  }\n}',
    "D3:fin"
)

# PATCH E: call_omo_agent — remove run_in_background from schema and enforce fg-only
# E1: Replace schema to remove run_in_background and add fg-only description
patch(
    '      run_in_background: tool.schema.boolean().describe("REQUIRED. true: run asynchronously (use background_output to get results), false: run synchronously and wait for completion"),',
    '      run_in_background: tool.schema.boolean().optional().describe("DEPRECATED: always false. For background delegation use the task tool with run_in_background=true."),',
    "E1:desc"
)

# E2: In execute, reject run_in_background=true at schema level
patch(
    '      if (args.run_in_background) {\n        if (args.session_id) {\n          return `Error: session_id is not supported in background mode. Use run_in_background=false to continue an existing session.`;\n        }\n        return await executeBackground(args, toolCtx, backgroundManager, ctx.client, fallbackChain, resolvedModel);\n      }',
    '      if (args.run_in_background === true) {\n        return "Error: call_omo_agent background delegation is not supported. Use the task tool with run_in_background=true instead. The task tool provides native OpenCode UI clickability for background sessions.";\n      }',
    "E2:exec"
)

# E3: Update tool description
patch(
    'var CALL_OMO_AGENT_DESCRIPTION = `Spawn explore/librarian agent. run_in_background REQUIRED (true=async with task_id, false=sync).',
    'var CALL_OMO_AGENT_DESCRIPTION = `Spawn explore/librarian agent for FOREGROUND delegation only. For background delegation use the task tool with run_in_background=true.',
    "E3:desc"
)

# E4: Add fg_only sentinel
patch(
    '    async execute(args, toolContext) {\n      const toolCtx = toolContext;',
    '    async execute(args, toolContext) {\n      const _GO_CALL_OMO_FG_ONLY_V1 = true;\n      const toolCtx = toolContext;',
    "E4:sent"
)

# PATCH F: Grant task:allow to OpenCode-Builder (THE KEY FIX)
patch(
    '  params.config.permission = {\n    webfetch: "allow",\n    external_directory: "allow",\n    ...params.config.permission,\n    task: "deny"\n  };\n}',
    '  const _GO_BUILDER_TASK_ALLOW_V1 = true;\n  const _builderAgent = agentByKey(params.agentResult, "OpenCode-Builder", params.pluginConfig);\n  if (_builderAgent) {\n    _builderAgent.permission = { ..._builderAgent.permission, task: "allow" };\n  }\n  params.config.permission = {\n    webfetch: "allow",\n    external_directory: "allow",\n    ...params.config.permission,\n    task: "deny"\n  };\n}',
    "F1:build"
)

# Post-flight
for s, n in [("_GO_NATIVE_UI_NO_ATTACH_PATCH_V1", "Native-UI"), ("_GO_TASK_NATIVE_UI_NO_ATTACH_PATCH_V1", "Task"), ("_GO_TASK_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1", "BG Task"), ("_GO_CALL_OMO_BACKGROUND_NATIVE_UI_NO_ATTACH_PATCH_V1", "BG CallOmo")]:
    if src.count(s) != 1:
        print(f"ERROR: {n} sentinel count != 1", file=sys.stderr); sys.exit(1)
if src.count(FG_ONLY_SENTINEL) != 1:
    print(f"ERROR: FG_ONLY sentinel count != 1 (found {src.count(FG_ONLY_SENTINEL)})", file=sys.stderr); sys.exit(1)
if src.count(BUILDER_TASK_SENTINEL) != 1:
    print(f"ERROR: BUILDER_TASK sentinel count != 1 (found {src.count(BUILDER_TASK_SENTINEL)})", file=sys.stderr); sys.exit(1)
if OLD_V1_SENTINEL in src:
    print("ERROR: old V1 sentinel present", file=sys.stderr); sys.exit(1)
if src.count(BG_V2_SENTINEL) != 0:
    print("ERROR: V2 sentinel present — BEST uses router completion, not V2", file=sys.stderr); sys.exit(1)

with open(filepath, "w") as f:
    f.write(src)

print("PATCHED")
sys.exit(0)
