"""Offline checks only. No root, systemd, boot, or USB action is executed."""

from contextlib import ExitStack, contextmanager, nullcontext
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

import support as s
import service
import install


@contextmanager
def mocked_startup(outcomes):
    events, states, commands = [], [], []
    remaining = iter(outcomes)
    def command(arguments):
        commands.append(arguments)
        return "stock-uvc" if arguments[0] == "modinfo" else ""
    def health():
        events.append("health")
        outcome = next(remaining)
        if outcome is not None:
            raise outcome
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as patches:
        definitions = [
            patch.object(s, "RUN", Path(temporary)),
            patch.object(s, "locked", return_value=nullcontext()),
            patch.object(s, "host_checks", side_effect=lambda capture=True: events.append("guard" if capture else "safety")),
            patch.object(s, "no_temporary_trial"), patch.object(s, "verified_module"),
            patch.object(s.temporary, "bound", return_value="dwc2"),
            patch.object(s.temporary, "override", return_value=""),
            patch.object(s, "stock_binding", side_effect=lambda: events.append("stock")),
            patch.object(s.temporary, "restore_binding", side_effect=lambda saved: events.append("restore")),
            patch.object(s, "command", side_effect=command),
            patch.object(service, "write_state", side_effect=lambda saved: states.append(dict(saved))),
            patch.object(service, "wait_capture_ready", side_effect=lambda version: events.append("ready")),
            patch.object(service, "decode_health", side_effect=health),
        ]
        for definition in definitions:
            patches.enter_context(definition)
        binary = patches.enter_context(patch.object(service, "require_health_binary"))
        bind = patches.enter_context(patch.object(service, "bind_pio", side_effect=lambda module, version: events.append("bind")))
        yield events, states, commands, binary, bind


class ConfigTests(unittest.TestCase):
    def test_unreviewed_baseline_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "reviewed exact baseline"):
            s.append_config(b"[all]\narm_64bit=1\n")

    def test_reviewed_hash_allows_inactive_other_board_host_settings(self):
        original = b"[cm4]\notg_mode=1\n[cm5]\ndtoverlay=dwc2,dr_mode=host\n[all]\nenable_uart=1\n"
        with patch.object(s, "digest", return_value=s.BASELINE_CONFIG_SHA):
            proposed = s.append_config(original)
        self.assertEqual(proposed, original + s.BLOCK)
        with self.assertRaisesRegex(RuntimeError, "Existing or incomplete"):
            s.append_config(proposed)

    def test_exact_uninstall_recovers_original_bytes(self):
        original = b"original bytes without a final newline"
        proposed = original + s.BLOCK
        self.assertEqual(s.remove_config(proposed, s.digest(proposed), original), original)

    def test_uninstall_keeps_unrelated_config_edits(self):
        original = b"original\n"
        proposed = original + s.BLOCK
        edited = b"# user changed this\n" + proposed + b"enable_uart=1\n"
        self.assertEqual(s.remove_config(edited, s.digest(proposed), original), b"# user changed this\n" + original + b"enable_uart=1\n")

    def test_modified_or_duplicate_block_requires_manual_review(self):
        proposed = b"original" + s.BLOCK
        for current in (proposed.replace(b"include raspbaby", b"include other"), proposed + s.BLOCK):
            with self.assertRaises(RuntimeError):
                s.remove_config(current, s.digest(proposed), b"original")


