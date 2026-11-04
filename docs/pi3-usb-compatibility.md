# Pi 3B+ USB compatibility experiment

This is an opt-in kernel diagnostic. It is not an installation step or a
supported camera fix. The media feasibility gate remains open.

## Tested scope

The available board is a Raspberry Pi 3 Model B Plus Rev 1.4, running ARM64
Raspberry Pi OS Lite, Debian 13.7. The tested kernel is
`6.18.50+rpt-rpi-v8`. The camera reports USB ID `4c4a:4a55`, DV20 USB / Jieli,
revision 1.00, with no serial number. These results do not validate a Pi 4,
another kernel, another camera, or production use.

The stock USB capture path produced corrupt frames. A temporary DWC2 driver
with host DMA disabled, together with the stock UVC driver, produced clear
full-color MJPEG at 640 × 480 and 30 FPS in a direct capture test. A 15-second
sample contained 72 distinct decoded frames in RAM. FFmpeg still dropped some
buffers marked `V4L2_BUF_FLAG_ERROR`. This short result does not prove that all
frames are valid, that audio and video stay synchronized, or that CPU and RAM
use remain acceptable. Do not infer a stable 30 FPS output from this sample.

A later direct capture run lasted 120.96 seconds and produced 597 distinct
decoded RGB frames out of 597 sampled frames. The picture showed a clear,
full-color person. FFmpeg decoded 3,175 input frames, about 26.56 FPS, and
dropped 376 flagged V4L2 buffers. No JPEG error lines were reported. Whole-Pi
CPU use averaged 18.57% of four-core capacity. FFmpeg used 65.66% of one core.
The diagnostic child-process maximum RSS was 183,532 KiB; this may include
FFmpeg and diagnostic overhead. It is not a Rust daemon memory measurement.
The local wrapper confirmed stock-driver restoration. These results came from
the earlier local diagnostic scripts. They do not validate the prepared tools
below or complete the WebRTC feasibility gate.

## USB impact and prerequisites

Switching the host driver resets the whole USB tree, including the camera,
microphone, integrated USB Ethernet controller, keyboards, and USB disks.
Use the built-in Wi-Fi connection for the actual SSH session. Keep root on the
MMC card. Disconnect all USB storage. Stop all video, media, and sound
consumers. Do not connect a USB disk or start an unrelated consumer during the
trial. Plan to lose USB access during activation and restoration.

The active platform driver must already be stock `dwc2`, at platform device
`3f980000.usb`. The standard Pi 3 boot configuration can use `dwc_otg` instead.
The activation script does not change boot configuration or substitute a
different host driver.

If a one-time DWC2 boot is needed, inspect the current boot files first. Prepare
`/boot/firmware/tryboot.txt` as a copy of the normal configuration, with one
reviewed host selection: `dtoverlay=dwc2,dr_mode=host`. Resolve conflicting host
settings in that temporary file. Do not overwrite an existing tryboot file.
Do not change `config.txt`, the normal command line, or the kernel image.
Prepare a review copy outside the boot partition first:

```sh
cp /boot/firmware/config.txt /tmp/raspbaby-tryboot-review.txt
nano /tmp/raspbaby-tryboot-review.txt
```

Append `[all]` and `dtoverlay=dwc2,dr_mode=host` to the review copy only after
you check its existing host settings. Review the complete copy, then have the
administrator create the new `tryboot.txt` from that copy. The tools do not
copy it into the boot partition or apply a host override automatically.
Only after local review, request the one-time boot:

```sh
sudo reboot '0 tryboot'
```

A later ordinary reboot selects the normal configuration. A failed one-time
boot can still require physical power cycling. This procedure is not
automated here. Before activation, verify that the kernel, model, stock UVC
module, actual SSH Wi-Fi route, MMC root, and `dwc2` binding satisfy the guards.

## Build without installation

Run the build command on the Pi as an ordinary user. Install matching headers
and build tools separately through the administrator's normal APT process.
The required source package is `linux-source-6.18`, APT version
`1:6.18.50-1+rpt1`. Download that exact package with APT; do not install a newer
source release. The SHA-256 below applies to the **Debian package**, not its
inner source archive:

```text
bb1a58ab172c5feecb99d75f1885e531e8a0d55ca92beb60481aee386c277e3a
```

The verified inner `linux-source-6.18.tar.xz` SHA-256 is:

```text
40c46bb1d72aa67a3e09903b59c768ab053b30e38ef7804a7f613be49f1b5154
```

