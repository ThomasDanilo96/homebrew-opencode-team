"""Per-phase timing benchmark for shared/maintenance.py — reuses
test_maintenance.py's staging guard, containment, and session root.
Run ONLY via tests/guardrail/runner.sh (direct invocation raises at import).

Patches the real maintenance functions (checksum, logical_checksum,
quick_check, os.fsync) with time.perf_counter wrappers to measure each
phase inside the production snapshot() flow. Also reports isolated
one-shot I/O and post-snapshot integrity (checksum + row-count).

Default: 2 configs × 2 budgets × 5 reps. The profile target compares the frozen
rc2 digest; qualification runs 30 consecutive snapshots with controlled loads.
Incomplete samples, integrity failures and phase errors fail closed.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
import tracemalloc
from pathlib import Path
from unittest import mock

if "test_maintenance" in sys.modules:
    _tm = sys.modules["test_maintenance"]
else:
    import test_maintenance as _tm  # side effect: guard + containment

maintenance = _tm.maintenance
SNAPSHOTS = maintenance.SNAPSHOTS
PROFILE = "best"

SMALL = {"name": "small", "sessions": 100, "mib": 100}
LARGE = {"name": "large", "sessions": 650, "mib": 700}
CONFIGS, BUDGETS, REPS, GLOBAL_BUDGET_S = [SMALL, LARGE], [30, 120], 5, 1800
QUALIFICATION_BUDGET_S, QUALIFICATION_GLOBAL_BUDGET_S = 120, 4500


def profile_digest():
    tmp = Path(tempfile.mkdtemp(prefix="ocgt-profile-"))
    path = tmp / "fixture.db"
    try:
        build_fixture(str(path), LARGE["sessions"], LARGE["mib"])
        timings = {key: 0.0 for key in ("fetch", "repr", "encode", "hash", "sort")}
        db = sqlite3.connect(path)
        hashes = []
        cursor = db.execute("SELECT rowid,* FROM benchmark_payload")
        while True:
            start = time.perf_counter()
            row = cursor.fetchone()
            timings["fetch"] += time.perf_counter() - start
            if row is None:
                break
            start = time.perf_counter()
            text = repr(row)
            timings["repr"] += time.perf_counter() - start
            start = time.perf_counter()
            encoded = text.encode("utf-8")
            timings["encode"] += time.perf_counter() - start
            start = time.perf_counter()
            hashes.append(hashlib.sha256(encoded).digest())
            timings["hash"] += time.perf_counter() - start
        start = time.perf_counter()
        hashes.sort()
        timings["sort"] += time.perf_counter() - start
        start = time.perf_counter()
        reference = _tm.legacy_logical_checksum(db)
        baseline = time.perf_counter() - start
        start = time.perf_counter()
        digest = maintenance.logical_checksum(db)
        elapsed = time.perf_counter() - start
        allocation_peaks = {}
        for name, function in (("baseline", _tm.legacy_logical_checksum),
                               ("optimized", maintenance.logical_checksum)):
            tracemalloc.start()
            try:
                function(db)
                allocation_peaks[name] = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        db.close()
        deadline = time.monotonic() + GLOBAL_BUDGET_S
        with mock.patch.object(maintenance, "logical_checksum", _tm.legacy_logical_checksum):
            before = run_cell(LARGE, QUALIFICATION_BUDGET_S, deadline)
        after = run_cell(LARGE, QUALIFICATION_BUDGET_S, deadline)
        print(json.dumps({"fixture_bytes": path.stat().st_size, "phases_s": timings,
                          "baseline_logical_s": baseline, "logical_s": elapsed,
                          "logical_checksum": digest, "exact_legacy_match": reference == digest,
                          "python_allocation_peak_bytes": allocation_peaks,
                          "baseline": before, "optimized": after}, sort_keys=True))
        return int(reference != digest or before["status"] != "ok" or after["status"] != "ok")
    finally:
        shutil.rmtree(tmp)

def build_fixture(db_path: str, sessions: int, mib: int) -> None:
    """Synthetic session_v2 + activity schema, blob payload, tiny WAL freelist."""
    Path(db_path).touch(mode=0o600, exist_ok=False)
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA auto_vacuum=2")
    db.executescript("""
        CREATE TABLE session_v2 (
            id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
            time_created INTEGER, time_updated INTEGER, time_idle INTEGER,
            time_viewed INTEGER, time_archived INTEGER, idle_outcome TEXT,
            time_suspended INTEGER, time_compacting INTEGER, resume_attempts INTEGER,
            pinned INTEGER);
        CREATE TABLE session_inbox (session_id TEXT);
        CREATE TABLE session_pending (session_id TEXT);
        CREATE TABLE session_execution_claim (session_id TEXT);
        CREATE TABLE session_use (session_id TEXT);
        CREATE TABLE benchmark_payload (id INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE scratch (value BLOB);
    """)
    old = 1600000000000
    db.executemany(
        "INSERT INTO session_v2 VALUES (?,NULL,NULL,?,?,?,?,?,?,NULL,NULL,0,0)",
        [(f"ocgt-session-{i}", old, old, old, old, old, "succeeded")
         for i in range(sessions)],
    )
    for i in range(mib):
        chunk = hashlib.shake_256(f"synthetic-{i}".encode()).digest(1024 * 1024)
        db.execute("INSERT INTO benchmark_payload VALUES (?, ?)", (i, chunk))
        if i % 50 == 0:
            db.commit()
    db.commit()
    db.executemany("INSERT INTO scratch VALUES (?)", [(b"x" * 4096,) for _ in range(50)])
    db.commit()
    db.execute("DELETE FROM scratch")
    db.commit()
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA wal_autocheckpoint=0")
    db.execute("INSERT INTO session_inbox VALUES ('ocgt-session-0')")
    db.commit()
    db.close()


def phase_patchers():
    """mock.patch objects wrapping maintenance functions with perf_counter."""
    timings: dict[str, float] = {"previous_sha256": 0.0}
    def _wrap(name, fn):
        def w(*a, **k):
            label = name
            if name == "checksum":
                label = "new_sha256" if Path(a[0]).parent.name.startswith(".pending-") else "previous_sha256"
            t0 = time.perf_counter()
            try:
                return fn(*a, **k)
            finally:
                timings[label] = timings.get(label, 0.0) + time.perf_counter() - t0
        return w
    return [
        mock.patch.object(maintenance, "checksum", _wrap("checksum", maintenance.checksum)),
        mock.patch.object(maintenance, "logical_checksum", _wrap("logical", maintenance.logical_checksum)),
        mock.patch.object(maintenance, "quick_check", _wrap("quick_check", maintenance.quick_check)),
        mock.patch.object(maintenance.os, "fsync", _wrap("fsync", maintenance.os.fsync)),
    ], timings


def dist_ms(samples):
    if not samples:
        return {"n": 0}
    s = sorted(samples)
    n = len(s)
    return {"n": n,
            "min_ms": round(s[0]*1000, 1),
            "median_ms": round(statistics.median(s)*1000, 1),
            "p95_ms": round((s[int(n*0.95)] if n > 1 else s[0])*1000, 1),
            "max_ms": round(s[-1]*1000, 1)}


def verify_integrity(db_path: str, state_dir: Path, profile: str, expected: int) -> dict:
    snap_dir = state_dir / SNAPSHOTS / profile
    entries = sorted(d for d in snap_dir.iterdir()
                     if d.is_dir() and not d.name.startswith(".")) if snap_dir.exists() else []
    if not entries:
        return {"ok": False, "reason": "no_snapshot"}
    latest = entries[-1]
    manifest = json.loads((latest / "manifest.json").read_text())
    db_file = latest / "database.db"
    sha = maintenance.checksum(db_file)
    s = sqlite3.connect(db_path)
    d = sqlite3.connect(str(db_file))
    sn = s.execute("SELECT count(*) FROM session_v2").fetchone()[0]
    dn = d.execute("SELECT count(*) FROM session_v2").fetchone()[0]
    s.close()
    d.close()
    return {"ok": sha == manifest["sha256"] and sn == dn == expected,
            "checksum_match": sha == manifest["sha256"],
            "sessions_match": sn == dn == expected,
            "source_sessions": sn, "restored_sessions": dn, "expected": expected}


def isolated(db_path: str, state_dir: Path, profile: str, deadline) -> dict:
    """One-shot dominant-I/O measurements (production timing, no snapshot flow)."""
    out = {"fixture_bytes": Path(db_path).stat().st_size if Path(db_path).exists() else 0}
    t0 = time.perf_counter()
    maintenance.checksum(db_path, deadline)
    out["checksum_iso_ms"] = round((time.perf_counter()-t0)*1000, 1)
    c = sqlite3.connect(db_path)
    c.set_progress_handler(lambda: int(time.monotonic() >= deadline), 100)
    t0 = time.perf_counter()
    maintenance.logical_checksum(c, deadline)
    out["logical_iso_ms"] = round((time.perf_counter()-t0)*1000, 1)
    c.close()
    snap_dir = state_dir / SNAPSHOTS / profile
    if snap_dir.exists():
        entries = sorted(d for d in snap_dir.iterdir()
                         if d.is_dir() and not d.name.startswith("."))
        if entries:
            t0 = time.perf_counter()
            maintenance.verify_snapshot(entries[-1], deadline)
            out["verify_iso_ms"] = round((time.perf_counter()-t0)*1000, 1)
    return out


def run_cell(config, budget, deadline):
    tmp = Path(tempfile.mkdtemp(prefix="ocgt-bench-")).resolve()
    state_dir = (tmp / "state/maintenance").resolve()
    db_path = str(tmp / "data" / PROFILE / "data/opencode/opencode.db")
    Path(db_path).parent.mkdir(parents=True, mode=0o700)
    build_fixture(db_path, config["sessions"], config["mib"])

    phase_samples: dict[str, list[float]] = {}
    errors = []
    reps_done = 0

    for rep in range(REPS):
        if time.monotonic() > deadline:
            break
        db = sqlite3.connect(db_path)
        db.execute("INSERT INTO scratch VALUES (?)", (f"bench-{time.time_ns()}-{rep}".encode(),))
        db.commit()
        db.close()

        effective_budget = min(budget, max(1.0, deadline - time.monotonic()))
        inventory_started = time.perf_counter()
        directory = state_dir / SNAPSHOTS / PROFILE
        if directory.exists():
            list(directory.iterdir())
        phase_samples.setdefault("inventory_probe", []).append(time.perf_counter() - inventory_started)
        patchers, timings = phase_patchers()
        for p in patchers:
            p.start()
        t0 = time.perf_counter()
        try:
            report = maintenance.snapshot(db_path, state_dir, PROFILE, budget=effective_budget)
            total = time.perf_counter() - t0
            reps_done += 1
            merged = {k: v/1000.0 for k, v in report.get("timing_ms", {}).items()}
            merged.update(timings)
            merged["total"] = total
            for k, v in merged.items():
                phase_samples.setdefault(k, []).append(v)
            if report.get("status") == "error":
                errors.append({"rep": rep, "phase": report.get("phase"),
                               "reason": report.get("reason")})
        except (TimeoutError, OSError, ValueError, sqlite3.Error) as error:
            errors.append({"rep": rep, "phase": getattr(error, "phase", "unknown"),
                           "reason": getattr(error, "snapshot_reason", type(error).__name__),
                           "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1)})
        finally:
            for p in patchers:
                p.stop()

    integrity = verify_integrity(db_path, state_dir, PROFILE, config["sessions"])
    iso = isolated(db_path, state_dir, PROFILE, deadline) if reps_done > 0 else {}
    shutil.rmtree(tmp, ignore_errors=True)

    status = "incomplete" if reps_done < REPS else ("failed" if not integrity["ok"] or errors else "ok")
    return {"config": config["name"], "sessions": config["sessions"],
            "target_mib": config["mib"], "budget": budget, "reps_done": reps_done,
            "phase_stats": {k: dist_ms(v) for k, v in phase_samples.items()},
            "isolated": iso, "errors": errors, "integrity": integrity, "status": status}


def main():
    deadline = time.monotonic() + GLOBAL_BUDGET_S
    results, exit_code = [], 0
    for config in CONFIGS:
        for budget in BUDGETS:
            cell = run_cell(config, budget, deadline)
            results.append(cell)
            if cell["status"] != "ok":
                exit_code = 1
            if time.monotonic() > deadline:
                break
        if time.monotonic() > deadline:
            break
    cells_expected = len(CONFIGS) * len(BUDGETS)
    complete = len(results) == cells_expected
    if not complete:
        exit_code = 1
    report = {"benchmark": "snapshot_phases",
              "cells_expected": cells_expected, "cells_completed": len(results),
              "matrix_complete": complete,
              "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "reps_target": REPS, "configs": [c["name"] for c in CONFIGS],
              "budgets": BUDGETS, "results": results,
              "limits": {"fixture_synthetic": True,
                          "payload": "deterministic_SHAKE256_distinct_1MiB_blobs",
                         "fsync_wrapper_only": True,
                         "wal_fixture_only_no_concurrent_io": True,
                         "note": "fsync measures Python wrapper + OS cache, "
                                 "not raw device commit. No concurrent "
                                 "writer/reader. Synthetic payload."}}
    print(json.dumps(report, indent=2, sort_keys=True))
    return exit_code


@contextlib.contextmanager
def controlled_load(db_path, root, mode):
    stop = threading.Event()
    counts = {"wal_commits": 0, "cpu_hashes": 0, "io_fsyncs": 0}
    errors = []
    reader = None
    if mode != "idle":
        reader = sqlite3.connect(db_path)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM scratch").fetchone()

    def work(kind):
        try:
            if kind == "wal_commits":
                with contextlib.closing(sqlite3.connect(db_path, timeout=1)) as writer:
                    while not stop.is_set():
                        writer.execute("INSERT INTO scratch VALUES (?)", (b"controlled-wal",))
                        writer.commit()
                        counts[kind] += 1
                        stop.wait(0.05)
            elif kind == "cpu_hashes":
                block = b"c" * (1024 * 1024)
                while not stop.is_set():
                    hashlib.sha256(block).digest()
                    counts[kind] += 1
            else:
                block = b"i" * (8 * 1024 * 1024)
                with (root / "io-load.bin").open("wb") as output:
                    while not stop.is_set():
                        output.seek(0)
                        output.write(block)
                        output.flush()
                        os.fsync(output.fileno())
                        counts[kind] += 1
                        stop.wait(0.05)
        except (OSError, sqlite3.Error) as error:
            errors.append(type(error).__name__)

    kinds = [] if mode == "idle" else ["wal_commits"]
    if mode == "wal_cpu_io":
        kinds += ["cpu_hashes", "io_fsyncs"]
    workers = [threading.Thread(target=work, args=(kind,), daemon=True) for kind in kinds]
    for worker in workers:
        worker.start()
    try:
        yield counts
    finally:
        stop.set()
        for worker in workers:
            worker.join(timeout=5)
        if reader is not None:
            reader.close()
        if errors or any(worker.is_alive() for worker in workers):
            raise RuntimeError("controlled-load-failed: " + repr(errors))


def qualification():
    deadline = time.monotonic() + QUALIFICATION_GLOBAL_BUDGET_S
    tmp = Path(tempfile.mkdtemp(prefix="ocgt-qualification-"))
    path = tmp / "data/best/data/opencode/opencode.db"
    path.parent.mkdir(parents=True, mode=0o700)
    state = tmp / "state/maintenance"
    runs = []
    try:
        build_fixture(str(path), LARGE["sessions"], LARGE["mib"])
        for rep in range(30):
            if time.monotonic() >= deadline:
                break
            mode = ("idle", "wal", "wal_cpu_io")[rep // 10]
            with contextlib.closing(sqlite3.connect(path)) as db:
                db.execute("INSERT INTO scratch VALUES (?)", (f"qualification-{rep}".encode(),))
                db.commit()
            patchers, timings = phase_patchers()
            with contextlib.ExitStack() as stack:
                for patcher in patchers:
                    stack.enter_context(patcher)
                counts = stack.enter_context(controlled_load(str(path), tmp, mode))
                start = time.perf_counter()
                report = maintenance.snapshot(str(path), state, PROFILE, budget=QUALIFICATION_BUDGET_S)
                elapsed = time.perf_counter() - start
            integrity = verify_integrity(str(path), state, PROFILE, LARGE["sessions"])
            ok = (report["status"] == "created" and integrity["ok"]
                  and all(counts[k] > 0 for k in counts if mode == "wal_cpu_io" or
                          (mode == "wal" and k == "wal_commits")))
            run = {"rep": rep + 1, "mode": mode, "total_s": elapsed,
                   "report": report, "timings_s": timings, "load_counts": counts,
                   "integrity": integrity, "ok": ok}
            runs.append(run)
            print(json.dumps({"qualification_run": run}, sort_keys=True), flush=True)
            if not ok:
                break
        complete = len(runs) == 30 and all(run["ok"] for run in runs)
        print(json.dumps({"qualification_complete": complete, "runs": len(runs),
                          "budget_s": QUALIFICATION_BUDGET_S, "fixture_bytes": path.stat().st_size,
                          "stats": {mode: dist_ms([r["total_s"] for r in runs if r["mode"] == mode])
                                    for mode in ("idle", "wal", "wal_cpu_io")}}, sort_keys=True))
        return 0 if complete else 1
    finally:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    operation = {"profile": profile_digest, "qualification": qualification,
                 "benchmark": main}.get(sys.argv[1] if len(sys.argv) > 1 else "benchmark")
    if operation is None:
        raise SystemExit("unknown benchmark target")
    raise SystemExit(operation())
