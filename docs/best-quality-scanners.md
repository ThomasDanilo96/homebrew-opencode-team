# BEST quality scanners — evidence report (2026-10-22)

Scope: bring up a local quality-scanner toolchain, prove each scanner actually
fires, and demonstrate a duplication cleanup and a Dockerfile hardening loop.
No release, no Git commits, no changes to OpenCode/FREE configuration, no
edits outside this document. All installs are isolated from system Python.

Fixture work happened under
`/private/var/folders/fs/7py3y1294056jtqn3vhvq3l80000gn/T/opencode/best-quality-tools/`
(subdirs `py-fixture/`, `docker-fixture/`) and is throwaway scratch, not repo
source.

## 1. Tools installed and verified

Installed binaries (paths from this machine):

| Tool | Version | Install path / prefix |
| --- | --- | --- |
| ruff | 0.16.8 | `/Users/thomasd/.pyenv/shims/ruff` (pre-existing) |
| trivy | 0.74.0 | `/opt/homebrew/bin/trivy` (pre-existing) |
| hadolint | 2.15.1 | `/opt/homebrew/Cellar/hadolint/2.15.1` (Homebrew) |
| ast-grep | 0.51.0 | `/opt/homebrew/Cellar/ast-grep/0.51.0` (Homebrew) |
| semgrep | 1.182.1 | `~/.local/share/opencode-team/best/bin/semgrep` (`uv tool`) |
| vulture | 2.16 | `~/.local/share/opencode-team/best/bin/vulture` (`uv tool`) |
| jscpd | 4.0.5 | `~/.local/share/opencode-team/best/quality/node_modules/.bin/jscpd` |

### Isolation / install evidence

- `uv` tool prefix (isolated, not system Python):
  `/Users/thomasd/.local/share/opencode-team/best/bin` — contains `semgrep`,
  `pysemgrep`, `vulture`.
- `uv` reported: ``warning: `/Users/thomasd/.local/share/opencode-team/best/data/../bin` is not on your PATH`` — so each run below exports
  `PATH="/Users/thomasd/.local/share/opencode-team/best/bin:$PATH"`.
- System `python3` is untouched: `which -a python3` → `/Users/thomasd/.pyenv/shims/python3`,
  `/opt/homebrew/bin/python3`, `/usr/bin/python3`; `python3 -c "import sys; print(sys.prefix)"`
  → `/Users/thomasd/.pyenv/versions/3.13.5`. No `pip install` ran against it.

Install commands actually executed (all exit 0):
- `brew install hadolint` (exit 0, bottle 2.15.1)
- `brew install ast-grep` (exit 0, bottle 0.51.0)
- `uv tool install vulture` (exit 0, vulture==2.16)
- `uv tool install semgrep` (exit 0, semgrep==1.182.1)
- jscpd: initially `mkdir -p …/best-quality-tools && cd … && npm init -y && npm install jscpd@4.0.5`
  (exit 0, scratch dir). The parent session then made it durable:
  `npm install --prefix /Users/thomasd/.local/share/opencode-team/best/quality --no-audit --no-fund --save-exact jscpd@4.0.5`
  (exit 0), now at `~/.local/share/opencode-team/best/quality/node_modules/.bin/jscpd`
  (`--version` → `4.0.5`, exit 0). No further installs were performed for this revision.

Version checks (each exit 0): `hadolint --version` → `Haskell Dockerfile Linter 2.15.1`;
`ast-grep --version` → `ast-grep 0.51.0`; `vulture --version` → `vulture 2.16`;
`semgrep --version` → `1.182.1`; `ruff --version` → `ruff 0.16.8`;
`trivy --version` → `Version: 0.74.0`; `jscpd --version` → `4.0.5`.

## 2. Python fixture — duplication + unnecessary wrapper

Fixture: `…/best-quality-tools/py-fixture/billing.py` (+ `test_billing.py`).

- Before: three byte-identical `format_*_total` bodies, plus a transparent
  `build_invoice_payload_layer` wrapper that only forwarded arguments.
