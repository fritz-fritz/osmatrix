#!/usr/bin/env bash
# Runs inside a dockur image (dockurr/windows, dockurr/windows-arm or dockurr/macos) with /storage
# bind-mounted from the host. It executes dockur's own setup scripts, in the order the image's entry.sh
# runs them, up to and including boot.sh: download the ISO (Windows) or recovery image (macOS), build
# the install media with the drivers, the answer file and /oem (Windows) or OpenCore (macOS), create
# the disk and UEFI firmware images. It skips the parts that only matter for dockur's own VM (web
# viewer, display, audio, networking, samba) and stops before QEMU starts, so osmatrix can boot the
# result with the host's native QEMU (HVF, KVM or WHPX).
set -Eeuo pipefail
cd /run
# The image's own defaults (APP, PLATFORM, MACHINE, BOOT_MODE) are set at the top of its entry.sh.
eval "$(sed -n 's/^: "\${\([A-Z_]*\):="\([^"]*\)"}"$/: "${\1:=\2}"/p' entry.sh)"
: "${SUPPORT:=https://github.com/fritz-fritz/osmatrix}"
export APP PLATFORM BOOT_MODE SUPPORT
[ -n "${MACHINE:-}" ] && export MACHINE
for f in $(sed -n 's/^\. \([a-z]*\)\.sh.*/\1/p' entry.sh); do
  case "$f" in server | display | audio | network | samba) continue ;; esac
  # shellcheck disable=SC1090
  . "$f.sh"
  [ "$f" = boot ] && break
done
if [ "$APP" = macOS ]; then
  # osmatrix boots the OpenCore image with the boot menu only to reach Recovery after installing, so
  # build that variant too (dockur's PICKER=Y), and keep the Apple SMC key boot.sh derived for QEMU.
  mv "$STORAGE/boot.img" "$STORAGE/boot.nopicker"
  PICKER=Y
  . boot.sh
  mv "$STORAGE/boot.img" "$STORAGE/boot-picker.img"
  mv "$STORAGE/boot.nopicker" "$STORAGE/boot.img"
  rm -f "$STORAGE/boot.sig"
  printf '%s' "$osk" >"$STORAGE/osmatrix.osk"
fi
# The host's QEMU runs as the user, not root (matters where bind mounts keep ownership, i.e. Linux).
[ -n "${HOST_UID:-}" ] && chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$STORAGE"
echo "[osmatrix] prepared: $(cd "$STORAGE" && ls)"
