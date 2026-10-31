"""Disposable SQLite integration tests; never run live cleanup or Homebrew."""

import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).absolute().parents[1]
_staging = os.environ.get("OPENCODE_TEAM_STAGING_ROOT")
if not _staging or ROOT != Path(_staging).resolve():
    raise RuntimeError("Run tests with bash tests/guardrail/runner.sh")
for _name in ("HOME", "OPENCODE_TEAM_HOME", "TMPDIR"):
    _path = Path(os.environ.get(_name, "/")).resolve()
    if ROOT not in _path.parents:
        raise RuntimeError("Test environment escapes isolated staging")
SPEC = importlib.util.spec_from_file_location("maintenance", ROOT / "shared/maintenance.py")
assert SPEC is not None and SPEC.loader is not None
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)

class PathContainmentError(ValueError):
    """A maintenance path escaped the allowed root."""


_guard_real_popen = subprocess.Popen
_guard_real_run_command = maintenance.run_command
_guard_real_safe_path = maintenance.safe_path
_guard_real_sqlite_connect = sqlite3.connect

# Cache an exclusively owned root: clearing HOME/TMPDIR inside a test must not
# redirect subsequent fixtures or permit an environment-supplied DB allowlist.
_session_temp = tempfile.TemporaryDirectory(prefix="ocgt-session-")
_containment_root = Path(_session_temp.name).resolve()
tempfile.tempdir = str(_containment_root)


def _check_containment(path_str):
    """Validate *path_str* resolves inside the allowed root (resolves symlinks)."""
    resolved = Path(path_str).resolve()
    if resolved != _containment_root and _containment_root not in resolved.parents:
        raise PathContainmentError("path outside exclusively owned test root")


def _guarded_safe_path(path, directory=False, private=False):
    """maintenance.safe_path + containment check."""
    _check_containment(path)
    return _guard_real_safe_path(path, directory=directory, private=private)


def _guarded_sqlite_connect(database, *args, **kwargs):
    """sqlite3.connect + containment check (validates file: URIs too)."""
    value = os.fsdecode(os.fspath(database))
    if value != ":memory:":
        if value.startswith("file:"):
            parsed = urllib.parse.urlsplit(value)
            if parsed.netloc or not parsed.path:
                raise PathContainmentError("unsupported SQLite URI in test")
            value = urllib.parse.unquote(parsed.path)
        _check_containment(value)
    return _guard_real_sqlite_connect(database, *args, **kwargs)


def _guarded_run_command(*args, **kwargs):
    if subprocess.Popen is _guard_real_popen:
        raise PathContainmentError(
            "FAIL-CLOSED: unmocked maintenance.run_command — "
            "the test must mock subprocess.Popen"
        )
    return _guard_real_run_command(*args, **kwargs)


maintenance.safe_path = _guarded_safe_path
sqlite3.connect = _guarded_sqlite_connect
maintenance.run_command = _guarded_run_command

def run_command_json(args, **kwargs):
    """Mock run_command returning valid JSON for brew, empty for shell scripts."""
    return '{"formulae": []}' if args and args[0] == "brew" else ""


def legacy_logical_checksum(connection, deadline=None):
    """Frozen rc2 oracle: existing snapshot-v1 digests must remain identical."""
    digest = hashlib.sha256()
    schema = connection.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
    digest.update(repr(schema).encode("utf-8"))
    for kind, name, _, _ in schema:
        if kind != "table":
            continue
        quoted = '"' + name.replace('"', '""') + '"'
        cols = {row[1].lower() for row in connection.execute(f"PRAGMA table_info({quoted})")}
        alias = next((key for key in ("rowid", "_rowid_", "oid") if key not in cols), None)
        without = connection.execute(f"PRAGMA index_info({quoted})").fetchone() is not None
        if alias is None and not without:
            raise ValueError("rowid-fully-shadowed")
        selected = "*" if without else f"{alias},*"
        hashes = []
        for row in connection.execute(f"SELECT {selected} FROM " + quoted):
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("logical-checksum-deadline")
            hashes.append(hashlib.sha256(repr(row).encode("utf-8")).digest())
        digest.update(name.encode("utf-8") + b"\0")
        for value in sorted(hashes):
            digest.update(value)
    return digest.hexdigest()


