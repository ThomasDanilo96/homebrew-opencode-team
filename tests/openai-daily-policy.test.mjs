import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDailyProviderModel, dailyCost, dailyFanout, dailyModelIdentity, dailySearchDecision, dailyInvestigationLimits, DAILY_AGENT_MODELS, DAILY_PRICING, shouldStopDaily } from "../teams/daily/daily-policy.mjs";
import { admitDurableFanout, allowsDailyOrchestratorShell, backgroundDelegationAllowed, beginRequestCycle, admitDelegation, admitToolCall, canonicalDelegatedObjective, createGuardrailState, delegatedScopeIsBound, explicitlyConfirms, finishDelegation, GuardrailPolicyError, isStopText, objectiveIsBound, preserveChildGuardState, recoverRootRequestState, settleVerificationGateState, updateStopLatch, verificationGateDecision } from "../teams/openai/config/opencode/openai-guardrails.js";
import { summarizeDailyPackets } from "../teams/daily/bin/daily-report.mjs";
import { analyzeObjective, objectiveRequestsLocalCommit, routeDelegatedAgent, selectAuthoritativeObjective } from "../teams/openai/config/opencode/openai-routing.js";
import { OpenAIAuthorshipGuard } from "../teams/openai/config/opencode/openai-authorship-guard.js";
import { dailyRootMutationToolPolicy, latestUserObjective, localCommitPostcondition, OpenAITeamTools, resolveInitialObjectiveFromClient } from "../teams/openai/config/opencode/openai-team-tools.js";
import { resolveCodexModels } from "../teams/openai/config/opencode/codex-models.js";
import { postExecutionPolicy } from "../teams/openai/config/opencode/execution-policy.js";

test("Daily shell policy is bounded by the genuine objective", () => {
  const env = { OPENAI_DAILY_PROFILE: "1" };
  for (const command of ["printf ok", "test -f file", "node calculator.test.js", "ls", "build", "git status", "docker inspect app", "command -v ssh", "ssh -V"]) {
    assert.equal(allowsDailyOrchestratorShell("bash", command, "Inspect the repository", env), true, command);
  }
  assert.equal(allowsDailyOrchestratorShell("bash", "printf 'fixture' | patch -p0", "Inspect the repository", env), false);
  assert.equal(allowsDailyOrchestratorShell("bash", "apply_patch <<'PATCH'\n*** Update File: fixture\nPATCH", "Inspect the repository", env), false);
  assert.equal(allowsDailyOrchestratorShell("bash", "ssh host", "Inspect the repository", env), false);
  assert.equal(allowsDailyOrchestratorShell("bash", "git push", "Push the branch", env), false);
  assert.equal(allowsDailyOrchestratorShell("bash", "git push", "I explicitly confirm push", env), true);
  assert.equal(allowsDailyOrchestratorShell("bash", "rm file", "Do not delete anything", env), false);
  assert.equal(allowsDailyOrchestratorShell("bash", "rm file", "I explicitly confirm deletion", env), true);
  assert.equal(allowsDailyOrchestratorShell("bash", "printf ok", "Inspect", {}), false);
});


test("Daily commit requests are mutating and route through Codex without granting root Git mutation", () => {
  const objectives = [
    "Fai un commit delle modifiche attuali senza fare push.",
    "Committa le modifiche correnti, non fare push.",
    "Effettua il commit delle modifiche senza push.",
    "Esegui git commit per le modifiche correnti ma non fare push.",
    "Create a commit for the current changes and do not push.",
    "Commit the current changes but do not push.",
  ];

  for (const objective of objectives) {
    assert.equal(
      analyzeObjective(objective).classification,
      "MUTATING",
      objective,
    );

    const tools = dailyRootMutationToolPolicy({
      daily: true,
      agent: "openai_orchestrator",
      root: true,
      objective,
      tools: {
        task: true,
        read: true,
        bash: true,
        interactive_bash: true,
        edit: true,
        write: true,
      },
    });

    assert.equal(tools.task, true, objective);
    assert.equal(tools.read, false, objective);
    assert.equal(tools.bash, false, objective);
    assert.equal(tools.interactive_bash, false, objective);
    assert.equal(tools.edit, false, objective);
    assert.equal(tools.write, false, objective);
  }

  assert.equal(
    analyzeObjective("Inspect commit abc123 and explain what changed").classification,
    "READ_ONLY",
  );
});

test("Daily orchestrator shell never performs local Git repository mutations directly", () => {
  const env = { OPENAI_DAILY_PROFILE: "1" };
  const objective = "Fai un commit delle modifiche attuali senza fare push.";

  for (const command of [
    "git add .",
    "git add templates/customer.html",
    "git commit -m 'Fix copy'",
    "git commit --amend --no-edit",
    "git checkout other-branch",
    "git switch other-branch",
    "git reset HEAD file",
    "git restore file",
    "git clean -fd",
    "git merge feature",
    "git rebase main",
    "git cherry-pick abc123",
    "git revert abc123",
    "git rm file",
    "git mv old new",
    "git apply fix.patch",
    "git am patch.mbox",
    "git status && git commit -m 'Fix copy'",
  ]) {
    assert.equal(
      allowsDailyOrchestratorShell("bash", command, objective, env),
      false,
      command,
    );
  }

  for (const command of [
    "git status",
    "git status --short",
    "git diff",
    "git diff --check",
    "git log -5",
    "git branch --show-current",
  ]) {
    assert.equal(
      allowsDailyOrchestratorShell(
        "bash",
        command,
        "Inspect the repository",
        env,
      ),
      true,
      command,
    );
  }
});


test("Daily local commit intent respects explicit negation", () => {
  for (const objective of [
    "Crea un commit locale con tutte le modifiche correnti senza fare push.",
    "Committa le modifiche correnti, non fare push.",
    "Create a commit for the current changes and do not push.",
  ]) {
    assert.equal(
      objectiveRequestsLocalCommit(objective),
      true,
      objective,
    );
  }

  for (const objective of [
    "Non fare commit, limita la verifica al diff.",
    "Senza creare un commit, mostrami lo stato.",
    "Do not commit anything; inspect the changes only.",
    "Never run git commit; just inspect the repository.",
  ]) {
    assert.equal(
      objectiveRequestsLocalCommit(objective),
      false,
      objective,
    );
  }
});

test("local commit postcondition requires HEAD advancement and a clean final worktree", () => {
  const before = {
    valid: true,
    head: "a".repeat(40),
    dirty: true,
  };

  assert.deepEqual(
    localCommitPostcondition({
      requested: true,
      before,
      after: {
        valid: true,
        head: "b".repeat(40),
        dirty: false,
      },
    }),
    {
      ok: true,
      reason: "commit_created",
    },
  );

  assert.equal(
    localCommitPostcondition({
      requested: true,
      before,
      after: {
        valid: true,
        head: before.head,
        dirty: true,
      },
    }).reason,
    "head_not_advanced",
  );

  assert.equal(
    localCommitPostcondition({
      requested: true,
      before,
      after: {
        valid: true,
        head: "b".repeat(40),
        dirty: true,
      },
    }).reason,
    "worktree_dirty_after_commit",
  );

  assert.deepEqual(
    localCommitPostcondition({
      requested: true,
      before: {
        valid: true,
        head: before.head,
        dirty: false,
      },
      after: {
        valid: true,
        head: before.head,
        dirty: false,
      },
    }),
    {
      ok: true,
      reason: "nothing_to_commit",
    },
  );

  assert.equal(
    localCommitPostcondition({
      requested: true,
      before: {
        valid: true,
        head: before.head,
        dirty: false,
      },
      after: {
        valid: true,
        head: "b".repeat(40),
        dirty: false,
      },
    }).reason,
    "unexpected_commit_from_clean_worktree",
  );
});

test("mandatory tester gate allows only the exact tester task and blocks root shell", () => {
  const packetID = "a".repeat(64);
  const pending = { ...createGuardrailState(), pendingVerificationPacketID: packetID };
  assert.equal(verificationGateDecision(pending, "bash", "openai_orchestrator", "printf ok").reason, "MANDATORY_TESTER_GATE");
  assert.equal(verificationGateDecision(createGuardrailState(), "bash", "openai_orchestrator", "printf ok").allowed, true);
  assert.equal(verificationGateDecision(pending, "task", "tester", `verify test_task_id=${packetID}`).allowed, true);
  assert.equal(verificationGateDecision(pending, "bash", "tester", "node gated.test.js", true).allowed, true);
  assert.equal(verificationGateDecision(pending, "bash", "tester", "node gated.test.js").reason, "MANDATORY_TESTER_GATE");
  for (const [agent, prompt] of [["tester", "verify"], ["tester", `verify test_task_id=${"b".repeat(64)}`], ["specialist", `verify test_task_id=${packetID}`]]) {
    assert.equal(verificationGateDecision(pending, "task", agent, prompt).reason, "MANDATORY_TESTER_GATE");
  }
  assert.equal(verificationGateDecision({ ...pending, pendingTesterActive: true }, "task", "tester", `verify test_task_id=${packetID}`).reason, "TESTER_ALREADY_ACTIVE");
});

