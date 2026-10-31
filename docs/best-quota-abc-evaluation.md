# BEST A/B/C quota evaluation — 2026-10-23

## Decision

**Do not release or change installed BEST 0.3.3.** C is the only unattended
structured-task completion within the deadline, not a demonstrated winner on
both subscriptions. It used more OpenAI tokens than A. LongCat used less
normalized Go allowance than Flash despite costing more nominal dollars.
Keep the experimental results on `experiment/best-quota-abc-20261023`;
no profile/model source changes are applied without a convincing overall winner.

Recommended direction, **not a measured fourth configuration**: Luna for light
coordination/exploration/summaries, LongCat for bounded coding, Sol Medium for
critical analysis/review. Do not claim this untested combination beats C. Sol
need not perform contract discovery: Luna completed that role correctly here.

## Method and provenance

- Native OpenCode **2.1.0**, existing BEST subscription connections; no API-key
  fallback, login, paid-balance enablement, new plugin/hook/orchestrator or install.
- Temporary configs derived from installed BEST; same instructions, skills and
  MCP definitions for A/B/C. Only model selections differ. Existing FREE/global
  files, installed BEST and historical sessions were not intentionally edited.
  Native runtime writes experimental session records to existing BEST storage;
  no credentials were copied/read/edited by this evaluation. Normal native OAuth
  refresh behavior was not independently audited.
- Disposable Django **5.2.16** fixture, no database: two Django forms, two writers
  with exclusive file ownership, contract-map lane and independent boundary-analysis
  lane, followed by read-only Reviewer. No model overrides in the frozen mandate.
- Same user message and attached TASK.md for all initial valid runs. TASK SHA-256:
  `1f3fed21481ea578145228d6a1d9e4c1b508eed76832ebba119932393a392114`.
  Frozen test SHA-256:
  `eb4fdf9c13f37cb88504756250971d321bebf53ccb9f32e68ca2517b2a313649`.
  Both hashes remained equal across all three final fixture copies.
- One valid run per candidate, concurrent, 240-second deadline. Initial invalid
  runs shared the runner's inherited PWD despite different subprocess cwd; they
  were discarded, recorded separately and rerun once after an actual `pwd` probe.
  No statistical significance, workload generalization or cache fairness claimed.
- A/B were resumed once with an identical recovery prompt, explicitly preserving
  the incomplete Explore result and forbidding retries/replacements. Their final
  review/tests are included in structured-task metrics below.
- Requests below mean native assistant/model steps, including a zero-token
  interrupted attempt. Hidden transport retries and unreported provider usage
  cannot be counted. Native output and reasoning are separate reported fields;
  cache is never added to input and described as deduplicated tokens.
- Raw native exports, fixture/config copies and aggregate JSON are retained at
  `/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/best-abc-QKkE7V`.
  `metrics.json` is structured-task data, `overhead.json` separates discarded runs,
  access probes and continuity, `historical-roles.json` records the role sample.
  These are temporary evidence, not a permanent benchmark runtime; historical
  exports contain private project context and must not be published wholesale.

## Actual model access

| Provider/model | Probe wall seconds | Result |
| --- | ---: | --- |
| OpenAI Luna Low | 2.390 | ACCESS_OK |
| OpenAI Sol Low | 4.202 | ACCESS_OK |
| Go Luna Low | 3.531 | ACCESS_OK |
| Go MiniMax M3 | 3.512 | ACCESS_OK |
| Go MiniMax M3.1 Flash Low | 5.330 | ACCESS_OK |
| Go LongCat 2.0 | 4.605 | ACCESS_OK |
| Go MiMo V2.5 | 19.805 | ACCESS_OK; later structured lane timed out |
| Go MiMo V2.6 Flash | 45.011 | Probe timeout; later partial native model/tool activity confirms access, not reliable completion |

Sol is exposed by OpenAI, not by the connected Go catalog. MiMo Pro variants
are catalog-available but were not individually probed, to limit extra usage.
Catalog discovery with `all:true` includes V2.6 Flash; the default newest-family
listing omitted it. Catalog presence alone is not authenticated completion.

## Recent real BEST usage

Native `stats --standalone --days 7 --models --cost --json`, captured before probes:
**2026-10-16 22:00 UTC → 2026-10-23 15:38:39.745 UTC**. This is BEST account-storage
usage across projects/configurations, not proof all requests used release 0.3.3.
43 top-level sessions, 345 subagents, 19,633 steps; cache-write total 1,614,715.

