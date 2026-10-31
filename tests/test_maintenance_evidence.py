import base64
import hashlib
import importlib.util
import json
import os
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if not os.environ.get("OPENCODE_TEAM_STAGING_ROOT") or ROOT != Path(
        os.environ["OPENCODE_TEAM_STAGING_ROOT"]).resolve():
    raise RuntimeError("Run tests with bash tests/guardrail/runner.sh")
for name in ("HOME", "OPENCODE_TEAM_HOME", "TMPDIR"):
    if ROOT not in Path(os.environ.get(name, "/")).resolve().parents:
        raise RuntimeError("Test environment escapes isolated staging")
SPEC = importlib.util.spec_from_file_location("maintenance_evidence", ROOT / "shared/maintenance_evidence.py")
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.snapshots = self.state / "snapshots-v1"
        self.snapshots.mkdir(parents=True)
        for profile in ("best", "free"):
            self.create_snapshot(profile, "b")
        self.script = self.root / "libexec/shared/maintenance.py"
        self.script.parent.mkdir(parents=True)
        self.script.write_text("# fixture only\n")
        (self.script.parent.parent / "VERSION").write_text("0.3.7\n")
        self.digest = hashlib.sha256(self.script.read_bytes()).hexdigest()
        self.log = self.state / "maintenance.log"
        self.log.write_bytes(b"old log\n")
        self.plist = self.root / "job.plist"
        self.plist.write_bytes(plistlib.dumps({
            "Label": evidence.LABEL,
            "ProgramArguments": ["/usr/bin/python3", str(self.script)],
            "StartCalendarInterval": {"Hour": 4, "Minute": 15},
            "StandardOutPath": str(self.log), "StandardErrorPath": str(self.log),
        }))
        self.paths = {"plist": str(self.plist), "state": str(self.state)}
        self.launch = {"loaded": True, "runs": 3, "last_exit_code": 0,
                       "print_exit_code": 0}
        self.addCleanup(patch.stopall)
        patch.object(evidence, "default_paths", return_value=self.paths).start()
        patch.object(evidence, "launch_state", side_effect=lambda: dict(self.launch)).start()

    def create_snapshot(self, profile, suffix):
        directory = self.snapshots / profile / ("0" * 20 + "-" + suffix * 32)
        directory.mkdir(parents=True)
        db = directory / "database.db"
        with sqlite3.connect(db) as connection:
            connection.execute("create table fixture (id integer)")
        manifest = {"format": "snapshots-v1", "profile": profile,
                    "sha256": hashlib.sha256(db.read_bytes()).hexdigest(),
                    "logical_sha256": "b" * 64}
        (directory / "manifest.json").write_text(json.dumps(manifest))
        return directory

    def baseline(self):
        target = self.root / "baseline.json"
        self.assertEqual(evidence.main(["baseline", "--output", str(target)]), 0)
        return target

    def append_run(self, task_changes=None, **changes):
        now = datetime.now(timezone.utc)
        reports = []
        for index, task in enumerate(evidence.TASKS):
            started = now + timedelta(microseconds=index * 2)
            report = {"task": task, "status": "ok", "run_id": "fixture-run",
                      "version": "0.3.7", "script_sha256": self.digest,
                      "started_at": started.isoformat(),
                      "finished_at": (started + timedelta(microseconds=1)).isoformat()}
            report["status"] = {"sessions": "advisory-only", "snapshot": "unchanged",
                                "reclaim": "ok", "caches": "ok", "updates": "informational"}[
                                    task.split(".")[-1]]
            report.update(changes)
            report.update((task_changes or {}).get(task, {}))
            reports.append(report)
        with self.log.open("ab") as output:
            output.write(b"".join((json.dumps(report) + "\n").encode() for report in reports))
        self.launch["runs"] += 1

    def verify(self, baseline):
        target = self.root / "verified.json"
        code = evidence.main(["verify", "--baseline", str(baseline),
                              "--expected-version", "0.3.7", "--expected-sha256", self.digest,
                              "--output", str(target)])
        return code, json.loads(target.read_text())

    def test_complete_new_run_remains_pending_without_scheduler_attribution(self):
        baseline = self.baseline()
        self.append_run()
        code, result = self.verify(baseline)
        self.assertEqual(code, 2)
        self.assertEqual(result["evidence_verdict"], "PASS")
        self.assertEqual(result["production_verdict"], "PENDING")
        self.assertEqual(result["schedule_attribution"], "PENDING")
        self.assertTrue(result["calendar_matches"])
        started = evidence.utc_timestamp(result["new_runs"][0]["reports"][0]["started_at"]).astimezone()
        expected_time_match = (started.hour, started.minute) == (4, 15)
        self.assertEqual(result["run_time_consistent"], expected_time_match)
        self.assertEqual(result["schedule_consistent"], expected_time_match)
        self.assertEqual(len(result["new_runs"][0]["reports"]), 8)
        self.assertTrue(base64.b64decode(result["appended_logs"][str(self.log)]["bytes_base64"]))

    def test_no_new_run_is_pending_not_pass(self):
        code, result = self.verify(self.baseline())
        self.assertEqual(code, 2)
        self.assertEqual(result["evidence_verdict"], "PENDING")
        self.assertFalse(result["schedule_consistent"])

    def test_invalid_task_status_cannot_pass(self):
        for task, status in (("caches", "deferred"), ("best.snapshot", "advisory-only"),
                             ("free.sessions", "ok"), ("updates", "ok")):
            with self.subTest(task=task):
                baseline = evidence.capture()
                self.append_run(task_changes={task: {"status": status, "reason": "deadline"}})
                result = evidence.verify(baseline, evidence.capture(), "0.3.7", self.digest)
                self.assertEqual(result["evidence_verdict"], "FAIL")
                self.assertIn("invalid-run-report", result["failures"])

    def test_unavailable_updates_prevents_evidence_pass(self):
        baseline = self.baseline()
        self.append_run(task_changes={"updates": {"status": "unavailable"}})
        code, result = self.verify(baseline)
        self.assertEqual(code, 2)
        self.assertEqual(result["evidence_verdict"], "PENDING")
        self.assertEqual(result["pending_reasons"], ["updates-unavailable"])

    def test_reclaim_deferred_reason_must_be_supported(self):
        for reason in ("busy", "deadline", "arbitrary"):
            with self.subTest(reason=reason):
                baseline = evidence.capture()
                self.append_run(task_changes={"best.reclaim": {"status": "deferred", "reason": reason}})
                result = evidence.verify(baseline, evidence.capture(), "0.3.7", self.digest)
                self.assertEqual(result["evidence_verdict"], "FAIL" if reason == "arbitrary" else "PASS")

    def test_truncated_or_rewritten_log_fails_closed(self):
        baseline = self.baseline()
        self.log.write_bytes(b"changed\n")
        code, result = self.verify(baseline)
        self.assertEqual(code, 1)
        self.assertIn("log-not-append-only", result["failures"])

    def test_rotated_log_fails_closed(self):
        baseline = self.baseline()
        self.log.rename(self.log.with_suffix(".old"))
        self.log.write_bytes(b"old log\n")
        self.append_run()
        code, result = self.verify(baseline)
        self.assertEqual(code, 1)
        self.assertIn("log-not-append-only", result["failures"])

    def test_wrong_code_and_missing_deferred_reason_fail(self):
        baseline = self.baseline()
        self.append_run(script_sha256="0" * 64, status="deferred")
        code, result = self.verify(baseline)
        self.assertEqual(code, 1)
        self.assertIn("invalid-run-report", result["failures"])

    def test_new_snapshot_checked_without_sidecars_and_unknown_artifact_preserved(self):
        baseline = self.baseline()
        directory = self.create_snapshot("best", "a")
        unknown = directory.parent / ".operator-note"
        unknown.write_text("preserve")
        before = {p.name: p.read_bytes() for p in directory.iterdir()}
        self.append_run(task_changes={"best.snapshot": {"status": "created"}})
        code, result = self.verify(baseline)
        self.assertEqual(code, 2)
        self.assertEqual(result["new_snapshots"], ["best/" + directory.name])
        self.assertTrue(result["current"]["snapshots"]["unknown_artifacts"])
        self.assertEqual(unknown.read_text(), "preserve")
        self.assertEqual(before, {p.name: p.read_bytes() for p in directory.iterdir()})

    def test_output_cannot_overwrite_or_follow_symlink(self):
        target = self.root / "existing"
        target.write_text("keep")
        with self.assertRaises(FileExistsError):
            evidence.write_output(target, {})
        link = self.root / "link"
        link.symlink_to(target)
        with self.assertRaises(ValueError):
            evidence.write_output(link, {})
        self.assertEqual(target.read_text(), "keep")

    def test_capture_failures_keep_only_controlled_diagnostic_reasons(self):
        for reason, expected in (("evidence-size-limit", "evidence-size-limit"),
                                 ("fixture-secret-bearing-error", "unclassified")):
            with self.subTest(reason=reason):
                target = self.root / (expected + ".json")
                with patch.object(evidence, "capture", side_effect=ValueError(reason)):
                    self.assertEqual(evidence.main(["baseline", "--output", str(target)]), 1)
                result = json.loads(target.read_text())
                self.assertEqual(result["error_reason"], expected)
                self.assertNotIn("fixture-secret", target.read_text())

    def test_output_is_flushed_to_storage(self):
        with patch.object(evidence.os, "fsync", wraps=os.fsync) as fsync:
            evidence.write_output(self.root / "durable.json", {"fixture": True})
        fsync.assert_called_once()

    def test_flush_failure_cannot_return_success(self):
        with patch.object(evidence.os, "fsync", side_effect=OSError), self.assertRaises(SystemExit) as error:
            evidence.main(["baseline", "--output", str(self.root / "failed-output.json")])
        self.assertEqual(error.exception.code, 1)

    def test_launchctl_missing_is_not_loaded_and_numeric_fields_are_parsed(self):
        patch.stopall()
        popen = subprocess.Popen
        def fixture_process(*args, **kwargs):
            return popen([sys.executable, "-c", "print(' runs = 3'); print(' last exit code = 0'); exit(113)"],
                         **kwargs)
        with patch.object(evidence.subprocess, "Popen", side_effect=fixture_process):
            result = evidence.launch_state()
        self.assertFalse(result["loaded"])
        self.assertEqual(result["runs"], 3)
        self.assertEqual(result["last_exit_code"], 0)

    def test_other_launchctl_exit_is_an_error_not_unloaded(self):
        patch.stopall()
        popen = subprocess.Popen
        def fixture_process(*args, **kwargs):
            return popen([sys.executable, "-c", "exit(1)"], **kwargs)
        with patch.object(evidence.subprocess, "Popen", side_effect=fixture_process), self.assertRaises(ValueError):
            evidence.launch_state()


if __name__ == "__main__":
    unittest.main()
