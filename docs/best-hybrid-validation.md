# BEST Hybrid 0.3.0 validation

Status: candidate locally validated; release gates pending.

## Acceptance protocol

Compare installed 0.2.1 and the candidate on identical fresh copies of
`tests/fixtures/hybrid`, using the same `TASK.md` without prescribing agent names,
number of calls or parallelism in the user prompt. Never copy authentication or
sessions between profiles. Use existing BEST subscriptions and no model overrides.

The candidate must demonstrate, from native session/message/tool metadata:

- Build Sol Low; Explore Go MiMo; two separate General Go MiniMax sessions;
  Specialist Sol Medium; independent Reviewer Sol Medium after implementations.
- Four useful initial delegations, overlapping execution intervals where independent,
  disjoint writer ownership, and actual successful edits/tests.
- Initially failing fixture tests, final passing tests, no permission requests.
- Input/output/cache, model request counts and elapsed time, when exposed; no
  monetary savings or quota claims without comparable measurements.
- FREE generated configuration and instruction bytes unchanged, global Premium
  files unchanged, existing authentication/session/backup paths retained.

Configuration tests are not evidence of concurrent execution. The runtime eval
uses native OpenCode sessions, not a product router, scheduler or custom gate.
Allow at most three valid candidate instruction variants before reporting a
blocker; discard a measurement with contaminated stdin rather than score it.

Keep the 0.2.1 autonomy rules and only one new native agent (`specialist`). Reuse
General twice, with distinct child sessions and exclusive implementation files.
Simple work remains direct; four lanes are a preference only for suitable work.

## Changes and review

Only one new native agent: `specialist`, Sol Medium, subagent mode, implementation
permissions inherited from BEST with questions/nested delegation denied. General
is reused, not duplicated. BEST appends `shared/best-hybrid.md`; the original shared
instructions and FREE configuration/instruction bytes are unchanged.

RED: generated-role tests failed with absent Specialist; installed 0.2.1 role
assertion also exited 1. GREEN: generated JSON, override, permission and instruction
byte/idempotence tests pass. No router, scheduler, hook or custom runtime was added.
Independent read-only review found two test/docs gaps (foreground/Low negative
controls and release refs); both were corrected and focused tests rerun.

## Real native comparison (V2 2.0.32)

Same frozen task bytes and initial files, separate temporary repositories, no
model overrides and no `--auto`. Native exported user messages compare exactly
(SHA-256 `8d103b3b5eb9bd157fa1ea33841f51c42e39d6c32657ffda02cdf7497af7642b`).
Child message metadata, not model self-reports, establishes identity and timing.

| Measurement | Installed 0.2.1 | Final Hybrid candidate |
| --- | ---: | ---: |
| Frozen tests, initial → final | 11 failures → 14/14 pass | 11 failures → 14/14 pass |
| Delegations, including subsequent Reviewer | 5 | 5 |
| Wall seconds | 100.768 | 81.065 |
| Model requests (all six sessions) | 51 | 29 |
| Native `tokens.input` | 303,421 | 291,790 |
| Native `tokens.output` | 6,759 | 3,983 |
| Native `tokens.reasoning` | 2,231 | 155 |
| Native `tokens.cache.read` | 2,263,432 | 1,069,035 |
| Native `tokens.cache.write` | 0 | 0 |
| OpenAI input / requests | 151,819 / 25 | 185,475 / 13 |
| Go input / requests | 151,602 / 26 | 106,315 / 16 |
| Permission required | 0 | 0 |

These are single ordered observations, not a controlled repeated benchmark or
proof of general savings. Cache state, provider latency and nondeterminism vary.
OpenAI input increased; subscription billing, residual quota and actual monetary
cost are not measured. The accepted benefit is fewer requests/context replays on
this fixture, with the same correct result and a dedicated critical Medium lane,
not a higher delegate count. Small tasks still used zero children: 3 requests in
both runs; 10.477s / 7.380s, input 83,113 / 84,479, output 92 / 106, cache-read
43,776 / 44,928. No claim of small-task token reduction.

Baseline parent: `ses_eaaeaa7c5ffeIewi7Z3IExBzeU`.
Accepted candidate parent: `ses_eaae0f97effedWaWj2n8cFZU7N`.

| Candidate child | Agent / actual message model | Session ID |
| --- | --- | --- |
| Contract map | Explore / Go MiMo Flash | `ses_eaae0ae3effedYYP8ORn7HOxs2` |
| Alpha writer | General / Go MiniMax M3 | `ses_eaae0ae3dffe71Kp8WE49LA4AA` |
| Beta writer | General / Go MiniMax M3 | `ses_eaae0ae3affeOkdPDDI50OBZ44` |
| Critical analysis | Specialist / Sol Medium | `ses_eaae0ae3affdanaTKbS3uaRLR9` |
| Post-implementation review | Reviewer / Sol Medium | `ses_eaae00327ffeox5av5fkQOQqxE` |

All four initial children were created within 5ms; actual assistant execution
intervals overlap. Parent native exports contain four foreground calls in one
model response. Writer tool inputs resolve only to `alpha.py` and `beta.py`
respectively. Reviewer began after both writers completed and made no writes.
Build message identity is Sol; its message omits a variant, so Low is established
by the captured native Build `#low` definition and per-model `reasoningEffort: low`,
not by pretending the export contains an explicit Low variant.

Raw native exports/NDJSON are retained outside the repository under the approved
temporary evidence directory `hybrid-eval.Xq5frV`. Optional executable verification:

```sh
OPENCODE_TEAM_HYBRID_EXPORT_PREFIX=/path/to/evidence/candidate4 \
  node --test tests/hybrid-evidence.test.mjs
```

This validates real exported messages, concurrent foreground dispatch, models,
disjoint writers, frozen files, final unittest success, reviewer ordering and
negative controls for High/Medium Build or background dispatch. Six tests passed,
exit 0. It is an evidence test, not an installed runtime orchestration gate.

### Retained failed/discarded trials

- Initial baseline/candidate measurements inherited QA-script stdin. Discarded;
  reruns use `stdin=DEVNULL`, and exact native user messages are compared.
- First valid background candidate: 125.718s, 67 requests, final tests passed,
  but one Go worker repeatedly guessed unavailable tools. Added a report-once,
  no-alias-probing instruction; Build natively verified that worker's tests.
- Next background candidate: 132.938s, returned while beta/review/final tests were
  pending. Not scored PASS. Required lanes now use concurrent foreground calls;
  the final bounded revision above passed. No custom waiting loop or gate added.
- Baseline recovered a malformed Serena symbol replacement natively. Candidate
  uses the same pinned Serena; actual initial-instructions calls succeeded, ECC
  skills loaded, and `doctor` passed. Tool availability is never inferred from
  mere configuration presence.

## Regression verification

- Full Node/coverage run: 35 passed, 1 native-policy test skipped (run separately),
  exit 0. Production generator line coverage 100%, branches 88.37%.
- Real native permission matrix, now including Specialist: 1 passed, no skips,
  exit 0. Django/MySQL, Git/SSH resources were evaluated, not executed.
- Workflow shell tests, Ruby/Bash/Zsh syntax and diff checks: exit 0.
- Protected-file hashes: FREE config/instructions and Premium config/CLI/rules
  unchanged. Historical auth metadata unchanged; every prior backup retained.
  Existing accounts remain usable; no credentials or sessions were imported.

Release and installed-package evidence follows after remote gates.
