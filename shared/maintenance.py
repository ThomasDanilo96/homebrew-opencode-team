#!/usr/bin/env python3
"""Non-deleting profile maintenance. Dry-run permits only lock/state metadata.

Session reports are advisory, never deletion eligibility. SQLite logical pages
are not disk bytes: WAL, filesystem allocation and open readers differ.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import time
import uuid


PROFILES = ("best", "free")
SNAPSHOTS = "snapshots-v1"
SNAPSHOT_NAME = r"[0-9]{20}-[a-f0-9]{32}"
AGE_MS = 90 * 86400 * 1000


def safe_path(path, directory=False, private=False):
    """Reject links throughout the path; protected leaves must be user-owned."""
    path = Path(os.path.abspath(path))
    for entry in reversed((path, *path.parents)):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("symlink")
        is_directory = entry != path or directory
        if is_directory:
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("not-directory")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("not-safe-regular-file")
        if entry == path:
            if info.st_uid != os.getuid():
                raise ValueError("not-owned")
            if private and info.st_mode & 0o077:
                raise ValueError("not-private")
            if info.st_mode & 0o022:
                raise ValueError("writable-by-others")
    return path


def private_directory(path):
    path = safe_path(path, directory=True, private=True)
    # mkdir(parents=True) ignores mode for intermediate directories.
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for entry in reversed(missing):
        entry.mkdir(mode=0o700)
    return safe_path(path, directory=True, private=True)


@contextlib.contextmanager
def locked(state):
    state = safe_path(state, directory=True)
    if not state.exists():
        state = private_directory(state)
    path = safe_path(state / "maintenance.lock", private=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("unsafe-lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        # Never truncate or unlink: waiters must observe the same inode.
        os.close(fd)


def database_path(path):
    path = safe_path(path)
    for suffix in ("-wal", "-shm", "-journal"):
        safe_path(Path(str(path) + suffix))
    return path


@contextlib.contextmanager
def connect(path, mode="ro", immutable=False):
    path = database_path(path)
    uri = path.as_uri() + "?mode=" + mode
    if immutable:
        # Dry-run preflights WAL first. This also prevents SHM writes if journal
        # mode changes between preflight and opening this advisory reader.
        uri += "&immutable=1"
    connection = sqlite3.connect(uri,
                                 uri=True, timeout=0, isolation_level=None)
    try:
        yield connection
    finally:
        try:
            if connection.in_transaction:
                connection.rollback()
        finally:
            connection.close()


def columns(connection, table):
    # All identifiers are constants supplied by this module.
    return {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}


def dry_run_wal(path):
    """Even mode=ro changes WAL read marks in -shm; defer rather than write."""
    with path.open("rb") as source:
        header = source.read(20)
    return header[18:20] == b"\x02\x02" or Path(str(path) + "-wal").exists()


def session_report(path, dry_run=False):
    path = database_path(path)
    if not path.exists():
        return {"status": "missing"}
    if dry_run and dry_run_wal(path):
        return {"status": "deferred-wal-read-only"}
    with connect(path, immutable=dry_run) as connection:
        connection.execute("BEGIN")
        required = ("id", "parent_id", "fork_session_id", "time_created", "time_updated", "time_idle",
                    "time_viewed", "time_archived", "idle_outcome", "time_suspended",
                    "time_compacting", "resume_attempts")
        available = columns(connection, "session_v2")
        if not set(required) <= available:
            raise ValueError("unknown-session-schema")
        selected = (*required, *(("pinned",) if "pinned" in available else ()))
        rows = [dict(zip(selected, row)) for row in connection.execute(
            "SELECT " + ",".join(selected) + " FROM session_v2")]
        parents = {row["id"]: row["id"] for row in rows}

        def root(key):
            while parents[key] != key:
                parents[key] = parents[parents[key]]
                key = parents[key]
            return key

        protected = set()
        cutoff = int(time.time() * 1000) - AGE_MS
        times = ("time_created", "time_updated", "time_idle", "time_viewed", "time_archived")
        for row in rows:
            key = row["id"]
            if not isinstance(key, str):
                raise ValueError("unknown-session-id")
            timestamps = [row[name] for name in times]
            if (any(not isinstance(value, (int, float)) or value <= 0 or value >= cutoff
                    for value in timestamps)
                    or row["idle_outcome"] not in ("succeeded", "failed", "interrupted")
                    or row["time_suspended"] is not None
                    or row.get("pinned", 0) != 0
                    or row["time_compacting"] is not None
                    or row["resume_attempts"] != 0):
                protected.add(key)
            for dependency in (row["parent_id"], row.get("fork_session_id")):
                if dependency is not None:
                    if dependency not in parents:
                        protected.add(key)
                    else:
                        parents[root(key)] = root(dependency)
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_schema WHERE type='table'")}
        if not {"session_inbox", "session_pending"} <= tables:
            raise ValueError("missing-activity-schema")
        for table in ("session_inbox", "session_pending", "session_execution_claim", "session_use"):
            if table not in tables:
                continue
            if "session_id" not in columns(connection, table):
                raise ValueError("unknown-activity-schema")
            for (key,) in connection.execute(f'SELECT session_id FROM "{table}"'):
                if key not in parents:
                    raise ValueError("unknown-activity-reference")
                protected.add(key)
        families = {root(key) for key in protected}
        count = sum(root(key) in families for key in parents)
        return {"status": "advisory-only", "total": len(rows), "protected": count,
                "potential_review": len(rows) - count}


def quick_check(connection):
    if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise ValueError("integrity-check-failed")


def checksum(path, deadline=None):
    digest = hashlib.sha256()
    with safe_path(path, private=True).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("checksum-deadline")
            digest.update(block)
    return digest.hexdigest()


def logical_checksum(connection, deadline=None):
    """Hash typed rows losslessly, including NUL text, BLOBs and row identity."""
    digest = hashlib.sha256()
    schema = connection.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
    digest.update(repr(schema).encode("utf-8"))
    for kind, name, _, _ in schema:
        if kind != "table":
            continue
        quoted = '"' + name.replace('"', '""') + '"'
        try:
            rows = connection.execute("SELECT _rowid_,* FROM " + quoted)
        except sqlite3.OperationalError as error:
            if "no such column: _rowid_" not in str(error):
                raise
            rows = connection.execute("SELECT * FROM " + quoted)  # WITHOUT ROWID
        hashes = []
        for row in rows:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("logical-checksum-deadline")
            # SQLite returns only None/int/float/str/bytes. Their tuple repr is
            # typed and lossless; SQL quote()/iterdump() truncates text at NUL.
            hashes.append(hashlib.sha256(repr(row).encode("utf-8")).digest())
        digest.update(name.encode("utf-8") + b"\0")
        for value in sorted(hashes):
            digest.update(value)
    return digest.hexdigest()


def verify_snapshot(directory, deadline=None):
    directory = safe_path(directory, directory=True, private=True)
    manifest_path = safe_path(directory / "manifest.json", private=True)
    if manifest_path.stat().st_size > 4096:
        raise ValueError("invalid-manifest")
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("format") != SNAPSHOTS or manifest.get("profile") not in PROFILES
            or any(not re.fullmatch(r"[a-f0-9]{64}", manifest.get(key, ""))
                   for key in ("sha256", "logical_sha256"))):
        raise ValueError("invalid-manifest")
    database = safe_path(directory / "database.db", private=True)
    if checksum(database, deadline) != manifest["sha256"]:
        raise ValueError("checksum-mismatch")
    with connect(database) as connection:
        if deadline is not None:
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 100)
        quick_check(connection)
    return manifest


def sync_directory(directory):
    fd = os.open(safe_path(directory, directory=True, private=True),
                 os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def remove_retired_snapshot(directory):
    """A durable retirement rename is the receipt for retrying partial removal."""
    directory = safe_path(directory, directory=True, private=True)
    if not re.fullmatch(r"\.retired-" + SNAPSHOT_NAME, directory.name):
        raise ValueError("not-retired-snapshot")
    children = list(directory.iterdir())
    if not {child.name for child in children} <= {"database.db", "manifest.json"}:
        raise ValueError("unexpected-snapshot-files")
    for child in children:
        safe_path(child, private=True)
    sync_directory(directory.parent)
    for child in children:
        child.unlink()
    sync_directory(directory)
    directory.rmdir()
    sync_directory(directory.parent)


def snapshot(path, state, profile, budget=30):
    deadline = time.monotonic() + budget
    path = database_path(path)
    if not path.exists():
        return {"status": "missing"}
    if profile not in PROFILES:
        raise ValueError("unknown-profile")
    state = safe_path(state, directory=True)
    snapshots = private_directory(state / SNAPSHOTS)
    directory = private_directory(snapshots / profile)
    existing = []
    ignored = 0
    # Only directories named by this implementation and with verified receipts.
    for entry in directory.iterdir():
        if re.fullmatch(r"\.retired-" + SNAPSHOT_NAME, entry.name):
            remove_retired_snapshot(entry)
            continue
        if not re.fullmatch(SNAPSHOT_NAME, entry.name):
            ignored += 1
            continue
        manifest = verify_snapshot(entry, deadline)
        if manifest["profile"] != profile:
            raise ValueError("profile-mismatch")
        existing.append((entry, manifest))
    temporary = directory / (".pending-" + uuid.uuid4().hex)
    temporary.mkdir(mode=0o700)
    database = temporary / "database.db"
    try:
        with connect(path) as source:
            size = source.execute("PRAGMA page_count").fetchone()[0]
            size *= source.execute("PRAGMA page_size").fetchone()[0]
            if shutil.disk_usage(directory).free < size + 1024 * 1024:
                raise OSError("insufficient-space")
            fd = os.open(database, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)

            def progress(status, remaining, total):
                if time.monotonic() >= deadline:
                    raise TimeoutError("backup-deadline")

            with contextlib.closing(sqlite3.connect(database)) as target:
                source.backup(target, pages=128, progress=progress, sleep=0.01)
                # Backup inherits WAL mode; published snapshots are standalone.
                target.execute("PRAGMA journal_mode=DELETE").fetchall()
                target.set_progress_handler(lambda: int(time.monotonic() >= deadline), 100)
                quick_check(target)
                logical = logical_checksum(target, deadline)
        # Some SQLite builds leave an orphaned SHM after leaving WAL mode.
        # This is our unpublished target, closed and confirmed in DELETE mode.
        shm = safe_path(Path(str(database) + "-shm"), private=True)
        if shm.exists():
            shm.unlink()
        digest = checksum(database, deadline)
        report = {"status": "unchanged", "ignored_artifacts": ignored}
        survivors = sorted(existing, key=lambda item: item[0].name)[-3:]
        if not any(manifest["logical_sha256"] == logical for _, manifest in survivors):
            manifest = {"format": SNAPSHOTS, "profile": profile, "sha256": digest,
                        "logical_sha256": logical}
            receipt = temporary / "manifest.json"
            fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump(manifest, output)
                output.flush()
                os.fsync(output.fileno())
            with database.open("rb") as output:
                os.fsync(output.fileno())
            sync_directory(temporary)
            published = directory / (f"{time.time_ns():020d}-" + uuid.uuid4().hex)
            temporary.rename(published)
            existing.append((published, manifest))
            report.update(status="created", snapshot_bytes=(published / "database.db").stat().st_size)
        sync_directory(directory)
        # Reuse this locked run's verification, including on an unchanged retry.
        # Retire atomically before unlinking, so partial removal cannot masquerade
        # as a damaged published snapshot and block all future backups.
        for entry, _ in sorted(existing, key=lambda item: item[0].name)[:-3]:
            if time.monotonic() >= deadline:
                raise TimeoutError("snapshot-retention-deadline")
            safe_path(entry, directory=True, private=True)
            retired = entry.with_name(".retired-" + entry.name)
            entry.rename(retired)
            remove_retired_snapshot(retired)
        return report
    finally:
        # Cleanup is restricted to this call's unpublished, exclusive artifacts.
        if temporary.exists():
            for name in ("database.db", "database.db-journal", "database.db-wal",
                         "database.db-shm", "manifest.json"):
                artifact = safe_path(temporary / name)
                if artifact.exists():
                    artifact.unlink()
            temporary.rmdir()


def file_bytes(path):
    path = safe_path(path)
    return path.stat().st_size if path.exists() else 0


def reclaim(path, dry_run=False):
    path = database_path(path)
    if not path.exists():
        return {"status": "missing"}
    if dry_run and dry_run_wal(path):
        return {"status": "deferred-wal-read-only", "committed_pages": 0,
                "file_bytes_before": file_bytes(path),
                "wal_bytes_before": file_bytes(Path(str(path) + "-wal"))}
    committed_pages = 0
    deadline = time.monotonic() + 0.25
    result: dict[str, object] = {"file_bytes_before": file_bytes(path),
                               "wal_bytes_before": file_bytes(Path(str(path) + "-wal"))}
    with connect(path, "ro" if dry_run else "rw", immutable=dry_run) as connection:
        result["page_size"] = connection.execute("PRAGMA page_size").fetchone()[0]
        result["freelist_before"] = connection.execute("PRAGMA freelist_count").fetchone()[0]
        auto = connection.execute("PRAGMA auto_vacuum").fetchone()[0]
        result["status"] = "dry-run" if dry_run else "not-configured" if auto != 2 else "ok"
        if not dry_run and auto == 2:
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 100)
            try:
                while committed_pages < 16384 and time.monotonic() < deadline:
                    connection.execute("BEGIN IMMEDIATE")
                    before = connection.execute("PRAGMA freelist_count").fetchone()[0]
                    if before == 0:
                        connection.rollback()
                        break
                    pages = min(64, 16384 - committed_pages)
                    connection.execute(f"PRAGMA incremental_vacuum({pages})").fetchall()
                    after = connection.execute("PRAGMA freelist_count").fetchone()[0]
                    connection.commit()
                    committed_pages += max(0, before - after)
                    if before == after:
                        break
                    time.sleep(0.001)
            except sqlite3.OperationalError as error:
                connection.set_progress_handler(None, 0)
                if connection.in_transaction:
                    connection.rollback()
                message = str(error).lower()
                if not any(value in message for value in ("interrupted", "locked", "busy")):
                    raise
                result["status"] = "deferred"
                result["reason"] = "busy" if "locked" in message or "busy" in message else "deadline"
            finally:
                connection.set_progress_handler(None, 0)
            if time.monotonic() >= deadline:
                result["status"] = "deferred"
        result["freelist_after"] = connection.execute("PRAGMA freelist_count").fetchone()[0]
        if not dry_run:
            # PASSIVE never waits for readers/writers or truncates WAL. Defer a
            # large checkpoint rather than let it exceed this run's page budget.
            wal = file_bytes(Path(str(path) + "-wal"))
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            if time.monotonic() >= deadline or wal > 32 + 16384 * (page_size + 24):
                result["checkpoint_status"] = "deferred"
            else:
                result["checkpoint"] = list(connection.execute(
                    "PRAGMA wal_checkpoint(PASSIVE)").fetchone())
    result["file_bytes_after"] = file_bytes(path)
    result["wal_bytes_after"] = file_bytes(Path(str(path) + "-wal"))
    result["committed_pages"] = committed_pages
    return result


def run_command(args, timeout):
    # Allowlist rather than attempting to enumerate every credential variable.
    environment = {key: os.environ[key] for key in
                   ("HOME", "PATH", "TMPDIR", "OPENCODE_TEAM_HOME") if key in os.environ}
    environment.update(HOMEBREW_NO_AUTO_UPDATE="1", HOMEBREW_NO_ANALYTICS="1",
                       HOMEBREW_NO_ENV_HINTS="1")
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               text=True, env=environment, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, args)
    return output


def cache_cleanup(dry_run):
    args = ["/bin/zsh", str(Path(__file__).absolute().with_name("disk-cleanup.sh")),
            "--safe-caches-only"]
    if dry_run:
        args.append("--dry-run")
    run_command(args, timeout=300)
    return {"status": "dry-run" if dry_run else "ok"}


def update_check(dry_run):
    if dry_run:
        return {"status": "would-check"}
    try:
        output = run_command(["brew", "outdated", "--json=v2", "--formula"], timeout=15)
    except FileNotFoundError:
        return {"status": "unavailable"}
    data = json.loads(output)
    if not isinstance(data.get("formulae"), list):
        raise ValueError("unknown-update-response")
    outdated = sum(formula.get("name") in ("opencode", "opencode-team")
                   for formula in data["formulae"])
    return {"status": "informational", "outdated_count": outdated}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    failed = False

    def task(name, function, *values):
        nonlocal failed
        try:
            report = function(*values)
        except Exception as error:
            failed = True
            report = {"status": "error", "type": type(error).__name__}
        print(json.dumps({"task": name, **report}, sort_keys=True))

    try:
        home = Path(os.environ["HOME"])
        team = os.environ.get("OPENCODE_TEAM_HOME")
        data = Path(team) / "data" if team else home / ".local/share/opencode-team"
        state = (Path(team) / "state" if team else home / ".local/state/opencode-team") / "maintenance"
        with locked(state):
            for profile in PROFILES:
                database = data / profile / "data/opencode/opencode.db"
                task(profile + ".sessions", session_report, database, args.dry_run)
                if args.dry_run:
                    task(profile + ".snapshot", lambda: {"status": "dry-run"})
                else:
                    task(profile + ".snapshot", snapshot, database, state, profile)
                task(profile + ".reclaim", reclaim, database, args.dry_run)
            task("caches", cache_cleanup, args.dry_run)
            task("updates", update_check, args.dry_run)
    except BlockingIOError:
        print(json.dumps({"task": "maintenance", "status": "locked"}))
    except Exception as error:
        failed = True
        print(json.dumps({"task": "maintenance", "status": "error", "type": type(error).__name__}))
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
