"""Activate a bounded USB diagnostic. The command stays in the foreground."""

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time

from runtime import (
    DEVICE, KERNEL, STATE, STOCK, TEST, UNIT, bound, require, run,
    secure_state, snapshot, validate_snapshot, verify_module, write_attribute,
)


def lease_seconds(value):
    seconds = int(value)
    if not 1 <= seconds <= 1800:
        raise argparse.ArgumentTypeError("Lease must be 1 to 1800 seconds")
    return seconds


def arm_recovery(seconds):
    run(["systemd-run", f"--unit={UNIT}", f"--on-active={seconds}s", "--timer-property=AccuracySec=1s", "/usr/bin/python3", str(STATE / "restore.py")])
    run(["systemctl", "is-active", "--quiet", f"{UNIT}.timer"])


def switch_host(seconds):
    # The recovery timer must be active before loading or unbinding any driver.
    arm_recovery(seconds)
    run(["insmod", str(STATE / "dwc2_pio_test.ko")])
    write_attribute(DEVICE / "driver_override", TEST)
    write_attribute(Path("/sys/bus/platform/drivers/dwc2/unbind"), DEVICE.name)
    if bound() is None:
        write_attribute(Path("/sys/bus/platform/drivers/dwc2_pio_test/bind"), DEVICE.name)
    require(bound() == TEST, "The test host did not bind")
    run(["udevadm", "settle", "--timeout=10"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--expected-module-sha256", required=True)
    parser.add_argument("--lease-seconds", type=lease_seconds, default=120)
    parser.add_argument("--accept-usb-tree-reset", action="store_true", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "Run this command as root")
    validate_snapshot(snapshot())
    require(args.manifest.stat().st_size <= 65536, "Manifest is too large")
    manifest = json.loads(args.manifest.read_text())
    content = verify_module(args.module, manifest, args.expected_module_sha256)
    require(not STATE.exists(), "Runtime state already exists. Restore and inspect it; reboot before another trial")
    lock = secure_state(create=True)
    source = Path(__file__).resolve().parent
    saved = {"schema_version": 1, "kernel_release": KERNEL, "stock": STOCK, "test": TEST, "override": "", "module_sha256": args.expected_module_sha256, "restored": False}
    (STATE / "state.json").write_text(json.dumps(saved) + "\n")
    for filename in ("restore.py", "runtime.py"):
        (STATE / filename).write_bytes((source / filename).read_bytes())
    (STATE / "dwc2_pio_test.ko").write_bytes(content)
    def interrupted(signum, frame):
        raise InterruptedError(f"Diagnostic interrupted by signal {signum}")
    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    try:
        # Repeat the device guards after preparing state, before the USB reset.
        validate_snapshot(snapshot())
        switch_host(args.lease_seconds)
        lock.close()
        print(f"PIO host active for at most {args.lease_seconds} seconds. The whole USB tree was reset. Stop all capture consumers before restoration.", file=sys.stderr, flush=True)
        deadline = time.monotonic() + args.lease_seconds
        while time.monotonic() < deadline and bound() == TEST:
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    finally:
        lock.close()
        # Recovery does not depend on this foreground process remaining alive.
        # Do not cancel the independent timer, including after a local failure.
        run(["/usr/bin/python3", str(STATE / "restore.py")])


if __name__ == "__main__":
    main()
