"""Shared checks for the exact Pi 3B+ persistent proposal."""

from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
if not (HERE / "runtime.py").exists():
    sys.path.insert(0, str(HERE.parent))
import runtime as temporary

KERNEL = temporary.KERNEL
MODEL = temporary.MODEL
DEVICE = temporary.DEVICE
MODULE_SHA = "49e09cb02c24e75b935987ce490d08b9f48077aa7b0fec4e422966e09c54ebb7"
BASELINE_CONFIG_SHA = "fee3e47fe6d168f61882fac6ee6ee2802de4c7d65d8935320287af310e36e887"
VERSION = Path("/usr/local/lib/raspbaby/pi3-dwc2-pio") / KERNEL
DATA = Path("/var/lib/raspbaby-pi3-pio")
RUN = Path("/run/raspbaby-persistent-pio")
CONFIG = Path("/boot/firmware/config.txt")
INCLUDE = Path("/boot/firmware/raspbaby-pi3-pio.txt")
UNIT = Path("/etc/systemd/system/raspbaby-pi3-pio.service")
RECOVERY_UNIT = "raspbaby-persistent-pio-recovery"
BLOCK = b"\n# BEGIN RASPBABY PI3 PIO\n[all]\ninclude raspbaby-pi3-pio.txt\n# END RASPBABY PI3 PIO\n"
INCLUDE_CONTENT = b"# Raspbaby Pi 3B+ compatibility opt-in\n[all]\ndtoverlay=dwc2,dr_mode=host\n"
require = temporary.require


def digest(content):
    return hashlib.sha256(content).hexdigest()


def command(arguments):
    return subprocess.check_output(arguments, text=True, timeout=20).strip()


def root():
    require(os.geteuid() == 0, "Run as root")


def owned(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    require(kind and info.st_uid == 0 and not info.st_mode & 0o022, f"Unsafe ownership or mode: {path}")


def private_directory(path):
    if not path.exists():
        path.mkdir(mode=0o700)
    owned(path, directory=True)
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, "Runtime directory must have mode 0700")


