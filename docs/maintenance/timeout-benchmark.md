# Snapshot-phase benchmark

`tests/benchmark_maintenance.py` measures per-phase timing of
`shared/maintenance.py`'s `snapshot()` workflow using `time.perf_counter`
wrappers. Reuses `test_maintenance.py`'s staging guard, containment, and
session root — no duplicate guards.

## Contract

Run **only** via `tests/guardrail/runner.sh`. Direct invocation raises
`RuntimeError` at import. The module-level guard from `test_maintenance.py`
requires `OPENCODE_TEAM_STAGING_ROOT` and confines HOME/TEAM/TMPDIR to the
staging root. `run_command` is disabled (subprocess guard).

## Execution

```bash
bash tests/guardrail/runner.sh benchmark
bash tests/guardrail/runner.sh profile
bash tests/guardrail/runner.sh qualification
```

All targets first require the 13 isolation negative controls. Output, including
stderr, is captured through a pipe inside the sandbox before the runner writes
it to a persistent log; redirecting a sandboxed process's stderr directly to an
outside log is denied by the write policy. No sandbox permissions were widened.

## Matrix

2 configs × 2 budgets × 5 reps = 20 snapshot runs:

| config | sessions | target |
|--------|----------|--------|
| small  | 100      | ~100 MiB |
| large  | 650      | ~700 MiB (BEST-profile) |

Budgets: 30 s (historical rc2 entrypoint default) and 120 s (current Python
entrypoint default). The explicit matrix values remain unchanged for comparison.

## Measured phases

Patched functions (production flow, real I/O):

| phase | function |
|-------|----------|
| previous_sha256 / new_sha256 | `maintenance.checksum()` split by published/pending target |
| logical | `maintenance.logical_checksum()` — SHA-256 of typed rows |
| quick_check | `maintenance.quick_check()` — integrity pragma |
| fsync | `os.fsync()` — all sync calls during snapshot |
| total | wall-clock around full `snapshot()` call |
| inventory_probe | independent directory-list probe immediately before each snapshot |

Plus `snapshot()`'s own `timing_ms` fields (verify_existing, backup_ms,
integrity_ms, logical_ms, checksum_ms, publish_ms, retention_ms) merged
into the per-phase stats. Isolated one-shot measurements for checksum,
logical_checksum, verify_snapshot (dominant I/O only).

## Integrity

After each cell: latest snapshot's checksum + session-count verified
against source. Failure → cell status `failed` → exit 1.

## Outcome codes

| code | meaning |
|-----:|---------|
| 0 | All cells: 5 reps done, integrity ok, no phase errors |
| 1 | Any cell incomplete (<5 reps), integrity false, or phase error |

## Limits (declared in output)

- Synthetic payload: deterministic, distinct SHAKE256-derived 1 MiB blobs;
  representative of volume, not production row-size distribution or entropy.
- `fsync` timing measures the Python wrapper + OS page-cache, not raw
  device commit.
- WAL fixture only — no concurrent writer/reader (not claimed).
- Bounded global runtime (1800 s); cells skip once exceeded.

## Final execution: rc2-compatible optimization

Evidence: `.local-release-evidence/final-execution-digest/` (new directory; rc2
evidence untouched). Commands below were run serially, foreground, with no
parallel benchmark launched by this lane. Host scheduling/I/O were variable;
these are observed wall times, not guaranteed production latency.

`profile` builds a deterministic **736,198,656-byte**, 650-session fixture with
700 distinct SHAKE256-derived 1 MiB BLOBs. It separately times fetch/allocation,
tuple repr, UTF-8 encoding, row hashing and sorting; compares the full digest to
a frozen rc2 oracle; measures Python allocation peaks in separate traced passes;
and runs five full snapshots with each digest implementation at a 120 s budget.
Only the digest is swapped for the baseline; the WAL read-transaction correction
is common to both, so the snapshot comparison isolates serialization changes.

From `profile-release-view.log` (exact final code), exit 0:

| Metric | rc2 digest | optimized digest |
|---|---:|---:|
| Snapshot logical median / max | 4.523 / 4.648 s | 3.424 / 3.447 s |
| Full snapshot median / max | 7.779 / 8.242 s | 6.665 / 7.373 s |
| Isolated logical | 4.653 s | 3.407 s |
| Python traced allocation peak | 8,931,060 bytes | 6,346,895 bytes |
| Snapshot completions / integrity | 5/5, true | 5/5, true |

The profiled baseline's fetch/repr/encode/hash/sort were respectively
0.458/3.739/0.106/0.775/0.000097 s. Sorting is negligible; serialization is the
dominant cost. The promoted implementation hashes the **exact existing tuple
repr byte stream** incrementally, using native `codecs.escape_encode` for BLOBs
with Python's quote-selection rule. It does not retain an escaped BLOB into the
next row. No manifest format, schema or digest algorithm changed. Deterministic
fixture logical SHA-256 (both implementations):
`4acec90ed22ccdba3e1f59635b77947edad160528a5681033d28c01f2ebe078a`.
Tests cover scalar boundaries, Unicode/NUL, BLOB quote/backslash/all-byte cases,
duplicates, rowid changes, reversed scan order, WITHOUT ROWID, shadowed aliases,
and reuse of an rc2-generated manifest without republication.

### WAL correction and 30 consecutive snapshots