test("mandatory gate survives a root request cycle and admits only its exact reviewer after tester completion", () => {
  const packetID = "a".repeat(64);
  const pending = { ...createGuardrailState(), pendingVerificationPacketID: packetID };
  const cycled = beginRequestCycle(pending, "continue the implementation", 1);
  assert.equal(cycled.pendingVerificationPacketID, packetID);
  assert.equal(verificationGateDecision(cycled, "task", "codex_executor", "implement another change").reason, "MANDATORY_TESTER_GATE");
  assert.equal(verificationGateDecision(cycled, "task", "reviewer", `review review_task_id=${packetID}`).allowed, true);
  assert.equal(verificationGateDecision(cycled, "task", "reviewer", `review review_task_id=${"b".repeat(64)}`).reason, "MANDATORY_TESTER_GATE");
});

test("Daily template enables only orchestrator shell access and runtime forwards SSH vars conditionally", async () => {
  const template = await readFile(new URL("../teams/daily/opencode.jsonc.template", import.meta.url), "utf8");
  assert.match(template, /"bash": "allow"/);
  assert.match(template, /"interactive_bash": "allow"/);
  assert.match(template, /"bash": true/);
  assert.match(template, /"interactive_bash": true/);
  assert.match(template, /"edit": "deny"/);
  assert.match(template, /"write": "deny"/);
  assert.match(template, /"skill_mcp": "deny"/);
  assert.match(template, /CodeGraph remains unavailable in DAILY; browser work may load the Playwright skill/);
  assert.match(template, /"openai_run_codex": false/);
  assert.match(template, /NORMAL repository work is never direct: repository mutations must use exactly one codex_executor child first, and read-only repository objectives must use exactly one openai_explore child first/);
  assert.match(template, /do not launch a second repository child/);
  const premium = await readFile(new URL("../teams/openai/opencode.jsonc.template", import.meta.url), "utf8");
  assert.match(premium, /"bash": "deny"/);
  assert.match(premium, /"interactive_bash": "deny"/);
  assert.match(premium, /"skill_mcp": "deny"/);
  assert.match(premium, /CodeGraph remains unavailable in OPENAI; browser work may load the Playwright skill/);
  const runtime = await readFile(new URL("../core/bin/team-runtime", import.meta.url), "utf8");
  assert.match(runtime, /OPENCODE_AUTH_SOURCE OPENAI_CODEX_AUTH_SOURCE SSH_AUTH_SOCK SSH_AGENT_PID/);
  assert.match(runtime, /\[\s*"\$\{!auth_var\+x\}"\s*=\s*x\s*\]/);
});

test("Daily mutating root delegates to Codex before repository inspection", async () => {
  const template = await readFile(
    new URL("../teams/daily/opencode.jsonc.template", import.meta.url),
    "utf8",
  );

  assert.match(
    template,
    /For repository-mutating objectives, delegate immediately to codex_executor as your first operational tool call\./,
  );

  assert.match(
    template,
    /Do not inspect, read, glob, grep, search, use Serena, run shell commands, or write todos before that delegation\./,
  );
});

test("Daily root mutation tool policy allows only task and denies inspection, mutation, and Serena tools", () => {
  const tools = {
    task: false,
    openai_run_codex: true,
    read: true,
    glob: true,
    grep: true,
    bash: true,
    edit: true,
    write: true,
    todowrite: true,
    serena_find_symbol: true,
    serena_replace_symbol_body: true,
    webfetch: true,
  };
  const restricted = dailyRootMutationToolPolicy({
    daily: true,
    agent: "openai_orchestrator",
    root: true,
    objective: "Add multiply(a, b) to calculator.js",
    tools,
  });

  for (const name of Object.keys(tools)) {
    assert.equal(
      restricted[name],
      name === "task",
      `${name} must match the DAILY mutating-root policy`,
    );
  }

  assert.equal(restricted.task, true);
  assert.deepEqual(tools, {
    task: false,
    openai_run_codex: true,
    read: true,
    glob: true,
    grep: true,
    bash: true,
    edit: true,
    write: true,
    todowrite: true,
    serena_find_symbol: true,
    serena_replace_symbol_body: true,
    webfetch: true,
  });

  const emptyCatalog = dailyRootMutationToolPolicy({
    daily: true,
    agent: "openai_orchestrator",
    root: true,
    objective: "Add multiply(a, b) to calculator.js",
    tools: {},
  });

  assert.equal(emptyCatalog.task, true);

  for (const name of [
    "read",
    "glob",
    "grep",
    "bash",
    "interactive_bash",
    "apply_patch",
    "todowrite",
    "openai_run_codex",
    "openai_remote_read",
    "serena_initial_instructions",
    "serena_onboarding",
    "serena_find_symbol",
    "serena_search_for_pattern",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "multi_tool_use.parallel",
  ]) {
    assert.equal(
      emptyCatalog[name],
      false,
      `${name} must be explicitly disabled for a DAILY mutating root`,
    );
  }

  const sparseCatalog = dailyRootMutationToolPolicy({
    daily: true,
    agent: "openai_orchestrator",
    root: true,
    objective: "Add multiply(a, b) to calculator.js",
    tools: {
      task: false,
      strange_new_tool: true,
    },
  });

  assert.equal(sparseCatalog.task, true);
  assert.equal(sparseCatalog.strange_new_tool, false);
  assert.equal(sparseCatalog.read, false);
  assert.equal(sparseCatalog.bash, false);
  assert.equal(sparseCatalog.serena_initial_instructions, false);

  const withoutTask = { read: true, edit: true, webfetch: true };
  const withoutTaskRestricted = dailyRootMutationToolPolicy({
    daily: true,
    agent: "openai_orchestrator",
    root: true,
    objective: "Add multiply(a, b) to calculator.js",
    tools: withoutTask,
  });

  assert.equal(withoutTaskRestricted.task, true);
  assert.equal(withoutTaskRestricted.read, false);
  assert.equal(withoutTaskRestricted.edit, false);
  assert.equal(withoutTaskRestricted.webfetch, false);
  assert.equal(withoutTaskRestricted.bash, false);
  assert.equal(withoutTaskRestricted.serena_initial_instructions, false);
});

test("Daily chat.message hook applies fail-closed tools to a mutating root with an absent catalog", async () => {
  const previousDaily = process.env.OPENAI_DAILY_PROFILE;
  const previousRoot = process.env.OPENAI_TEAM_STATE_ROOT;

  process.env.OPENAI_DAILY_PROFILE = "1";
  process.env.OPENAI_TEAM_STATE_ROOT = await mkdtemp(join(tmpdir(), "daily-tool-hook-"));

  try {
    const objective = "Add multiply(a, b) to calculator.js";

    const client = {
      session: {
        get: async () => ({
          data: {
            id: "root-session",
            parentID: null,
          },
        }),
        messages: async () => ({
          data: [
            {
              info: {
                role: "user",
                agent: "openai_orchestrator",
              },
              parts: [
                {
                  type: "text",
                  text: objective,
                },
              ],
            },
          ],
        }),
      },
    };

    const plugin = await OpenAITeamTools({ client });

    const output = {
      message: {
        agent: "openai_orchestrator",
      },
      parts: [
        {
          type: "text",
          text: objective,
        },
      ],
    };

    await plugin["chat.message"](
      {
        sessionID: "root-session",
        agent: "openai_orchestrator",
      },
      output,
    );

    assert.equal(output.message.tools.task, true);

    for (const name of [
      "read",
      "glob",
      "grep",
      "bash",
      "interactive_bash",
      "apply_patch",
      "todowrite",
      "openai_run_codex",
      "openai_remote_read",
      "serena_initial_instructions",
      "serena_find_symbol",
    ]) {
      assert.equal(output.message.tools[name], false, name);
    }
  } finally {
    await rm(process.env.OPENAI_TEAM_STATE_ROOT, {
      recursive: true,
      force: true,
    });

    if (previousDaily === undefined) {
      delete process.env.OPENAI_DAILY_PROFILE;
    } else {
      process.env.OPENAI_DAILY_PROFILE = previousDaily;
    }

    if (previousRoot === undefined) {
      delete process.env.OPENAI_TEAM_STATE_ROOT;
    } else {
      process.env.OPENAI_TEAM_STATE_ROOT = previousRoot;
    }
  }
});

