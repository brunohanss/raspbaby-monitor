"""Install the reviewed persistent proposal. This command does not reboot."""

import argparse
import json
import os
from pathlib import Path
import re
import sys

import support as s


def make_parent_chain(path):
    for parent in reversed(path.parents):
        if not parent.exists():
            parent.mkdir(mode=0o755)
        s.owned(parent, directory=True)


def metadata():
    s.owned(s.DATA, directory=True)
    for filename in ("original-config.bin", "installation.json"):
        s.owned(s.DATA / filename)
    value = json.loads((s.DATA / "installation.json").read_text())
    s.require(value.get("schema_version") == 1 and value.get("kernel") == s.KERNEL and value.get("module_sha256") == s.MODULE_SHA, "Installation metadata is not recognized")
    original = (s.DATA / "original-config.bin").read_bytes()
    s.require(s.digest(original) == value.get("original_config_sha256") == s.BASELINE_CONFIG_SHA, "Original config backup does not match its reviewed hash")
    return value, original


def installed_files(value):
    expected = value.get("installed_files")
    s.require(isinstance(expected, dict), "No installed file manifest exists")
    paths = {str(s.INCLUDE), str(s.UNIT)} | {str(s.VERSION / name) for name in ("dwc2_pio_test.ko", "runtime.py", "support.py", "service.py", "install.py")}
    s.require(set(expected) == paths, "Installed file manifest is incomplete or has unknown paths")
    for path_string, sha in expected.items():
        path = Path(path_string)
        s.require(path in (s.INCLUDE, s.UNIT) or path.parent == s.VERSION, "Unexpected installed path")
        s.owned(path)
        s.require(s.digest(path.read_bytes()) == sha, f"Installed file changed: {path}. Stop for manual review")


def trusted_sources(source, runtime_source):
    for filename in ("support.py", "service.py", "install.py"):
        path = source / filename
        s.owned(path)
        for parent in path.parents:
            s.owned(parent, directory=True)
    s.owned(runtime_source)
    for parent in runtime_source.parents:
        s.owned(parent, directory=True)


def rollback_preparation(value, original, boot_changed):
    # Keep the original backup and versioned files. Do not erase evidence of an
    # incomplete install. Remove only files whose exact bytes are still ours.
    try:
        s.command(["systemctl", "disable", s.UNIT.name])
    except Exception as error:
        print(f"Could not disable the proposed unit: {error}", file=sys.stderr)
    config_safe = not boot_changed
    if boot_changed:
        try:
            current = s.CONFIG.read_bytes()
            if current != original:
                restored = s.remove_config(current, value["installed_config_sha256"], original)
                s.atomic_write(s.CONFIG, restored, mode=0o644)
            config_safe = True
        except Exception as error:
            print(f"Boot config needs manual restoration before reboot: {error}", file=sys.stderr)
    if config_safe:
        for path in (s.UNIT, s.INCLUDE):
            if path.exists() and s.digest(path.read_bytes()) == value["installed_files"][str(path)]:
                path.unlink()
    try:
        s.command(["systemctl", "daemon-reload"])
    except Exception as error:
        print(f"Could not reload systemd: {error}", file=sys.stderr)


