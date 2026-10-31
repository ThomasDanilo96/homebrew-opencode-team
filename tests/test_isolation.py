"""Kernel-level negative controls for the sandbox guardrail.

These tests prove the sandbox denies what it must deny. Meaningful only under
sandbox-exec (detected via OPENCODE_TEAM_STAGING_ROOT). Probes use a sentinel
directory OUTSIDE staging (passed via OPENCODE_TEAM_OUTSIDE_ROOT) — a second
mktemp root created by the runner before sandboxing. This proves global temp is
neither readable nor writable, without ever touching real user data.

Probes:
  1. read pre-created sentinel in OUTSIDE_ROOT  → EPERM
  2. write to OUTSIDE_ROOT                       → EPERM
  3. TCP connect                                 → EPERM (errno 1, not ECONNREFUSED)
  4. unix bind in OUTSIDE_ROOT                   → EPERM
  5. exec /bin/launchctl                         → PermissionError
  6. exec a denied maintenance binary            → PermissionError
  7. actual maintenance module guard blocks:
     - unmocked run_command
     - file: URI pointing outside temp
     - bytes path outside temp
     - symlink escape
"""

import errno
import os
import socket
import subprocess
import tempfile
import unittest

STAGING = os.environ.get("OPENCODE_TEAM_STAGING_ROOT")
OUTSIDE = os.environ.get("OPENCODE_TEAM_OUTSIDE_ROOT")