```sh
mkdir -p target/pi3-pio-source
cd target/pi3-pio-source
apt download 'linux-source-6.18=1:6.18.50-1+rpt1'
cd ../..
python3 tools/pi3-dwc2-pio/build.py \
  --source-deb ./target/pi3-pio-source/linux-source-6.18_1%3a6.18.50-1+rpt1_all.deb \
  --output ./target/pio-build
```

Use the actual downloaded filename if APT encodes the version differently.
The output directory must not exist. Keep build output outside Git. The build
verifies the package hash, package name, version, and exact header release. It
extracts the driver from the verified package. It checks each patch anchor
exactly once. It renames the platform driver to `dwc2_pio_test`, removes the
duplicate PCI symbol export, and sets `host_dma`, `dma_desc_enable`, and
`dma_desc_fs_enable` to false **after** `dwc2_check_params`.

The module includes the complete object set used in the tested dual-role
configuration, including the host, DRD, gadget, and debugfs objects. The script
does not install a module, run `depmod`, load a driver, or change boot files.
The manifest records the source, header configuration, and module hashes.
Build timestamps and build identity are fixed. Compiler and header differences
can still change module bytes. Review the manifest and module hash after each
build. A matching hash identifies the artifact; it is not a module signature.

## Activate with a bounded lease

Copy these scripts and the reviewed build output to the Pi through an
authenticated channel. Keep one SSH terminal open for activation. Use another
Wi-Fi SSH terminal for the capture test and manual recovery.

```sh
sudo --preserve-env=SSH_CONNECTION python3 tools/pi3-dwc2-pio/activate.py \
  --module ./target/pio-build/dwc2_pio_test/dwc2_pio_test.ko \
  --manifest ./target/pio-build/manifest.json \
  --expected-module-sha256 REVIEWED_MODULE_SHA256 \
  --lease-seconds 120 \
  --accept-usb-tree-reset
```

Replace `REVIEWED_MODULE_SHA256` with the reviewed lowercase hash from the build.
The default lease is 120 seconds. The hard maximum is 1,800 seconds. The command
stays in the foreground. It copies recovery code and the verified module into
a private root-owned directory under `/run`. It repeats the device guards,
arms an independent systemd recovery timer, and verifies that the timer is
active before it loads or unbinds a driver. It then switches the host.
The timer remains armed if the SSH session or activation process stops.

Capture only after activation succeeds. Keep the capture test shorter than
the lease. Stop capture before restoration. At lease expiry, recovery resets
the USB tree even if a consumer still has a device open. This can interrupt
that consumer. The tools do not start capture,
save media, listen on a network port, or change the stock UVC driver. Do not
use custom UVC modules with this experiment.

## Restore and verify

Stop capture first. To restore early, run this command in the second terminal:

```sh
sudo python3 /run/raspbaby-dwc2-pio/restore.py
```

Ctrl+C in the activation terminal also requests restoration. A shared file
lock prevents local restoration and timer restoration from modifying the
binding at the same time. Restoration clears the saved empty driver override,
binds stock `dwc2`, unloads the test module, and waits for udev. It refuses to
unbind an unrelated driver. It can run again after successful restoration.
Keep the `/run` state until reboot so a queued timer can repeat safely. Reboot
before another trial. Do not delete a live state directory or lock file.

Verify the stock binding, an empty override, and absence of the test module:

```sh
readlink /sys/bus/platform/devices/3f980000.usb/driver
cat /sys/bus/platform/devices/3f980000.usb/driver_override
test ! -d /sys/module/dwc2_pio_test
systemctl status raspbaby-dwc2-pio-recovery.timer --no-pager
```

An empty override may be displayed as `(null)`. If restoration fails, keep the
timer and state intact, inspect its service journal, and use an ordinary reboot
to return to the normal boot configuration. A kernel lockup can defeat both
software recovery paths and require physical access. No kernel module change
can guarantee recovery from a kernel lockup.

## Offline checks

From the repository root, run:

```powershell
python -m unittest discover -s tools/pi3-dwc2-pio -p test_tools.py -v
```

The tests check patch anchors, the three DMA settings, module fingerprint
rejection, unsafe device states, timer failure before unbind, bounded leases,
and repeatable restoration. They do not load a module or access Pi hardware.
The prepared activation scripts then passed a guarded Pi runtime test with a
1,800-second independent recovery lease and the reviewed module fingerprint.
Native Windows and Android VGA playback both produced clear full-frame video.
See [real camera validation](real-camera-validation.md) for client evidence.

Local validation: all 11 offline tests passed on the Windows development host.
Python compilation and whitespace checks also passed. The separate build
script has offline coverage; its generated module still needs a fresh build
and review before use. The runtime test used the previously built and reviewed
module, not an untested rebuilt artifact.
