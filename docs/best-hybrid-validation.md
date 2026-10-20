# BEST Hybrid 0.3.0 validation

Status: **0.3.0 published, installed with Homebrew and verified**.

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

## Release and installed-package acceptance

- PR #2 merged: `cfec27b5c1eb2bb8680d9d5047d46720868c988b`.
- Immutable `v0.3.0`: `d197d649b7827d0025e880f4b94ab48c2ab0d4fa`.
  Stable formula commit: `912f3b36a41341a7f6f6a6ab2bde8bc8758b33ff`.
- Official archive SHA-256, measured locally and identical to Phase B:
  `556b728e2f38b9eca964d2dc0830eea7cbc9a381d2b0cfcff9cc9fa94c5e347e`.
- All required GitHub Actions gates succeeded:
  - Phase A staging install/tests: `39292163345`.
  - Phase B official archive: `39292668146`.
  - Stable tap clean-install / formula test / audit: `39294443082`.
  - Gated official publisher: `39295084885`.
- API watch encountered rate-limit exhaustion. Waited until the declared reset,
  then confirmed Phase B success and matching checksum. No quota/auth bypass,
  failed-job relabeling, tag rewrite or alternate publication path was needed.
- Official non-draft, non-prerelease release published at `2026-10-19T17:34:06Z`:
  https://github.com/ThomasDanilo96/homebrew-opencode-team/releases/tag/v0.3.0
- Normal Homebrew upgrade changed only OpenCode Team 0.2.1 → 0.3.0, with cleanup
  disabled. Previous kegs/backups retained. `brew test`, `opencode-team setup` and
  `doctor` exited 0. `/opt/homebrew/bin/opencode-team version` reports 0.3.0;
  native OpenCode remains 2.0.32. Installed executable, VERSION and all profile
  assets match the verified official archive byte-for-byte.
- Installed BEST structured E2E parent: `ses_eaac4e08dffeS9DRTcUm6YOCIc`.
  Actual foreground children:
  - Explore Go MiMo: `ses_eaac48c34ffevkI5qJi7sMeb9e`.
  - General Go MiniMax: `ses_eaac48c22ffeNVlL2yQKHaBeJN`.
  - General Go MiniMax: `ses_eaac48c27ffejbgBv7URBVMdZn`.
  - Specialist Sol Medium: `ses_eaac48c13ffeyJKhHZxvgiQfqE`.
  - Subsequent Reviewer Sol Medium: `ses_eaac38246ffeP7HWy59yYX3C3c`.
- Native export audit passed 6/6, exit 0, on the installed sessions: four initial
  calls in one response, overlapping execution, disjoint actual writes, Medium
  specialist/reviewer, Build Low definition/default, reviewer after writers,
  frozen-file hashes, 14/14 final unittest checks, no permission requests.
  Both writer tests and the coordinator's combined tests used env-prefixed Python.
- Installed run: 120.283s, 35 requests, input 289,288, output 5,207, reasoning 204,
  cache-read 1,396,113. This later trial was slower than the baseline observation;
  there is **no claim of consistent latency improvement**. Request/context counts
  and native execution semantics, not a selected fast timing, justify the change.
- Installed FREE: `ses_eaac4e0a9ffelmvHLUzNsHtjPf`, `FREE_030_OK`, exit 0; actual
  assistant model provider verified as `team-free`, no tools or paid fallback.
- Final preservation checks: FREE and Premium byte hashes unchanged; historical
  auth metadata and every pre-existing backup retained. The 0.2.1 baseline session
  remains retrievable after upgrade. No auth/session import or database rewrite;
  normal native account refresh/session recording remains owned by OpenCode.

Limitations: single synthetic workload, non-randomized provider/cache conditions,
no measured monetary cost or remaining subscription quota, and no guarantee that
arbitrary prompts always choose four useful lanes. Delegation remains a native
instruction preference, intentionally not an enforced custom gate.

## Strict minimalism — 0.3.1 candidate

