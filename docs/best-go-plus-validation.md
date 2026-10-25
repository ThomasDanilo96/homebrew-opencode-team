# BEST Go Plus candidate — 2026-10-25

## Scope and decision

Based on stable Team 0.3.3. Change only General to
`opencode-go/longcat-2.0` and Title to `openai/gpt-6-luna#low`.
Build remains Sol Low, Specialist/Reviewer Sol Medium, Explore MiMo V2.6 Flash.
Summary and compaction retain MiniMax M3, independently of the General override.
No router, hook, plugin, permission change or pay-as-you-go fallback is added.

Luna's direct summary probe preserves the exact constraints, but that does not
establish native Summary-role execution. Historical Economy D's native Luna
compaction omitted the exact minimum and precision parameters. Do not replace
the continuity model on the strength of a short prompted summary.

## One candidate, historical controls reused

No A/B/C/D reruns. Reuse the A baseline in `best-quota-abc-evaluation.md` and
the retained Economy D evidence. One structured candidate uses the same frozen
Django forms/tests, with an added explicit security/continuity requirement.
Four initial concurrent native foreground calls: two LongCat writers, Explore,
Specialist; then independent Reviewer. Build owns integration. Two native
continuations address missing RED reporting and an evidenced Ruff import error;
neither is a blind retry or replacement worker. No required work remains active.

Evidence is retained privately in the temporary directory
`/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/best-sustainable-O5bkHy`.
Do not publish its raw catalog, session lists, server password or exports.
Configuration/state/cache are isolated; existing BEST subscription storage is
used through native OpenCode, without copying or manually changing credentials
or historical sessions. New experimental sessions are stored there normally.

The structured run uses stock OpenCode 2.1.0. The installed ordinary launcher
resolves an existing `2.1.0-retention.1` binary; it is not changed. Isolated setup,
doctor and `best --help` additionally exercise that ordinary launcher. This is
not a second coding benchmark against the locally modified runtime.

## Consumption (reported model steps, not hidden transport requests)

Structured task only; maintenance below is separate. Cache-write is zero.

| Provider/run | Requests | Input | Output | Reasoning | Cache-read |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenAI historical A | 19 | 216,125 | 2,307 | 137 | 724,864 |
| OpenAI candidate | 24 | 207,980 | 2,585 | 178 | 1,051,648 |
| Go historical A | 25 | 135,882 | 4,024 | 190 | 1,167,893 |
| Go candidate | 32 | 271,681 | 6,027 | 6,508 | 1,453,184 |

Candidate LongCat writers: 21 requests, 209,895 input, 3,680 output, 3,531
reasoning, 947,712 cache-read, **$0.077307972** Go equivalent. Explore:
11 requests, 61,786 input, 2,347 output, 2,977 reasoning, 505,472 cache-read,
**$0.011556082** equivalent. Build/Specialist/Reviewer: 14/5/5 requests.

| Structured-task Go metric | Historical A | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Dollar equivalent | $0.101152228 | $0.088864054 | 12.1% |
| Nominal monthly allowance burden | 0.056929% | 0.041842% | 26.5% |
| Writers only, nominal burden | 0.054730% | 0.032212% | 41.1% |

Formula and rates match the historical method and published Go Plus table
retrieved 2026-10-25: input/output/cache-read per million are LongCat
0.30/1.20/0.006, M3 0.30/1.20/0.06, MiMo 0.14/0.28/0.0028. Reasoning counts
with output; allowances are $240/$180/$120 respectively. Sum equivalent divided
by each model's allowance. Native reported cost matches these calculations.
Exports do not expose an observed account balance or `opencode.allowance` field.

OpenAI input falls 3.8%, but output rises 12.1%, reasoning 29.9% and cache-read
45.1%. OpenAI native cost zero is not free allowance. This is a reduction of
normalized Go burden, **not** proven overall subscription savings or a guarantee
that $40 covers a month of intense work. More requests/tokens were used; the
benefit comes from model/cache weighting, not demonstrated fewer requests.

