"""Shared guards for the bounded Pi 3B+ USB diagnostic."""

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess

KERNEL = "6.18.50+rpt-rpi-v8"
MODEL = "Raspberry Pi 3 Model B Plus Rev 1.4"
DEVICE = Path("/sys/bus/platform/devices/3f980000.usb")
STATE = Path("/run/raspbaby-dwc2-pio")
UNIT = "raspbaby-dwc2-pio-recovery"
TEST = "dwc2_pio_test"
STOCK = "dwc2"
PACKAGE_SHA256 = "bb1a58ab172c5feecb99d75f1885e531e8a0d55ca92beb60481aee386c277e3a"


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=30, **kwargs).stdout.strip()


def bound():
    link = DEVICE / "driver"
    return link.resolve().name if link.exists() else None


def override():
    value = (DEVICE / "driver_override").read_text().strip()
    return "" if value == "(null)" else value


def validate_snapshot(snapshot):
    require(snapshot["kernel"] == KERNEL, "Wrong running kernel")
    require(snapshot["model"] == MODEL, "Only the tested Pi 3B+ revision is allowed")
    require(re.fullmatch(r"/dev/mmcblk[0-9]+p[0-9]+", snapshot["root_source"]) is not None, "Root must be on MMC storage")
    require(snapshot["wifi_route"] and not snapshot["wifi_is_usb"], "The actual SSH peer must use non-USB Wi-Fi")
    require(not snapshot["usb_storage"], "Disconnect all USB storage first")
    require(not snapshot["consumers"], "Stop all video, media, and sound consumers first")
    require(snapshot["camera_present"], "The tested 4c4a:4a55 USB camera must be connected")
    require(snapshot["stock_uvc"], "Loaded UVC must match the stock module")
    require(snapshot["driver"] == STOCK, "The platform device must use the stock dwc2 driver")
    require(snapshot["override"] == "", "An existing driver override needs manual review")
    require(not snapshot["test_loaded"], "The test module is already present")


def snapshot():
    connection = os.environ.get("SSH_CONNECTION", "").split()
    require(len(connection) == 4, "Preserve SSH_CONNECTION from the current SSH session")
    peer = str(ipaddress.ip_address(connection[0]))
    route = json.loads(run(["ip", "-j", "route", "get", peer]))
    require(len(route) == 1 and "dev" in route[0], "Cannot determine the actual SSH route")
    interface = Path("/sys/class/net") / route[0]["dev"]
    wifi = (interface / "wireless").exists() or (interface / "phy80211").exists()
    usb_storage = [str(item) for item in Path("/sys/class/block").iterdir() if "/usb" in str(item.resolve())]
    for driver in ("usb-storage", "uas"):
        directory = Path("/sys/bus/usb/drivers") / driver
        if directory.exists():
            usb_storage.extend(str(item) for item in directory.iterdir() if item.is_symlink() and ":" in item.name)
    consumers = []
    for process in Path("/proc").glob("[0-9]*/fd"):
        try:
            for descriptor in process.iterdir():
                try:
                    target = os.readlink(descriptor)
                except FileNotFoundError:
                    continue
                if target.startswith(("/dev/video", "/dev/media", "/dev/snd/", "/dev/v4l/")):
                    consumers.append(str(process.parent.name))
                    break
        except FileNotFoundError:
            continue
    camera = False
    for item in Path("/sys/bus/usb/devices").iterdir():
        if (item / "idVendor").exists() and (item / "idProduct").exists():
            if (item / "idVendor").read_text().strip() == "4c4a" and (item / "idProduct").read_text().strip() == "4a55":
                camera = True
    stock_uvc = run(["modinfo", "-F", "srcversion", "uvcvideo"])
    loaded = Path("/sys/module/uvcvideo/srcversion")
    return {
        "kernel": os.uname().release,
        "model": Path("/proc/device-tree/model").read_text().rstrip("\0\n"),
        "root_source": run(["findmnt", "-e", "-n", "-o", "SOURCE", "/"]),
        "wifi_route": wifi, "wifi_is_usb": "/usb" in str((interface / "device").resolve()),
        "usb_storage": usb_storage, "consumers": consumers, "camera_present": camera,
        "stock_uvc": bool(stock_uvc) and loaded.exists() and loaded.read_text().strip() == stock_uvc,
        "driver": bound(), "override": override(),
        "test_loaded": Path("/sys/module/dwc2_pio_test").exists() or Path("/sys/bus/platform/drivers/dwc2_pio_test").exists(),
    }


def secure_state(create=False):
    import fcntl

    require(os.geteuid() == 0, "Run this command as root")
    if create:
        STATE.mkdir(mode=0o700, exist_ok=False)
    info = STATE.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, "Unsafe runtime state directory")
    lock_path = STATE / "restore.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(descriptor, "a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def write_attribute(path, value):
    path.write_text(value + "\n")


def verify_module(module, manifest, expected_hash):
    require(re.fullmatch("[a-f0-9]{64}", expected_hash) is not None, "Supply a reviewed lowercase module SHA-256")
    require(module.is_file() and module.stat().st_size <= 32 * 1024 * 1024, "Invalid module file")
    content = module.read_bytes()
    require(hashlib.sha256(content).hexdigest() == expected_hash == manifest.get("module_sha256"), "Module SHA-256 mismatch")
    require(manifest.get("schema_version") == 1 and manifest.get("kernel_release") == KERNEL and manifest.get("module_name") == TEST and manifest.get("source_package_sha256") == PACKAGE_SHA256, "Manifest does not match the pinned build")
    require(run(["modinfo", "-F", "name", str(module)]) == TEST, "Wrong module name")
    require(run(["modinfo", "-F", "vermagic", str(module)]).split()[0] == KERNEL, "Wrong module kernel version")
    require(run(["modinfo", "-F", "raspbaby_diagnostic", str(module)]) == "host-pio-no-dma", "Wrong diagnostic module marker")
    return content


def restore_binding(saved):
    require(saved.get("schema_version") == 1 and saved.get("kernel_release") == KERNEL and saved.get("stock") == STOCK and saved.get("test") == TEST and saved.get("override") == "", "Unsafe restoration state")
    require(os.uname().release == KERNEL, "Kernel changed since activation")
    require(bound() in (STOCK, TEST, None), "An unrelated driver is bound; stop for manual review")
    if bound() == TEST:
        write_attribute(Path("/sys/bus/platform/drivers") / TEST / "unbind", DEVICE.name)
    write_attribute(DEVICE / "driver_override", saved["override"])
    if bound() is None:
        write_attribute(Path("/sys/bus/platform/drivers") / STOCK / "bind", DEVICE.name)
    require(bound() == STOCK, "The stock host did not bind")
    if Path("/sys/module/dwc2_pio_test").exists():
        run(["rmmod", TEST])
    run(["udevadm", "settle", "--timeout=10"])
