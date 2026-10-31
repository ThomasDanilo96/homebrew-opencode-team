"""Behavioral regression for bounded benchmark matrix completion."""

import contextlib
import io
import json
import unittest
from unittest import mock

import benchmark_maintenance as benchmark


class BenchmarkControlTests(unittest.TestCase):
    def test_qualification_rejects_incomplete_or_failed_snapshot(self):
        for expired in (True, False):
            with self.subTest(expired=expired), \
                    mock.patch.object(benchmark, "LARGE", {"sessions": 2, "mib": 1}), \
                    mock.patch.object(benchmark, "QUALIFICATION_GLOBAL_BUDGET_S", 1), \
                    mock.patch.object(benchmark.time, "monotonic", side_effect=[0, 2] if expired else None,
                                      return_value=0), \
                    mock.patch.object(benchmark.maintenance, "snapshot", return_value={"status": "error"}), \
                    mock.patch.object(benchmark, "verify_integrity", return_value={"ok": True}), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(benchmark.qualification(), 1)
                summary = json.loads(output.getvalue().splitlines()[-1])
                self.assertFalse(summary["qualification_complete"])
                self.assertEqual(summary["runs"], 0 if expired else 1)

    def test_global_deadline_cannot_omit_cells_and_report_success(self):
        for expired, count, code in ((True, 1, 1), (False, 4, 0)):
            with self.subTest(expired=expired):
                output = io.StringIO()
                clock = [0, 2, 2] if expired else None
                with mock.patch.object(benchmark, "GLOBAL_BUDGET_S", 1), \
                        mock.patch.object(benchmark.time, "monotonic", side_effect=clock, return_value=0), \
                        mock.patch.object(benchmark, "run_cell", return_value={"status": "ok"}), \
                        contextlib.redirect_stdout(output):
                    self.assertEqual(benchmark.main(), code)
                result = json.loads(output.getvalue())
                self.assertEqual(result["cells_completed"], count)
                self.assertEqual(result["cells_expected"], 4)
                self.assertEqual(result["matrix_complete"], not expired)


if __name__ == "__main__":
    unittest.main()
