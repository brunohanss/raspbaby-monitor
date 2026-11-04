"""Offline regression checks. These tests do not read or change hardware."""

import argparse
import hashlib
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

import activate
import build
import runtime


def valid_snapshot():
    return {
        "kernel": runtime.KERNEL, "model": runtime.MODEL,
        "root_source": "/dev/mmcblk0p2", "wifi_route": True, "wifi_is_usb": False,
        "usb_storage": [], "consumers": [], "camera_present": True,
        "stock_uvc": True, "driver": "dwc2", "override": "", "test_loaded": False,
    }


class SourceTests(unittest.TestCase):
    def write_source(self, directory, anchor="\tdwc2_check_params(hsotg);"):
        (directory / "platform.c").write_text('static const char dwc2_driver_name[] = "dwc2";\n')
        (directory / "params.c").write_text("EXPORT_SYMBOL_GPL(dwc2_pci_ids);\n" + anchor)

    def test_patch_keeps_checks_then_disables_all_three_dma_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.write_source(directory)
            build.patch_source(directory)
            params = (directory / "params.c").read_text()
            self.assertNotIn("EXPORT_SYMBOL_GPL(dwc2_pci_ids)", params)
            for flag in ("host_dma", "dma_desc_enable", "dma_desc_fs_enable"):
                self.assertGreater(params.index(f"hsotg->params.{flag} = false;"), params.index("dwc2_check_params(hsotg);"))
            self.assertIn('dwc2_driver_name[] = "dwc2_pio_test"', (directory / "platform.c").read_text())
            self.assertIn("hcd_ddma.o gadget.o debugfs.o", (directory / "Makefile").read_text())
            with self.assertRaises(ValueError):
                build.patch_source(directory)

    def test_missing_or_duplicate_anchor_does_not_partially_patch(self):
        for anchor in ("different_kernel();", "\tdwc2_check_params(hsotg);\n\tdwc2_check_params(hsotg);"):
            with self.subTest(anchor=anchor), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                self.write_source(directory, anchor)
                original = (directory / "platform.c").read_bytes()
                with self.assertRaises(ValueError):
                    build.patch_source(directory)
                self.assertEqual((directory / "platform.c").read_bytes(), original)

    def test_rejects_a_different_module_before_modinfo(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = Path(temporary) / "module.ko"
            module.write_bytes(b"changed module")
            with patch.object(runtime, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    runtime.verify_module(module, {"module_sha256": "0" * 64}, "0" * 64)
                command.assert_not_called()
            self.assertEqual(build.sha256(module), hashlib.sha256(b"changed module").hexdigest())

    def test_wrong_package_hash_stops_before_extraction_or_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "wrong.deb"
            package.write_bytes(b"not the pinned package")
            destination = Path(temporary) / "output"
            with patch.object(sys, "argv", ["build.py", "--source-deb", str(package), "--output", str(destination)]), patch.object(build, "output") as command:
                with self.assertRaisesRegex(SystemExit, "SHA-256"):
                    build.main()
                command.assert_not_called()
            self.assertFalse(destination.exists())


class GuardTests(unittest.TestCase):
    def test_each_unsafe_state_is_rejected(self):
        runtime.validate_snapshot(valid_snapshot())
        changes = {
            "kernel": "another-kernel", "model": "Raspberry Pi 4 Model B Rev 1.4",
            "root_source": "/dev/sda2", "wifi_route": False, "wifi_is_usb": True,
            "usb_storage": ["USB disk"], "consumers": ["capture process"],
            "camera_present": False, "stock_uvc": False, "driver": "dwc_otg",
            "override": "another_driver", "test_loaded": True,
        }
        for field, value in changes.items():
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                runtime.validate_snapshot({**valid_snapshot(), field: value})

    def test_timer_failure_prevents_driver_changes(self):
        with patch.object(activate, "arm_recovery", side_effect=RuntimeError("timer failed")), patch.object(activate, "run") as command, patch.object(activate, "write_attribute") as write:
            with self.assertRaises(RuntimeError):
                activate.switch_host(120)
            command.assert_not_called()
            write.assert_not_called()

    def test_recovery_is_armed_before_any_driver_change(self):
        events = []
        with patch.object(activate, "arm_recovery", side_effect=lambda seconds: events.append("timer")), patch.object(activate, "run", side_effect=lambda args: events.append(args[0])), patch.object(activate, "write_attribute", side_effect=lambda path, value: events.append(path.name)), patch.object(activate, "bound", return_value=runtime.TEST):
            activate.switch_host(120)
        self.assertEqual(events[:2], ["timer", "insmod"])
        self.assertLess(events.index("timer"), events.index("unbind"))

    def test_inactive_timer_prevents_module_load_and_unbind(self):
        with patch.object(activate, "run", side_effect=["", RuntimeError("inactive timer")]) as command, patch.object(activate, "write_attribute") as write:
            with self.assertRaisesRegex(RuntimeError, "inactive timer"):
                activate.switch_host(120)
            self.assertEqual([call.args[0][0] for call in command.call_args_list], ["systemd-run", "systemctl"])
            write.assert_not_called()

    def test_restore_is_repeatable_and_rejects_unrelated_driver(self):
        saved = {"schema_version": 1, "kernel_release": runtime.KERNEL, "stock": runtime.STOCK, "test": runtime.TEST, "override": ""}
        with patch.object(runtime.os, "uname", create=True) as uname, patch.object(runtime, "bound", return_value="dwc2"), patch.object(runtime, "write_attribute") as write, patch.object(runtime, "run"):
            uname.return_value.release = runtime.KERNEL
            runtime.restore_binding(saved)
            runtime.restore_binding(saved)
            self.assertEqual(write.call_count, 2)
            self.assertTrue(all(call.args[0].name == "driver_override" and call.args[1] == "" for call in write.call_args_list))
        with patch.object(runtime.os, "uname", create=True) as uname, patch.object(runtime, "bound", return_value="unrelated"), patch.object(runtime, "write_attribute") as write:
            uname.return_value.release = runtime.KERNEL
            with self.assertRaises(RuntimeError):
                runtime.restore_binding(saved)
            write.assert_not_called()

    def test_restore_unbinds_test_clears_override_then_binds_stock(self):
        saved = {"schema_version": 1, "kernel_release": runtime.KERNEL, "stock": runtime.STOCK, "test": runtime.TEST, "override": ""}
        current = [runtime.TEST]
        events = []
        def write(path, value):
            events.append((str(path), value))
            if path.name == "unbind":
                current[0] = None
            elif path.name == "bind":
                current[0] = runtime.STOCK
        with patch.object(runtime.os, "uname", create=True) as uname, patch.object(runtime, "bound", side_effect=lambda: current[0]), patch.object(runtime, "write_attribute", side_effect=write), patch.object(runtime.Path, "exists", return_value=True), patch.object(runtime, "run") as command:
            uname.return_value.release = runtime.KERNEL
            runtime.restore_binding(saved)
            self.assertEqual([Path(item[0]).name for item in events], ["unbind", "driver_override", "bind"])
            self.assertEqual(events[1][1], "")
            self.assertEqual(command.call_args_list[0].args[0], ["rmmod", runtime.TEST])

    def test_lease_limit(self):
        self.assertEqual(activate.lease_seconds("120"), 120)
        self.assertEqual(activate.lease_seconds("1800"), 1800)
        for value in ("0", "1801", "-1"):
            with self.assertRaises(argparse.ArgumentTypeError):
                activate.lease_seconds(value)


if __name__ == "__main__":
    unittest.main()