class MaintenanceTests(unittest.TestCase):
    def test_rc2_manifest_is_reused_without_republication(self):
        db = self.fixture(wal=True)
        self.addCleanup(db.close)
        db.executemany("INSERT INTO history VALUES (?)", [("é漢字😀\0",), (b"\0'\"\\",)])
        db.commit()
        with mock.patch.object(maintenance, "logical_checksum", legacy_logical_checksum):
            self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        entry = next(directory.iterdir())
        manifest = (entry / "manifest.json").read_bytes()
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "unchanged")
        self.assertEqual(list(directory.iterdir()), [entry])
        self.assertEqual((entry / "manifest.json").read_bytes(), manifest)

    def test_snapshot_completes_with_wal_commit_after_every_backup_step(self):
        writer = self.fixture(wal=True)
        self.addCleanup(writer.close)
        writer.executemany("INSERT INTO scratch VALUES (?)", [(b"w" * 4096,)] * 750)
        writer.commit()
        commits = []

        class ConcurrentSource(sqlite3.Connection):
            def backup(self, target, **kwargs):
                progress = kwargs["progress"]

                def commit_during_backup(status, remaining, total):
                    writer.execute("INSERT INTO history VALUES ('concurrent-wal')")
                    writer.commit()
                    commits.append(1)
                    progress(status, remaining, total)

                kwargs["progress"] = commit_during_backup
                return super().backup(target, **kwargs)

        connect = sqlite3.connect

        def concurrent_connect(database, *args, **kwargs):
            if "mode=ro" in str(database) and "immutable" not in str(database):
                kwargs["factory"] = ConcurrentSource
            return connect(database, *args, **kwargs)

        with mock.patch.object(sqlite3, "connect", side_effect=concurrent_connect):
            report = maintenance.snapshot(self.db, self.state, "best", budget=2)
        self.assertEqual(report["status"], "created")
        self.assertGreater(len(commits), 1)

    def test_logical_checksum_exact_rc2_scalar_blob_unicode_compatibility(self):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.executescript('''
            CREATE TABLE "unicodé" (value);
            CREATE TABLE keyed (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
            CREATE TABLE shadow (RoWiD INTEGER, value);
        ''')
        values = [None, 0, -9223372036854775808, 9223372036854775807,
                  1.25, -0.0, float("inf"), "é漢字😀\0'\"\\\n", b"",
                  b"'", b'"', b"\\'", b"'\"", bytes(range(256)), b"x" * 1048576]
        db.executemany('INSERT INTO "unicodé" VALUES (?)', [(v,) for v in values] * 2)
        db.executemany("INSERT INTO keyed VALUES (?, ?)", [(str(i), v) for i, v in enumerate(values)])
        db.execute("INSERT INTO shadow VALUES (1, 'duplicate')")
        db.execute("INSERT INTO shadow VALUES (1, 'duplicate')")
        expected = legacy_logical_checksum(db)
        self.assertEqual(maintenance.logical_checksum(db), expected)
        db.execute("PRAGMA reverse_unordered_selects=ON")
        self.assertEqual(maintenance.logical_checksum(db), expected)
        db.execute('UPDATE "unicodé" SET rowid=1000 WHERE rowid=1')
        self.assertNotEqual(maintenance.logical_checksum(db), expected)
        self.assertEqual(maintenance.logical_checksum(db), legacy_logical_checksum(db))

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
        environment = mock.patch.dict(os.environ, self.env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

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
        db.execute("ALTER TABLE session_inbox RENAME TO missing_inbox")
        db.commit()
        with self.assertRaises(ValueError):
            maintenance.session_report(self.db)
        db.execute("ALTER TABLE missing_inbox RENAME TO session_inbox")
        db.execute("ALTER TABLE session_pending RENAME COLUMN session_id TO unknown")
        db.commit()
        with self.assertRaises(ValueError):
            maintenance.session_report(self.db)
        db.close()

    def test_native_schema_after_pending_removal_preserves_session_protection(self):
        db = self.fixture()
        db.execute("INSERT INTO session_inbox VALUES ('session-0')")
        db.execute("UPDATE session_v2 SET parent_id='session-0' WHERE id='session-1'")
        db.execute("INSERT INTO session_use VALUES ('session-2')")
        db.execute("UPDATE session_v2 SET fork_session_id='session-2' WHERE id='session-3'")
        db.execute("UPDATE session_v2 SET pinned=1 WHERE id='session-4'")
        db.execute("UPDATE session_v2 SET time_suspended=1 WHERE id='session-5'")
        db.execute("UPDATE session_v2 SET time_compacting=1 WHERE id='session-6'")
        db.execute("UPDATE session_v2 SET resume_attempts=1 WHERE id='session-7'")
        db.execute("UPDATE session_v2 SET time_archived=NULL WHERE id='session-8'")
        db.execute("UPDATE session_v2 SET time_updated=? WHERE id='session-9'",
                   (int(time.time() * 1000),))
        db.execute("UPDATE session_v2 SET idle_outcome=NULL WHERE id='session-10'")
        db.commit()
        expected = maintenance.session_report(self.db)
        self.assertEqual(expected, {"status": "advisory-only", "total": 641,
                                    "protected": 11, "potential_review": 630})
        db.execute("DROP TABLE session_pending")
        db.execute("DROP TABLE session_execution_claim")
        db.commit()
        before = self.rows(db)
        schema = db.execute("SELECT name,sql FROM sqlite_schema ORDER BY name").fetchall()
        self.assertEqual(maintenance.session_report(self.db), expected)
        self.assertEqual(self.rows(db), before)
        self.assertEqual(db.execute("SELECT name,sql FROM sqlite_schema ORDER BY name").fetchall(), schema)
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
        db.execute("CREATE TABLE payload (id TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID")
        db.execute("INSERT INTO payload VALUES ('fixture', ?)", (b"a\0blob",))
        db.execute("INSERT INTO history VALUES (?)", ("a\0old",))
        db.commit()
        maintenance.snapshot(self.db, self.state, "best")
        db.execute("UPDATE history SET value=? WHERE value=?", ("a\0new", "a\0old"))
        db.commit()
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        latest = sorted((self.state / maintenance.SNAPSHOTS / "best").iterdir())[-1]
        with contextlib.closing(sqlite3.connect(latest / "database.db")) as restored:
            self.assertIn(("a\0new",), list(restored.execute("SELECT value FROM history")))
            self.assertEqual(restored.execute("SELECT value FROM payload").fetchone(), (b"a\0blob",))
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

    def test_retirement_retry_syncs_parent_before_any_unlink(self):
        db = self.fixture()
        for i in range(3):
            db.execute("INSERT INTO history VALUES (?)", (str(i),))
            db.commit()
            maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        db.execute("INSERT INTO history VALUES ('fourth')")
        db.commit()
        original = maintenance.sync_directory
        parent_syncs = []

        def sync(path):
            if path == directory:
                parent_syncs.append(path)
                if len(parent_syncs) == 2:
                    raise OSError("fixture-retirement-parent-sync")
            original(path)

        with mock.patch.object(maintenance, "sync_directory", side_effect=sync):
            with self.assertRaises(OSError):
                maintenance.snapshot(self.db, self.state, "best")
        retired = next(directory.glob(".retired-*"))
        expected = {p.name: p.read_bytes() for p in retired.iterdir()}

        def fail_parent(path):
            if path == directory:
                raise OSError("fixture-retry-parent-sync")
            original(path)

        with mock.patch.object(maintenance, "sync_directory", side_effect=fail_parent):
            with self.assertRaises(OSError):
                maintenance.snapshot(self.db, self.state, "best")
        self.assertTrue(retired.exists())
        self.assertEqual({p.name: p.read_bytes() for p in retired.iterdir()}, expected)
        maintenance.snapshot(self.db, self.state, "best")
        self.assertFalse(retired.exists())
        db.close()

    def test_dedup_never_prunes_the_only_snapshot_matching_current_data(self):
        db = self.fixture()
        for value in ("A", "B", "C"):
            db.execute("INSERT INTO history VALUES (?)", (value,))
            db.commit()
            maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        db.execute("INSERT INTO history VALUES ('D')")
        db.commit()
        original_rename, clock = Path.rename, time.monotonic
        published = []

        def rename(source, target):
            result = original_rename(source, target)
            if source.name.startswith(".pending-"):
                published.append(target)
            return result

        with mock.patch.object(Path, "rename", rename), \
                mock.patch.object(maintenance.time, "monotonic", side_effect=lambda: clock() + (100 if published else 0)):
            with self.assertRaises(TimeoutError):
                maintenance.snapshot(self.db, self.state, "best")
        db.execute("DELETE FROM history WHERE value IN ('B','C','D')")  # fixture reverts to A
        db.commit()
        expected = self.rows(db)
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        latest = sorted(directory.iterdir())[-1]
        with contextlib.closing(sqlite3.connect(latest / "database.db")) as restored:
            self.assertEqual(self.rows(restored), expected)
        self.assertEqual(len(list(directory.iterdir())), 3)
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
        self.assertEqual(result["reason"], "deadline")
        self.assertEqual(result["checkpoint_reason"], "deadline")
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

    # --- snapshot error observability: phase/reason/elapsed_ms/budget_ms ---

    def test_snapshot_error_report_includes_phase_reason_elapsed_budget(self):
        db = self.fixture()

        def fail_snapshot(path, state, profile, budget=30):
            raise TimeoutError("backup-deadline")

        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "snapshot", side_effect=fail_snapshot), \
                mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main([]), 1)
        task_report = json.loads(next(line for line in output.getvalue().splitlines()
                                      if "best.snapshot" in line))
        self.assertEqual(task_report["status"], "error")
        self.assertEqual(task_report["error_type"], "TimeoutError")
        self.assertIn("phase", task_report)
        self.assertIn("reason", task_report)
        self.assertIn("elapsed_ms", task_report)
        self.assertIn("budget_ms", task_report)
        self.assertIn("published", task_report)
        self.assertEqual(task_report["reason"], "backup-deadline")
        self.assertGreater(task_report["budget_ms"], 0)
        db.close()

    def test_snapshot_checksum_timeout_reports_checksum_phase(self):
        db = self.fixture()
        with mock.patch.object(maintenance, "checksum", side_effect=TimeoutError("checksum-deadline")), \
                self.assertRaises(TimeoutError) as caught:
                maintenance.snapshot(self.db, self.state, "best")
        error = caught.exception
        self.assertEqual(error.phase, "checksum")
        self.assertEqual(error.snapshot_reason, "checksum-deadline")
        self.assertIn("checksum_ms", error.timing_ms)
        self.assertFalse(error.published)
        db.close()

    def test_snapshot_timeout_phase_attached_to_exception(self):
        db = self.fixture()
        with self.assertRaises(TimeoutError) as caught:
            maintenance.snapshot(self.db, self.state, "best", budget=0)
        self.assertEqual(caught.exception.phase, "backup")
        self.assertFalse(caught.exception.published)
        self.assertEqual(caught.exception.snapshot_reason, "backup-deadline")
        db.close()

    def test_reason_label_never_leaks_arbitrary_exception_strings(self):
        # ValueError -> "invalid", OSError -> "os-error", TimeoutError -> "deadline"
        self.assertEqual(maintenance.reason_label(ValueError("anything")), "invalid")
        self.assertEqual(maintenance.reason_label(OSError("path-secret")), "os-error")
        self.assertEqual(maintenance.reason_label(TimeoutError("deadline")), "deadline")
        self.assertEqual(maintenance.reason_label(TimeoutError("logical-checksum-deadline")),
                         "logical-checksum-deadline")
        self.assertEqual(maintenance.reason_label(sqlite3.Error("query data")), "database")
        # Arbitrary exception -> class name only, not its message
        self.assertEqual(maintenance.reason_label(RuntimeError("sensitive message")), "RuntimeError")
        self.assertNotIn("sensitive", maintenance.reason_label(RuntimeError("sensitive")))

    def test_controlled_sqlite_and_io_reasons(self):
        for message, expected in (("database is locked", "busy"),
                                  ("database table is locked", "busy"),
                                  ("database schema is locked: main", "busy"),
                                  ("database is busy", "busy"), ("interrupted", "deadline"),
                                  ("private locked contents", "database")):
            with self.subTest(message=message):
                self.assertEqual(maintenance.reason_label(sqlite3.OperationalError(message)),
                                 expected)
        for code, expected in ((5, "busy"), (6, "busy"), (261, "busy"),
                               (262, "busy"), (9, "deadline"), (10, "io-error"),
                               (13, "insufficient-space"), (1, "database")):
            with self.subTest(code=code):
                error = sqlite3.OperationalError("private contents")
                error.sqlite_errorcode = code
                self.assertEqual(maintenance.reason_label(error), expected)
        for code, expected in ((errno.ENOSPC, "insufficient-space"),
                               (errno.EIO, "io-error"), (errno.EACCES, "os-error")):
            with self.subTest(errno=code):
                self.assertEqual(maintenance.reason_label(OSError(code, "private path")), expected)

    def test_cleanup_failure_preserves_primary_error_and_annotations(self):
        self.fixture().close()
        primary = TimeoutError("backup-deadline")
        original_unlink = Path.unlink

        def fail_cleanup(path, *args, **kwargs):
            if path.name == "database.db" and path.parent.name.startswith(".pending-"):
                raise OSError(errno.EIO, "private cleanup path")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(maintenance, "logical_checksum", side_effect=primary), \
                mock.patch.object(Path, "unlink", fail_cleanup):
            with self.assertRaises(TimeoutError) as caught:
                maintenance.snapshot(self.db, self.state, "best")
        self.assertIs(caught.exception, primary)
        self.assertEqual(primary.phase, "logical")
        self.assertEqual(primary.cleanup_error_type, "OSError")
        self.assertEqual(primary.cleanup_reason, "io-error")
        self.assertEqual(primary.snapshot_reason, "backup-deadline")

    def test_cleanup_only_failure_has_cleanup_phase(self):
        self.fixture().close()
        maintenance.snapshot(self.db, self.state, "best")
        original_unlink = Path.unlink

        def fail_cleanup(path, *args, **kwargs):
            if path.name == "database.db" and path.parent.name.startswith(".pending-"):
                raise OSError(errno.ENOSPC, "private cleanup path")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_cleanup):
            with self.assertRaises(OSError) as caught:
                maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(caught.exception.phase, "cleanup")
        self.assertEqual(caught.exception.snapshot_reason, "insufficient-space")
        self.assertFalse(caught.exception.published)

    def test_retired_recovery_deadline_preserves_artifact(self):
        self.fixture().close()
        maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        entry = next(directory.iterdir())
        retired = entry.with_name(".retired-" + entry.name)
        entry.rename(retired)
        before = {path.name: path.read_bytes() for path in retired.iterdir()}
        clock = iter([0])
        with mock.patch.object(maintenance.time, "monotonic", side_effect=lambda: next(clock, 31)):
            with self.assertRaises(TimeoutError) as caught:
                maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(caught.exception.phase, "retired-recovery")
        self.assertEqual(caught.exception.snapshot_reason, "snapshot-recovery-deadline")
        self.assertEqual({path.name: path.read_bytes() for path in retired.iterdir()}, before)

    def test_checkpoint_page_budget_reason(self):
        self.fixture(auto=0).close()
        with mock.patch.object(maintenance, "file_bytes", return_value=10 ** 12), \
                mock.patch.object(maintenance.time, "monotonic", return_value=0):
            result = maintenance.reclaim(self.db)
        self.assertEqual(result["checkpoint_status"], "deferred")
        self.assertEqual(result["checkpoint_reason"], "page-budget")

    # --- post-publication retention error: published=true distinguishes it ---

    def test_retention_timeout_after_publication_reports_published_true(self):
        db = self.fixture()
        for i in range(3):
            db.execute("INSERT INTO history VALUES (?)", (str(i),))
            db.commit()
            maintenance.snapshot(self.db, self.state, "best")
        db.execute("INSERT INTO history VALUES ('fourth')")
        db.commit()
        original_rename, original_clock = Path.rename, time.monotonic
        published = []

        def rename(source, target):
            result = original_rename(source, target)
            if source.name.startswith(".pending-"):
                published.append(target)
            return result

        # After publication, retention loop sees deadline exceeded -> TimeoutError
        # with published=True, distinguishing it from a pre-publish failure.
        with mock.patch.object(Path, "rename", rename), \
                mock.patch.object(maintenance.time, "monotonic",
                                  side_effect=lambda: original_clock() + (100 if published else 0)):
            try:
                maintenance.snapshot(self.db, self.state, "best")
            except TimeoutError as error:
                self.assertTrue(error.published)
                self.assertEqual(error.phase, "retention")
            else:
                self.fail("expected TimeoutError after post-publication retention timeout")
        db.close()

    def test_main_surfaces_post_publication_flag_and_preserves_good_snapshots(self):
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

        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                mock.patch.object(Path, "rename", rename), \
                mock.patch.object(maintenance.time, "monotonic",
                                  side_effect=lambda: original_clock() + (100 if published else 0)), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main(["--timeout", "30"]), 1)
        snapshot_report = json.loads(next(line for line in output.getvalue().splitlines()
                                          if "best.snapshot" in line))
        self.assertTrue(snapshot_report["published"])
        self.assertEqual(snapshot_report["phase"], "retention")
        # The good snapshots must remain; none pruned during failed retention run.
        published_entries = [e for e in directory.iterdir() if not e.name.startswith(".")]
        self.assertEqual(len(published_entries), 4)
        for entry in published_entries:
            maintenance.verify_snapshot(entry)
        db.close()

    # --- deadline checked before publication ---

    def test_deadline_before_publication_no_partial_write(self):
        db = self.fixture()
        original = time.monotonic
        original_checksum = maintenance.checksum
        expired = False

        def checksum(*args, **kwargs):
            nonlocal expired
            digest = original_checksum(*args, **kwargs)
            expired = True
            return digest

        with mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                mock.patch.object(maintenance, "checksum", side_effect=checksum), \
                mock.patch.object(maintenance.time, "monotonic",
                                  side_effect=lambda: original() + (1000 if expired else 0)), \
                self.assertRaises(TimeoutError) as caught:
                maintenance.snapshot(self.db, self.state, "best", budget=1)
        self.assertTrue(expired)
        self.assertEqual(caught.exception.phase, "publish")
        self.assertEqual(caught.exception.snapshot_reason, "snapshot-publish-deadline")
        self.assertFalse(caught.exception.published)
        directory = self.state / maintenance.SNAPSHOTS / "best"
        # No partial snapshot directory should be published.
        published = [e for e in directory.iterdir() if not e.name.startswith(".")]
        self.assertEqual(published, [])
        db.close()

    # --- checksum rowid alias shadowing ---

    def test_logical_checksum_uses_non_shadowed_rowid_alias(self):
        db = self.fixture()
        # SQLite identifier shadowing is case-insensitive.
        db.execute("CREATE TABLE shadow_rowid (RoWiD INTEGER, data TEXT)")
        db.execute("INSERT INTO shadow_rowid VALUES (1, 'a')")
        db.execute("INSERT INTO shadow_rowid VALUES (2, 'b')")
        db.commit()
        maintenance.snapshot(self.db, self.state, "best")
        latest = max((self.state / maintenance.SNAPSHOTS / "best").iterdir())
        with contextlib.closing(sqlite3.connect(latest / "database.db")) as restored:
            self.assertEqual(restored.execute("SELECT RoWiD FROM shadow_rowid").fetchall(),
                             [(1,), (2,)])
        before = maintenance.logical_checksum(db)
        db.execute("UPDATE shadow_rowid SET _rowid_=20 WHERE data='a'")
        self.assertNotEqual(maintenance.logical_checksum(db), before)
        db.close()

    def test_logical_checksum_fail_closed_when_all_rowid_aliases_shadowed(self):
        db = self.fixture()
        # A table with columns named rowid, _rowid_, AND oid shadows all three aliases.
        db.execute('CREATE TABLE full_shadow (rowid INTEGER, "_rowid_" INTEGER, oid INTEGER)')
        db.commit()
        with self.assertRaises(ValueError) as ctx, maintenance.connect(self.db) as connection:
            maintenance.logical_checksum(connection)
        self.assertIn("shadowed", str(ctx.exception))
        db.execute("DROP TABLE full_shadow")
        db.execute('CREATE TABLE full_shadow (rowid INTEGER PRIMARY KEY, "_rowid_" INTEGER, '
                   'oid INTEGER) WITHOUT ROWID')
        self.assertEqual(len(maintenance.logical_checksum(db)), 64)
        db.close()

    def test_logical_checksum_detects_change_in_shadowed_table(self):
        db = self.fixture()
        db.execute("CREATE TABLE shadow_rowid (_rowid_ INTEGER, data TEXT)")
        db.execute("INSERT INTO shadow_rowid VALUES (1, 'a')")
        db.commit()
        maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "unchanged")
        db.execute("UPDATE shadow_rowid SET data='changed' WHERE _rowid_=1")
        db.commit()
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        db.close()

    # --- reclaim acquires its commit lock before vacuuming ---

    def test_reclaim_defers_before_vacuum_when_rollback_reader_holds_lock(self):
        db = self.fixture()
        db.execute("PRAGMA journal_mode=DELETE")
        db.commit()
        reader = sqlite3.connect(self.db)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM history").fetchone()
        started = time.monotonic()
        statements = []
        original_connect = maintenance.connect

        @contextlib.contextmanager
        def traced_connect(*args, **kwargs):
            with original_connect(*args, **kwargs) as connection:
                connection.set_trace_callback(statements.append)
                yield connection

        with mock.patch.object(maintenance, "connect", traced_connect):
            result = maintenance.reclaim(self.db)
        elapsed = time.monotonic() - started
        reader.rollback()
        reader.close()
        self.assertEqual(result["status"], "deferred")
        self.assertFalse(any("incremental_vacuum" in sql.lower() for sql in statements))
        self.assertLess(elapsed, 1.0)
        db.close()

    def test_reclaim_busy_defers_promptly_without_blocking(self):
        db = self.fixture()
        for transaction in ("BEGIN IMMEDIATE", "BEGIN EXCLUSIVE"):
            with self.subTest(transaction=transaction), mock.patch.object(
                    maintenance, "run_command", side_effect=run_command_json):
                db.execute(transaction)
                try:
                    started = time.monotonic()
                    result = maintenance.reclaim(self.db)
                    elapsed = time.monotonic() - started
                    self.assertEqual(result["status"], "deferred")
                    self.assertEqual(result["committed_pages"], 0)
                    self.assertEqual(result["reason"], "busy")
                    self.assertLess(elapsed, 1.0)
                finally:
                    db.rollback()
        db.close()

    # --- CLI timeout configurable ---

    def test_main_custom_timeout_passed_to_snapshot(self):
        db = self.fixture()
        db.close()
        captured = []

        def spy_snapshot(path, state, profile, budget=30):
            captured.append(budget)
            return {"status": "missing"}

        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "snapshot", side_effect=spy_snapshot), \
                mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main(["--timeout", "15.5"]), 0)
        self.assertEqual(captured, [15.5, 15.5])

    def test_main_error_budget_ms_reflects_custom_timeout(self):
        db = self.fixture()
        captured = []

        def fail_snapshot(path, state, profile, budget=30):
            captured.append(budget)
            raise TimeoutError("backup-deadline")

        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "snapshot", side_effect=fail_snapshot), \
                mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main(["--timeout", "5"]), 1)
        self.assertEqual(captured, [5, 5])
        snapshot_report = json.loads(next(line for line in output.getvalue().splitlines()
                                          if "best.snapshot" in line))
        self.assertEqual(snapshot_report["budget_ms"], 5000.0)
        self.assertEqual(snapshot_report["reason"], "backup-deadline")
        db.close()

    def test_main_timeout_default_120_when_not_specified(self):
        captured = []

        def fail_snapshot(path, state, profile, budget=30):
            captured.append(budget)
            raise TimeoutError("backup-deadline")

        output = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), \
                mock.patch.object(maintenance, "snapshot", side_effect=fail_snapshot), \
                mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main([]), 1)
        self.assertEqual(captured, [120, 120])
        snapshot_report = json.loads(next(line for line in output.getvalue().splitlines()
                                          if "best.snapshot" in line))
        self.assertEqual(snapshot_report["budget_ms"], 120000.0)

    # --- timeout fixtures: checksum/integrity/retention ---

    def test_integrity_check_failure_aborts_without_pruning(self):
        db = self.fixture()
        maintenance.snapshot(self.db, self.state, "best")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        before = set(directory.iterdir())
        with mock.patch.object(maintenance, "quick_check",
                               side_effect=sqlite3.DatabaseError("corrupt")), \
                self.assertRaises(sqlite3.DatabaseError) as caught:
            maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(caught.exception.phase, "verify")
        self.assertIn("verify_existing_ms", caught.exception.timing_ms)
        self.assertEqual(set(directory.iterdir()), before)
        for entry in before:
            maintenance.verify_snapshot(entry)
        db.close()

    def test_new_snapshot_integrity_and_logical_failures_have_distinct_phases(self):
        db = self.fixture()
        for function, phase in (("quick_check", "integrity"), ("logical_checksum", "logical")):
            with self.subTest(phase=phase), mock.patch.object(
                    maintenance, function, side_effect=sqlite3.DatabaseError("secret")):
                with self.assertRaises(sqlite3.DatabaseError) as caught:
                    maintenance.snapshot(self.db, self.state, "best")
                self.assertEqual(caught.exception.phase, phase)
                self.assertIn(phase + "_ms", caught.exception.timing_ms)
        db.close()

    def test_cli_timeout_requires_positive_finite_value(self):
        for value in ("0", "-1", "nan", "inf", "-inf", "not-a-number"):
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()), \
                    mock.patch.dict(os.environ, self.env, clear=True), \
                    mock.patch.object(maintenance, "run_command", side_effect=run_command_json):
                with self.assertRaises(SystemExit) as caught:
                    maintenance.main(["--timeout=" + value])
                self.assertEqual(caught.exception.code, 2)

    # --- WAL contention with concurrent writers ---

    def test_snapshot_and_reclaim_under_wal_contention_keep_data_intact(self):
        db = self.fixture(wal=True)
        # Capture immutable tables only; history is the contention target.
        before_rows = tuple(db.execute(f"SELECT * FROM {t} ORDER BY rowid").fetchall()
                            for t in ("session_v2", "credentials"))
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
            stop.set()
            thread.join(2)
            reclaimed = maintenance.reclaim(self.db)
            self.assertIn(reclaimed["status"], {"ok", "deferred"})
        finally:
            stop.set()
            thread.join(2)
            db.close()
        self.assertFalse(thread.is_alive())
        # Source data must be intact regardless of reclaim contention.
        reopened = sqlite3.connect(self.db)
        after_rows = tuple(reopened.execute(f"SELECT * FROM {t} ORDER BY rowid").fetchall()
                           for t in ("session_v2", "credentials"))
        self.assertEqual(after_rows, before_rows)
        reopened.close()

    def test_insufficient_space_preserves_old_snapshot_and_no_pending(self):
        db = self.fixture()
        # Valid snapshot fixture exists before the space failure.
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        original = set(directory.iterdir())
        # Source change would force a new "created" snapshot without the space fault.
        db.execute("INSERT INTO history VALUES ('post-snapshot-change')")
        db.commit()
        fake_usage = mock.Mock()
        fake_usage.free = 0
        with mock.patch.object(maintenance.shutil, "disk_usage", return_value=fake_usage):
            with self.assertRaises(OSError) as caught:
                maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(caught.exception.phase, "backup")
        self.assertEqual(caught.exception.snapshot_reason, "insufficient-space")
        self.assertFalse(caught.exception.published)
        # Old snapshot preserved; unpublished pending artifacts cleaned up.
        self.assertEqual(set(directory.iterdir()), original)
        self.assertFalse(any(directory.glob(".pending-*")))
        for entry in directory.iterdir():
            maintenance.verify_snapshot(entry)
        db.close()

    def test_invalid_manifest_fails_closed_preserves_source_and_unknown_artifacts(self):
        db = self.fixture()
        self.assertEqual(maintenance.snapshot(self.db, self.state, "best")["status"], "created")
        directory = self.state / maintenance.SNAPSHOTS / "best"
        snapshot_entry = next(directory.iterdir())
        # Unknown artifact not owned by this implementation must survive fail-closed.
        unknown = directory / "unknown-artifact.txt"
        unknown.write_bytes(b"preserve-me")
        # Corrupt the manifest so the existing snapshot fails verification.
        manifest_path = snapshot_entry / "manifest.json"
        corrupted = json.loads(manifest_path.read_text())
        corrupted["sha256"] = "not-a-valid-hash"
        manifest_path.write_text(json.dumps(corrupted))
        db.execute("INSERT INTO history VALUES ('post-snapshot-change')")
        db.commit()
        source_bytes = self.db.read_bytes()
        before = set(directory.iterdir())
        with self.assertRaises(ValueError) as caught:
            maintenance.snapshot(self.db, self.state, "best")
        self.assertEqual(caught.exception.phase, "verify")
        self.assertEqual(caught.exception.snapshot_reason, "invalid-manifest")
        self.assertFalse(caught.exception.published)
        # No new snapshot published; source bytes and unknown artifact preserved.
        self.assertEqual(set(directory.iterdir()), before)
        self.assertEqual(self.db.read_bytes(), source_bytes)
        self.assertEqual(unknown.read_bytes(), b"preserve-me")
        self.assertFalse(any(directory.glob(".pending-*")))
        db.close()

    def test_run_identity_is_complete_and_constant_across_success_and_error_tasks(self):
        self.fixture().close()
        output = io.StringIO()
        with mock.patch.object(maintenance, "run_command", side_effect=run_command_json), \
                mock.patch.object(maintenance, "snapshot", side_effect=TimeoutError("backup-deadline")), \
                contextlib.redirect_stdout(output):
            self.assertEqual(maintenance.main([]), 1)
        reports = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(reports), 8)
        self.assertEqual(len({r["run_id"] for r in reports}), 1)
        expected = hashlib.sha256((ROOT / "shared/maintenance.py").read_bytes()).hexdigest()
        for report in reports:
            self.assertEqual(report["version"], (ROOT / "VERSION").read_text().strip())
            self.assertEqual(report["script_sha256"], expected)
            self.assertRegex(report["started_at"], r"T.*\+00:00$")
            self.assertLessEqual(report["started_at"], report["finished_at"])

    def test_snapshot_reports_timing_ms_without_sensitive_data(self):
        db = self.fixture()
        report = maintenance.snapshot(self.db, self.state, "best")
        self.assertIn("timing_ms", report)
        timing = report["timing_ms"]
        self.assertIn("verify_existing_ms", timing)
        self.assertIn("backup_ms", timing)
        self.assertIn("checksum_ms", timing)
        self.assertIn("retention_ms", timing)
        # Timing dict contains only numeric phase durations, no paths or data.
        serialized = json.dumps(report)
        self.assertNotIn("fixture-secret", serialized)
        self.assertNotIn("session-", serialized)
        for key in timing:
            self.assertIsInstance(timing[key], (int, float))
        db.close()


if __name__ == "__main__":
    unittest.main()