def install(module):
    s.host_checks()
    s.actual_ssh_wifi()
    s.no_temporary_trial()
    with s.locked():
        if s.DATA.exists():
            value, original = metadata()
            s.require(value.get("status") == "installed", "A prior installation is incomplete or removed. Review retained backups")
            installed_files(value)
            s.require(s.digest(s.CONFIG.read_bytes()) == value["installed_config_sha256"], "Installed boot config changed. Stop for review")
            print("The exact persistent proposal is already installed. No files changed.")
            return
        s.stock_binding()
        s.owned(s.CONFIG)
        original = s.CONFIG.read_bytes()
        proposed = s.append_config(original)
        s.require(not s.INCLUDE.exists() and not s.UNIT.exists() and not s.VERSION.exists(), "A proposed install path already exists. Stop for manual review")
        s.require(module.stat().st_size <= 32 * 1024 * 1024, "Module is too large")
        module_bytes = module.read_bytes()
        s.require(s.digest(module_bytes) == s.MODULE_SHA, "Module is not the exact tested artifact")
        source = Path(__file__).resolve().parent
        runtime_source = source / "runtime.py" if (source / "runtime.py").exists() else source.parent / "runtime.py"
        trusted_sources(source, runtime_source)
        files = {
            s.VERSION / "dwc2_pio_test.ko": module_bytes,
            s.VERSION / "runtime.py": runtime_source.read_bytes(),
            s.VERSION / "support.py": (source / "support.py").read_bytes(),
            s.VERSION / "service.py": (source / "service.py").read_bytes(),
            s.VERSION / "install.py": (source / "install.py").read_bytes(),
            s.INCLUDE: s.INCLUDE_CONTENT,
            s.UNIT: s.unit_content(),
        }
        for path, content in files.items():
            if path.suffix == ".py":
                compile(content, str(path), "exec")
        make_parent_chain(s.DATA)
        s.DATA.mkdir(mode=0o700)
        # Backups are created once. Neither installation nor removal overwrites them.
        descriptor = os.open(s.DATA / "original-config.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as backup:
            backup.write(original)
            backup.flush()
            os.fsync(backup.fileno())
        make_parent_chain(s.VERSION)
        s.VERSION.mkdir(mode=0o755)
        value = {
            "schema_version": 1, "kernel": s.KERNEL, "module_sha256": s.MODULE_SHA,
            "original_config_sha256": s.digest(original), "installed_config_sha256": s.digest(proposed),
            "installed_files": {str(path): s.digest(content) for path, content in files.items()},
            "status": "prepared",
        }
        s.atomic_write(s.DATA / "installation.json", (json.dumps(value, indent=2) + "\n").encode())
        boot_changed = False
        try:
            for path, content in files.items():
                s.atomic_write(path, content, mode=0o644 if path in (s.INCLUDE, s.UNIT) else 0o600)
            s.verified_module(s.VERSION / "dwc2_pio_test.ko")
            s.require(s.CONFIG.read_bytes() == original, "Boot config changed during preparation")
            # Set intent first: atomic_write can replace the file successfully
            # and then report a directory fsync error.
            boot_changed = True
            s.atomic_write(s.CONFIG, proposed, mode=0o644)
            s.command(["systemctl", "daemon-reload"])
            # Do not start the service or reboot from the installer.
            s.command(["systemctl", "enable", s.UNIT.name])
            value["status"] = "installed"
            s.atomic_write(s.DATA / "installation.json", (json.dumps(value, indent=2) + "\n").encode())
        except BaseException:
            rollback_preparation(value, original, boot_changed)
            print("Installation failed. The original backup and prepared files remain for review. Check unit enablement before any reboot.", file=sys.stderr)
            raise
        print("Persistent proposal installed and enabled for the next boot. No service was started and no reboot was requested.")


def uninstall_environment():
    s.root()
    # Boot-file rollback must also work after a kernel update or camera removal.
    # Do not enter the live USB restore path unless our module is present.
    s.actual_ssh_wifi()
    s.require(s.MODEL == Path("/proc/device-tree/model").read_text().rstrip("\0\n"), "Wrong board for this recovery")
    s.require(re.fullmatch(r"/dev/mmcblk[0-9]+p[0-9]+", s.command(["findmnt", "-e", "-n", "-o", "SOURCE", "/"])) is not None, "Root must use MMC storage")
    s.require(not s.consumers(), "Stop all video, media, and sound consumers before removal")
    s.no_temporary_trial()


def pio_active():
    return s.temporary.bound() == s.temporary.TEST or Path("/sys/module/dwc2_pio_test").exists()


def uninstall():
    uninstall_environment()
    live_restore = pio_active()
    if live_restore:
        s.host_checks(capture=False)
    with s.locked():
        value, original = metadata()
        if value.get("status") == "removed":
            print("Removal was already completed. Original backup remains intact.")
            return
        installed_files(value)
        current = s.CONFIG.read_bytes()
        restored = s.remove_config(current, value["installed_config_sha256"], original)
    # ExecStop must obtain the same lock. Do not hold it across systemctl stop.
    try:
        s.command(["systemctl", "stop", s.UNIT.name])
    except Exception:
        if live_restore:
            raise
        print("The inactive/failed unit could not stop cleanly. PIO was not loaded; continue boot-file rollback only.", file=sys.stderr)
    if live_restore:
        s.command(["/usr/bin/python3", str(s.VERSION / "service.py"), "stop"])
        s.stock_binding()
    else:
        s.require(not pio_active(), "PIO appeared during rollback; stop for review")
    s.command(["systemctl", "disable", s.UNIT.name])
    with s.locked():
        s.require(s.CONFIG.read_bytes() == current, "Boot config changed during removal. Review it manually")
        s.atomic_write(s.CONFIG, restored, mode=0o644)
        # Remove only the two files whose exact content was recorded. Keep the
        # root-only backup and versioned scripts for physical/manual recovery.
        for path in (s.INCLUDE, s.UNIT):
            s.require(s.digest(path.read_bytes()) == value["installed_files"][str(path)], "Owned file changed during removal")
            path.unlink()
        value["status"] = "removed"
        s.atomic_write(s.DATA / "installation.json", (json.dumps(value, indent=2) + "\n").encode())
    s.command(["systemctl", "daemon-reload"])
    print("PIO service disabled. Live restoration was completed if needed. An ordinary reboot returns to the original legacy boot selection. Original backup and versioned recovery files remain.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--module", type=Path)
    parser.add_argument("--accept-persistent-usb-reset", action="store_true", required=True)
    args = parser.parse_args()
    s.root()
    if args.action == "install":
        s.require(args.module is not None, "Supply the exact tested module")
        install(args.module)
    else:
        uninstall()


if __name__ == "__main__":
    main()
