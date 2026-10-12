#!/usr/bin/env bash
# Runs inside a dockur image (e.g. dockurr/windows-arm) with /storage bind-mounted from the host.
# It executes dockur's own setup scripts (download the ISO, build setup.img with the drivers, the
# answer file and /oem, create the disk and UEFI firmware images) and stops before QEMU starts, so
# osmatrix can boot the result with the host's native QEMU (HVF on macOS).
set -Eeuo pipefail
cd /run
: "${APP:=Windows}" "${MACHINE:=virt}" "${PLATFORM:=arm64}" "${BOOT_MODE:=windows}" "${SUPPORT:=https://github.com/fritz-fritz/osmatrix}"
export APP MACHINE PLATFORM BOOT_MODE SUPPORT
for f in start utils init memory download define mido answer legacy image install disk boot; do
  # shellcheck disable=SC1090
  . "$f.sh"
done
# The host's QEMU runs as the user, not root (matters where bind mounts keep ownership, i.e. Linux).
[ -n "${HOST_UID:-}" ] && chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$STORAGE"
echo "[osmatrix] prepared: $(cd "$STORAGE" && ls)"