test("Daily root tool policy routes read-only roots through an OpenAI explorer child", () => {
  const tools = { task: false, read: true, edit: true, serena_find_symbol: true };
  const restricted = dailyRootMutationToolPolicy({ daily: true, agent: "openai_orchestrator", root: true, objective: "Inspect calculator.js", tools });
  assert.equal(restricted.task, true);
  assert.equal(restricted.read, false);
  assert.equal(restricted.edit, false);
  assert.equal(restricted.serena_find_symbol, false);

  for (const policy of [
    { daily: true, agent: "openai_orchestrator", root: false, objective: "Add multiply(a, b)" },
    { daily: false, agent: "openai_orchestrator", root: true, objective: "Add multiply(a, b)" },
    { daily: true, agent: "openai_explore", root: true, objective: "Add multiply(a, b)" },
  ]) assert.strictEqual(dailyRootMutationToolPolicy({ ...policy, tools }), tools);
});

test("Real Italian implementation objectives close the root surface before Codex", async () => {
  const objectives = [
    "Modifica il modulo campagne e aggiorna i flussi interessati.",
    "Nel modulo campagne deve essere possibile associare più account Ads allo stesso cliente e scegliere quale usare per ogni campagna.",
    "Nel dettaglio cliente deve comparire anche l'account Ads associato alla campagna e il flusso deve supportare più account per cliente.",
  ];

  for (const objective of objectives) {
    assert.equal(analyzeObjective(objective).classification, "MUTATING", objective);
    const tools = dailyRootMutationToolPolicy({
      daily: true,
      agent: "openai_orchestrator",
      root: true,
      objective,
      tools: { task: true, read: true, glob: true, grep: true, bash: true, edit: true },
    });
    assert.equal(tools.task, true, objective);
    for (const name of ["read", "glob", "grep", "bash", "edit"]) assert.equal(tools[name], false, `${name}: ${objective}`);
  }

  const readOnly = "Analizza come vengono collegati oggi clienti, campagne e Google Ads e spiegami il flusso senza modificare nulla.";
  assert.equal(analyzeObjective(readOnly).classification, "READ_ONLY");
  assert.equal(dailyRootMutationToolPolicy({
    daily: true,
    agent: "openai_orchestrator",
    root: true,
    objective: readOnly,
    tools: { task: true, read: true, glob: true },
  }).read, false);

  const negated = "Non modificare nulla e non implementare niente: mostrami soltanto come funziona.";
  assert.equal(analyzeObjective(negated).classification, "READ_ONLY");
});

