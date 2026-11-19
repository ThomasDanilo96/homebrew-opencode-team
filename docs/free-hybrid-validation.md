# FREE Hybrid qualification (candidate with GPT-6.2 Sol BEST)

Status: **locally qualified candidate; no push, no tag, no release**.

Date: 2026-11-19. Environment: OpenCode V2 2.2.7 (`/opt/homebrew/bin/opencode`),
repo `master` at `7cf02bf` plus the FREE Hybrid working tree, macOS Darwin.

## 1. Verified free models (Section 1)

Source: live `opencode models` catalog for provider `team-free`, cross-checked
against models.dev cost metadata and probe sessions. Included (all declare
`cost: {input: 0, output: 0}`, `capabilities.tools: true`):

| Model | Notes |
| --- | --- |
| `deepseek-v4.1-flash-free` | zero retention, no training on inputs |
| `beam-free` | no training, 30-day retention, text-only input |
| `mimo-v2.6-flash-free` | feedback/improvement data may be collected |
| `big-pickle` | feedback data may be collected |
| `flint-40b-free` | feedback data may be collected |
| `iceman-free` | feedback data may be collected |
| `longcat-2.5-free` | zero retention, 100 requests/day cap |
| `nemotron-3.5-lightning-free` | NVIDIA trial: requests are logged |
| `nemotron-3.5-super-vl-free` | NVIDIA trial: requests are logged |

Excluded: `glm-5.3-flash-free` and `minimax-m3.1-flash-free` (deprecated),
`inkling-2-small-free` (country restriction + training retention). No
subscription, no paid API key, no Go/OpenAI consumption is involved: FREE's
provider is a singleton `team-free` at `https://opencode.ai/inference/openai/v1`
with an empty API key. All free models are promotional ("for a limited time");
unavailability is never permission to spend.

## 2. Role assignment (Section 2)

| Role | Model | Rationale |
| --- | --- | --- |
| Build (coordinator), Plan, Reviewer, root | `team-free/deepseek-v4.1-flash-free` | strongest verified free coder; zero retention |
| Explore (read-only analysis) | `team-free/beam-free` | 1M context, no training on inputs, text-only fits analysis |
| General, title, summary, compaction | `team-free/mimo-v2.6-flash-free` | proven helper already used by this profile |

Three distinct models (≤ 4 allowed); distinct only where there is a concrete
benefit (context window / privacy / role fit). `OPENCODE_TEAM_FREE_MODEL`
accepts only `team-free/<verified id>`; setup fails on anything else
(`openai/gpt-6.2-sol`, `opencode-go/minimax-m3`, `opencode/zen/...`,
`team-free/unknown` all rejected), so no unverified or paid model can reach the
generated config.

## 3. Native delegation (Section 6 item 2) — SÌ

`agents.explore.mode = agents.general.mode = 'subagent'`; Build permissions:
`subagent deny *`, `subagent allow explore`, `subagent allow general`;
`general` denies `subagent`; `experimental.subagent_depth: 1` blocks recursion.
At most two concurrent subagents is an instruction-level rule (native OpenCode
has no concurrency key).

Live qualification run (throwaway workspace
`/private/var/folders/.../opencode/free-qual-PwRn/ws`, no productive project):

```
✓ Inspect calc.py and test_calc.py — Explore Agent
> build · deepseek-v4.1-flash-free
## Summary of explore subagent's report
```

FREE DB evidence (`session_v2` / `session_message`):

| Session | Agent | Model | cost | Parent |
| --- | --- | --- | --- | --- |
| `ses_e0c8d6ccaffe…` (read+test run) | build | `team-free/deepseek-v4.1-flash-free` | 0.0 | — |
| `ses_e0c8c7379ffe…` (delegation run) | build | `team-free/deepseek-v4.1-flash-free` | 0.0 | — |
| `ses_e0c8c2925ffe…` (subagent) | explore | `team-free/beam-free` | 0.0 | `ses_e0c8c7379ffe…` |

The Explore child session carries `parent_id` of the Build session: native V2
Build→Explore delegation, one level only.

## 4. Ordinary permissions without interruptions (Section 6 item 4) — SÌ

Qualification run 1: the Build agent read `calc.py`/`test_calc.py`, executed
`python3 test_calc.py` (exit 0) and redirected stdout/stderr — **zero permission
prompts** (non-interactive `opencode run` would have failed on any `ask`).

Global permission order (64 rules; last match wins): first
`external_directory ask` (single untrusted-external ask, no per-path allow),
then `shell allow`, then every shell ask, then `edit ask <secretFiles>`,
`edit allow *.env.example`, `edit ask ~/Library/LaunchAgents/*`,
`read ask <secretFiles>`, and the final rule
`read allow *.env.example`. There is no configured `*`/`*` allow wildcard and
no `provider.use allow *`; `opencode --auto` must not be used to bypass them.

## 5. Dangerous operations still gated (Section 6 item 5) — SÌ

