# ADR 0003: Hold the OS image pin until hardware validation

Status: Proposed. Blocked on a Raspberry Pi test.

The required target is Raspberry Pi OS Lite 64-bit, based on Debian 13 Trixie.
No OS image has been tested for this project. Do not mark an image as supported
or add a fabricated checksum.

Before RB-001 is complete, record the image release, official download URL,
SHA-256 checksum, Pi model, camera model, and capability report. Store the exact
image identity in build configuration before work on the installer or image
generator starts. Do not change the OS major version without a new decision.