test("Daily chat.message closes an unresolved root before objective recovery", async () => {
  const previousDaily = process.env.OPENAI_DAILY_PROFILE;
  const previousRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_DAILY_PROFILE = "1";
  process.env.OPENAI_TEAM_STATE_ROOT = await mkdtemp(join(tmpdir(), "daily-unresolved-root-"));

  try {
    const plugin = await OpenAITeamTools({
      client: {
        session: {
          get: async () => ({ data: { id: "root-session", parentID: null } }),
          messages: async () => ({ data: [] }),
        },
      },
    });
    const output = {
      message: { agent: "openai_orchestrator", tools: { task: true, read: true, glob: true, grep: true, bash: true, edit: true } },
      parts: [],
    };

    await plugin["chat.message"]({ sessionID: "root-session", agent: "openai_orchestrator" }, output);

    assert.equal(output.message.tools.task, true);
    for (const name of ["read", "glob", "grep", "bash", "edit"]) assert.equal(output.message.tools[name], false, name);
  } finally {
    await rm(process.env.OPENAI_TEAM_STATE_ROOT, { recursive: true, force: true });
    if (previousDaily === undefined) delete process.env.OPENAI_DAILY_PROFILE;
    else process.env.OPENAI_DAILY_PROFILE = previousDaily;
    if (previousRoot === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previousRoot;
  }
});

test("Daily and OpenAI templates expose Codex executor as a native subagent", async () => {
  for (const path of ["../teams/daily/opencode.jsonc.template", "../teams/openai/opencode.jsonc.template"]) {
    const template = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(template, /"codex_executor": \{[\s\S]*?"mode": "subagent"[\s\S]*?"tools": \{[\s\S]*?"openai_run_codex": true[\s\S]*?"read": false/);
  }
});

test("Daily uses OpenAI-only model tiers", () => {
  assert.equal(DAILY_AGENT_MODELS.openai_orchestrator, "openai/gpt-6-luna");
  assert.equal(DAILY_AGENT_MODELS.reviewer, "openai/gpt-6-terra");
  assert.equal(DAILY_AGENT_MODELS.reviewer_critical, "openai/gpt-6-sol");
  assert.ok(Object.values(DAILY_AGENT_MODELS).every((model) => model.startsWith("openai/")));
});

test("Explicit review gates remain required for low-risk mutations", () => {
  const policy = postExecutionPolicy({
    classification: "MUTATING",
    risk: "low",
    review_required: true,
    verification_evidence: [],
    codex_outcome: "success",
  });
  assert.deepEqual(policy.next_agents, ["reviewer", "tester"]);
  assert.equal(policy.reviewer_route, "reviewer");
});

test("Automatic reviewer prompts retain protocol target binding", () => {
  const parent = "Implement multiply in calculator.js and calculator.test.js and require a reviewer gate";
  const child = "Review completed work review_task_id=" + "a".repeat(64);
  assert.notEqual(canonicalDelegatedObjective(parent, child, { targetBound: true }), "");
});

test("Root authority survives sequential Explore completion before Codex admission", () => {
  const rootObjective = "Inspect the fixture, then add multiply(a, b) to calculator.js and calculator.test.js";
  const exploreObjective = "Inspect calculator.js and calculator.test.js read-only; do not edit files";
  const codexObjective = "Implement the requested change in the current fixture. You are the only implementation worker and MUST edit only these two files: calculator.js and calculator.test.js. Add multiply(a, b) to calculator.js, export it using the existing CommonJS style, and add one focused test assertion for multiplication to calculator.test.js matching the existing test style. Do not edit, create, delete, or rename any other files. Do not merely describe changes: make the edits. Do not run tests; a separate tester must run exactly node calculator.test.js. Return a concise summary of files changed.";
  let root = beginRequestCycle(undefined, rootObjective, 1, { OPENAI_DAILY_PROFILE: "1" });
  const explore = canonicalDelegatedObjective(rootObjective, exploreObjective);
  root = admitDelegation(root, explore);
  root = finishDelegation(root, false, explore);
  root = { ...root, limits: { ...root.limits, delegations: 2 } };

  const codex = canonicalDelegatedObjective(rootObjective, codexObjective);
  const returnedToRoot = {
    ...beginRequestCycle(root, codexObjective, 2, { OPENAI_DAILY_PROFILE: "1" }, { preserveVerificationGate: true }),
    authoritativeObjective: rootObjective,
  };
  returnedToRoot.limits = { ...returnedToRoot.limits, delegations: 2 };
  assert.equal(returnedToRoot.objective, codexObjective);
  assert.equal(returnedToRoot.authoritativeObjective, rootObjective);
  assert.equal(objectiveIsBound(returnedToRoot.objective, codex), false);
  assert.doesNotThrow(() => admitDelegation(returnedToRoot, codex));

  assert.throws(() => admitDelegation(returnedToRoot, canonicalDelegatedObjective(rootObjective, "Modify unrelated billing secrets")), /OBJECTIVE_UNBOUND/);
  assert.equal(canonicalDelegatedObjective("Inspect the fixture read-only", "Modify calculator.js"), "");
  assert.throws(() => admitDelegation(returnedToRoot, canonicalDelegatedObjective("Unrelated root objective", codexObjective)), /OBJECTIVE_UNBOUND/);
});

test("Daily provider boundary accepts only the frozen OpenAI model matrix", () => {
  assert.deepEqual(dailyModelIdentity("openai/gpt-6-luna"), { provider: "openai", model: "gpt-6-luna" });
  for (const model of ["openai/gpt-6-luna", "openai/gpt-6-terra", "openai/gpt-6-sol"]) {
    assert.doesNotThrow(() => assertDailyProviderModel({ model }));
  }
  for (const model of ["opencode-go/minimax-m3", "opencode-go/minimax-m2.7", "openai/minimax-m3", "openai/gpt-6-astra"]) {
    assert.throws(() => assertDailyProviderModel({ model }), /OPENAI_DAILY_(?:PROVIDER|MODEL)_FORBIDDEN/);
  }
  assert.throws(() => assertDailyProviderModel({ provider: "opencode-go", model: "gpt-6-luna" }), (error) => error.code === "OPENAI_DAILY_PROVIDER_FORBIDDEN");
});

test("Daily Codex fallback remains OpenAI-only and fails closed on forbidden models", () => {
  assert.deepEqual(resolveCodexModels("quick", {
    OPENAI_DAILY_PROFILE: "1",
    OPENAI_CODEX_QUICK_PRIMARY: "gpt-6-luna",
    OPENAI_CODEX_QUICK_FALLBACK: "gpt-6-terra",
  }), { profile: "quick", requested_model: "gpt-6-luna", fallback_model: "gpt-6-terra" });
  for (const forbidden of ["minimax-m3", "minimax-m2.7"]) {
    assert.throws(() => resolveCodexModels("quick", {
      OPENAI_DAILY_PROFILE: "1",
      OPENAI_CODEX_QUICK_PRIMARY: "gpt-6-luna",
      OPENAI_CODEX_QUICK_FALLBACK: forbidden,
    }), /OPENAI_DAILY_MODEL_FORBIDDEN/);
  }
});

test("Daily config loads OMO for browser skill routing without changing provider policy", async () => {
  const template = await readFile(new URL("../teams/daily/opencode.jsonc.template", import.meta.url), "utf8");
  assert.match(template, /@OMO_PLUGIN@/);
  assert.match(template, /enabled_providers": \["openai"\]/);
});

test("Daily fanout is bounded and complexity-aware", () => {
  assert.deepEqual([dailyFanout("TRIVIAL"), dailyFanout("NORMAL"), dailyFanout("COMPLEX"), dailyFanout("HEAVY"), dailyFanout("EXTREME")], [0, 1, 2, 3, 3]);
  assert.deepEqual(dailyInvestigationLimits("NORMAL"), { minutes: 8, toolCalls: 12 });
});

test("Daily durable fanout admits three unique lanes, rejects duplicates and a fourth", () => {
  const state = { daily: true, limits: { delegations: 3 } };
  const options = { parentSessionID: "root", rootObjectiveSHA: "root-sha" };
  const packets = [];
  for (const scope of ["architecture", "tests", "documentation"]) {
    assert.equal(admitDurableFanout(state, scope, packets, options).scope, scope);
    packets.push({ parent_session_id: "root", root_objective_sha256: "root-sha", agent: "openai_explore", delegation_scope: scope });
  }
  assert.throws(() => admitDurableFanout(state, "architecture rephrased", packets, options), /DUPLICATE_DELEGATION_SCOPE/);
  assert.throws(() => admitDurableFanout(state, "runtime", packets, options), /DELEGATION_LIMIT/);
});

test("Daily durable fanout retries only missing scopes and makes replay a no-op", () => {
  const state = { daily: true, limits: { delegations: 3 } };
  const options = { parentSessionID: "root", rootObjectiveSHA: "root-sha" };
  const packets = [
    { parent_session_id: "root", root_objective_sha256: "root-sha", agent: "openai_explore", delegation_scope: "architecture" },
    { parent_session_id: "root", root_objective_sha: "root-sha", agent: "openai_librarian", delegation_scope: "tests" },
  ];
  assert.equal(admitDurableFanout(state, "documentation", packets, options).remaining, 1);
  packets.push({ parent_session_id: "root", root_objective_sha256: "root-sha", agent: "openai_ops", delegation_scope: "documentation" });
  assert.throws(() => admitDurableFanout(state, "architecture", packets, options), /DUPLICATE_DELEGATION_SCOPE/);
  assert.throws(() => admitDurableFanout(state, "documentation", packets, options), /DUPLICATE_DELEGATION_SCOPE/);
});

test("Daily search policy rejects noisy discovery and duplicate evidence", () => {
  const seen = new Set();
  assert.equal(dailySearchDecision({ tool: "glob", args: { pattern: "**/*" }, seen }).reason, "ROOT_GLOB_STARSTAR");
  assert.equal(dailySearchDecision({ tool: "glob", args: { pattern: "**/*", path: "." }, seen }).reason, "ROOT_GLOB_STARSTAR");
  assert.equal(dailySearchDecision({ tool: "grep", args: { pattern: "animation", path: "core/lib" }, seen }).allowed, true);
  const repeated = dailySearchDecision({ tool: "grep", args: { pattern: "animation", path: "core/lib" }, seen: new Set(["grep:animation core/lib"]) });
  assert.equal(repeated.reason, "DUPLICATE_SEARCH");
  assert.equal(dailySearchDecision({ tool: "grep", args: { pattern: "version", path: "." }, seen }).reason, "UNTARGETED_REPOSITORY_SEARCH");
  assert.equal(dailySearchDecision({ tool: "grep", args: { pattern: "package-lock.json", path: "teams" }, seen }).reason, "PACKAGE_LOCK_NOISE");
  assert.equal(dailySearchDecision({ tool: "bash", args: { command: "strings /opt/homebrew/opt/opencode/bin/opencode" }, seen }).reason, "BINARY_STRINGS_SCAN");
});

test("Daily stop policy ends confirmatory research once evidence is sufficient", () => {
  assert.equal(shouldStopDaily({ answerSupported: true, remainingEvidence: "confirmatory" }), true);
  assert.equal(shouldStopDaily({ answerSupported: true, materialContradiction: true, remainingEvidence: "confirmatory" }), false);
  assert.equal(shouldStopDaily({ answerSupported: false, remainingEvidence: "confirmatory" }), false);
});

test("Daily trivial lookups stay direct and bounded", () => {
  const state = beginRequestCycle(undefined, "What model does DAILY use by default?", 0, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(analyzeObjective("What model does DAILY use by default?").complexity, "TRIVIAL");
  assert.equal(state.limits.delegations, 0);
  assert.equal(state.limits.toolCalls, 5);
});

test("Daily pricing is optional observability math", () => {
  assert.equal(dailyCost({ model: "gpt-6-luna", input: 4000, cached: 0, output: 1000 }), 0.002);
  assert.equal(dailyCost({ model: "unknown", input: 4000, cached: 0, output: 1000 }), null);
  assert.equal(DAILY_PRICING.effective_date, "2026-09-16");
});

test("Routing ignores explicitly negated mutations without hiding genuine mutations", () => {
	assert.equal(analyzeObjective("Add multiply(a,b) to the calculator").classification, "MUTATING");
	assert.equal(analyzeObjective("make edits to the calculator").classification, "MUTATING");
	assert.equal(analyzeObjective("run write operations on the calculator").classification, "MUTATING");
	assert.equal(analyzeObjective("write files for the calculator").classification, "MUTATING");
	assert.equal(analyzeObjective("Inspect the calculator and verify it defines add(a,b)").classification, "READ_ONLY");
	assert.equal(analyzeObjective("Inspect the calculator. Make no edits.").classification, "READ_ONLY");
	assert.equal(analyzeObjective("Inspect the calculator. No edits.").classification, "READ_ONLY");
	assert.equal(analyzeObjective("Inspect the calculator. Do not run any write operations.").classification, "READ_ONLY");
	assert.equal(analyzeObjective("Inspect the calculator. Do not perform any write operations.").classification, "READ_ONLY");
  assert.equal(analyzeObjective("Read only README.md line 3. Do not modify anything and do not call task.").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not analyze, modify the file").classification, "MUTATING");
  assert.equal(analyzeObjective("Do not modify or delete files; review them").classification, "READ_ONLY");
  assert.equal(analyzeObjective("Do not modify and delete files; review them").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not modify and then delete the file").classification, "MUTATING");
  assert.equal(analyzeObjective("Don’t modify files").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not ever modify files").classification, "READ_ONLY");
  assert.equal(analyzeObjective("do not modify files, but delete the file").classification, "MUTATING");
  assert.equal(analyzeObjective("do not modify files; then delete the file").classification, "MUTATING");
});


test("Natural Italian editing requests are classified as mutating and close the Daily root tool surface", () => {
  const objectives = [
    "Applica tutte le correzioni linguistiche individuate nei template.",
    "Apporta tutte le correzioni linguistiche individuate.",
    "Sistema gli errori grammaticali nei template.",
    "Sistemami tutti gli errori grammaticali nei template.",
    "Correggi gli accenti errati nei template.",
    "Aggiorna i testi dei template.",
    "Sostituisci le forme senza accento con quelle corrette.",
  ];

  for (const objective of objectives) {
    assert.equal(
      analyzeObjective(objective).classification,
      "MUTATING",
      objective,
    );

    const restricted = dailyRootMutationToolPolicy({
      daily: true,
      agent: "openai_orchestrator",
      root: true,
      objective,
      tools: {
        task: true,
        read: true,
        bash: true,
        apply_patch: true,
        edit: true,
        write: true,
      },
    });

    assert.equal(restricted.task, true, objective);
    assert.equal(restricted.read, false, objective);
    assert.equal(restricted.bash, false, objective);
    assert.equal(restricted.apply_patch, false, objective);
    assert.equal(restricted.edit, false, objective);
    assert.equal(restricted.write, false, objective);
  }
});

test("Italian and English mutation scopes bind across languages without widening authority", () => {
  const italianParent = `Esegui un test controllato sul repository corrente.

Aggiungi a calculator.js la funzione multiply(a, b).
Esportala insieme alle funzioni esistenti.

Poi modifica calculator.test.js per importare multiply
e aggiungi assert.equal(multiply(4, 5), 20).`;
  const englishChild = `Use the normal DAILY flow and modify only the current repository.

In calculator.js, add function multiply(a, b) and export it.

In calculator.test.js, import multiply and add
assert.equal(multiply(4, 5), 20).

Do not modify any other files.`;
  assert.equal(analyzeObjective(italianParent).classification, "MUTATING");
  assert.equal(analyzeObjective(englishChild).classification, "MUTATING");
  assert.notEqual(canonicalDelegatedObjective(italianParent, englishChild), "");
  assert.notEqual(canonicalDelegatedObjective(englishChild, italianParent), "");
  assert.equal(canonicalDelegatedObjective(italianParent, "modify unrelated billing secrets"), "");
});

test("Conditional, negated, and quoted STOP mentions do not latch while standalone commands do", () => {
  for (const text of ["Se fallisce, fermati", "Non fermarti", "Spiegami quando usare stop", "La parola è 'stop'"]) {
    assert.equal(isStopText(text), false, text);
    assert.equal(updateStopLatch({ stopped: false }, text).stopped, false, text);
  }
  for (const text of ["Fermati", "Stop", "Annulla", "Basta"]) {
    assert.equal(isStopText(text), true, text);
    assert.equal(updateStopLatch({ stopped: false }, text).stopped, true, text);
  }
});

test("Serena project activation is read-only for the authorship guard", async () => {
  const guard = await OpenAIAuthorshipGuard();
  await assert.doesNotReject(() => guard["tool.execute.before"]({
    agent: "openai_orchestrator", sessionID: "serena-read-only-test", tool: "serena_activate_project",
  }, { args: {} }));
});

test("Guardrail task denials are recorded without prompt contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "openai-policy-denial-"));
  const previous = process.env.OPENAI_TEAM_STATE_ROOT;
  process.env.OPENAI_TEAM_STATE_ROOT = root;
  try {
    const client = { session: {
      get: async () => ({ data: { id: "policy-root" } }),
      messages: async () => ({ data: [] }),
    } };
    const plugin = await OpenAITeamTools({ client, listWorkPackets: async () => [] });
    await assert.rejects(
      () => plugin["tool.execute.before"]({ tool: "task", sessionID: "policy-root", agent: "openai_orchestrator" }, { args: { prompt: "secret-token inspect unrelated repository" } }),
      /OBJECTIVE_UNBOUND/,
    );
    const log = await readFile(join(root, "logs", "authorship-guard.log"), "utf8");
    assert.match(log, /policy_denied session_id=policy-root agent=openai_orchestrator tool=task policy_reason=OBJECTIVE_UNBOUND decision=BLOCK/);
    assert.doesNotMatch(log, /secret-token|unrelated repository/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_TEAM_STATE_ROOT;
    else process.env.OPENAI_TEAM_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Child review wording cannot override an explicitly requested read-only agent", () => {
  assert.equal(routeDelegatedAgent("Inspect the fixture structure", "Review the fixture structure", "openai_explore").agent, "openai_explore");
  assert.equal(routeDelegatedAgent("Implement the fixture change", "Inspect the fixture first; do not edit files", "specialist").agent, "specialist");
  assert.deepEqual(routeDelegatedAgent("Implement the fixture change", "Inspect the fixture first; do not edit files", "codex_executor"), { classification: "READ_ONLY", agent: "specialist" });
  assert.equal(routeDelegatedAgent("Review the fixture structure", "Review the fixture structure", "openai_explore").agent, "reviewer");
  assert.equal(routeDelegatedAgent("Critical security review of the fixture", "Review the fixture structure", "openai_explore").agent, "reviewer_critical");
  assert.equal(routeDelegatedAgent("Inspect the fixture structure", "Review the fixture structure", "reviewer").agent, "reviewer");
  assert.equal(routeDelegatedAgent("Inspect the fixture structure", "Modify the fixture", "openai_explore").agent, "codex_executor");
});

test("Scoped no-modify constraints cannot downgrade delegated mutation work to read-only", () => {
  const parent = "Add multiply(a, b), export it consistently with the existing module style, add one focused test for multiplication, run the relevant test, and report what changed.";
  const child = "In /private/tmp/daily-autonomous-git.rqqJ9E, implement the user's request: add multiply(a, b) to calculator.js, export it consistently with existing CommonJS style, and add one focused multiplication assertion to calculator.test.js consistent with the existing direct Node test. Use the smallest change. Run the relevant test command (likely `node calculator.test.js`) and report the files changed and test result. You are authorized to edit these files; do not modify unrelated files.";

  assert.equal(analyzeObjective(child).classification, "MUTATING");
  assert.deepEqual(
    routeDelegatedAgent(parent, child, "codex_executor"),
    { classification: "MUTATING", agent: "codex_executor" },
  );
});

test("Exact live coding parent/task binding is bounded and routes mutation to Codex", () => {
  const parent = "Fix parser bug";
  const task = "Modify parser bug";
  const canonical = canonicalDelegatedObjective(parent, task);
  assert.notEqual(canonical, "");
  assert.equal(routeDelegatedAgent(parent, task, "openai_explore").agent, "codex_executor");
  assert.equal(canonicalDelegatedObjective(parent, "Modify parser billing"), "");
  assert.equal(canonicalDelegatedObjective("Fix parser", "Modify parser billing"), "");
  assert.equal(canonicalDelegatedObjective(parent, "Modify billing secrets"), "");
  assert.notEqual(canonicalDelegatedObjective("Read parser", "Read parser"), "");
});

test("Routing uses the current request objective instead of an older session turn", () => {
  assert.equal(selectAuthoritativeObjective("Inspect the fixture structure", "Review the old implementation"), "Inspect the fixture structure");
  assert.equal(selectAuthoritativeObjective("Review the current implementation", "Inspect the old fixture"), "Review the current implementation");
  assert.equal(routeDelegatedAgent(selectAuthoritativeObjective("Inspect the fixture", "Review the old implementation"), "Review the fixture", "openai_explore").agent, "openai_explore");
  assert.equal(routeDelegatedAgent(selectAuthoritativeObjective("Review the current implementation", "Inspect the old fixture"), "Inspect the implementation", "openai_explore").agent, "reviewer");
});

test("Delegated objectives retain exact root authority while preserving contained scopes", () => {
  const root = "Fix the parser and add regression tests";
  const child = "Update parser tests";
  const canonical = canonicalDelegatedObjective(root, child);
  assert.notEqual(canonical, child);
  assert.match(canonical, /Parent objective \(verbatim\):[\s\S]*Fix the parser and add regression tests/);
  assert.match(canonical, /Delegated scope:[\s\S]*update parser tests/);
  assert.equal(objectiveIsBound(root, canonical), true);
  assert.equal(canonicalDelegatedObjective(root, `${root}; update parser tests`), canonical);
  assert.equal(canonicalDelegatedObjective(root, canonical), canonical);
  assert.equal(canonicalDelegatedObjective("", child), "");
  assert.equal(canonicalDelegatedObjective(root, ""), "");
  assert.equal(delegatedScopeIsBound(root, "Inspect parser"), true);
  assert.equal(delegatedScopeIsBound(root, "delete unrelated billing code"), false);
  assert.equal(delegatedScopeIsBound("Review parser only; no edits", "Delete parser billing code"), false);
  assert.equal(delegatedScopeIsBound("Fix parser bug", "modify parser"), true);
  assert.equal(delegatedScopeIsBound("Modify calculator multiply behavior", "add multiply/calculator"), true);
  assert.equal(delegatedScopeIsBound("Fix parser bug", "Delete parser"), false);
  assert.equal(delegatedScopeIsBound("Modify calculator", "Delete calculator"), false);
  assert.equal(delegatedScopeIsBound("Confirm delete parser", "Delete parser"), true);
  assert.equal(explicitlyConfirms("确认删除解析器", "destructive"), true);
  assert.equal(explicitlyConfirms("Fix parser; yes, do not delete parser", "destructive"), false);
  assert.equal(explicitlyConfirms("Fix parser; I explicitly authorize deleting parser", "destructive"), true);
  assert.equal(explicitlyConfirms("Fix parser; confirm no delete parser", "destructive"), false);
  assert.equal(explicitlyConfirms("确认不要删除解析器", "destructive"), false);
  assert.equal(explicitlyConfirms("确认不删除解析器", "destructive"), false);
  assert.equal(explicitlyConfirms("confirm non eliminare parser", "destructive"), false);
  assert.equal(explicitlyConfirms("confirm no eliminar parser", "destructive"), false);
  assert.equal(delegatedScopeIsBound("Fix parser", "Delete parser"), false);
  assert.equal(canonicalDelegatedObjective(root, "delete unrelated billing code"), "");
  assert.equal(canonicalDelegatedObjective(root, "parser"), canonicalDelegatedObjective(root, "Parser"));
  assert.match(canonicalDelegatedObjective("Explore fixture exploration calculator multiply behavior", "fixture exploration"), /Delegated scope:\nfixture exploration$/);
  assert.match(canonicalDelegatedObjective("Modify calculator multiply behavior", "modify calculator multiply"), /Delegated scope:\nmodify calculator multiply$/);
  assert.equal(delegatedScopeIsBound("修复解析器错误", "解析器"), true);
  assert.equal(delegatedScopeIsBound("修复解析器错误", "删除计费代码"), false);
  assert.equal(canonicalDelegatedObjective("修复解析器错误", "解析器"), "Parent objective (verbatim):\n修复解析器错误\nDelegated scope:\n解析器");
  assert.equal(delegatedScopeIsBound("只审查解析器，不修改", "删除解析器"), false);
  assert.equal(delegatedScopeIsBound("修复解析器错误", "修改解析器"), true);
  assert.equal(delegatedScopeIsBound("Review parser only", "eliminar parser"), false);
  assert.equal(delegatedScopeIsBound("Read parser", "Read parser then eliminar billing"), false);
  assert.equal(delegatedScopeIsBound("Inspect calculator fixture", "Review calculator fixture"), true);
  assert.equal(delegatedScopeIsBound("Inspect calculator fixture", "Review calculator billing"), false);
});

test("Delegated scope token normalization ignores temp paths and binds calculator stems", () => {
  const parent = "Inspect this fixture and add multiply to calculator.js.";
  const captured = "Inspect /private/var/folders/ab/random-id/opencode/fixture/calculator.test.js and add multiply.";
  assert.equal(delegatedScopeIsBound(parent, captured), true);
  assert.equal(delegatedScopeIsBound("read calculator.js", "read calculator.test.js"), true);
  assert.equal(delegatedScopeIsBound("read calculator.js", "read /private/var/folders/random/opencode/notes.txt"), false);
  assert.equal(delegatedScopeIsBound("modify calculator.js", "modify /private/var/folders/random/opencode/notes.txt"), false);
});

test("Equivalent absolute path spellings share canonical delegated identity", () => {
  const parent = "Inspect fixture calculator.js and add multiply.";
  const posix = canonicalDelegatedObjective(parent, 'read /private/var/folders/one/opencode/fixture/calculator.test.js with multiply');
  const windows = canonicalDelegatedObjective(parent, 'read C:\\Users\\two\\opencode\\fixture\\calculator.test.js with multiply');
  assert.equal(posix, windows);
});

test("Quoted absolute paths with spaces are stripped as one path", () => {
  const parent = "Inspect fixture calculator.js and add multiply.";
  assert.equal(delegatedScopeIsBound(parent, 'read "/private/var/folders/random/opencode fixture/calculator.test.js" with multiply'), true);
  assert.equal(delegatedScopeIsBound(parent, 'read "C:\\Users\\random\\opencode fixture\\calculator.test.js" with multiply'), true);
  assert.equal(delegatedScopeIsBound("read billing secrets", "read billing secrets"), true);
  assert.equal(delegatedScopeIsBound("read billing secrets", "read calculator multiply"), false);
  assert.equal(delegatedScopeIsBound(parent, "read /private/var/folders/billing/random-id/opencode/notes.txt"), false);
});

test("Captured live calculator parent and child scopes remain canonically bound", () => {
  const parent = "Identify calculator.js, existing tests, package/test commands, conventions relevant to adding multiply. Do not edit files. Return concise findings with paths and recommended focused test location.";
  const child = "Identify calculator.js, existing tests, package/test commands, conventions relevant to adding multiply. Do not edit files. Return concise findings with paths and recommended focused test location: /private/var/folders/7k/9x3q8m2n0p1q2r3s4t5u6v7w8x9y0z/opencode-daily-cert.6aFpe3/fixture";
  const canonical = canonicalDelegatedObjective(parent, child);
  assert.notEqual(canonical, "");
  assert.equal(objectiveIsBound(parent, canonical), true);
});

test("Recovered Daily inspection scope remains bound without admitting unrelated domains", () => {
  const parent = "Delegate exactly one read-only subagent using openai_explore to inspect calculator.js. It must make no edits and return exactly the fixed sentinel DAILY_READONLY_CHILD_OK if calculator.js defines add(a, b) and exports add. Do not start any other child. Return the child's sentinel and nothing else.";
  const child = "Read-only inspection only. Inspect calculator.js in the workspace. If it defines add(a, b) and exports add, return exactly: DAILY_READONLY_CHILD_OK. Make no edits and return nothing else.";
  const canonical = canonicalDelegatedObjective(parent, child);
  assert.notEqual(canonical, "");
  assert.equal(objectiveIsBound(parent, canonical), true);
  assert.equal(canonicalDelegatedObjective(parent, "Read-only inspection only. Inspect billing secrets in the workspace."), "");
});

test("Second live parent and child inspection scope remains read-only and bound", () => {
	const parent = "Run one read-only agent using openai_explore to inspect calculator.js, write no operation, and otherwise include the reason, but do not edit files. Verify it defines add(a,b) and supports multiply.";
	const child = "Read-only inspection: run the agent to inspect calculator.js, write no operation, otherwise include the reason, but do not edit files; verify it defines add(a,b) and supports multiply.";
	assert.equal(analyzeObjective(child).classification, "READ_ONLY");
	assert.equal(routeDelegatedAgent(parent, child, "openai_explore").agent, "openai_explore");
	assert.notEqual(canonicalDelegatedObjective(parent, child), "");
	assert.equal(canonicalDelegatedObjective(parent, "Inspect unrelated billing secrets and include the reason"), "");
});

test("Third live root/task inspection ignores response formatting while routing explore", () => {
  const root = "Use one read-only openai_explore task to inspect calculator.js and verify it defines add(a,b) and exports add(a,b). Return exactly CALCULATOR_READONLY_OK and nothing else.";
  const child = "Inspect calculator.js and verify it defines add(a,b) and exports add(a,b). Otherwise return CALCULATOR_READONLY_OK and nothing else.";
  const canonical = canonicalDelegatedObjective(root, child);
  assert.notEqual(canonical, "");
  assert.equal(routeDelegatedAgent(root, child, "openai_explore").agent, "openai_explore");
  assert.equal(canonicalDelegatedObjective(root, "Inspect unrelated billing secrets. Return exactly CALCULATOR_READONLY_OK."), "");
});

test("Exact live Daily child prompt routes read-only inspection to openai_explore", () => {
  const root = "Delegate exactly one read-only subagent using openai_explore to inspect calculator.js. It must make no edits and return exactly the fixed sentinel DAILY_READONLY_CHILD_OK if calculator.js defines add(a, b) and exports add. Do not start any other child. Return the child's sentinel and nothing else.";
  const child = "Read-only inspection only. Inspect calculator.js in the workspace. If it defines add(a, b) and exports add, return exactly: DAILY_READONLY_CHILD_OK. Make no edits and return nothing else.";
  assert.equal(analyzeObjective(child).classification, "READ_ONLY");
  assert.equal(routeDelegatedAgent(root, child, "openai_explore").agent, "openai_explore");
});

test("Review protocol target binding excludes unrelated scope tokens", () => {
  const id = "a".repeat(64);
  const root = "Inspect parser fixtures";
  const protocol = `Review completed work review_task_id=${id}`;
  const critical = `Critical review findings verify result review_task_id=${id}`;
  assert.notEqual(canonicalDelegatedObjective(root, protocol, { targetBound: true }), "");
  assert.notEqual(canonicalDelegatedObjective(root, critical, { targetBound: true }), "");
  assert.equal(canonicalDelegatedObjective(root, `Review billing secrets review_task_id=${id}`, { targetBound: true }), "");
  assert.equal(canonicalDelegatedObjective(root, "Review completed work", { targetBound: true }), "");
});

test("Equivalent canonical scopes collide and the root is never omitted", () => {
  const root = "Fix parser slice tests";
  const first = canonicalDelegatedObjective(root, "slice tests");
  const second = canonicalDelegatedObjective(root, `${root}; slice tests`);
  assert.equal(first, second);
  assert.match(first, /^Parent objective \(verbatim\):\nFix parser slice tests\nDelegated scope:\nslice tests$/);
  const state = { ...beginRequestCycle(undefined, root, 1), limits: { ...beginRequestCycle(undefined, root, 1).limits, delegations: 2 } };
  const once = admitDelegation(state, first);
  assert.throws(() => admitDelegation({ ...once, activeDelegation: false, activeDelegations: 0 }, second), /DUPLICATE_DELEGATION_SCOPE/);
});

test("Reviewer authorization is evaluated against the root, not injected delegated text", () => {
  const root = "Audit the release parser";
  const delegated = canonicalDelegatedObjective(root, "Inspect release parser");
  const state = beginRequestCycle(undefined, root, 1);
  assert.doesNotThrow(() => admitDelegation(state, delegated, { review: true, explicitlyRequestedReview: /review|audit/i.test(root) }));
  assert.equal(objectiveIsBound(root, delegated), true);
});

test("Guardrail authority survives operational sequential cycles and terminal verification", () => {
  const user = beginRequestCycle(undefined, "Inspect the fixture", 1);
  const sequential = beginRequestCycle({ ...user, delegations: 1 }, "Review the fixture", 2, process.env, { preserveVerificationTerminal: true });
  assert.equal(sequential.objective, "Review the fixture");
  assert.equal(sequential.authoritativeObjective, "Inspect the fixture");
  assert.deepEqual(beginRequestCycle({ ...user, verificationTerminal: true }, "Review the fixture", 2, process.env, { preserveVerificationTerminal: true }), { ...user, verificationTerminal: true });
  const reviewed = beginRequestCycle(undefined, "Review the fixture", 3);
  assert.equal(reviewed.authoritativeObjective, "Review the fixture");
});

test("Objective recovery selects the latest root user message and safely follows resumed parents", async () => {
  const sessions = {
    root: { id: "root", parentID: null },
    child: { id: "child", parentID: "root" },
  };
  const messages = {
    root: [
      { info: { role: "user" }, parts: [{ type: "text", text: "Inspect the old fixture" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "Review the current fixture" }] },
    ],
    child: [{ info: { role: "user" }, parts: [{ type: "text", text: "Review synthetic child prompt" }] }],
  };
  const client = { session: {
    get: async ({ path: { id } }) => ({ data: sessions[id] }),
    messages: async ({ path: { id } }) => ({ data: messages[id] }),
  } };
  assert.equal(latestUserObjective(messages.root), "Review the current fixture");
  assert.equal(latestUserObjective({ messages: messages.root }), "Review the current fixture");
  const resolved = await resolveInitialObjectiveFromClient(client, "child");
  assert.deepEqual(resolved, { objective: "Review the current fixture", parentSessionID: "root", rootSessionID: "root" });
});

test("Objective recovery ignores an internal continuation prompt", async () => {
  const client = { session: {
    get: async () => ({ data: { id: "root", parentID: null } }),
    messages: async () => ({ data: [
      { info: { role: "user" }, parts: [{ type: "text", text: "Mutate the fixture" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "Resume the authoritative recovery packet for this same objective." }] },
    ] }),
  } };
  const resolved = await resolveInitialObjectiveFromClient(client, "root");
  assert.equal(resolved.objective, "Mutate the fixture");
});

test("Objective recovery falls back on lookup failure and breaks parent loops", async () => {
  const failing = { session: { get: async () => { throw new Error("unavailable"); }, messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "Review synthetic child" }] }] }) } };
  assert.equal(await resolveInitialObjectiveFromClient(failing, "child"), null);
  const loop = { session: { get: async ({ path: { id } }) => ({ data: { id, parentID: id === "a" ? "b" : "a" } }), messages: async ({ path: { id } }) => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: `Inspect ${id}` }] }] }) } };
  assert.equal(await resolveInitialObjectiveFromClient(loop, "a"), null);
  assert.equal(routeDelegatedAgent(null, "Review synthetic child", "openai_explore").agent, "openai_explore");
});