Same run: the agent attempted `rm` of its scratch files and the sandbox refused
non-interactively (`ask` without a TTY → denied). Asserted in tests: `rm *`,
`sudo *`, `launchctl *`, `kubectl *`, `git *reset *--hard*`, `git *push *`,
`git push`, `git *rebase *`, `git *filter-*`, `*.ssh/*` all `ask`; secret files
(`*.env`, `*.key`, `*.pem`, `*credentials*`, `*auth.json*`) `ask` for both read
and edit; `~/Library/LaunchAgents/*` edit `ask`. FREE prompts for **any** remote
push, force-free or not (`freeApprovalShell`).

## 6. Economic isolation (Section 4) — PASS

- `opencode-team free auth list` → `No authenticated integrations`.
- `opencode-team best auth list` → `OpenCode Go API key stored`, `OpenAI OAuth
  stored` — accounts stay separated; FREE never reads BEST's `auth.json`.
- FREE `policies`: `provider.use * deny` + `provider.use team-free allow`
  (no `allow *`), provider `settings.apiKey: ''`, `plugins` absent (the BEST
  Quota Governor never loads in FREE).
- FREE DB sessions: `cost = 0.0` on every qualification session; provider is
  always `team-free`.
- Setup rejects any `OPENCODE_TEAM_FREE_MODEL` outside the verified catalog,
  so Go/OpenAI/paid/zen models cannot be selected even by override.
- Failure mode: a `team-free` outage or rate limit fails the run; it can never
  fall back to a paid provider.

## 7. Tests run (Section 6)

| Suite | Result |
| --- | --- |
| `runner.sh all` (isolation negative controls + native-profiles 51 + disk-cleanup + hybrid-evidence + packaging + best-routing + python 60 + smoke) | exit 0 |
| `runner.sh best-native` | 10/10 |
| `runner.sh best-routing` | 20/20 |
| `runner.sh packaging` | 4/4 |
| `runner.sh smoke` | PASS |
| quota suites (`best-quota` 44, `essential` 8, `cli` 11, `native` 1, `runtime` 32, `sources` 8) | 104/104 |
| `tests/setup-smoke.sh` | PASS |

New test `FREE Hybrid: verified free catalog, role models, native delegation,
read-only reviewer, gated danger, economic isolation` in
`tests/native-profiles.test.mjs` covers Section 6 items (1)–(8): catalog
identity and zero cost, role models ≤ 4 distinct, delegation rules and
`subagent_depth: 1`, Reviewer read-only (no shell/edit/write/subagent allow),
shell allow preceding every ask, gated danger/secret/push rules, override
rejection/acceptance, BEST `openai/gpt-6.2-sol` + `#low` untouched, and FREE
packaging (`FREE Hybrid` supplement present, `## BEST strict minimalism`
absent). The packaging test asserts both profiles append their **own**
supplement to `shared/instructions.md` and that setup is byte-idempotent.

## 8. BEST state unchanged (Section 6 item 7)

- Coordinator: `openai/gpt-6.2-sol`, Build `openai/gpt-6.2-sol#low`,
  Plan/Specialist/Reviewer `#medium` (commit `7cf02bf`, preserved).
- Quota Governor plugin loads in BEST only; governor process ACTIVE.
- BEST generated `AGENTS.md` still 13428 bytes with `## BEST strict minimalism`.
- BEST permissions byte-order unchanged (trusted external allows intact).
- `best auth list` unchanged (Go + OpenAI credentials stored).
- `OPENCODE_TEAM_FREE_MODEL` changes affect only the FREE config.

## 9. Live FREE configuration (after `bin/opencode-team setup`)

Backup: `2026-11-19T10-55-04.904Z-5953b54f-…`. Verified generated values:

```
FREE model:   team-free/deepseek-v4.1-flash-free
FREE roles:   build/plan/reviewer deepseek · explore beam · general mimo
FREE catalog: 9 models, cost 0, tools true
policies:     provider.use * deny → provider.use team-free allow
modes:        explore=subagent general=subagent depth=1
build perms:  subagent deny* → allow explore → allow general
global perms: 64 (first external_directory ask, last read allow *.env.example)
FREE AGENTS:  has FREE Hybrid · no BEST strict minimalism
BEST AGENTS:  has BEST strict minimalism · 13428 bytes
```

## 10. Qualification transcripts (Section 6 "real new FREE session")

Run 1 — ordinary work, no interruptions:

> Files read (`calc.py`, `test_calc.py`) … `python3 test_calc.py` … exit code
> `0` … "I tried to remove them, but the sandbox rejected the `rm`
> non-interactively" — `EXIT=0`, console header `build · deepseek-v4.1-flash-free`.

Run 2 — native delegation:

> "Files exist. Delegating to the explore subagent now."
> `✓ Inspect calc.py and test_calc.py — Explore Agent` → summarized report,
> `EXIT=0`, header `build · deepseek-v4.1-flash-free`.

Neither run touched a productive project; the workspace was a disposable
directory under the system temp root.
