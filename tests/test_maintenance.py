"""Disposable SQLite integration tests; never run live cleanup or Homebrew."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


ROOT = Path(__file__).absolute().parents[1]
SPEC = importlib.util.spec_from_file_location("maintenance", ROOT / "shared/maintenance.py")
assert SPEC is not None and SPEC.loader is not None
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # macOS's /var alias is intentionally resolved for these test fixtures.
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.team = self.root / "team"
        self.db = self.team / "data/best/data/opencode/opencode.db"
        self.db.parent.mkdir(parents=True, mode=0o700)
        self.state = self.team / "state/maintenance"
        self.env = {"HOME": str(self.home), "OPENCODE_TEAM_HOME": str(self.team),
                    "PATH": "/usr/bin:/bin", "FAKE_TOKEN": "never-forward"}

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, auto=2, wal=False):
        db = sqlite3.connect(self.db)
        db.execute(f"PRAGMA auto_vacuum={auto}")
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
            CREATE TABLE credentials (value TEXT);
            INSERT INTO credentials VALUES ('fixture-secret-not-for-logs');
            CREATE TABLE history (value TEXT);
            INSERT INTO history VALUES ('historical-sentinel');
            CREATE TABLE scratch (value BLOB);
        """)
        old = int((time.time() - 100 * 86400) * 1000)
        db.executemany("INSERT INTO session_v2 VALUES (?,NULL,NULL,?,?,?,?,?,?,NULL,NULL,0,0)",
                       [(f"session-{i}", old, old, old, old, old, "succeeded")
                        for i in range(641)])
        db.executemany("INSERT INTO scratch VALUES (?)", [(b"x" * 6000,)] * 500)
        db.commit()
        db.execute("DELETE FROM scratch")  # fixture-only freelist, never production
        db.commit()
        if wal:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA wal_autocheckpoint=0")
            db.execute("INSERT INTO history VALUES ('wal-sentinel')")
            db.commit()
        return db

    def rows(self, db):
        return tuple(tuple(db.execute(f"SELECT * FROM {table} ORDER BY rowid"))
                     for table in ("session_v2", "history", "credentials"))

    def test_report_family_protection_and_no_sensitive_output(self):
        db = self.fixture()
        db.execute("UPDATE session_v2 SET parent_id='session-0' WHERE id='session-1'")
        db.execute("INSERT INTO session_pending VALUES ('session-1')")
        db.execute("UPDATE session_v2 SET pinned=1 WHERE id='session-2'")
        db.execute("UPDATE session_v2 SET fork_session_id='session-2' WHERE id='session-3'")
        db.execute("UPDATE session_v2 SET time_updated=? WHERE id='session-4'",
                   (int(time.time() * 1000),))
        db.execute("UPDATE session_v2 SET idle_outcome=NULL WHERE id='session-5'")
        db.execute("UPDATE session_v2 SET time_archived=NULL WHERE id='session-6'")
        db.execute("UPDATE session_v2 SET time_suspended=1 WHERE id='session-7'")
        db.execute("UPDATE session_v2 SET time_compacting=1 WHERE id='session-8'")
        db.execute("UPDATE session_v2 SET resume_attempts=1 WHERE id='session-9'")
        db.execute("INSERT INTO session_inbox VALUES ('session-10')")
        db.execute("INSERT INTO session_execution_claim VALUES ('session-11')")
        db.execute("INSERT INTO session_use VALUES ('session-12')")
        db.commit()
        before = self.rows(db)
        report = maintenance.session_report(self.db)
        self.assertEqual(report["total"], 641)
        self.assertEqual(report["protected"], 13)
        self.assertEqual(report["potential_review"], 628)
        self.assertEqual(self.rows(db), before)
        self.assertNotIn("session-", json.dumps(report))
        self.assertNotIn("fixture-secret", json.dumps(report))
        db.close()

    def test_unknown_schema_fails_closed_and_missing_never_created(self):
        sqlite3.connect(self.db).close()
        with self.assertRaises(ValueError):
            maintenance.session_report(self.db)
        missing = self.db.parent / "missing.db"
        self.assertEqual(maintenance.session_report(missing)["status"], "missing")
        self.assertFalse(missing.exists())

    def test_existing_035_state_directory_is_reused_without_chmod(self):
        db = self.fixture()
        self.state.mkdir(parents=True, mode=0o755)
        self.state.chmod(0o755)
        with maintenance.locked(self.state):
            self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.state / maintenance.SNAPSHOTS).stat().st_mode & 0o777, 0o700)
        self.state.chmod(0o777)
        with self.assertRaises(ValueError):
            with maintenance.locked(self.state):
                self.fail("writable state accepted")
        db.close()

    def test_native_schema_without_optional_pin_or_claim_table(self):
        db = self.fixture()
        db.execute("ALTER TABLE session_v2 RENAME TO old_session")
        db.execute("CREATE TABLE session_v2 AS SELECT id,parent_id,fork_session_id,time_created,"
                   "time_updated,time_idle,time_viewed,time_archived,idle_outcome,time_suspended,"
                    "time_compacting,resume_attempts FROM old_session")
        db.execute("DROP TABLE old_session")
        db.execute("DROP TABLE session_execution_claim")
        db.execute("UPDATE session_v2 SET time_suspended=1 WHERE id='session-1'")
        db.execute("UPDATE session_v2 SET fork_session_id='session-1' WHERE id='session-2'")
        db.commit()
        self.assertEqual(maintenance.session_report(self.db)["protected"], 2)
        db.execute("ALTER TABLE session_pending RENAME COLUMN session_id TO unknown")
        db.commit()
        with self.assertRaises(ValueError):
            maintenance.session_report(self.db)
        db.close()

    def test_backup_restore_checksum_dedup_retention_and_unrelated_preserved(self):
        db = self.fixture(wal=True)
        expected = self.rows(db)
        unrelated = self.team / "state/old-backup.db"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_bytes(b"leave-alone")
        first = maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(first["status"], "created")
        snapshots = self.state / maintenance.SNAPSHOTS / "best"
        saved = next(snapshots.glob("*/database.db"))
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        manifest = json.loads((saved.parent / "manifest.json").read_text())
        self.assertEqual(hashlib.sha256(saved.read_bytes()).hexdigest(), manifest["sha256"])
        with contextlib.closing(sqlite3.connect(saved)) as restored:
            self.assertEqual(restored.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertEqual(self.rows(restored), expected)
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "unchanged")
        maintenance.reclaim(self.db)
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "unchanged")
        self.assertEqual(len(list(snapshots.iterdir())), 1)
        for i in range(4):
            db.execute("INSERT INTO history VALUES (?)", (str(i),))
            db.commit()
            for entry in snapshots.iterdir():
                self.assertEqual({child.name for child in entry.iterdir()},
                                 {"database.db", "manifest.json"})
            self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        self.assertEqual(len(list(snapshots.iterdir())), 3)
        self.assertEqual(unrelated.read_bytes(), b"leave-alone")
        db.close()

    def test_failed_timeout_and_corrupt_backup_never_prune_good(self):
        db = self.fixture()
        with self.assertRaises(TimeoutError):
            maintenance.snapshot(self.db, self.state, "best", budget=0)
        snapshots = self.state / maintenance.SNAPSHOTS / "best"
        self.assertEqual(list(snapshots.iterdir()), [])
        maintenance.snapshot(self.db, self.state, "best")
        db.execute("INSERT INTO history VALUES ('second-good-snapshot')")
        db.commit()
        maintenance.snapshot(self.db, self.state, "best")
        before = set(snapshots.iterdir())
        with self.assertRaises(TimeoutError):
            maintenance.verify_snapshot(next(iter(before)), deadline=0)
        db.execute("INSERT INTO history VALUES ('change')")
        db.commit()
        with self.assertRaises(TimeoutError):
            maintenance.snapshot(self.db, self.state, "best", budget=0)
        self.assertEqual(set(snapshots.iterdir()), before)
        with mock.patch.object(maintenance, "quick_check", side_effect=sqlite3.DatabaseError):
            with self.assertRaises(sqlite3.DatabaseError):
                maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(set(snapshots.iterdir()), before)
        saved = next(snapshots.glob("*/database.db"))
        saved.write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            maintenance.verify_snapshot(saved.parent)
        with self.assertRaises(ValueError):
            maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(set(snapshots.iterdir()), before)
        for good in before - {saved.parent}:
            maintenance.verify_snapshot(good)
        db.close()

    def test_snapshot_dedup_preserves_text_after_nul(self):
        db = self.fixture()
        db.execute("INSERT INTO history VALUES (?)", ("a\0old",))
        db.commit()
        maintenance.snapshot(self.db, self.state, "best")
        db.execute("UPDATE history SET value=? WHERE value=?", ("a\0new", "a\0old"))
        db.commit()
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        latest = sorted((self.state / maintenance.SNAPSHOTS / "best").iterdir())[-1]
        with contextlib.closing(sqlite3.connect(latest / "database.db")) as restored:
            self.assertIn(("a\0new",), list(restored.execute("SELECT value FROM history")))
        db.close()

    def test_interrupted_prune_retries_without_blocking_future_backups(self):
        db = self.fixture()
        for i in range(3):
            db.execute("INSERT INTO history VALUES (?)", (str(i),))
            db.commit()
            maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        db.execute("INSERT INTO history VALUES ('fourth')")
        db.commit()
        original = Path.unlink
        calls = []

        def interrupted(path, *args, **kwargs):
            if path.parent.parent == directory and not path.parent.name.startswith(".pending-"):
                calls.append(path)
                if len(calls) == 2:
                    raise OSError("fixture-prune-interruption")
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", interrupted):
            with self.assertRaises(OSError):
                maintenance.snapshot(self.db, self.state, "best")
        maintenance.snapshot(self.db, self.state, "best")
        published = [entry for entry in directory.iterdir() if not entry.name.startswith(".")]
        self.assertEqual(len(published), 3)
        self.assertFalse(any(entry.name.startswith(".retired-") for entry in directory.iterdir()))
        for entry in published:
            maintenance.verify_snapshot(entry)
        db.close()

    def test_unchanged_retry_finishes_retention_after_post_publication_timeout(self):
        db = self.fixture()
        for i in range(3):
            db.execute("INSERT INTO history VALUES (?)", (str(i),))
            db.commit()
            maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        db.execute("INSERT INTO history VALUES ('fourth')")
        db.commit()
        original_rename, original_clock = Path.rename, time.monotonic
        published = []

        def rename(source, target):
            result = original_rename(source, target)
            if source.name.startswith(".pending-"):
                published.append(target)
            return result

        with mock.patch.object(Path, "rename", rename), \
                mock.patch.object(maintenance.time, "monotonic", side_effect=lambda: original_clock() + (100 if published else 0)):
            with self.assertRaises(TimeoutError):
                maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(len(list(directory.iterdir())), 4)
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "unchanged")
        self.assertEqual(len(list(directory.iterdir())), 3)
        db.close()

    def test_directory_sync_failure_never_prunes_recovery_copies(self):
        db = self.fixture()
        for i in range(3):
            db.execute("INSERT INTO history VALUES (?)", (str(i),))
            db.commit()
            maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        old = set(directory.iterdir())
        db.execute("INSERT INTO history VALUES ('fourth')")
        db.commit()
        original = os.fsync

        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("fixture-directory-sync")
            original(fd)

        with mock.patch.object(maintenance.os, "fsync", fsync):
            with self.assertRaises(OSError):
                maintenance.snapshot(self.db, self.state, "best")
        self.assertTrue(old <= set(directory.iterdir()))
        for entry in old:
            maintenance.verify_snapshot(entry)
        db.close()

    def test_source_authorizer_observes_no_row_mutations(self):
        db = self.fixture()
        expected = self.rows(db)
        original = maintenance.sqlite3.connect
        mutations = []

        def guarded(database, *args, **kwargs):
            connection = original(database, *args, **kwargs)
            if str(database).startswith(self.db.as_uri() + "?"):
                def authorize(action, arg1, arg2, schema, trigger):
                    if action in (sqlite3.SQLITE_DELETE, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE):
                        mutations.append(action)
                        return sqlite3.SQLITE_DENY
                    return sqlite3.SQLITE_OK
                connection.set_authorizer(authorize)
            return connection

        with mock.patch.object(maintenance.sqlite3, "connect", side_effect=guarded):
            maintenance.session_report(self.db)
            maintenance.snapshot(self.db, self.state, "best")
            maintenance.reclaim(self.db)
        self.assertEqual(mutations, [])
        self.assertEqual(self.rows(db), expected)
        db.close()

    def test_reclaim_benchmark_preserves_641_sessions_history_and_credentials(self):
        db = self.fixture(wal=True)
        before = self.rows(db)
        started = time.monotonic()
        result = maintenance.reclaim(self.db)
        self.assertEqual(self.rows(db), before)
        self.assertGreater(result["committed_pages"], 0)
        self.assertLessEqual(result["committed_pages"], 16384)
        self.assertLess(result["freelist_after"], result["freelist_before"])
        self.assertIn("wal_bytes_before", result)
        self.assertNotIn("disk_freed", result)
        print("DISPOSABLE SQLITE BENCHMARK " + json.dumps(
            {**result, "elapsed_seconds": round(time.monotonic() - started, 6)}, sort_keys=True))
        db.close()

    def test_reclaim_cooperative_deadline_defers_without_changes(self):
        db = self.fixture()
        before = self.rows(db)
        with mock.patch.object(maintenance.time, "monotonic", side_effect=[0, 1, 1, 1]):
            result = maintenance.reclaim(self.db)
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(result["committed_pages"], 0)
        self.assertEqual(result["checkpoint_status"], "deferred")
        self.assertEqual(self.rows(db), before)
        db.close()

    def test_auto_vacuum_zero_skips_without_conversion(self):
        db = self.fixture(auto=0)
        before = self.rows(db)
        self.assertEqual(maintenance.reclaim(self.db)["status"], "not-configured")
        self.assertEqual(db.execute("PRAGMA auto_vacuum").fetchone()[0], 0)
        self.assertEqual(self.rows(db), before)
        db.close()

    def test_writer_lock_error_is_prompt_and_transaction_released(self):
        db = self.fixture()
        db.execute("BEGIN IMMEDIATE")
        started = time.monotonic()
        result = maintenance.reclaim(self.db)
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(result["committed_pages"], 0)
        self.assertEqual(result["reason"], "busy")
        self.assertLess(time.monotonic() - started, 1)
        db.rollback()
        self.assertGreater(maintenance.reclaim(self.db)["committed_pages"], 0)
        db.close()

    def test_connection_closed_even_if_rollback_fails(self):
        connection = mock.Mock(in_transaction=True)
        connection.rollback.side_effect = sqlite3.OperationalError("fixture-rollback")
        with mock.patch.object(maintenance.sqlite3, "connect", return_value=connection):
            with self.assertRaises(sqlite3.OperationalError):
                with maintenance.connect(self.db):
                    pass
        connection.close.assert_called_once()

    def test_wal_idle_reader_and_concurrent_writer_backup_consistent(self):
        db = self.fixture(wal=True)
        reader = sqlite3.connect(self.db)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM history").fetchone()
        db.execute("INSERT INTO history VALUES ('after-reader')")
        db.commit()
        stop = threading.Event()
        errors = []

        def writer():
            with contextlib.closing(sqlite3.connect(self.db, timeout=0.1)) as connection:
                while not stop.is_set():
                    try:
                        connection.execute("INSERT INTO history VALUES ('writer')")
                        connection.commit()
                    except sqlite3.OperationalError as error:
                        errors.append(type(error).__name__)
                    stop.wait(0.005)

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            result = maintenance.snapshot(self.db, self.state, "best")
            self.assertEqual(result["status"], "created")
            # A writer may legitimately win BEGIN IMMEDIATE. Test backup under
            # active writes, then checkpoint with the idle reader still held;
            # the separate lock test verifies prompt contention errors.
            stop.set()
            thread.join(2)
            reclaimed = maintenance.reclaim(self.db)
            self.assertGreater(reclaimed["wal_bytes_after"], 0)
        finally:
            stop.set()
            thread.join(2)
            reader.close()
            db.close()
        self.assertFalse(thread.is_alive())

    def test_symlinks_in_ancestors_files_and_lock_rejected(self):
        db = self.fixture()
        db.close()
        alias = self.root / "alias"
        alias.symlink_to(self.team, target_is_directory=True)
        with self.assertRaises(ValueError):
            maintenance.session_report(alias / "data/best/data/opencode/opencode.db")
        self.state.mkdir(parents=True, mode=0o700)
        (self.state / "maintenance.lock").symlink_to(self.db)
        with self.assertRaises(ValueError):
            with maintenance.locked(self.state):
                self.fail("unsafe lock acquired")

    def test_private_snapshot_boundary_and_source_sidecar_rejected(self):
        db = self.fixture()
        db.close()
        self.state.mkdir(parents=True, mode=0o700)
        snapshots = self.state / maintenance.SNAPSHOTS
        snapshots.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            maintenance.snapshot(self.db, self.state, "best")
        snapshots.chmod(0o700)
        target = self.root / "sentinel"
        target.write_bytes(b"unchanged")
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(self.db) + suffix)
            with self.subTest(suffix=suffix), \
                    mock.patch.object(maintenance.sqlite3, "connect") as connect:
                sidecar.symlink_to(target)
                try:
                    for operation in (lambda: maintenance.session_report(self.db),
                                      lambda: maintenance.snapshot(self.db, self.state, "best"),
                                      lambda: maintenance.reclaim(self.db),
                                      lambda: maintenance.reclaim(self.db, dry_run=True)):
                        with self.assertRaises(ValueError):
                            operation()
                    connect.assert_not_called()
                finally:
                    sidecar.unlink()
                sidecar.write_bytes(b"unsafe-sidecar")
                sidecar.chmod(0o666)
                try:
                    with self.assertRaises(ValueError):
                        maintenance.session_report(self.db, dry_run=True)
                    connect.assert_not_called()
                finally:
                    sidecar.unlink()
        self.assertEqual(target.read_bytes(), b"unchanged")

    def test_dry_run_rollback_database_read_only_and_default_roots(self):
        db = self.fixture()
        db.close()
        default = self.home / ".local/share/opencode-team/best/data/opencode/opencode.db"
        default.parent.mkdir(parents=True)
        self.db.rename(default)
        before = default.read_bytes()
        output = io.StringIO()
        original_connect = maintenance.sqlite3.connect
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=True), \
                mock.patch.object(maintenance, "run_command", return_value=""), \
                mock.patch.object(maintenance.sqlite3, "connect", wraps=original_connect) as connect, \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main(["--dry-run"]), 0)
        self.assertEqual(connect.call_count, 2)
        for call in connect.call_args_list:
            self.assertIn("?mode=ro", call.args[0])
            self.assertNotIn("mode=rw", call.args[0])
        reports = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(reports[0]["total"], 641)
        self.assertEqual(default.read_bytes(), before)
        self.assertEqual({p.name for p in default.parent.iterdir()}, {"opencode.db"})
        self.assertTrue((self.home / ".local/state/opencode-team/maintenance/maintenance.lock").exists())

    def test_flock_other_process_and_no_truncation(self):
        with maintenance.locked(self.state):
            lock = self.state / "maintenance.lock"
            lock.write_text("sentinel")
            script = """
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('maintenance', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    with m.locked(pathlib.Path(sys.argv[2])):
        sys.exit(9)
except BlockingIOError:
    sys.exit(0)
"""
            result = subprocess.run([sys.executable, "-c", script,
                                     str(ROOT / "shared/maintenance.py"), str(self.state)],
                                    timeout=5, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(lock.read_text(), "sentinel")
        with maintenance.locked(self.state):
            self.assertTrue(lock.exists())

    def test_dry_run_preserves_all_data_bytes_and_skips_update(self):
        db = self.fixture(wal=True)
        before = {p.name: p.read_bytes() for p in self.db.parent.iterdir()}
        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "run_command", return_value="") as command, \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main(["--dry-run"]), 0)
        self.assertEqual({name: hashlib.sha256(data).hexdigest() for name, data in before.items()},
                         {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in self.db.parent.iterdir()})
        self.assertFalse((self.state / maintenance.SNAPSHOTS).exists())
        self.assertEqual(command.call_count, 1)
        self.assertIn("--dry-run", command.call_args.args[0])
        self.assertIn("would-check", output.getvalue())
        self.assertNotIn("fixture-secret", output.getvalue())
        db.close()

    def test_dry_run_read_connection_never_writes_shm_on_wal_mode_race(self):
        db = self.fixture(wal=True)
        before = {p.name: p.read_bytes() for p in self.db.parent.iterdir()}
        # Simulate journal mode changing after the initial header preflight.
        with mock.patch.object(maintenance, "dry_run_wal", return_value=False):
            maintenance.session_report(self.db, dry_run=True)
            maintenance.reclaim(self.db, dry_run=True)
        self.assertEqual({name: hashlib.sha256(data).hexdigest() for name, data in before.items()},
                         {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in self.db.parent.iterdir()})
        db.close()

    def test_independent_task_errors_still_reach_caches_and_update_sanitized(self):
        db = self.fixture()
        db.close()
        calls = []

        def command(args, **kwargs):
            calls.append(args)
            return '{"formulae": []}' if args[0] == "brew" else "secret-output"

        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "session_report", side_effect=ValueError("secret")), \
                mock.patch.object(maintenance, "run_command", side_effect=command), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main([]), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1], ["brew", "outdated", "--json=v2", "--formula"])
        self.assertNotIn("secret", output.getvalue())

    def test_update_check_filters_installed_formulae_without_assuming_native_keg(self):
        payload = {"formulae": [{"name": "node@22"}, {"name": "opencode-team"}, {"name": "git"}]}
        with mock.patch.object(maintenance, "run_command", return_value=json.dumps(payload)) as command:
            result = maintenance.update_check(False)
        self.assertEqual(result, {"status": "informational", "outdated_count": 1})
        self.assertEqual(command.call_args.args[0], ["brew", "outdated", "--json=v2", "--formula"])

    def test_subprocess_timeout_kills_and_reaps_group_and_sanitizes_environment(self):
        process = mock.Mock()
        process.communicate.side_effect = [subprocess.TimeoutExpired("fake", 1), ("", "")]
        process.pid = 43210
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance.subprocess, "Popen", return_value=process) as popen, \
                mock.patch.object(maintenance.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                maintenance.run_command(["fake"], timeout=1)
        kill.assert_called_once()
        self.assertEqual(process.communicate.call_count, 2)
        self.assertNotIn("FAKE_TOKEN", popen.call_args.kwargs["env"])


if __name__ == "__main__":
    unittest.main()