class ServiceTests(unittest.TestCase):
    def test_health_failure_restores_then_rechecks_before_one_retry(self):
        with mocked_startup([service.HealthError("bad frames"), None]) as (events, states, commands, binary, bind):
            service.start()
        self.assertEqual(bind.call_count, 2)
        self.assertEqual(events.count("restore"), 1)
        first = events.index("bind")
        restored = events.index("restore")
        second = events.index("bind", first + 1)
        self.assertLess(first, restored)
        self.assertLess(restored, events.index("safety", restored))
        self.assertLess(events.index("ready", restored), events.index("guard", restored))
        self.assertLess(events.index("stock", restored), second)
        self.assertTrue(states[-1]["committed"])
        self.assertEqual(sum(arguments[0] == "systemd-run" for arguments in commands), 1)

    def test_second_health_failure_leaves_stock_and_never_commits(self):
        with mocked_startup([service.HealthError("first"), service.HealthError("second")]) as (events, states, commands, binary, bind):
            with self.assertRaisesRegex(service.HealthError, "second"):
                service.start()
        self.assertEqual(bind.call_count, 2)
        self.assertEqual(events.count("restore"), 2)
        self.assertTrue(states[-1]["restored"])
        self.assertFalse(any(saved["committed"] for saved in states))
        self.assertFalse(any(arguments[:2] == ["systemctl", "stop"] for arguments in commands))

    def test_unrelated_guard_failure_is_not_retried(self):
        with mocked_startup([]) as (events, states, commands, binary, bind):
            bind.side_effect = RuntimeError("unsafe route")
            with self.assertRaisesRegex(RuntimeError, "unsafe route"):
                service.start()
        self.assertEqual(bind.call_count, 1)
        self.assertEqual(events.count("restore"), 1)
        self.assertNotIn("health", events)
        self.assertFalse(any(saved["committed"] for saved in states))

    def test_missing_ffmpeg_is_rejected_before_mutation(self):
        with mocked_startup([]) as (events, states, commands, binary, bind):
            binary.side_effect = RuntimeError("Install /usr/bin/ffmpeg")
            with self.assertRaisesRegex(RuntimeError, "/usr/bin/ffmpeg"):
                service.start()
        bind.assert_not_called()
        self.assertFalse(states)
        self.assertFalse(any(arguments[0] == "systemd-run" for arguments in commands))

    def test_decode_health_accepts_three_frames_and_discards_media(self):
        result = subprocess.CompletedProcess([], 0, "frame=1\nprogress=continue\nframe=3\nprogress=end\n", "")
        with patch.object(service.subprocess, "run", return_value=result) as run:
            service.decode_health()
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[0], str(Path("/usr/bin/ffmpeg")))
        self.assertEqual(arguments[-3:], ["-f", "null", "-"])
        self.assertEqual(arguments[arguments.index("-frames:v") + 1], "3")
        self.assertEqual(arguments[arguments.index("-progress") + 1], "pipe:1")
        self.assertIn("-xerror", arguments)
        self.assertIn("explode", arguments)
        self.assertEqual(run.call_args.kwargs["timeout"], 8)

    def test_decode_health_rejects_error_incomplete_and_timeout(self):
        results = [
            subprocess.CompletedProcess([], 1, "frame=3\nprogress=end\n", "decode error"),
            subprocess.CompletedProcess([], 0, "frame=2\nprogress=end\n", ""),
            subprocess.CompletedProcess([], 0, "frame=3\nprogress=continue\n", ""),
            subprocess.CompletedProcess([], 0, "frame=invalid\nprogress=end\n", ""),
        ]
        for result in results:
            with self.subTest(stdout=result.stdout, code=result.returncode), patch.object(service.subprocess, "run", return_value=result):
                with self.assertRaises(service.HealthError):
                    service.decode_health()
        with patch.object(service.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 8)):
            with self.assertRaisesRegex(service.HealthError, "within 8 seconds"):
                service.decode_health()

    def test_capture_readiness_requires_all_enumerated_devices(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            dev, sysfs, sound = (directory / name for name in ("dev", "sys", "sound"))
            files = {
                dev / "v4l/by-id" / service.VIDEO_ID: "",
                sysfs / "module/uvcvideo/srcversion": "stock-uvc\n",
                sysfs / "bus/usb/devices/1-1/idVendor": "4c4a\n",
                sysfs / "bus/usb/devices/1-1/idProduct": "4a55\n",
                sound / "card2/id": "Device\n",
                sound / "card2/pcm0c/info": "card: 2\nstream: CAPTURE\n",
                dev / "snd/pcmC2D0c": "",
            }
            for path, content in files.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            self.assertTrue(service.capture_ready("stock-uvc", dev, sysfs, sound))
            for path, content in files.items():
                with self.subTest(missing=path.name):
                    path.unlink()
                    self.assertFalse(service.capture_ready("stock-uvc", dev, sysfs, sound))
                    path.write_text(content)
            (sysfs / "module/uvcvideo/srcversion").write_text("custom-uvc")
            self.assertFalse(service.capture_ready("stock-uvc", dev, sysfs, sound))
            (sysfs / "module/uvcvideo/srcversion").write_text("stock-uvc")
            (sound / "card2/pcm0c/info").write_text("stream: PLAYBACK\n")
            self.assertFalse(service.capture_ready("stock-uvc", dev, sysfs, sound))

    def test_readiness_wait_polls_without_repeating_full_host_checks(self):
        with patch.object(service, "capture_ready", side_effect=[False, False, True]) as ready, patch.object(service.time, "monotonic", side_effect=[0, 0.1, 0.2]), patch.object(service.time, "sleep") as sleep, patch.object(s, "host_checks") as checks:
            service.wait_capture_ready("stock-uvc")
            self.assertEqual(ready.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
            checks.assert_not_called()
        with patch.object(service, "capture_ready", return_value=False), patch.object(service.time, "monotonic", side_effect=[0, 12]), patch.object(service.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "within 12 seconds"):
                service.wait_capture_ready("stock-uvc")
            sleep.assert_not_called()

    def test_recovery_names_are_unique_even_if_pid_is_reused(self):
        with patch.object(service.os, "getpid", return_value=42), patch.object(service.time, "monotonic_ns", side_effect=[100, 101]):
            first, second = service.recovery_unit(), service.recovery_unit()
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith(s.RECOVERY_UNIT + "-42-"))

    def test_success_waits_before_final_guards_and_stops_only_own_timer(self):
        events = []
        commands = []
        def command(arguments):
            commands.append(arguments)
            events.append(arguments[0])
            return "stock-uvc" if arguments[0] == "modinfo" else ""
        def saved(value):
            events.append("committed" if value.get("committed") else "prepared")
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(s, "RUN", Path(temporary)), patch.object(s, "locked", return_value=nullcontext()), patch.object(s, "host_checks", side_effect=lambda capture=True: events.append("guard" if capture else "safety")), patch.object(s, "no_temporary_trial"), patch.object(s, "verified_module"), patch.object(s.temporary, "bound", side_effect=["dwc2", "dwc2", None, "dwc2_pio_test"]), patch.object(s.temporary, "override", return_value=""), patch.object(service, "write_state", side_effect=saved), patch.object(service, "recovery_unit", return_value="own-attempt-42"), patch.object(s, "command", side_effect=command), patch.object(s.temporary, "write_attribute"), patch.object(service, "wait_capture_ready", side_effect=lambda version: events.append("ready")), patch.object(service, "require_health_binary"), patch.object(service, "decode_health", side_effect=lambda: events.append("health")):
                service.start()
        self.assertEqual(events.count("guard"), 2)
        self.assertEqual(events[0], "safety")
        first_ready = events.index("ready")
        second_ready = events.index("ready", first_ready + 1)
        self.assertLess(first_ready, events.index("guard"))
        self.assertLess(events.index("guard"), events.index("systemd-run"))
        self.assertLess(events.index("udevadm"), second_ready)
        self.assertLess(second_ready, events.index("guard", second_ready))
        self.assertLess(events.index("guard", second_ready), events.index("health"))
        self.assertLess(events.index("health"), events.index("committed"))
        self.assertLess(events.index("committed"), len(events) - 1)
        timer_command = next(arguments for arguments in commands if arguments[0] == "systemd-run")
        self.assertIn("--collect", timer_command)
        self.assertIn("--on-active=75s", timer_command)
        self.assertIn("--unit=own-attempt-42", timer_command)
        self.assertEqual(commands[-1], ["systemctl", "stop", "own-attempt-42.timer"])

    def test_initial_wait_timeout_prevents_all_driver_and_state_changes(self):
        with patch.object(s, "host_checks") as checks, patch.object(s, "no_temporary_trial"), patch.object(s, "verified_module"), patch.object(s, "command", return_value="stock-uvc"), patch.object(service, "wait_capture_ready", side_effect=RuntimeError("not enumerated")), patch.object(s, "locked") as lock, patch.object(s.temporary, "write_attribute") as write:
            with self.assertRaisesRegex(RuntimeError, "not enumerated"):
                service.start()
            checks.assert_called_once_with(capture=False)
            lock.assert_not_called()
            write.assert_not_called()

    def test_queued_old_recovery_does_not_restore_a_committed_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            (Path(temporary) / "state.json").write_text('{"committed": true}')
            with patch.object(s, "RUN", Path(temporary)), patch.object(s, "locked", return_value=nullcontext()), patch.object(s.temporary, "restore_binding") as restore:
                service.restore(recovery=True)
                restore.assert_not_called()

    def test_old_and_new_temporary_processes_are_rejected(self):
        self.assertTrue(s.temporary_arguments([b"python3", b"/tmp/run_host_pio_trial.py"]))
        self.assertTrue(s.temporary_arguments([b"python3", b"/opt/tools/activate.py"]))
        self.assertFalse(s.temporary_arguments([b"python3", b"service.py", b"start"]))

    def test_dynamic_legacy_recovery_units_must_be_inactive(self):
        s.check_legacy_units([])
        s.check_legacy_units([{"unit": "raspbaby-pio-recovery-12.timer", "active": "inactive"}])
        for active in ("active", "activating", "deactivating", None):
            with self.subTest(active=active), self.assertRaises(RuntimeError):
                s.check_legacy_units([{"unit": "raspbaby-pio-recovery-12.timer", "active": active}])

    def test_inactive_recovery_timer_prevents_insmod_or_unbind(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(s, "RUN", Path(temporary)), patch.object(s, "locked", return_value=nullcontext()), patch.object(s, "host_checks"), patch.object(s, "no_temporary_trial"), patch.object(s, "verified_module"), patch.object(s.temporary, "bound", return_value="dwc2"), patch.object(s.temporary, "override", return_value=""), patch.object(service, "write_state"), patch.object(service, "wait_capture_ready"), patch.object(service, "require_health_binary"), patch.object(s, "command", side_effect=["stock-uvc", "", RuntimeError("timer inactive")]) as command, patch.object(s.temporary, "write_attribute") as write, patch.object(s.temporary, "restore_binding") as restore:
                with self.assertRaisesRegex(RuntimeError, "timer inactive"):
                    service.start()
                self.assertEqual([call.args[0][0] for call in command.call_args_list], ["modinfo", "systemd-run", "systemctl"])
                write.assert_not_called()
                restore.assert_called_once()

    def test_unit_has_bounded_startup_and_does_not_start_capture(self):
        unit = s.unit_content().decode()
        for setting in ("Type=oneshot", "RemainAfterExit=yes", "TimeoutStartSec=90s", "TimeoutStopSec=45s", "Restart=no", "After=network-online.target"):
            self.assertIn(setting, unit)
        self.assertNotIn("ffmpeg", unit)
        self.assertNotIn("raspbaby-daemon", unit)

    def test_stop_refuses_active_capture_before_driver_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state.json"
            state.write_text("{}")
            with patch.object(s, "RUN", Path(temporary)), patch.object(s, "locked", return_value=nullcontext()), patch.object(s, "consumers", return_value={"123"}), patch.object(s.temporary, "restore_binding") as restore:
                with self.assertRaisesRegex(RuntimeError, "Stop all"):
                    service.restore()
                restore.assert_not_called()


class InstallationTests(unittest.TestCase):
    def test_boot_rollback_without_pio_does_not_require_camera_or_old_kernel(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = b"original"
            config, include, unit = (directory / name for name in ("config.txt", "include", "unit"))
            config.write_bytes(original + s.BLOCK)
            include.write_bytes(b"include bytes")
            unit.write_bytes(b"unit bytes")
            value = {"status": "installed", "installed_config_sha256": s.digest(config.read_bytes()), "installed_files": {str(include): s.digest(include.read_bytes()), str(unit): s.digest(unit.read_bytes())}}
            with patch.object(install, "uninstall_environment"), patch.object(install, "pio_active", return_value=False), patch.object(install, "metadata", return_value=(value, original)), patch.object(install, "installed_files"), patch.object(s, "CONFIG", config), patch.object(s, "INCLUDE", include), patch.object(s, "UNIT", unit), patch.object(s, "DATA", directory), patch.object(s, "locked", return_value=nullcontext()), patch.object(s, "host_checks") as hardware, patch.object(s, "command"), patch.object(s, "atomic_write", side_effect=lambda path, content, **kwargs: path.write_bytes(content)):
                install.uninstall()
                hardware.assert_not_called()
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse(include.exists())
            self.assertFalse(unit.exists())

    def test_unknown_installed_paths_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "incomplete or has unknown"):
            install.installed_files({"installed_files": {"/etc/shadow": "abc"}})

    def test_rollback_handles_config_replace_before_fsync_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "config.txt"
            original = b"original"
            config.write_bytes(original + s.BLOCK)
            value = {"installed_config_sha256": s.digest(config.read_bytes()), "installed_files": {}}
            with patch.object(s, "CONFIG", config), patch.object(s, "UNIT", Path(temporary) / "unit"), patch.object(s, "INCLUDE", Path(temporary) / "include"), patch.object(s, "command"), patch.object(s, "atomic_write", side_effect=lambda path, content, **kwargs: path.write_bytes(content)):
                install.rollback_preparation(value, original, boot_changed=True)
            self.assertEqual(config.read_bytes(), original)

    def test_rollback_does_not_overwrite_unknown_config_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "config.txt"
            config.write_bytes(b"unrelated replacement")
            value = {"installed_config_sha256": s.digest(b"original" + s.BLOCK), "installed_files": {}}
            with patch.object(s, "CONFIG", config), patch.object(s, "command"), patch.object(s, "atomic_write") as write:
                install.rollback_preparation(value, b"original", boot_changed=True)
                write.assert_not_called()
            self.assertEqual(config.read_bytes(), b"unrelated replacement")


if __name__ == "__main__":
    unittest.main()