Native parent creation-to-idle: **559.092 s**, versus A's 285.442 s active CLI
time (different timing definitions). The foreground client timed out at 360 s
(exit 124); a native wait completed with exit 0, without another model prompt.
This latency increase is substantial, not a modest or proven model-only effect.
No exported assistant retry fields; unreported transport retries remain unknown.
Explore's verbose discovery remains a limitation despite concise instructions.

## Continuity and maintenance, separately measured

- OpenAI Luna Low direct summary plus post-compaction recall: two requests,
  48,161 input, 364 output, zero reasoning, 46,592 cache-read.
- Native compaction actually selected **Go MiniMax M3**: one request, 50,018
  input, 375 output, 128 cache-read, $0.015463080 equivalent, 0.008591% nominal
  monthly burden. The configured Summary agent was Luna during this isolated
  probe; the compaction metadata nevertheless records M3, demonstrating distinct
  roles. The shipped Summary assignment remains unchanged because its native
  execution path was not established.
- Both the native compaction text and no-tools post-compaction recall retain
  `Decimal("0.01")`, `max_digits=8`, `decimal_places=2`, public form/error
  contracts, no untrusted-input execution/credential/network access, read-only
  Reviewer, writer ownership, and all pending checks. No pending task is falsely
  marked complete. Default recent-tail retention remains enabled; not a claim
  of lossless long-context compaction.
- The runtime registers hidden Title/Summary/Compaction model assignments;
  the Luna probe receives an automatic title. Transient title usage/model billing
  is not separately exposed in session exports and is not invented here.
- Catalog confirms the exact OpenAI/Go IDs and Low/Medium variants. Native
  completions verify existing subscription access for all used models. No login,
  balance fallback or authentication changes were performed.

## Verification evidence

- Configuration TDD: three focused tests RED exit 1, then GREEN exit 0.
- Candidate: full RED exit 1 (nine failures), focused writer RED then GREEN;
  Article's RED shell pipeline masks the outer status, but actual unittest output
  records four failures. No synthetic successful RED status is claimed.
- Writer tool inputs show exclusive ownership of `invoice.py` / `article.py`.
  Frozen tests remain unchanged. Native Reviewer PASS; final full suite four
  tests exit 0 and final Ruff exit 0 after import-spacing correction.
- No permission prompt or model override in the structured mandate. Serena and
  relevant ECC skills execute natively. Playwright, Context7 skills and ECC pin
  are unchanged, not unnecessarily rerun for this configuration-only change.
- Isolated real setup, doctor and ordinary launcher help: exit 0. Configuration
  comparison preserves permissions, policies, providers, MCP and skills, allowing
  only the expected temporary Serena state and source installation paths.
- Full Node invocation initially exceeded its 300-second host timeout; this is
  not PASS. Focused rerun of the cancelled native-profile file with adequate
  timeout: 26 passed, one optional native-permission test skipped, exit 0.
  Other completed files: five fixture tests and three packaging tests passed;
  optional old-fixture native-export test skipped. No tests weakened or deleted.
- `node --check shared/profiles.mjs` and `git diff --check`: exit 0.

## Publication gates

- Source PR: https://github.com/ThomasDanilo96/homebrew-opencode-team/pull/9
- Phase A staging/install/test: PASS, run
  https://github.com/ThomasDanilo96/homebrew-opencode-team/actions/runs/40187255748
- Immutable tag `v0.3.4`: `2c0de4553a6cd392ace92ad241b16913c3b76628`.
- Phase B official archive/install/test: PASS, run
  https://github.com/ThomasDanilo96/homebrew-opencode-team/actions/runs/40187512572
- Official archive SHA-256:
  `47bdbeeca4451af507613ff90bbcfd23c8b0066bc758b811d85dc03cc53c3bab`.

The formula update is separate from the immutable source tag. Stable clean-install
and guarded release publication must succeed before claiming deployment complete.
Live publication status: https://github.com/ThomasDanilo96/homebrew-opencode-team/releases/tag/v0.3.4