The BEST-only supplement now prioritizes demonstrated necessity for every addition,
linear code, existing ownership/reuse, framework-native behavior, one authoritative
source, focused regressions and preserved contracts/security. Significant changes
require independent read-only minimalism review, with concrete excess complexity
rejected until simplified. No generator, model, permission, dependency, plugin,
hook, session boundary or FREE instruction was changed.

### Behavioral comparison (OpenCode V2 2.0.32)

Two fresh temporary Git fixtures contained identical `shipping.py` (three strategy/
factory classes and `shipping_fee(subtotal)`) and a frozen unittest covering totals
0, 49, 50 and 51. The defect was `subtotal > 50` instead of `>= 50`. Identical native
user messages requested the threshold fix, preservation of the function/tests and
fixture-only work; they did not ask for class removal or prescribe the solution.
Only the BEST supplement differed; existing BEST connections/data were reused in
place, with temporary config/state/cache, no credential import and no installation.

| Observation | Previous BEST | Strict candidate |
| --- | --- | --- |
| Native Build session | `ses_ea614e528ffelX11cn4CFlZsXv` | `ses_ea6146efffferJmkjyxdTtOxyc` |
| Threshold test before / after | exit 1 / 0 | exit 1 / 0 |
| Application result | 20 lines; classes/factory retained | 2 lines; one existing function |
| Application files added | 0 | 0 |

The candidate produced `return 0 if subtotal >= 50 else 5` in the existing function.
Both used Sol with the unchanged Low configuration/default, called Serena and
loaded ECC TDD; frozen tests remained identical. A no-tools instruction probe
returned `ABSENT` on the previous supplement, but quoted the exact new concrete-
complexity FAIL rule on the candidate. This observes instruction availability in
the model context, beyond the mock test's generated-file/config reference checks.

Negative control: native Reviewer `ses_ea6129c45ffelVsUv0Cdpunf11`, actual message
model Sol **Medium**, inspected a proposed `ShippingFeeService.calculate()` wrapper
delegating to the function with no consumer. Verdict: **Request changes** (rejection,
not the literal label FAIL), citing `review.patch:9–11`, requiring class removal,
and retaining the existing function/tests. No edits or shell execution occurred.
The artificial proposal was never applied to the application. An earlier direct
Reviewer run retained the root model's missing variant; it is not Medium evidence.

Native exports, task/config snapshots, RED/GREEN outputs and probes are retained
under the approved temporary directory `strict-eval.N3x7dD`. Two initial trials
inherited the harness Location despite subprocess cwd; no fixture edits occurred.
They were excluded, then rerun with explicit native session Locations and PWD.

### Automated and independent checks

- Existing instruction-generation test extended, not a new fixture framework:
  `node --test --test-name-pattern='BEST Hybrid supplement' tests/native-profiles.test.mjs`.
  RED exit 1 (missing policy), GREEN exit 0 (generation, launch reference, FREE
  exclusion and byte-idempotence). Checkpoints: `5b60416`, `bfd73f9`.
- `node --test --experimental-test-coverage tests/*.test.mjs`: 34 passed, 2 optional
  native/evidence checks skipped, exit 0; generator line coverage 100%, branches
  88.37%. Native permissions separately: 1 passed, zero skips, exit 0.
- `bash tests/setup-smoke.sh`, `bash tests/homebrew-workflow.test.sh`, actionlint,
  Ruby/Bash/Zsh/Node syntax and diff checks: exit 0. No separate build/type/lint
  target exists for the changed Markdown and plain JavaScript test assertions.
- Independent static Reviewer: PASS, no concrete finding. FREE config/instructions
  and Premium config/CLI/rules: five protected hashes unchanged after live trials.
- Release-test maintenance advances the immutable published archive pin from
  0.2.1 to the verified 0.3.0 identity; the immutability assertions are unchanged.
  Stable formula metadata remains 0.3.0 until official 0.3.1 archive verification.
- After candidate VERSION advance, `node --test tests/packaging.test.mjs`: 3 passed,
  exit 0. Local Gitleaks is unavailable; archive scanning remains a remote gate.

Limits: one synthetic comparison, not a universal minimalism guarantee or proof
of consistent token/latency savings. Instructions guide native agents; there is no
custom runtime enforcement. Remote release and installed-package gates are not
implied by local tests.