test("Objective recovery has fresh per-call root reads", async () => {
  let current = "Inspect the fixture";
  const client = { session: {
    get: async () => ({ data: { id: "root", parentID: null } }),
    messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: current }] }] }),
  } };
  assert.equal((await resolveInitialObjectiveFromClient(client, "root")).objective, "Inspect the fixture");
  current = "Review the fixture";
  assert.equal((await resolveInitialObjectiveFromClient(client, "root")).objective, "Review the fixture");
});

test("Synthetic child messages preserve the inherited guard without resuming it", () => {
  const root = { ...beginRequestCycle(undefined, "Inspect the fixture", 1), activeDelegation: true, activeDelegations: 1, toolCalls: 7, weightedUnits: 8, stopped: true, verificationTerminal: true };
  const child = preserveChildGuardState(beginRequestCycle(undefined, "Review synthetic child", 2), root, "Inspect the fixture");
  assert.equal(child.activeDelegation, true);
  assert.equal(child.activeDelegations, 1);
  assert.equal(child.toolCalls, 7);
  assert.equal(child.weightedUnits, 8);
  assert.equal(child.stopped, true);
  assert.equal(child.verificationTerminal, true);
  assert.equal(child.authoritativeObjective, "Inspect the fixture");
  assert.equal(child.stopped, true);
  assert.equal(updateStopLatch(beginRequestCycle({ ...root, verificationTerminal: false }, "Inspect the fixture", 3), "Continue", true).stopped, false);
});

