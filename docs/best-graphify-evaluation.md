# Graphify local AST evaluation — 2026-10-26

## Decision

**Keep installed OpenCode Team 0.3.4. Do not integrate or release Graphify.**
The isolated trial works, but does not establish a net benefit over Serena on
this small workload. This is not evidence that Graphify cannot help larger repos.
No model, reasoning, provider, permission, delegation, scanner, MCP or profile
configuration was changed. No application repository or real GIAFFATTO was used.
The only tracked deliverable is this report; the pre-existing untracked
`docs/best-quota-abc-evaluation.md` was left alone.

## Baseline, safety and official syntax

- Installed Homebrew Team: **0.3.4**, native **2.1.0-retention.1**, Serena **1.7.0**.
  `VERSION` and the formula agree; README's 0.3.3 label is stale, not the baseline.
- Official PyPI package **graphifyy 0.9.95**, installed without extras in a disposable
  Python 3.13 venv, not a global uv tool. Django **5.2.16** is test-only.
- Official source default branch is **v8**. The old `main` README is not the current
  installation reference. Sources: [current README](https://github.com/Graphify-Labs/graphify/tree/v8),
  [extract reference](https://docs.graphify.com/reference/extract), package CLI help.
- Verified AST-only command:
  `GRAPHIFY_BACKEND=none graphify extract PATH --code-only --no-cluster --max-workers 1`.
  `GRAPHIFY_OUT=/absolute/per-repository/index` selects external persistent output.
  Repeating this command uses the manifest to extract only changed files.
- `graphify update PATH --no-cluster` also refreshed the AST correctly, but scans
  the corpus and can reuse AST cache: it is not the demonstrated differential path.
- No Graphify Cloud/trial, semantic backend, embeddings, model extras, API keys,
  remote media processing, Graphify MCP, hook, watcher or daemon was enabled.
  AST commands used a clean environment, disabled backend/auto-refresh/query log,
  disposable HOME and a Python socket audit guard. This guard is **not** an OS
  network/filesystem sandbox and does not constrain arbitrary native subprocesses.
- Twelve existing config/instruction files were backed up before experimentation;
  their hashes, mtimes and modes were unchanged afterward, including sampled
  classic/FREE/BEST files. Credentials and historical sessions were not copied or
  inspected. The two benchmark sessions are new native records in BEST storage;
  native account refresh behavior was not independently audited.

## Local results

Disposable synthetic Django source fixture: four Python files, a form, two pricing
functions and two unittest tests; A/B copies have identical source hashes. This
is not a representative production Django repository or a database-backed test.

- Initial extraction: **15 nodes / 23 edges**, **1.192 s** wall time, exit 0.
- `explain invoice_total`, `explain InvoiceForm`, scoped import query and path
  lookup succeeded. The undirected path includes containment/import edges; it is
  not evidence of a call chain or runtime behavior.
- Changed the form from `invoice_total` to `discounted_total`, adjusting its test.
  Refresh: **0.943 s**. Assertions verified the new `calls` edge and absence of the
  old one. Both tests passed before/after; new total is `Decimal('109.8000')`.
- Additional differential extraction tests changed only `billing/pricing.py`:
  helper addition **0.823 s**, rename **0.696 s**, removal **0.629 s**. Each reported
  **one changed / three unchanged** code files. Assertions checked new call edges
  and removed obsolete nodes/edges. No-change extraction: **0.670 s**, outputs
  explicitly left untouched. Original source content was restored.
- Clean regeneration produced identical node/edge **multisets**. An initial
  list-order comparison failed: serialization order differs, not graph contents.
- Synthetic `.venv`, `node_modules`, cache, media, generated and secrets canaries
  were excluded using `.graphifyignore`; SQL/database/env artifacts were excluded;
  a Markdown document was skipped by `--code-only`. None entered the graph.

## Native BEST A/B smoke benchmark

One sequential pair, A then B; same installed BEST Build/model/reasoning defaults,
prompt, Python sources, tests and correctness criteria. B alone gained a temporary
project-scoped copy of the **official OpenCode skill and its references**, plus an
existing external graph and isolated CLI. No official installer was executed.
The prompt requested a bounded existing-graph query followed by Serena verification.
No fanout or model strategy change was introduced.

| Metric | A: Serena | B: Graphify + Serena |
| --- | ---: | ---: |
| Input tokens | 93,792 | 106,207 |
| Output tokens | 710 | 810 |
| Reasoning tokens, separate | 11 | 0 |
| Cache-read tokens, separate | 400,896 | 315,136 |
| Cache-write tokens | 0 | 0 |
| OpenAI native assistant/model records | 10 | 7 |
| Go native assistant/model records | 0 | 0 |
| End-to-end wall seconds | 66.775 | 70.355 |
| Distinct source files with bodies inspected | 3 | 3 |
| Serena body-returning tool calls | 4 | 3 |
| Whole-source `read` calls | 0 | 0 |
| Runtime tests passed | 2/2 | 2/2 |
| Correct answers / tool errors / exit code | yes / 0 / 0 | yes / 0 / 0 |

Both exports identify only `openai/gpt-6.1-sol`. Metrics come from complete native
exports of **these new sessions**, including the final answer; streaming
`step_finish` events alone omitted the final response usage. Request counts mean
exported assistant/model records, not independently observed transport requests,
hidden retries or unrelated service activity. Native reported cost is zero;
this does not make subscription allowance consumption zero.

B loaded the official skill, ran a bounded graph query (14/15 nodes on this tiny
fixture), then used Serena bodies/references and executed the tests. Thus the
query-first path was actually exercised, not inferred from configuration.
Serena activation created `.serena` metadata in both disposable copies despite
the read-only task wording; source hashes stayed unchanged.

**Input +13.24%, output +14.08%, cache-read −21.39%; fewer model steps but slightly
slower, with the same three source files inspected.** Do not combine cache/input
into an invented subscription cost or claim a general saving. Fixed order, cold
skill loading, small synthetic corpus and one run preclude statistical conclusions.
Index construction is measured separately above, not included in B's query latency.
AST construction consumes zero LLM tokens; agents interpreting results do not.

## Disk, compatibility and review

- Final main index: **32,544 logical bytes / 65,536 allocated bytes**, 13 files.
  Benchmark B index: **27,651 / 57,344 bytes**, 11 files. No wiki/Obsidian/source
  copies were generated by Graphify. Indices are outside Git and regenerable.
- Measured Graphify + mandatory package payload: **113,310,027 bytes**; test-only
  Django packages: **23,642,946 bytes**. Entire venv: **137,458,351 logical /
  151,654,400 allocated bytes**. No dependency cache was requested during install.
  AST cache entries accumulate; no permanent disk-cap/retention policy was deployed.
  `disk-metrics.json` is an earlier snapshot; final per-path sizes are recorded in
  `disk-final-before-cleanup.json`. After review, only the disposable venv was
  removed, reclaiming its 151,654,400 allocated bytes. Retained trial evidence
  measured 709,242 logical / 1,105,920 allocated bytes before writing the cleanup
  receipt. Graphify is **not installed permanently**; scripts require recreating
  the venv from the saved `trial-requirements.txt` to run again.
- Independent Reviewer: **Request changes for promotion**, not approval to release.
  Official non-project OpenCode installation targets global config and installs a
  plugin; normal CLI calls can auto-refresh existing skills/plugins. Both conflict
  with a naive BEST-only integration. The trial avoided the installer and disabled
  auto-refresh. No shim/plugin is proposed for the installed profile.
- The official full skill also contains installation, semantic/media, delegation,
  feedback-write and interpreter-discovery workflows outside this mandate. The
  trial wrapper lacks `.graphify_python`; its explicit CLI query succeeded without
  using that fallback. This validates the narrow query path, **not** an unmodified
  full-skill installation. Metadata/read-only compatibility would need resolution
  before any future promotion; do not treat this trial as a deployable integration.
- Reviewer-requested differential add/rename/remove/no-op and clean-rebuild checks
  were completed after the initial review. Network isolation and benchmark limits
  are qualified above rather than overstated.

## Verification and disposition

- `opencode-team doctor`: exit 0 on installed 0.3.4; does not test auth/models.
- `brew test opencode-team`: exit 0, including installed setup smoke. Homebrew
  automatically refreshed its own Ruby test-tool dependencies during this command;
  no OpenCode package upgrade was requested.
- `node --test tests/*.test.mjs`: **34 passed, 2 optional skipped, 0 failed**, exit 0.
- Fixture tests and AST/query/incremental assertions passed as detailed above.
- Build/types/lint/coverage/security scanner suites: not run; no product code changed
  and no new application API/input boundary was introduced. No coverage claim.
- No setup against real profiles, PR, Actions, new tag, formula change, release or
  Homebrew upgrade: the benefit/promotion gate did not pass. Installed BEST remains
  **0.3.4**; FREE and classic configuration files checked remain unchanged.

Temporary evidence and protected backup root:
`/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/graphify-best-ZRA4UT`.
Contains CLI timings/stdout, A/B transcripts and new-session exports, source hashes,
`benchmark-metrics.json`, disk metrics and isolation checks. These are local trial
artifacts, not a shipped benchmark runtime or permanent Graphify integration.