| Provider/model/variant | Steps | Input | Output | Reasoning | Cache-read |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenAI Sol Medium | 7,809 | 26,631,940 | 2,240,706 | 1,651,517 | 1,112,499,712 |
| OpenAI Sol Low | 2,092 | 9,787,299 | 533,356 | 311,951 | 429,026,816 |
| OpenAI Sol, variant absent | 229 | 2,164,469 | 18,849 | 2,789 | 9,778,176 |
| OpenAI older gpt-6-sol default | 136 | 594,628 | 75,509 | 7,201 | 4,969,088 |
| OpenAI Luna default | 2,078 | 23,797,177 | 592,506 | 935,683 | 727,690,624 |
| Go MiniMax M3 | 5,977 | 11,429,217 | 1,760,716 | 0 | 923,701,377 |
| Go MiMo V2.6 Flash | 1,000 | 3,940,917 | 208,161 | 407,586 | 92,681,984 |
| Go Qwen3.7 Plus | 312 | 1,848 | 158,691 | 0 | 12,874,108 |

All cache-write is Qwen in this window. Native Go cost-equivalent is $63.524321,
including M3 $60.963707. M3 cache reads alone account for **$55.422083**, about
**90.9%** of its equivalent usage: repeated large contexts are the dominant
measured Go problem, not just worker output. OpenAI native cost=0 is not zero quota.

Role evidence: latest 20 pre-benchmark session exports attempted; 18 readable,
two truncated native JSON exports excluded (IDs recorded in JSON). Window-filtered
assistant messages give this **partial, nonrepresentative sample**, not the full
weekly role total. No inference of role from model name alone:

| Role/provider/model | Steps | Input | Output | Reasoning | Cache-read |
| --- | ---: | ---: | ---: | ---: | ---: |
| Build/OpenAI Sol | 993 | 5,374,936 | 295,740 | 215,028 | 231,056,256 |
| Specialist/OpenAI Sol | 411 | 883,962 | 98,649 | 74,646 | 68,628,864 |
| Reviewer/OpenAI Sol | 36 | 212,040 | 5,575 | 1,309 | 2,984,704 |
| General/Go M3 | 658 | 577,883 | 144,890 | 0 | 145,275,321 |
| Explore/Go MiMo Flash | 153 | 734,927 | 35,712 | 87,205 | 15,234,112 |

## Structured-task results

| Candidate | Coordinator; Explore; writers | Deadline result | Four initial lanes | Review/recovery | Active CLI wall time |
| --- | --- | --- | --- | --- | ---: |
| A | Sol Low; MiMo V2.6 Flash; M3 | Timeout; both form repairs correct | Four launched together, three completed | Reviewer PASS after explicit resume | 240.010 + 45.432 s |
| B | Luna Low; MiMo V2.5; LongCat | Timeout; both form repairs correct | Four launched together, three completed | Reviewer PASS after explicit resume | 240.010 + 41.733 s |
| C | Sol Low; Luna Low; M3.1 Flash Low | Completed unattended | Four launched together and completed | Reviewer PASS without rescue | 119.899 s |

All use Sol Medium Specialist/Reviewer. All initial four calls are in one native
assistant response, and child execution intervals overlap. Writer-only durations:
M3 28.486/41.842 s; LongCat 41.778/45.559 s; Flash 37.717/40.840 s.
Luna Explore: **8.905 s**, four steps, correct contract map. MiMo timeouts are
observed operational failures, not evidence of inherently weaker reasoning.

All final fixtures independently pass four unittest methods (with parameterized
subtests) and Ruff, exit 0. Initial full RED: nine failing subtests; both writers
show focused RED then GREEN. Some writers appended `echo EXIT=$?`, masking the
outer shell status; RED was verified from actual FAILED output plus printed
EXIT=1, not the shell wrapper's misleading exit 0.

Write-tool inputs confirm each writer touched only its assigned module. Native
snapshot file lists include sibling changes during concurrency and cannot establish
ownership. Frozen tests/config/TASK unchanged. Serena also created untracked
`.serena/` metadata in disposable fixtures, so this was not literally zero artifact
creation. A/C contain a redundant explicit `required=True`; B initially added an
unnecessary marker comment and needed import-format correction. All form logic is
small, linear and uses native Django; no new application abstractions. These
minor excesses prevent calling any output perfectly minimal.

Every parent recovered the deliberately missing test module without creating it
or weakening contracts. A/B additionally recovered from real interrupted lanes,
without claiming four completed lanes. No pending required benchmark writers.

### Per model and role, including A/B rescue but excluding compaction/continuity

Cache-write is **0** for every row. Two writer rows are combined; times above
remain per writer. OpenAI $0 is deliberately not interpreted as allowance usage.