- `test_billing.py` pins the public API (5 tests).

Baseline tests, before any change:

```
cd …/best-quality-tools/py-fixture
uv run --with pytest python -m pytest -q
→ 5 passed    exit 0
```

### jscpd detects the duplicates

```
cd …/best-quality-tools/py-fixture
../node_modules/.bin/jscpd --min-lines 3 --reporters consoleFull --output /tmp/jscpd-report .
→ Found 0 clones    exit 0
```
Threshold too high for one-line bodies — a useful reminder that thresholds gate
recall.

```
../node_modules/.bin/jscpd --min-lines 1 --min-tokens 5 --reporters consoleFull --output /tmp/jscpd-report .
→ Found 10 clones   exit 0
```
Reported clones include the production pairs `format_invoice_total_v2` /
`format_refund_total` (billing.py `[8:24 - 12:20]`, `[12:20 - 16:84]`) and the
wrapper forwards (`[23:28 - 24:22]`, `[27:23 - 28:21]`).

### Manual analysis drives the simplification

**jscpd flagged byte-identical text; it did not prove the wrapper was
unnecessary.** That judgement came from reading the code: the wrapper
`build_invoice_payload_layer(invoice_id, amount_cents)` only called
`build_invoice_payload(invoice_id, amount_cents)` with arguments unchanged — no
extra behaviour, no boundary, no validation, no abstraction gain. The three
format functions likewise held identical f-strings with no distinguishing
semantics. Only that manual reading justified removing the layer.

Result: single-owner `format_invoice_total` plus module-level aliases that keep
the exact public names (`format_invoice_total_v2`, `format_refund_total`), and the
wrapper name preserved as an alias with the forwarding layer removed.

### Verification

```
uv run --with pytest python -m pytest -q
→ 5 passed    exit 0        (behaviour preserved)

../node_modules/.bin/jscpd --min-lines 1 --min-tokens 5 --reporters console --output /tmp/jscpd-report2 billing.py
→ Found 1 clone    exit 0
```
The single remaining clone is the one-line `format_invoice_total`
(`[4:21 - 5:2]`) vs `describe_invoice_total` (`[23:23 - 24:21]`) — delegation, not
duplicated logic.

```
PATH="/Users/thomasd/.local/share/opencode-team/best/bin:$PATH" \
  vulture billing.py test_billing.py --min-confidence 60
→ (no output)    exit 0
```
Clean both before and after simplification; no dead code introduced.

## 3. Docker fixture — Hadolint finding then minimal fix (green)

Fixture: `…/best-quality-tools/docker-fixture/Dockerfile`.

```
hadolint …/docker-fixture/Dockerfile
→ DL3008 warning: Pin versions in apt get install
  DL3015 info:    Avoid additional packages by specifying --no-install-recommends
  DL4006 warning: Set the SHELL option -o pipefail before RUN with a pipe in it
  exit 1
```

Minimal fix: added `SHELL ["/bin/bash","-o","pipefail","-c"]`, pinned
`curl=7.88.1-10+deb12u5`, added `--no-install-recommends`.

```
hadolint …/docker-fixture/Dockerfile
→ (no output)    exit 0
```

Trivy (misconfig) additionally flagged a root-user issue outside Hadolint's scope:

```
trivy config --quiet --exit-code 1 --severity MEDIUM,HIGH,CRITICAL …/docker-fixture/Dockerfile
→ Tests: 24 (SUCCESSES: 23, FAILURES: 1)
  DS-0002 (HIGH): Specify at least 1 USER command with non-root user
  exit 1
```
Added `USER 10001:10001`, then:

```
hadolint …/docker-fixture/Dockerfile          → (no output)   exit 0
trivy config --quiet --exit-code 1 --severity MEDIUM,HIGH,CRITICAL …/docker-fixture/Dockerfile
→ (no findings)   exit 0
```

