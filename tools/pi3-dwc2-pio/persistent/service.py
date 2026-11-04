"""Unattended service with a bounded startup decode check. No media is saved."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import support as s

VIDEO_ID = "usb-Jieli_Technology_USB_Composite_Device-video-index0"
FFMPEG = Path("/usr/bin/ffmpeg")


class HealthError(RuntimeError):
    """Only this failure permits one controlled host rebind."""


def require_health_binary():
    s.require(FFMPEG.is_file() and os.access(FFMPEG, os.X_OK), "Install /usr/bin/ffmpeg before PIO activation")


def decode_health():
    arguments = [
        str(FFMPEG), "-nostdin", "-hide_banner", "-loglevel", "error",
        "-xerror", "-err_detect", "explode", "-f", "v4l2",
        "-input_format", "mjpeg", "-video_size", "640x480", "-framerate", "30",
        "-i", str(Path("/dev/v4l/by-id") / VIDEO_ID), "-an", "-frames:v", "3",
        "-progress", "pipe:1", "-f", "null", "-",
    ]
    try:
        # subprocess.run kills and waits for FFmpeg on timeout. Both streams
        # contain progress/diagnostics only; the null muxer discards the frames.
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=8, check=False)
    except subprocess.TimeoutExpired as error:
        raise HealthError("Startup decode did not finish within 8 seconds") from error
    except OSError as error:
        raise HealthError("Could not execute the startup decode check") from error
    frames = 0
    finished = False
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "frame":
            try:
                frames = max(frames, int(value.strip()))
            except ValueError as error:
                raise HealthError("Invalid frame count in decode progress") from error
        elif separator and key.strip() == "progress":
            finished = value.strip() == "end"
    if result.returncode != 0 or frames < 3 or not finished:
        raise HealthError(f"Startup decode failed: exit={result.returncode}, frames={frames}, complete={finished}")


def bind_pio(module, stock_uvc):
    s.stock_binding()
    s.command(["insmod", str(module)])
    s.temporary.write_attribute(s.DEVICE / "driver_override", s.temporary.TEST)
    s.temporary.write_attribute(Path("/sys/bus/platform/drivers/dwc2/unbind"), s.DEVICE.name)
    if s.temporary.bound() is None:
        s.temporary.write_attribute(Path("/sys/bus/platform/drivers/dwc2_pio_test/bind"), s.DEVICE.name)
    s.require(s.temporary.bound() == s.temporary.TEST, "PIO did not bind")
    s.command(["udevadm", "settle", "--timeout=10"])
    wait_capture_ready(stock_uvc)
    s.host_checks()


def recovery_unit():
    return f"{s.RECOVERY_UNIT}-{os.getpid()}-{time.monotonic_ns()}"


def capture_ready(stock_uvc, dev=Path("/dev"), sysfs=Path("/sys"), sound=Path("/proc/asound")):
    """Inspect enumeration state only. Do not open video or sound devices."""
    try:
        if not (dev / "v4l/by-id" / VIDEO_ID).exists():
            return False
        if (sysfs / "module/uvcvideo/srcversion").read_text().strip() != stock_uvc:
            return False
        camera = False
        for device in (sysfs / "bus/usb/devices").iterdir():
            if (device / "idVendor").exists() and (device / "idProduct").exists():
                camera |= (device / "idVendor").read_text().strip() == "4c4a" and (device / "idProduct").read_text().strip() == "4a55"
        if not camera:
            return False
        for card in sound.glob("card[0-9]*"):
            number = card.name[4:]
            if not number.isdigit() or (card / "id").read_text().strip() != "Device":
                continue
            if "stream: CAPTURE" in (card / "pcm0c/info").read_text() and (dev / "snd" / f"pcmC{number}D0c").exists():
                return True
        return False
    except FileNotFoundError:
        # Sysfs and proc entries can disappear during USB re-enumeration.
        return False


def wait_capture_ready(stock_uvc, seconds=12):
    deadline = time.monotonic() + seconds
    while True:
        if capture_ready(stock_uvc):
            return
        remaining = deadline - time.monotonic()
        s.require(remaining > 0, "Camera and ALSA capture did not become ready within 12 seconds")
        time.sleep(min(0.1, remaining))


def state():
    return json.loads((s.RUN / "state.json").read_text())


def write_state(value):
    s.atomic_write(s.RUN / "state.json", (json.dumps(value) + "\n").encode())


def restore(recovery=False):
    with s.locked():
        path = s.RUN / "state.json"
        if not path.exists():
            s.require(s.temporary.bound() != s.temporary.TEST, "PIO is bound without known restoration state")
            return
        saved = state()
        if recovery and saved.get("committed"):
            return
        if not recovery:
            s.require(not s.consumers(), "Stop all video, media, and sound consumers before stopping the service")
        s.temporary.restore_binding(saved)
        saved["committed"] = False
        saved["restored"] = True
        write_state(saved)


def start():
    # A prior stop can still be re-enumerating the stock USB devices. Check
    # non-capture safety first, then wait before requiring camera/ALSA nodes.
    s.host_checks(capture=False)
    s.no_temporary_trial()
    module = s.VERSION / "dwc2_pio_test.ko"
    s.verified_module(module)
    stock_uvc = s.command(["modinfo", "-F", "srcversion", "uvcvideo"])
    s.require(bool(stock_uvc), "Cannot identify the stock UVC module")
    wait_capture_ready(stock_uvc)
    s.host_checks()
    require_health_binary()
    with s.locked():
        if (s.RUN / "state.json").exists() and state().get("committed"):
            s.require(s.temporary.bound() == s.temporary.TEST, "Committed state does not match the driver")
            expected = s.command(["modinfo", "-F", "srcversion", str(module)])
            s.require(Path("/sys/module/dwc2_pio_test/srcversion").read_text().strip() == expected, "Loaded PIO artifact differs")
            return
        s.require(s.temporary.bound() == s.temporary.STOCK and s.temporary.override() == "", "Only stock dwc2 with an empty override can be activated")
        s.require(not Path("/sys/module/dwc2_pio_test").exists(), "An unrelated trial loaded the module")
        saved = {**s.saved_binding(), "committed": False, "restored": False}
        write_state(saved)
        own_recovery = recovery_unit()
        try:
            s.command(["systemd-run", "--collect", f"--unit={own_recovery}", "--on-active=75s", "--timer-property=AccuracySec=1s", "/usr/bin/python3", str(s.VERSION / "service.py"), "recover"])
            s.command(["systemctl", "is-active", "--quiet", own_recovery + ".timer"])
            for attempt in range(2):
                # Binding/readiness/security errors leave this loop immediately.
                # Only a completed or timed-out decode check can permit a retry.
                bind_pio(module, stock_uvc)
                try:
                    decode_health()
                except HealthError as error:
                    print(f"Startup decode attempt {attempt + 1} failed: {error}", file=sys.stderr, flush=True)
                    if attempt == 1:
                        raise
                    s.temporary.restore_binding(saved)
                    saved["restored"] = True
                    write_state(saved)
                    s.host_checks(capture=False)
                    s.no_temporary_trial()
                    wait_capture_ready(stock_uvc)
                    s.host_checks()
                    s.verified_module(module)
                    s.stock_binding()
                    saved["restored"] = False
                    write_state(saved)
                    continue
                saved["committed"] = True
                write_state(saved)
                print(f"Startup decode passed on attempt {attempt + 1}: at least 3 decoded frames; media discarded", flush=True)
                break
        except BaseException:
            s.temporary.restore_binding(saved)
            saved["restored"] = True
            write_state(saved)
            raise
    # Stop only this attempt's timer after committing under the shared lock.
    # An already queued recovery sees committed=True and takes no action.
    try:
        s.command(["systemctl", "stop", own_recovery + ".timer"])
    except Exception as error:
        print(f"Committed PIO startup; recovery timer cleanup failed: {error}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "recover"))
    args = parser.parse_args()
    s.root()
    def interrupted(signum, frame):
        raise InterruptedError(f"Service interrupted by {signum}")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    if args.action == "start":
        start()
    else:
        restore(recovery=args.action == "recover")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
