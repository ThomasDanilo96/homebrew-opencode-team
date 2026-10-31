"""Read-only maintenance evidence; only the explicit, new output file is written.

Exit codes: 0 baseline captured, 1 failed evidence, 2 pending attribution/run.
Calendar consistency is not proof that launchd scheduled a particular run.
Deploy first, then capture baseline before 04:15; verify against that same code.
Pre-deploy evidence is a separate record, not the baseline for this verification.
"""

import argparse
import base64
import hashlib
import json
import os
import plistlib
import re
import selectors
import sqlite3
import stat
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

LABEL = "io.opencode-team.safe-caches"
TASKS = tuple(profile + "." + task for profile in ("best", "free")
              for task in ("sessions", "snapshot", "reclaim")) + ("caches", "updates")
TASK_STATES = {"sessions": ("advisory-only",), "snapshot": ("created", "unchanged"),
               "reclaim": ("ok", "deferred", "not-configured"), "caches": ("ok",),
               "updates": ("informational", "unavailable")}
MAX_LOG_BYTES = 16 * 1024 * 1024
SNAPSHOT_NAME = re.compile(r"[0-9]{20}-[a-f0-9]{32}\Z")


def safe_path(path):
    path = Path(os.path.abspath(path))
    for component in reversed((path, *path.parents)):
        if component.is_symlink():
            raise ValueError("symlink")
    return path


def read_bytes(path, limit=None):
    path = safe_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("not-regular-file")
        data = source.read() if limit is None else source.read(limit + 1)
        if limit is not None and len(data) > limit:
            raise ValueError("evidence-size-limit")
        return data


def digest_file(path):
    path = safe_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("not-regular-file")
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def default_paths():
    home = Path.home()
    team = os.environ.get("OPENCODE_TEAM_HOME")
    state = Path(team) / "state" if team else home / ".local/state/opencode-team"
    return {"plist": str(home / "Library/LaunchAgents" / (LABEL + ".plist")),
            "state": str(state / "maintenance")}