This repository contains **no** Dockerfile (`find` returned none), so this section
is fixture evidence of the workflow, not a finding in this codebase.

## 4. Focused in-repo checks (no broad scans)

This repo's tracked source is small: `git ls-files '*.py' | wc -l` → **4**
(`tests/fixtures/hybrid/{alpha,beta,test_alpha,test_beta}.py`). An earlier
`find`-based count of ~7250 counted untracked/ignored files (notably installed
dependencies under `node_modules/` and venvs) and was **not** a measure of repo
source; it is withdrawn. Scope stayed narrow and is stated explicitly.

```
ruff check tests/ shared/                → All checks passed!   exit 0

PATH="/Users/thomasd/.local/share/opencode-team/best/bin:$PATH" \
  semgrep --config=p/python --metrics=off --quiet --max-target-bytes 1000000 tests/
→ (no findings)   exit 0
```

### Scanner liveness (negative controls)

Semgrep, controlled bad input at `/tmp/semgrep_bad.py`:

```python
import subprocess
def run(cmd):
    subprocess.call(cmd, shell=True)
def run2(cmd):
    subprocess.call(cmd, shell=True)
```

```
PATH="…/best/bin:$PATH" semgrep --config=p/python --metrics=off --quiet /tmp/semgrep_bad.py
→ 2 Code Findings
  python.lang.security.audit.subprocess-shell-true.subprocess-shell-true  (Blocking)
  3 │ subprocess.call(cmd, shell=True)
  5 │ subprocess.call(cmd, shell=True)
  exit 0
```

ast-grep, rule written to `/tmp/sg_rule.yml`:

```yaml
id: no-silent-subprocess
language: python
severity: warning
message: subprocess call found - verify shell=True is intentional
rule:
  pattern: subprocess.$F($$$ARGS)
```

```
ast-grep scan --rule /tmp/sg_rule.yml /tmp/semgrep_bad.py
→ warning[no-silent-subprocess]  /tmp/semgrep_bad.py:3:5   subprocess.call(cmd, shell=True)
  warning[no-silent-subprocess]  /tmp/semgrep_bad.py:5:5   subprocess.call(cmd, shell=True)
  exit 0
```

Both controls fired, so the clean results above are real rather than no-ops.

## 5. Limitations / notes

- **Scanners do not judge intent.** jscpd matches byte-identical text and said
  nothing about whether two different implementations are equivalent; Vulture
  reasons about reachability from the files given; neither establishes that an
  abstraction is unnecessary. That judgement requires reading the code, which is
  what justified dropping the wrapper. Scanners also do not detect all
  overengineering.
- jscpd is token/keyword-based, not semantic. Its default thresholds miss
  one-line duplicates, so `--min-lines` / `--min-tokens` need per-use tuning
  (0 clones at `--min-lines 3` vs 10 at `--min-lines 1 --min-tokens 5` here).
- Vulture needs the consuming files in scope: a symbol used only from tests can
  look unused when tests are omitted. It was clean here only because
  `test_billing.py` was passed alongside the source.
- Semgrep/ast-grep output depends entirely on the ruleset chosen; the focused
  `p/python` run is illustrative, not a security posture. Semgrep autofix was not
  exercised.
- Trivy's vulnerability DB last updated 2026-09-29. `trivy config` here covers
  Dockerfile/misconfig rules, not a package CVE scan (no image was built or
  scanned).
- The `SHELL … pipefail` fix satisfies DL4006 for this Debian-based image; an
  Alpine/busybox `/bin/sh` would need `/bin/ash` set explicitly, per hadolint's
  own hint.
- The pinning in the fixture fix (`curl=7.88.1-10+deb12u5`) is illustrative; a
  real image must pin versions that exist in its configured apt repository.
- No tool was reinstalled during this correction; jscpd's durable location is the
  parent's `npm install --prefix …/best/quality --save-exact jscpd@4.0.5` (exit 0),
  and BEST's PATH covers both `best/bin` and
  `best/quality/node_modules/.bin`.