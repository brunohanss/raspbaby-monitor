"""Collect read-only Pi media capabilities. Do not capture or store media."""

import argparse
import glob
import json
import platform
import shutil
import subprocess
from pathlib import Path

PLUGINS = (
    "webrtcbin", "nice", "dtls", "srtp", "v4l2src", "alsasrc",
    "videotestsrc", "audiotestsrc", "x264enc", "openh264enc",
    "h264parse", "rtph264pay", "opusenc", "rtpopuspay",
    "jpegdec", "videorate", "v4l2h264enc",
)


def run(args):
    if not shutil.which(args[0]):
        return {"status": "missing", "command": args}
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=15, check=False,
            encoding="utf-8", errors="replace",
        )
        return {"status": "ok" if result.returncode == 0 else "failed",
                "command": args, "exit_code": result.returncode,
                "output": (result.stdout + result.stderr)[:65536]}
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "command": args}


def read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8").replace("\x00", "").strip()
    except OSError:
        return None


def collect():
    stable_devices = sorted(glob.glob("/dev/v4l/by-id/*"))
    devices = stable_devices or sorted(glob.glob("/dev/video*"))
    return {
        "report_version": 1,
        "architecture": platform.machine(),
        "os_release": read_text("/etc/os-release"),
        "model": read_text("/proc/device-tree/model"),
        "memory": read_text("/proc/meminfo"),
        "stable_video_paths": stable_devices,
        "video_devices": [{"path": path, "capabilities": run([
            "v4l2-ctl", "--device", path, "--all", "--list-formats-ext",
        ])} for path in devices],
        "audio_devices": run(["arecord", "--list-devices"]),
        "audio_inputs": run(["arecord", "--list-pcms"]),
        "gstreamer": run(["gst-inspect-1.0", "--version"]),
        "plugins": {plugin: run(["gst-inspect-1.0", plugin]) for plugin in PLUGINS},
        "network_addresses": run(["ip", "-brief", "address"]),
        "limits": ["No capture test was run.",
                   "Audio sample formats need a separate device test.",
                   "Encoder presence does not prove encoder performance.",
                   "Review device IDs and local addresses before sharing this report."],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("Run this probe on the Raspberry Pi with Linux.")
    report = collect()
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote capability report to {args.output}")


if __name__ == "__main__":
    main()