def launch_state():
    deadline = time.monotonic() + 5
    with subprocess.Popen(
        ["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        data = bytearray()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError("launchctl-timeout")
                    chunk = os.read(process.stdout.fileno(), 8192)
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > 262144:
                        raise ValueError("launchctl-output-limit")
            exit_code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    text = data.decode("utf-8", errors="replace")
    if exit_code not in (0, 113):
        raise ValueError("launchctl-print-failed")
    fields = {"loaded": exit_code == 0, "print_exit_code": exit_code}
    for key, pattern in (("runs", r"^\s*runs = (\d+)\s*$"),
                         ("last_exit_code", r"^\s*last exit code = (-?\d+)\s*$")):
        match = re.search(pattern, text, re.MULTILINE)
        fields[key] = int(match[1]) if match else None
    return fields


def snapshot_evidence(root):
    root = safe_path(root)
    entries = {}
    unknown = []
    if not root.exists():
        return {"entries": entries, "unknown_artifacts": unknown}
    for profile_dir in sorted(root.iterdir()):
        if profile_dir.name not in ("best", "free") or profile_dir.is_symlink() or not profile_dir.is_dir():
            unknown.append(profile_dir.name)
            continue
        for directory in sorted(profile_dir.iterdir()):
            name = profile_dir.name + "/" + directory.name
            if not SNAPSHOT_NAME.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
                unknown.append(name)
                continue
            children = {child.name for child in directory.iterdir()}
            unknown.extend(name + "/" + child for child in sorted(children - {"database.db", "manifest.json"}))
            if children & {"database.db-wal", "database.db-shm", "database.db-journal"}:
                raise ValueError("snapshot-not-standalone")
            manifest_bytes = read_bytes(directory / "manifest.json", 4096)
            manifest = json.loads(manifest_bytes)
            if (manifest.get("format") != "snapshots-v1"
                    or manifest.get("profile") != profile_dir.name
                    or any(not isinstance(manifest.get(key), str)
                           or not re.fullmatch(r"[a-f0-9]{64}", manifest[key])
                           for key in ("sha256", "logical_sha256"))):
                raise ValueError("invalid-manifest")
            database = safe_path(directory / "database.db")
            digest = digest_file(database)
            if digest != manifest["sha256"]:
                raise ValueError("snapshot-checksum-mismatch")
            deadline = time.monotonic() + 5
            # Immutable is safe only here: published standalone snapshots, never live databases.
            connection = sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)
            try:
                connection.set_progress_handler(lambda end=deadline: int(time.monotonic() > end), 1000)
                check = connection.execute("PRAGMA quick_check").fetchall()
            finally:
                connection.close()
            if check != [("ok",)]:
                raise ValueError("snapshot-quick-check-failed")
            entries[name] = {"manifest": manifest,
                             "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                             "sha256": digest, "quick_check": "ok"}
    return {"entries": entries, "unknown_artifacts": unknown}


def capture():
    paths = default_paths()
    plist_bytes = read_bytes(paths["plist"], 65536)
    plist = plistlib.loads(plist_bytes)
    args = plist.get("ProgramArguments", [])
    if (plist.get("Label") != LABEL or len(args) != 2
            or args[0] != "/usr/bin/python3" or Path(args[1]).name != "maintenance.py"):
        raise ValueError("unexpected-maintenance-command")
    # Homebrew's opt path is a symlink; resolving this read-only code input is intentional.
    script = safe_path(Path(args[1]).resolve(strict=True))
    logs = {}
    for key in ("StandardOutPath", "StandardErrorPath"):
        path = safe_path(plist[key])
        data = read_bytes(path, MAX_LOG_BYTES)
        info = path.stat()
        logs[str(path)] = {"device": info.st_dev, "inode": info.st_ino,
                           "size": len(data), "offset": len(data),
                           "sha256": hashlib.sha256(data).hexdigest()}
    return {"format": 1, "captured_at": datetime.now(timezone.utc).isoformat(),
            "paths": paths, "label": LABEL, "launchctl": launch_state(),
            "plist": {"sha256": hashlib.sha256(plist_bytes).hexdigest(),
                      "command": args, "interpreter": args[0],
                      "schedule": plist.get("StartCalendarInterval")},
            "script": {"path": str(script), "sha256": digest_file(script),
                       "version": read_bytes(script.parent.parent / "VERSION", 128).decode().strip()},
            "logs": logs, "snapshots": snapshot_evidence(Path(paths["state"]) / "snapshots-v1")}


def utc_timestamp(value):
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.utcoffset() != timezone.utc.utcoffset(timestamp):
        raise ValueError("timestamp-not-utc")
    return timestamp


def verify(baseline, current, version, digest):
    failures = []
    pending_reasons = []
    appended = {}
    reports = []
    if baseline.get("format") != 1 or baseline["paths"] != current["paths"]:
        failures.append("baseline-contract-mismatch")
    if baseline["plist"] != current["plist"]:
        failures.append("plist-changed")
    if current["script"]["version"] != version or current["script"]["sha256"] != digest:
        failures.append("installed-code-mismatch")
    if baseline["script"] != current["script"]:
        failures.append("installed-code-changed")
    if set(baseline["logs"]) != set(current["logs"]):
        failures.append("log-paths-changed")
    for path, before in baseline["logs"].items():
        data = read_bytes(path, MAX_LOG_BYTES)
        after = current["logs"].get(path, {})
        offset = before["offset"]
        if (any(before[key] != after.get(key) for key in ("device", "inode"))
                or len(data) < offset or hashlib.sha256(data[:offset]).hexdigest() != before["sha256"]
                or len(data) != after.get("size")
                or hashlib.sha256(data).hexdigest() != after.get("sha256")):
            failures.append("log-not-append-only")
            continue
        tail = data[offset:]
        appended[path] = {"offset": offset, "size": len(tail),
                          "bytes_base64": base64.b64encode(tail).decode("ascii")}
        if offset and data[offset - 1:offset] != b"\n" or tail and not tail.endswith(b"\n"):
            failures.append("partial-log-line")
        for line in tail.splitlines():
            if not line.startswith(b"{"):
                continue
            try:
                report = json.loads(line)
                if not isinstance(report, dict) or "task" not in report:
                    raise ValueError("invalid-report")
                reports.append(report)
            except (ValueError, UnicodeError):
                failures.append("invalid-json-report")
    start = utc_timestamp(baseline["captured_at"])
    finish = utc_timestamp(current["captured_at"])
    runs = {}
    for report in reports:
        try:
            run_id = report["run_id"]
            if (not isinstance(run_id, str) or not run_id or report["task"] not in TASKS
                    or report["version"] != version or report["script_sha256"] != digest
                    or not start <= utc_timestamp(report["started_at"])
                    <= utc_timestamp(report["finished_at"]) <= finish
                    or report.get("status") not in TASK_STATES[report["task"].split(".")[-1]]
                    or report.get("status") == "deferred" and report.get("reason") not in ("busy", "deadline")
                    or report.get("checkpoint_status") == "deferred"
                    and (not report["task"].endswith(".reclaim")
                         or report.get("checkpoint_reason") not in ("deadline", "page-budget"))):
                raise ValueError("invalid-run-report")
            if report["task"] == "updates" and report["status"] == "unavailable":
                pending_reasons.append("updates-unavailable")
            runs.setdefault(run_id, []).append(report)
        except (KeyError, TypeError, ValueError, AttributeError):
            failures.append("invalid-run-report")
    for run in runs.values():
        if sorted(report["task"] for report in run) != sorted(TASKS):
            failures.append("incomplete-or-duplicate-task-set")
        ordered = sorted(run, key=lambda report: utc_timestamp(report["started_at"]))
        if any(utc_timestamp(ordered[index - 1]["finished_at"]) > utc_timestamp(report["started_at"])
               for index, report in enumerate(ordered) if index):
            failures.append("overlapping-task-times")
    old_launch, new_launch = baseline["launchctl"], current["launchctl"]
    if not new_launch["loaded"]:
        failures.append("job-not-loaded")
    if runs and (new_launch.get("last_exit_code") != 0
                 or not isinstance(old_launch.get("runs"), int)
                 or not isinstance(new_launch.get("runs"), int)
                 or new_launch["runs"] - old_launch["runs"] != len(runs)):
        failures.append("new-run-launchctl-mismatch")
    if len(runs) > 1:
        # launchctl exposes only the latest exit, not a trustworthy exit history.
        failures.append("multiple-new-run-exits-unproven")
    old_snapshots = baseline["snapshots"]["entries"]
    new_snapshots = current["snapshots"]["entries"]
    for run in runs.values():
        for report in run:
            if report["task"].endswith(".snapshot"):
                profile = report["task"].split(".")[0] + "/"
                names = {name for name in new_snapshots if name.startswith(profile)}
                if not names or report["status"] == "created" and not names - old_snapshots.keys():
                    failures.append("snapshot-report-inventory-mismatch")
    if any(new_snapshots[name] != old_snapshots[name] for name in old_snapshots.keys() & new_snapshots.keys()):
        failures.append("published-snapshot-changed")
    unknown_preserved = set(baseline["snapshots"]["unknown_artifacts"]) <= set(
        current["snapshots"]["unknown_artifacts"])
    if not unknown_preserved:
        failures.append("unknown-artifact-disappeared")
    calendar_matches = current["plist"]["schedule"] == {"Hour": 4, "Minute": 15}
    # A conservative minute match allows no delayed-start tolerance and proves no attribution.
    first_starts = [min(utc_timestamp(report["started_at"]) for report in run).astimezone()
                    for run in runs.values()]
    run_time_consistent = bool(first_starts) and all(
        (started.hour, started.minute) == (4, 15) for started in first_starts)
    if not calendar_matches:
        failures.append("unexpected-schedule")
    verdict = "FAIL" if failures else "PASS" if runs and not pending_reasons else "PENDING"
    return {"format": 1, "evidence_verdict": verdict,
            "production_verdict": "FAIL" if failures else "PENDING",
            "calendar_matches": calendar_matches, "run_time_consistent": run_time_consistent,
            "schedule_consistent": calendar_matches and run_time_consistent,
            "schedule_attribution": "PENDING", "pending_reasons": sorted(set(pending_reasons)),
            "schedule_attribution_reason": "External trusted per-run launchd scheduler observation required.",
            "failures": sorted(set(failures)), "current": current, "appended_logs": appended,
            "unknown_artifacts_preserved": unknown_preserved,
            "new_runs": [{"run_id": key, "reports": value} for key, value in runs.items()],
            "new_snapshots": sorted(new_snapshots.keys() - old_snapshots.keys()),
            "removed_snapshots": sorted(old_snapshots.keys() - new_snapshots.keys())}


def write_output(path, value):
    path = safe_path(path)
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    baseline_parser = commands.add_parser("baseline")
    baseline_parser.add_argument("--output", required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--baseline", required=True)
    verify_parser.add_argument("--expected-version", required=True)
    verify_parser.add_argument("--expected-sha256", required=True)
    verify_parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    if args.command == "verify" and not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha256):
        parser.error("--expected-sha256 must be a lowercase SHA-256 digest")
    try:
        if args.command == "baseline":
            result = capture()
            code = 0
        else:
            baseline = json.loads(read_bytes(args.baseline, 32 * 1024 * 1024))
            result = verify(baseline, capture(), args.expected_version, args.expected_sha256)
            code = 1 if result["production_verdict"] == "FAIL" else 2
    except (OSError, ValueError, KeyError, TypeError, AttributeError,
             sqlite3.Error, subprocess.SubprocessError) as error:
        reason = error.args[0] if error.args else None
        if reason not in ("symlink", "not-regular-file", "evidence-size-limit",
                          "launchctl-timeout", "launchctl-output-limit", "launchctl-print-failed",
                          "snapshot-not-standalone", "invalid-manifest", "snapshot-checksum-mismatch",
                          "snapshot-quick-check-failed", "unexpected-maintenance-command", "timestamp-not-utc"):
            reason = "unclassified"
        result = {"production_verdict": "FAIL", "failures": [type(error).__name__],
                  "error_reason": reason}
        if isinstance(error, OSError):
            result["error_errno"] = error.errno
        code = 1
    try:
        write_output(args.output, result)
    except (OSError, ValueError) as error:
        parser.exit(1, "Evidence output not written: " + type(error).__name__ + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