test("Cold child state remains the local monotonic base", () => {
  const root = { ...beginRequestCycle(undefined, "Inspect the fixture", 1), stopped: false, authoritativeObjective: "Inspect the fixture" };
  const coldChild = { ...beginRequestCycle(undefined, "Review synthetic child", 2), stopped: true, budgetTerminal: true, toolCalls: 9, weightedUnits: 11, authoritativeObjective: null };
  const merged = preserveChildGuardState(coldChild, root, "Inspect the fixture");
  assert.equal(merged.stopped, true);
  assert.equal(merged.budgetTerminal, true);
  assert.equal(merged.toolCalls, 9);
  assert.equal(merged.weightedUnits, 11);
  assert.equal(merged.authoritativeObjective, "Inspect the fixture");
  const rootStopped = preserveChildGuardState({ ...coldChild, stopped: false }, { ...root, stopped: true }, "Inspect the fixture");
  assert.equal(rootStopped.stopped, true);
});

test("Cold child delegation marker is internally consistent", () => {
  const merged = preserveChildGuardState(
    { ...beginRequestCycle(undefined, "Inspect child", 1), activeDelegations: 0, activeDelegation: false },
    { ...beginRequestCycle(undefined, "Inspect root", 1), activeDelegations: 0, activeDelegation: false },
    "Inspect root",
  );
  assert.equal(merged.activeDelegations, 1);
  assert.equal(merged.activeDelegation, true);
  assert.throws(() => admitDelegation(merged, "Inspect root", { review: false }), /CONCURRENT_DELEGATION/);

  const normal = beginRequestCycle(undefined, "Inspect normally", 1);
  assert.equal(normal.activeDelegation, false);
  assert.equal(admitDelegation(normal, "Inspect normally").activeDelegation, true);
});

