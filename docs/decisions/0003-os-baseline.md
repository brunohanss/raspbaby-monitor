# ADR 0003: Pin the observed Trixie image and keep hardware scope explicit

Status: Accepted for the available Pi 3B+ feasibility tests. Pi 4 validation is pending.

The required target is Raspberry Pi OS Lite 64-bit, based on Debian 13 Trixie.
The running Pi reports the 2026-10-06 image reference and Debian 13.7.
The local Imager cached download matches the official image checksum and catalog.
The exact URL and SHA-256 are stored in `config/tested-os-image.json`.

This verifies the cached download. It does not independently prove the original
flashed-image bytes. Record that distinction. The available Pi is a 3B+, not the
planned Pi 4. Do not extend its test result to Pi 4 or other camera models.

Use the pin when preparing future installation work. Verify the image again
before flashing. Do not silently change the image release or OS major version.
