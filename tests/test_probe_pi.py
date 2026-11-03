import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "probe_pi", Path(__file__).parents[1] / "scripts" / "probe_pi.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    @patch.object(probe.shutil, "which", return_value=None)
    def test_missing_tool_is_explicit(self, _):
        self.assertEqual(probe.run(["missing"])["status"], "missing")

    @patch.object(probe.shutil, "which", return_value="tool")
    @patch.object(probe.subprocess, "run", side_effect=subprocess.TimeoutExpired("tool", 15))
    def test_hung_driver_tool_has_deadline(self, *_):
        self.assertEqual(probe.run(["tool"])["status"], "timeout")

    @patch.object(probe.shutil, "which", return_value="tool")
    @patch.object(probe.subprocess, "run", return_value=subprocess.CompletedProcess(
        ["tool"], 1, "", "unsupported"))
    def test_unsupported_capability_is_not_success(self, *_):
        result = probe.run(["tool"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["output"], "unsupported")


if __name__ == "__main__":
    unittest.main()