test("OpenCode path plugins expose ids on their default objects", async () => {
  for (const [file, id, server] of [
    ["../teams/openai/config/opencode/openai-team-tools.js", "openai-team-tools", "OpenAITeamTools"],
    ["../teams/openai/config/opencode/openai-authorship-guard.js", "openai-authorship-guard", "OpenAIAuthorshipGuard"],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, new RegExp(`export default \\{ id: "${id}", server: ${server} \\};`));
    assert.doesNotMatch(source, new RegExp(`export const id = "${id}"`));
  }
});

test("Daily guardrails allow bounded concurrent delegation", () => {
  const objective = "implement an architecture change";
  let state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(state.limits.delegations, 2);
  state = admitDelegation(state, `${objective}; slice architecture`);
  const duplicateState = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
  const duplicateOnce = admitDelegation(duplicateState, `${objective}; slice architecture`);
  assert.throws(() => admitDelegation(duplicateOnce, `${objective}; slice architecture`), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DUPLICATE_DELEGATION_SCOPE");
  state = admitDelegation(state, `${objective}; slice tests`);
  assert.equal(state.activeDelegations, 2);
  assert.throws(() => admitDelegation(state, `${objective}; slice tests`), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DELEGATION_LIMIT");
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 1);
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 0);
  state = finishDelegation(state);
  assert.equal(state.activeDelegations, 0);
});