class TestSandboxDenials(unittest.TestCase):
    """Each test asserts a specific sandbox denial with explicit errno/type."""

    @classmethod
    def setUpClass(cls):
        if not STAGING or not OUTSIDE:
            raise unittest.SkipTest("not running under sandbox-exec")

    def test_read_outside_sentinel_denied(self):
        """Sentinel file created before sandbox must not be readable."""
        sentinel = os.path.join(OUTSIDE, "sentinel.txt")
        with self.assertRaises(PermissionError) as ctx, open(sentinel, "r") as f:
            f.read()
        self.assertEqual(ctx.exception.errno, errno.EPERM)

    def test_write_outside_staging_denied(self):
        sentinel = os.path.join(OUTSIDE, "write-probe")
        with self.assertRaises(PermissionError) as ctx, open(sentinel, "w") as f:
            f.write("probe")
        self.assertEqual(ctx.exception.errno, errno.EPERM)
        self.assertFalse(os.path.exists(sentinel))

    def test_tcp_connect_denied(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        with self.assertRaises(OSError) as ctx:
            s.connect(("127.0.0.1", 9))
        s.close()
        self.assertEqual(ctx.exception.errno, errno.EPERM)

    def test_unix_socket_bind_outside_staging_denied(self):
        path = os.path.join(OUTSIDE, "probe.sock")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(1)
        with self.assertRaises(OSError) as ctx:
            s.bind(path)
        s.close()
        self.assertEqual(ctx.exception.errno, errno.EPERM)
        self.assertFalse(os.path.exists(path))

    def test_launchctl_exec_denied(self):
        import subprocess
        with self.assertRaises(PermissionError):
            subprocess.run(
                ["/bin/launchctl", "print"],
                capture_output=True, timeout=5, check=False,
            )

    def test_maintenance_tool_exec_denied(self):
        """A denied maintenance binary must not exec."""
        import subprocess
        candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew",
                      "/bin/launchctl", "/usr/bin/docker"]
        targets = [p for p in candidates if os.path.exists(p)]
        self.assertTrue(targets, "no denied maintenance binary to probe")
        for target in targets:
            with self.subTest(target=target), self.assertRaises(PermissionError):
                subprocess.run(
                    [target, "--version"],
                    capture_output=True, timeout=5, check=False,
                )

    def test_direct_suite_entrypoints_fail_before_fixtures(self):
        commands = [
            ["/usr/bin/python3", "-B", "tests/test_maintenance.py"],
            ["node", "--test", "tests/disk-cleanup.test.mjs"],
            ["/bin/bash", "tests/setup-smoke.sh"],
            ["/bin/bash", "tests/homebrew-workflow.test.sh"],
        ]
        with tempfile.TemporaryDirectory() as directory:
            env = {"HOME": os.environ["HOME"], "TMPDIR": directory,
                   "PATH": os.environ["PATH"]}
            for command in commands:
                with self.subTest(command=command):
                    result = subprocess.run(command, env=env, capture_output=True,
                                            text=True, timeout=15, check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("guardrail/runner.sh", result.stderr + result.stdout)
                    self.assertEqual(os.listdir(directory), [])


class TestMaintenanceGuard(unittest.TestCase):
    """Test the ACTUAL maintenance module's fail-closed guards.

    Imports test_maintenance so its module-level guards are installed, then
    exercises the real maintenance module to prove containment.
    """

    @classmethod
    def setUpClass(cls):
        if not STAGING:
            raise unittest.SkipTest("not running under sandbox-exec")

    def setUp(self):
        # Import test_maintenance for its side effect: installing the
        # module-level fail-closed guards on the real maintenance module.
        import sys
        if "test_maintenance" not in sys.modules:
            import test_maintenance  # noqa: F401 — side effects: guard install
        self.maintenance = sys.modules["test_maintenance"].maintenance
        self.PathContainmentError = sys.modules["test_maintenance"].PathContainmentError

    def test_unmocked_run_command_blocked(self):
        with self.assertRaises(self.PathContainmentError):
            self.maintenance.run_command(["echo"])

    def test_run_command_with_mock_allowed(self):
        """A legit test mocks Popen — must not raise containment error."""
        from unittest import mock
        fake = mock.Mock()
        fake.communicate.return_value = (b"", b"")
        fake.returncode = 0
        with mock.patch.object(self.maintenance.subprocess, "Popen", return_value=fake):
            try:
                self.maintenance.run_command(["echo"], timeout=5)
            except self.PathContainmentError:
                self.fail("guarded run_command raised on mocked Popen")

    def test_sqlite_file_uri_outside_temp_blocked(self):
        """A file: URI pointing outside the containment root is blocked."""
        import sqlite3
        bad_uri = "file:" + os.path.join(OUTSIDE, "escape.db") + "?mode=rw"
        with self.assertRaises(self.PathContainmentError):
            sqlite3.connect(bad_uri)

    def test_sqlite_bytes_path_outside_temp_blocked(self):
        """A bytes path outside the containment root is blocked."""
        import sqlite3
        bad = os.path.join(OUTSIDE, "bytes-escape.db").encode("utf-8")
        with self.assertRaises(self.PathContainmentError):
            sqlite3.connect(bad)

    def test_sqlite_symlink_escape_blocked(self):
        """A symlink pointing outside the containment root is blocked."""
        import sqlite3
        import tempfile as _tf
        target = os.path.join(OUTSIDE, "symlink-target.db")
        # Create target outside staging (we can write there because the test
        # process itself is inside staging but OUTSIDE_ROOT is denied for
        # writes — so create the symlink source inside staging pointing out).
        link = os.path.join(_tf.gettempdir(), "ocgt-symlink-escape")
        try:
            os.symlink(target, link)
        except FileExistsError:
            os.unlink(link)
            os.symlink(target, link)
        try:
            with self.assertRaises((self.PathContainmentError, ValueError)):
                sqlite3.connect(link)
        finally:
            if os.path.islink(link):
                os.unlink(link)

    def test_safe_path_outside_blocked(self):
        """maintenance.safe_path rejects paths outside containment.

        Either the guard fires (PathContainmentError) or the sandbox denies
        the lstat (PermissionError) — both prove containment.
        """
        from pathlib import Path
        target = Path(OUTSIDE) / "foreign-state"
        try:
            self.maintenance.safe_path(target, directory=True)
            self.fail("safe_path accepted a path outside containment")
        except (self.PathContainmentError, PermissionError):
            pass


if __name__ == "__main__":
    unittest.main()
