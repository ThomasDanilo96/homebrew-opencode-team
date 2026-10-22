# BEST 0.3.3 — Context7 and intentional documentation

## Integration

Baseline: installed 0.3.2, clean master d068392. Dedicated branch
`feat/best-context7-docs-033`. No model, effort, provider, agent permission,
Serena/Playwright configuration or ECC pin changes.

Official references: [CLI](https://context7.com/docs/clients/cli),
[upstream skill](https://github.com/upstash/context7/blob/d980242a5b04be30ae8804124a8be259bcc2a227/skills/find-docs/SKILL.md),
[native V2 skill precedence](https://opencode.ai/v2/docs/skills).
`npm view ctx7 version dist.integrity repository engines bin --json` verified
Upstash's **0.8.1**, Node >=22.13 and integrity
`sha512-Co+cXpXk34FdknwUaCah88xSsjSSC7fy77Uz9mPjvdjFmho5F6qxG2X0TaxgqFDh9qAaSFS9Nn50j30C8rwRGg==`.
The pinned CLI is installed on demand by npx in BEST's private npm cache;
`npx --yes ctx7@0.8.1 --version` returned 0.8.1 (exit 0). No login/setup flow,
global installation or extra MCP. Explicit native skills override the existing
ECC `documentation-lookup` ID only for BEST, avoiding another advertised skill.
The new packaged skill file is necessary for this lazy native registration;
ECC itself remains unchanged. Queries are anonymous, telemetry disabled; network,
index version availability and anonymous rate limits remain external constraints.

## Behavioral fixtures (temporary, isolated)

Directory:
`/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/best-033-fixtures`.
Django **5.2.18** in its local venv; no application repository involved.

`bin/opencode-team best run --format json` from the source branch (with absolute
launcher path and fixture directory as cwd) performed A/B/C; actual tool timeline
is in sibling `033-fixture-abc.jsonl`, not merely an installation check:

- **A/framework:** frozen canonical slug contract initially failed three subcases
  (exit 1). BEST read the installed Django version, loaded the CLI skill, then ran
  `npx --offline --yes ctx7@0.8.1 library django "Django 5.2 django.utils.text.slugify default ASCII normalization punctuation underscores stripping" --json`
  and `npx --offline --yes ctx7@0.8.1 docs /websites/djangoproject_en_5_2 "django.utils.text.slugify default allow_unicode False punctuation removal leading trailing underscores and hyphens" --json`
  (both exit 0). `--offline` reuses the installed npm package; documentation was
  retrieved from Context7 over the network. Result cites
  `https://docs.djangoproject.com/en/5.2/ref/utils`; patch-specific 5.2.18 indexing
  was not claimed. A became a native `slugify` re-export, with no wrapper.
- **B/comments:** redundant narration/docstring removed; 4 behavioral tests passed
  before/after. No tests added for prose.
- **C/invariant:** compare-and-write lock explanation retained; all 5 tests,
  including late revision and concurrent monotonic state, passed unchanged.
- Final commands: `.venv/bin/python -B -m unittest discover -s a` (1 test/7 cases),
  corresponding `-s b` (4), `-s c` (5), then `ruff check --no-cache a/slugs.py b/stats.py c/state.py`
  and `ruff check --no-cache --select D301,D400,D415,D419 a/slugs.py b/stats.py c/state.py`:
  all exit 0. Frozen tests unchanged. Serena overview/find-symbol calls preceded
  edits. Its activation created metadata only inside the disposable fixture.
- Ruff liveness: `ruff check --no-cache --select D301,D400,D415,D419 docstring_probe.py`
  from the fixture directory returned exit 1 for D400/D415, then exit 0 after
  punctuation correction. The neighboring undocumented private function stayed
  valid; no missing-docstring rule or autofix was enabled. This is a disposable
  scanner control, not documentation added to product code merely for a scanner.
- **D/reviewer:** independent read-only Reviewer inspected `d/proposed.diff` and
  returned **Request changes** for an unnecessary `_normalize_path` wrapper,
  redundant docstrings and an “intact, including root” comment contradicted by
  destructive slicing. It proposed native normalization directly and correction
  of existing trailing-slash/root assertions. No edits or shell execution by Reviewer.

Initial fixture drafts accidentally encoded custom slug behavior and a docs-only
diff; these were corrected before acceptance. Initial draft results are not counted
as framework-first/reviewer acceptance. Fixture D intentionally remains a rejected
proposal, not released code.

## Regression / measurement

New config/environment tests: RED 2 failures (missing BEST skill source/private
cache), then GREEN 2 passes (exit 0). First full suite exposed an existing instruction
assertion requiring the FAIL marker; instructions retain “FAIL / Request changes”
without weakening the assertion. Targeted rerun passed. Source setup/doctor exit 0.
Final suite, independent product review, remote release gates and installed-version
acceptance are recorded in the release notes after completion, not claimed here.

A/B/C CLI metadata: **9 model steps**; sums of reported fields input **97,119**,
output **1,397**, reasoning **56**, cache.read **354,816**, cache.write **0**;
**2 Context7 documentation requests** (plus one CLI version check).
These fields are reported as supplied by V2, not a price or deduplicated-token
calculation. No comparable 0.3.2 task baseline exists; no savings percentage or
universal behavior guarantee is asserted. No scanner can establish semantic
comment correctness or detect all overengineering; independent review remains needed.