The first qualification discovered repeatable backup starvation under a commit
every 50 ms: SQLite restarted the unpinned backup until the 120 s deadline.
`wal-red.log` reproduces it deterministically with a commit after every backup
step. A read-only `BEGIN` before source metadata reads pins a coherent WAL view;
it is rolled back immediately after backup, before target checks/digest, so the
source read view is not unnecessarily retained. The existing connection context
also rolls back/closes on failures. This preserves the
snapshot contract while preventing concurrent commits from restarting progress.

`qualification-30-release-view.log`, exit 0, records **30/30 created snapshots**
on the exact final code, each
with matching manifest file checksum and 650 restored sessions:

| Consecutive runs | Controlled conditions | median / p95 / max |
|---|---|---:|
| 1–10 | idle fixture | 7.068 / 7.222 / 7.222 s |
| 11–20 | pinned WAL reader + writer committing every 50 ms | 7.198 / 7.731 / 7.731 s |
| 21–30 | same WAL load + one SHA-256 worker + 8 MiB rewrite/fsync every 50 ms | 7.367 / 7.831 / 7.831 s |

This batch recorded 2,571 WAL commits, 130,616 CPU hashes and 1,206 load fsyncs.
An earlier complete **30/30** qualification (`qualification-30-final.log`),
before shortening the source transaction lifetime, recorded median/max of
27.111/39.143 s idle, 11.474/88.141 s WAL and 11.010/13.591 s WAL+CPU+I/O.
Host variability in that batch is retained in the budget evidence; the final
faster batch does not erase the earlier long successful observations.

The pinned reader starts before the writer and remains open throughout each
snapshot. The writer appends only synthetic scratch rows. The CPU worker hashes
a fixed 1 MiB buffer continuously; the I/O worker rewrites one bounded 8 MiB file
inside the exclusive fixture root. Stop events and bounded joins clean them up;
worker errors fail the qualification. Per-run commit/hash/fsync counters prove
work occurred. `fsync` wrapper timings in these runs include the load worker's
fsyncs, so only total snapshot latency is used for budget selection. Each mode
has ten samples; reported p95 is the maximum for this sample size. No real
data, services, launchctl, Docker, Homebrew or network are used.

### Budget decision / authoritative Python default

**30 s is not qualified.** `profile-comparison.log` recorded three baseline
timeouts and one initial-variant timeout at 30 s. The first complete qualification
also measured successful idle runs above 30 s and a WAL maximum of 88.141 s. The
existing alternative benchmark budget **120 s** is retained as the finite
qualification budget: 31.859 s (36.1%) margin above the measured maximum. This
is not an incremental timeout trial or a production guarantee. The argparse
default in `shared/maintenance.py` is now **120 s**, inherited by CLI and scheduler
through the same entrypoint. No duplicate plist timeout argument or profile edit
is needed. Explicit finite positive CLI overrides remain supported; zero,
negative, nonfinite and nonnumeric values are rejected before maintenance starts.
The low-level `snapshot(..., budget=30)` API default and intentional historical
30 s/deadline fixtures are unchanged: `main` always passes its parsed timeout.
No LaunchAgent was installed.

The qualification has an independent 4500 s global deadline and a hard runner
process timeout of 5400 s (covers 30 × 120 s plus integrity checks/fixture
setup); ordinary matrix/profile targets retain a hard 1800 s timeout. Any
missing sample, timeout, worker error or integrity failure returns nonzero.
The first failed attempts and an initially 300 s-bounded full-suite run remain
in the evidence directory; the complete full suite was rerun successfully with
a 1200 s host timeout. Earlier noisy comparisons are retained, not discarded.

### Reproduction and gates

```bash
bash tests/guardrail/runner.sh maintenance
bash tests/guardrail/runner.sh profile
bash tests/guardrail/runner.sh qualification
bash tests/guardrail/runner.sh all
```

`compatibility-red.log` records a deliberately incorrect initial BLOB quoting
variant rejected by the compatibility test. `wal-red.log` records the real
concurrent-commit failure before `BEGIN`; `maintenance-green.log` and
`suite-release-view.log` record the corrections. `SHA256SUMS` in the evidence directory
binds the logs; it is not a release or deployment receipt.

The full protected suite exits 0: Python groups 13/59/15/2, Node groups
51/3/6/4 (two intentional native-evidence skips), plus the nested smoke groups
and seven release-workflow scenarios. Focused Ruff (`F,D301,D400,D415,D419`)
and `git diff --check` exit 0. Full repository-configured Ruff exits 1 with
23 findings in existing unchanged code (executable bit, exception conventions,
and existing test style); these were not silently ignored or broadly refactored.
Coverage and a separate type check were not measured. Independent integration
review remains the parent session's responsibility.

### Default-120 follow-up

`default120-red.log` records the default regression failing against the previous
30 s argparse default. `default120-all-final.log` records the full protected suite
after changing that default to 120 s, including both profiles receiving 120 s,
error receipts reporting 120,000 ms, a finite 15.5 s override, and invalid inputs.
The initial full run (`default120-all.log`) exposed a retention regression
fixture relying on the old implicit 30 s deadline with a simulated 100 s clock
jump. That fixture now passes `--timeout 30` explicitly, preserving its intended
failure scenario rather than changing its clock or weakening assertions.
The two successful 30-snapshot batches above both used **120 s budgets**: the
earlier host-variable batch reached **88.141 s**, and the later exact final
backup implementation reached **7.831 s**. They are not 30 s-budget passes;
neither batch is hidden or replaced by the other. Historical 30 s failures
remain separate evidence.

Previous `source-sha256.json`, `SHA256SUMS`, logs and rc2 evidence are preserved.
Follow-up hashes are saved separately as `source-sha256-default120.json` and
`SHA256SUMS-default120` in the same final-execution directory.