| Candidate/provider/model/role | Steps | Input | Output | Reasoning | Cache-read | Go equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A/OpenAI Sol/build | 8 | 117,412 | 1,379 | 40 | 313,472 | — |
| A/OpenAI Sol/specialist | 6 | 49,446 | 591 | 46 | 238,080 | — |
| A/OpenAI Sol/reviewer | 5 | 49,267 | 337 | 51 | 173,312 | — |
| A/Go M3/two writers | 19 | 122,442 | 3,618 | 0 | 957,333 | 0.098514180 |
| A/Go MiMo Flash/explore, interrupted | 6 | 13,440 | 406 | 190 | 210,560 | 0.002638048 |
| B/OpenAI Luna/build | 11 | 117,058 | 1,540 | 396 | 501,120 | — |
| B/OpenAI Sol/specialist | 6 | 54,216 | 645 | 48 | 242,560 | — |
| B/OpenAI Sol/reviewer | 5 | 48,659 | 378 | 51 | 172,672 | — |
| B/Go LongCat/two writers | 13 | 151,369 | 2,157 | 1,546 | 510,208 | 0.052915548 |
| B/Go MiMo V2.5/explore, interrupted | 1 | 0 | 0 | 0 | 0 | 0 reported; unknown unreported usage |
| C/OpenAI Sol/build | 10 | 101,211 | 1,335 | 44 | 439,168 | — |
| C/OpenAI Sol/specialist | 6 | 54,290 | 775 | 77 | 243,840 | — |
| C/OpenAI Sol/reviewer | 5 | 48,476 | 332 | 34 | 173,184 | — |
| C/OpenAI Luna/explore | 4 | 43,695 | 466 | 0 | 125,312 | — |
| C/Go Flash/two writers | 15 | 107,250 | 2,056 | 1,034 | 669,761 | 0.027987915 |

| Candidate/provider total | Steps | Input | Output | Reasoning | Cache-read |
| --- | ---: | ---: | ---: | ---: | ---: |
| A/OpenAI | 19 | 216,125 | 2,307 | 137 | 724,864 |
| A/Go | 25 | 135,882 | 4,024 | 190 | 1,167,893 |
| B/OpenAI | 22 | 219,933 | 2,563 | 495 | 916,352 |
| B/Go | 14 | 151,369 | 2,157 | 1,546 | 510,208 |
| C/OpenAI | 25 | 247,672 | 2,908 | 155 | 981,504 |
| C/Go | 15 | 107,250 | 2,056 | 1,034 | 669,761 |

### Official Go weighting, not API-price guessing

Source, retrieved 2026-10-23: <https://opencode.ai/v2/docs/console/go>.
Per million input/output/cache-read: M3 **0.30/1.20/0.06**; Flash
**0.15/0.60/0.015**; LongCat **0.30/1.20/0.006**; both tested MiMo
**0.14/0.28/0.0028**. Go Plus nominal monthly model allowances:
M3 **180**, Flash **80**, LongCat **240**, MiMo **120** USD-equivalent.

Formula: `(input*input_rate + (output+reasoning)*output_rate +
cache_read*cache_rate + cache_write*write_rate) / 1e6`.
It matches native reported Go cost for the valid runs. Normalized nominal burden
is the sum of each model's equivalent divided by its published monthly allowance;
it is **not** an observed account balance or proof of backend accounting/bucket
independence. Published five-hour/weekly limits are 20%/50% of monthly allowance.

| Candidate | Go equivalent/task | Normalized nominal monthly burden/task |
| --- | ---: | ---: |
| A | $0.101152228 | 0.056929% |
| B | $0.052915548 | 0.022048% |
| C | $0.027987915 | 0.034985% |

Flash has the lowest dollar-equivalent; LongCat the lowest normalized nominal
allowance burden on this fixture. C reduces Go equivalent versus A by 72.3%,
but normalized burden only by approximately 38.5%. **C increases OpenAI input
by 14.6% and cache-read by 35.4%**. There is no verified OpenAI subscription
conversion or remaining quota, so no claim that either subscription lasts until
month-end. No Console Extra usage was enabled or inspected.

## Compaction and continuity, measured separately

All three native compactions completed. Actual compaction message model metadata
uses configured compaction agents, despite the V2 documentation saying there is
no separate compaction model. Runtime evidence wins for this installed version;
do not silently generalize it to other versions.

| Candidate/actual compactor | Steps | Input | Output | Reasoning | Cache-read | Go equivalent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A/M3 | 1 | 59,696 | 1,309 | 0 | 161 | $0.019489260 |
| B/LongCat | 1 | 58,093 | 976 | 11 | 1,920 | $0.018623820 |
| C/OpenAI Luna Low | 1 | 55,740 | 530 | 0 | 0 | — |

All summaries retain native-form decisions, file ownership, frozen tests, domain
marker `NATIVE_FORMS_2026`, delegation marker `FOUR_DISJOINT_THEN_REVIEW`, pending
upper-bound verification and review rules. A/B preserve the interrupted Explore
status. C had no interrupted initial lane and retains the pending verification.
Luna did not preserve original child IDs/full lane details; exact identity is not
needed for the follow-up but recovering a specific incomplete child was not tested.
Default recent-tail retention also remains enabled, so this is not proof of
summary-only or long-context losslessness.

