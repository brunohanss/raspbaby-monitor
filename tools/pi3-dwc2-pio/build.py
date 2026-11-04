"""Build the exact diagnostic module. Do not install or load it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

KERNEL = "6.18.50+rpt-rpi-v8"
SOURCE_PACKAGE = "linux-source-6.18"
SOURCE_VERSION = "1:6.18.50-1+rpt1"
PACKAGE_SHA256 = "bb1a58ab172c5feecb99d75f1885e531e8a0d55ca92beb60481aee386c277e3a"
SOURCE_ARCHIVE_SHA256 = "40c46bb1d72aa67a3e09903b59c768ab053b30e38ef7804a7f613be49f1b5154"
NAME = "dwc2_pio_test"
OBJECTS = (
    "core.o core_intr.o platform.o drd.o params.o hcd.o hcd_intr.o "
    "hcd_queue.o hcd_ddma.o gadget.o debugfs.o"
)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one source anchor: {old!r}")
    return text.replace(old, new)


def patch_source(directory):
    platform = directory / "platform.c"
    params = directory / "params.c"
    platform_text = replace_once(
        platform.read_text(),
        'static const char dwc2_driver_name[] = "dwc2";',
        'static const char dwc2_driver_name[] = "dwc2_pio_test";',
    )
    params_text = replace_once(
        params.read_text(),
        "EXPORT_SYMBOL_GPL(dwc2_pci_ids);",
        "/* Diagnostic copy: do not duplicate the stock PCI export. */",
    )
    params_text = replace_once(
        params_text,
        "\tdwc2_check_params(hsotg);",
        "\tdwc2_check_params(hsotg);\n"
        "\t/* Diagnostic only: use the implemented CPU-driven host path. */\n"
        "\thsotg->params.host_dma = false;\n"
        "\thsotg->params.dma_desc_enable = false;\n"
        "\thsotg->params.dma_desc_fs_enable = false;\n"
        '\tdev_info(hsotg->dev, "Raspbaby diagnostic: host DMA disabled\\n");',
    )
    # Check every anchor before writing either file.
    platform.write_text(platform_text + '\nMODULE_INFO(raspbaby_diagnostic,"host-pio-no-dma");\n')
    params.write_text(params_text)
    (directory / "Makefile").write_text(
        f"obj-m += {NAME}.o\n{NAME}-y := {OBJECTS}\n"
    )


def extract_driver(archive, destination):
    prefix = "linux-source-6.18/drivers/usb/dwc2/"
    with tarfile.open(archive, "r:xz") as source:
        for member in source:
            if not member.name.startswith(prefix):
                continue
            relative = Path(member.name[len(prefix):])
            if not relative.parts:
                continue
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe source archive path")
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
            else:
                raise ValueError("Unexpected link or special file in driver source")
    if not (destination / "platform.c").is_file():
        raise ValueError("DWC2 source is absent from the archive")


def output(args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-deb", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sha256(args.source_deb) != PACKAGE_SHA256:
        raise SystemExit("Source package SHA-256 does not match the pin")
    if output(["dpkg-deb", "-f", str(args.source_deb), "Package"]) != SOURCE_PACKAGE:
        raise SystemExit("Wrong source package name")
    if output(["dpkg-deb", "-f", str(args.source_deb), "Version"]) != SOURCE_VERSION:
        raise SystemExit("Wrong source package version")
    headers = Path("/lib/modules") / KERNEL / "build"
    header_package = f"linux-headers-{KERNEL}"
    if output(["dpkg-query", "-W", "-f=${Version}", header_package]) != SOURCE_VERSION:
        raise SystemExit("Installed kernel header package version does not match")
    if output(["make", "-s", "-C", str(headers), "kernelrelease"]) != KERNEL:
        raise SystemExit("Kernel headers do not match the exact release")
    destination = args.output.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    subprocess.run(["dpkg-deb", "-x", str(args.source_deb.resolve()), str(destination / "source-package")], check=True)
    archive = destination / "source-package/usr/src/linux-source-6.18.tar.xz"
    if sha256(archive) != SOURCE_ARCHIVE_SHA256:
        raise SystemExit("Inner source archive SHA-256 does not match the pin")
    driver = destination / NAME
    driver.mkdir()
    extract_driver(archive, driver)
    originals = {name: sha256(driver / name) for name in ("platform.c", "params.c")}
    patch_source(driver)
    environment = dict(os.environ, KBUILD_BUILD_USER="raspbaby", KBUILD_BUILD_HOST="diagnostic", KBUILD_BUILD_TIMESTAMP="Thu Jan 1 00:00:00 UTC 1970", SOURCE_DATE_EPOCH="0")
    subprocess.run(["make", "-C", str(headers), f"M={driver}", "-j1", "modules"], check=True, env=environment)
    module = driver / f"{NAME}.ko"
    if output(["modinfo", "-F", "name", str(module)]) != NAME:
        raise SystemExit("Unexpected module name")
    if output(["modinfo", "-F", "vermagic", str(module)]).split()[0] != KERNEL:
        raise SystemExit("Unexpected module kernel version")
    if output(["modinfo", "-F", "raspbaby_diagnostic", str(module)]) != "host-pio-no-dma":
        raise SystemExit("Missing diagnostic module marker")
    manifest = {
        "schema_version": 1, "kernel_release": KERNEL,
        "source_package": SOURCE_PACKAGE, "source_version": SOURCE_VERSION,
        "source_package_sha256": PACKAGE_SHA256, "source_archive_sha256": sha256(archive),
        "original_source_sha256": originals,
        "kernel_config_sha256": sha256(headers / ".config"),
        "module_name": NAME, "module_sha256": sha256(module),
        "objects": OBJECTS.split(),
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    print("Build complete. No module was installed or loaded.")


if __name__ == "__main__":
    main()