test("Premium guardrails retain single active delegation", () => {
  let state = beginRequestCycle(undefined, "authorize long-running repository task", 0, {});
  state = admitDelegation(state, "authorize long-running repository task");
  assert.throws(() => admitDelegation(state, "authorize long-running repository task"), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_CONCURRENT_DELEGATION");
});

test("Background delegation is Daily-only", () => {
  assert.equal(backgroundDelegationAllowed({ OPENAI_DAILY_PROFILE: "1" }), true);
  assert.equal(backgroundDelegationAllowed({}), false);
});

test("Daily runtime maps every complexity to its policy fanout", () => {
  const cases = [
    ["rename one typo", 0],
    ["implement a small feature", 1],
    ["implement an architecture change", 2],
    ["implement a shared runtime change", 3],
    ["implement a cross-service change", 3],
  ];
  for (const [objective, expected] of cases) {
    const state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
    assert.equal(state.limits.delegations, expected);
    assert.equal(state.fanoutLimit, expected);
  }
});

test("Recovered Daily HEAVY root objective admits three delegations", () => {
  let state = recoverRootRequestState(createGuardrailState({}, 0), "implement a shared runtime change", 0, { OPENAI_DAILY_PROFILE: "1" });
  state = admitToolCall(state, "task", 1);
  assert.equal(state.limits.delegations, 3);
  for (let index = 0; index < 3; index += 1) state = admitDelegation(state, `implement a shared runtime change; slice-${index}`);
  assert.equal(state.delegations, 3);
  assert.throws(() => admitDelegation(state, "implement a shared runtime change; slice-3"), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DELEGATION_LIMIT");
});

test("Recovered Daily EXTREME root objective denies a fourth delegation", () => {
  let state = recoverRootRequestState(createGuardrailState({}, 0), "implement an end-to-end runtime recovery", 0, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(state.limits.delegations, 3);
  for (let index = 0; index < 3; index += 1) state = admitDelegation(state, `implement an end-to-end runtime recovery; slice-${index}`);
  assert.throws(() => admitDelegation(state, "implement an end-to-end runtime recovery; slice-3"), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DELEGATION_LIMIT");
});

test("Authorized reviewer may reuse the gated mutation scope", () => {
  const objective = "implement a shared runtime change";
  let state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
  state = admitDelegation(state, objective);
  assert.doesNotThrow(() => admitDelegation(state, objective, { review: true, explicitlyRequestedReview: true }));
});

test("mandatory critical reviewer keeps target binding separate from verdict instructions", () => {
  const parent = "implement a shared runtime authorship change";
  const taskID = "a".repeat(64);
  const bound = canonicalDelegatedObjective(parent, `Review completed work review_task_id=${taskID}`, { targetBound: true });
  assert.match(bound, new RegExp(`review_task_id=${taskID}`));
  assert.equal(canonicalDelegatedObjective(parent, `Review completed work review_task_id=${taskID}. Return APPROVE or REJECT as the terminal verdict, followed by concise findings.`, { targetBound: true }), "");
});

test("Late root recovery preserves consumed and terminal state", () => {
  const state = recoverRootRequestState({ ...createGuardrailState({}, 100), toolCalls: 9, weightedUnits: 12, delegations: 2, activeDelegations: 2, activeDelegation: true, delegationScopes: ["existing"], stopped: true, budgetTerminal: true, verificationTerminal: true }, "implement a shared runtime change", 200, { OPENAI_DAILY_PROFILE: "1" });
  assert.equal(state.startedAt, 100);
  assert.equal(state.toolCalls, 9);
  assert.equal(state.weightedUnits, 12);
  assert.equal(state.delegations, 2);
  assert.equal(state.activeDelegations, 2);
  assert.equal(state.activeDelegation, true);
  assert.deepEqual(state.delegationScopes, ["existing"]);
  assert.equal(state.limits.delegations, 3);
  assert.equal(state.stopped, true);
  assert.equal(state.budgetTerminal, true);
  assert.equal(state.verificationTerminal, true);
});

test("Recovered child guard stays active without starting a fresh budget", () => {
  const root = { ...beginRequestCycle(createGuardrailState(), "implement a shared runtime change", 10, { OPENAI_DAILY_PROFILE: "1" }), activeDelegations: 2, activeDelegation: true, toolCalls: 4, weightedUnits: 6 };
  const child = preserveChildGuardState(beginRequestCycle(createGuardrailState(), "child slice", 100, { OPENAI_DAILY_PROFILE: "1" }), root, "implement a shared runtime change");
  assert.equal(child.activeDelegation, true);
  assert.equal(child.startedAt, 10);
  assert.equal(child.toolCalls, 4);
  assert.equal(child.weightedUnits, 6);
});

test("Unresolved objective remains fail-closed without review or extra budget", () => {
  const state = createGuardrailState({}, 0);
  assert.equal(state.authoritativeObjective, null);
  assert.deepEqual(state.limits, { minutes: 15, toolCalls: 20, delegations: 1 });
  assert.throws(() => admitDelegation(state, "review the repository", { review: true }), /OBJECTIVE_UNBOUND/);
});

test("Recovered root objective leaves premium limits unchanged", () => {
  const state = beginRequestCycle(createGuardrailState(), "implement an architecture change", 0, {});
  assert.equal(state.limits.delegations, 2);
  assert.equal(state.limits.minutes, 45);
  assert.equal(state.limits.toolCalls, 50);
});

test("Daily admission stress keeps 1, 2, and 3 siblings bounded", () => {
  const objective = "implement a cross-service change";
  for (const target of [1, 2, 3]) {
    let state = beginRequestCycle(undefined, objective, 0, { OPENAI_DAILY_PROFILE: "1" });
    for (let index = 0; index < target; index += 1) state = admitDelegation(state, `${objective}; slice-${index}`);
    assert.equal(state.activeDelegations, target);
    assert.equal(state.delegations, target);
    if (target === 3) assert.throws(() => admitDelegation(state, `${objective}; slice-over-limit`), (error) => error instanceof GuardrailPolicyError && error.code === "OPENAI_GUARDRAIL_DELEGATION_LIMIT");
    for (let index = 0; index < target + 2; index += 1) state = finishDelegation(state);
    assert.equal(state.activeDelegations, 0);
    assert.equal(state.delegationScopes.length, 0);
  }
});

test("Daily report accounts for cached and uncached work-packet tokens once", () => {
  const report = summarizeDailyPackets([
    { outcome: "completed", parent_session_id: "parent-1", executed_model: "gpt-6-luna", complexity: "NORMAL", duration_ms: 100, codex_input_tokens: 1000, codex_cached_input_tokens: 200, codex_output_tokens: 300, codex_reasoning_tokens: 40, retry_count: 1, compaction_count: 2 },
    { outcome: "completed", parent_session_id: "parent-1", executed_model: "gpt-6-terra", complexity: "COMPLEX", duration_ms: 200, codex_input_tokens: 500, codex_cached_input_tokens: 100, codex_output_tokens: 100, codex_reasoning_tokens: 10, retry_count: 0, compaction_count: 0 },
  ]);
  assert.equal(report.completed_tasks, 2);
  assert.equal(report.uncached_input_tokens, 1200);
  assert.equal(report.cached_input_tokens, 300);
  assert.equal(report.output_tokens, 400);
  assert.equal(report.reasoning_tokens, 50);
  assert.equal(report.cache_ratio_pct, 20);
  assert.equal(report.avg_subagents, 2);
  assert.equal(report.max_subagents, 2);
  assert.equal(report.sol_escalation_count, 0);
  assert.equal(report.p50_duration_ms, 100);
  assert.equal(report.p95_duration_ms, 200);
  assert.equal(report.by_model.Luna.completed_tasks, 1);
  assert.equal(report.by_complexity.COMPLEX.completed_tasks, 1);
});