Identical post-compaction prompts in B/C asked for retained context **before any
file reads**, then exactly one General delegate for read-only upper-bound and
frozen-suite verification. Both did so; actual child shell outputs confirm tests
and upper-bound checks passed, no writes. C explicitly identified missing original
lane details instead of inventing them. A was compacted but not resumed for this
follow-up, to avoid another paid model run.

**Continuity latency failure:** foreground `run --server` clients exceeded the
95-second host timeout; server-side work survived the disconnected clients.
The children eventually completed, but took **1,254.747 s LongCat / 1,247.206 s
Flash** from creation to idle. This is not an acceptable unattended deadline
result. The disposable server was stopped; exports confirm both children and
parents succeeded and no required workers remain pending. No retry model calls
were used to obtain these eventual results. Model versus runtime/queue delay was
not isolated, so these timings must not be attributed solely to model speed.

| Continuity-only role/model | Steps | Input | Output | Reasoning | Cache-read | Go equivalent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B/coordinator Luna | 3 | 46,220 | 632 | 101 | 108,032 | — |
| B/General LongCat | 4 | 49,463 | 1,289 | 288 | 150,016 | $0.017631396 |
| C/coordinator Sol | 2 | 41,467 | 608 | 0 | 54,272 | — |
| C/General Flash | 6 | 100,649 | 1,268 | 214 | 208,640 | $0.019116150 |

## Evaluation overhead and limits

The discarded PWD-contaminated runs consumed real tokens and are not hidden:

| Provider/model, discarded runs | Steps | Input | Output | Reasoning | Cache-read | Go equivalent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| OpenAI Sol | 36 | 453,853 | 4,042 | 149 | 1,279,104 | — |
| OpenAI Luna | 22 | 165,016 | 1,974 | 476 | 979,712 | — |
| Go M3 | 18 | 108,276 | 3,759 | 0 | 840,940 | $0.087450000 |
| Go Flash | 16 | 108,612 | 2,181 | 760 | 733,712 | $0.029062080 |
| Go LongCat | 8 | 199,678 | 1,175 | 3,314 | 206,080 | $0.066526680 |
| Go MiMo Flash | 4 | 43,343 | 350 | 148 | 91,136 | $0.006462641 |
| Go MiMo V2.5 | 4 | 45,216 | 1,314 | 109 | 138,176 | $0.007115573 |

Access/location probes, all cache-write zero except Go Luna (4,919):

| Provider/model | Steps | Input | Output | Reasoning | Cache-read | Go equivalent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| OpenAI Luna, access plus pwd | 3 | 10,096 | 66 | 0 | 4,736 | — |
| OpenAI Sol | 1 | 4,920 | 6 | 0 | 0 | — |
| Go Luna | 1 | 3 | 6 | 0 | 0 | $0.000618175 |
| Go M3 | 1 | 5,689 | 3 | 0 | 164 | $0.001720140 |
| Go Flash | 1 | 5,759 | 3 | 1 | 128 | $0.000868170 |
| Go LongCat | 1 | 3,629 | 5 | 30 | 1,920 | $0.001142220 |
| Go MiMo V2.5 | 1 | 2,613 | 4 | 12 | 3,072 | $0.000378902 |
| Go MiMo Flash, timeout | 1 | 0 | 0 | 0 | 0 | 0 reported, not guaranteed free |

Parent-session analysis/delegation/review of this evaluation itself is outside
these fixture tables; the BEST native statistics will include it. Raw transcripts
can contain more account activity than this fixed-window report. No month-end
forecast, subscription savings percentage or universal correctness claim is made.

Final independent fixture verification: all three `python3 -B -m unittest -q
test_contracts` and `ruff check --no-cache invoice.py article.py` commands exited
0. Only this report is added to the repository; installed version, VERSION,
formula, FREE and profile generator remain unchanged. No Homebrew release gate
was run because no release is proposed.

Independent read-only Reviewer: no blocking findings; arithmetic and minimal
Django implementation checked, without independently rerunning shell tests.

Self-evaluation (1–5): accuracy 4 (native accounting, not subscription balances);
completeness 3 (historical role sample incomplete; one small fixture, no ORM/auth
or migration workload); clarity 4 (summary tables plus explicit exclusions);
actionability 3 (no proven dual-subscription winner to apply); conciseness 3
(large evidence report, short delivery summary). Mean **3.4**. Highest-value
improvement is a bounded real-workload observation with verified quota telemetry,
not more repetitions of this tiny fixture. Avoid another PWD-contaminated run by
verifying runtime location before any future concurrent experiment.