@contextmanager
def locked():
    import fcntl
    root()
    private_directory(RUN)
    descriptor = os.open(RUN / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def atomic_write(path, content, mode=0o600):
    owned(path.parent, directory=True)
    temporary_path = path.with_name(path.name + ".raspbaby-new")
    descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(descriptor, "wb") as outgoing:
            outgoing.write(content)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        os.replace(temporary_path, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary_path.unlink(missing_ok=True)


def append_config(original):
    require(BLOCK not in original and b"RASPBABY PI3 PIO" not in original, "Existing or incomplete Raspbaby boot block")
    # This is the reviewed device's exact file. Its cm4/cm5 settings are inactive
    # on this Pi 3B+. Do not interpret an arbitrary config with a partial parser.
    require(digest(original) == BASELINE_CONFIG_SHA, "Boot config differs from the reviewed exact baseline. Stop for manual review")
    return original + BLOCK


def remove_config(current, installed_hash, original):
    if digest(current) == installed_hash:
        return original
    require(current.count(BLOCK) == 1, "Boot block changed. Restore it by manual review; do not overwrite unrelated edits")
    return current.replace(BLOCK, b"", 1)


def consumers():
    users = set()
    for descriptors in Path("/proc").glob("[0-9]*/fd"):
        try:
            for entry in descriptors.iterdir():
                try:
                    target = os.readlink(entry)
                except FileNotFoundError:
                    continue
                if target.startswith(("/dev/video", "/dev/media", "/dev/snd/", "/dev/v4l/")):
                    users.add(descriptors.parent.name)
        except FileNotFoundError:
            continue
    return users


def actual_ssh_wifi():
    connection = os.environ.get("SSH_CONNECTION", "").split()
    require(len(connection) == 4, "Preserve the actual SSH_CONNECTION for installation or removal")
    peer = str(ipaddress.ip_address(connection[0]))
    route = json.loads(command(["ip", "-j", "route", "get", peer]))
    require(len(route) == 1 and route[0].get("dev") == "wlan0", "The actual SSH session must use wlan0")
    wifi = Path("/sys/class/net/wlan0")
    require((wifi / "wireless").exists() or (wifi / "phy80211").exists(), "wlan0 is not Wi-Fi")
    require("/usb" not in str((wifi / "device").resolve()), "Management Wi-Fi must not use USB")


def host_checks(capture=True):
    root()
    require(os.uname().release == KERNEL, "Kernel is not the tested exact release")
    require(Path("/proc/device-tree/model").read_text().rstrip("\0\n") == MODEL, "Board is not the tested Pi 3B+ revision")
    require(re.fullmatch(r"/dev/mmcblk[0-9]+p[0-9]+", command(["findmnt", "-e", "-n", "-o", "SOURCE", "/"])) is not None, "Root must use MMC storage")
    wifi = Path("/sys/class/net/wlan0")
    require((wifi / "wireless").exists() or (wifi / "phy80211").exists(), "wlan0 is not Wi-Fi")
    require("/usb" not in str((wifi / "device").resolve()), "Management Wi-Fi must not use USB")
    defaults = json.loads(command(["ip", "-j", "route", "show", "default"]))
    require(defaults, "No management route is available")
    route = min(defaults, key=lambda entry: entry.get("metric", 0))
    require(route.get("dev") == "wlan0" and route.get("gateway"), "The preferred management route must use wlan0")
    resolved = json.loads(command(["ip", "-j", "route", "get", route["gateway"]]))
    require(len(resolved) == 1 and resolved[0].get("dev") == "wlan0", "Management gateway does not route through wlan0")
    require(not any("/usb" in str(item.resolve()) for item in Path("/sys/class/block").iterdir()), "Disconnect all USB storage")
    for name in ("usb-storage", "uas"):
        directory = Path("/sys/bus/usb/drivers") / name
        require(not directory.exists() or not any(item.is_symlink() and ":" in item.name for item in directory.iterdir()), "Disconnect all USB storage")
    require(not consumers(), "Stop all video, media, and sound consumers first")
    if not capture:
        return
    srcversion = command(["modinfo", "-F", "srcversion", "uvcvideo"])
    require(srcversion and Path("/sys/module/uvcvideo/srcversion").read_text().strip() == srcversion, "Loaded UVC is not stock")
    camera = False
    for item in Path("/sys/bus/usb/devices").iterdir():
        if (item / "idVendor").exists() and (item / "idProduct").exists():
            camera |= (item / "idVendor").read_text().strip() == "4c4a" and (item / "idProduct").read_text().strip() == "4a55"
    require(camera, "The tested 4c4a:4a55 camera must be connected")


def temporary_arguments(arguments):
    return any(Path(os.fsdecode(argument)).name in ("activate.py", "run_host_pio_trial.py") for argument in arguments if argument)


def check_legacy_units(units):
    require(isinstance(units, list), "Cannot inspect legacy recovery units")
    for unit in units:
        require(unit.get("active") in ("inactive", "failed"), "A legacy recovery unit is still active. Stop it or reboot")


def no_temporary_trial():
    for process in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            arguments = process.read_bytes().split(b"\0")
        except FileNotFoundError:
            continue
        require(not temporary_arguments(arguments), "A temporary activation process is still alive. Stop it and wait for restoration")
    require(not Path("/run/raspbaby-pio-test").exists(), "Legacy trial state exists. Review its recovery units and reboot before persistent activation")
    units = json.loads(command(["systemctl", "list-units", "--all", "--output=json", "--no-pager", "raspbaby-pio-recovery-*.timer", "raspbaby-pio-recovery-*.service"]))
    check_legacy_units(units)
    for unit in ("raspbaby-dwc2-pio-recovery.timer", "raspbaby-dwc2-pio-recovery.service"):
        state = command(["systemctl", "show", unit, "-p", "ActiveState", "--value"])
        require(state in ("inactive", "failed"), "Restore the temporary trial and stop its timer before proceeding")
    state_path = Path("/run/raspbaby-dwc2-pio/state.json")
    if state_path.exists():
        owned(state_path.parent, directory=True)
        owned(state_path)
        require(json.loads(state_path.read_text()).get("restored") is True, "A temporary trial still owns the controller. Restore it first or reboot")


def stock_binding():
    require(temporary.bound() == temporary.STOCK and temporary.override() == "", "Restore stock dwc2 with an empty override first")
    require(not Path("/sys/module/dwc2_pio_test").exists(), "The PIO module is still loaded")


def verified_module(path):
    owned(path)
    require(path.stat().st_size <= 32 * 1024 * 1024, "Module is too large")
    require(digest(path.read_bytes()) == MODULE_SHA, "Module differs from the exact working artifact")
    require(command(["modinfo", "-F", "name", str(path)]) == temporary.TEST, "Wrong module name")
    require(command(["modinfo", "-F", "vermagic", str(path)]).split()[0] == KERNEL, "Wrong module kernel")
    require(command(["modinfo", "-F", "raspbaby_diagnostic", str(path)]) == "host-pio-no-dma", "Wrong module marker")


def saved_binding():
    return {"schema_version": 1, "kernel_release": KERNEL, "stock": temporary.STOCK, "test": temporary.TEST, "override": ""}


def unit_content():
    return f"""[Unit]
Description=Opt-in Pi 3B+ USB PIO compatibility
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 {VERSION}/service.py start
ExecStop=/usr/bin/python3 {VERSION}/service.py stop
TimeoutStartSec=90s
TimeoutStopSec=45s
Restart=no

[Install]
WantedBy=multi-user.target
""".encode()
