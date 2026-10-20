#!/usr/bin/env bash
# Runs inside a dockur Windows image (dockurr/windows or dockurr/windows-arm) with /storage bind-mounted
# from the host. It executes dockur's own setup scripts, in the order the image's entry.sh runs them,
# up to and including boot.sh: download the ISO, build the install media with the drivers, the answer
# file and /oem, create the disk and UEFI firmware images. It skips the parts that only matter for
# dockur's own VM (web viewer, display, audio, networking, samba) and stops before QEMU starts, so
# osmatrix can boot the result with the host's native QEMU (HVF, KVM or WHPX).
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
# The host's QEMU runs as the user, not root (matters where bind mounts keep ownership, i.e. Linux).
[ -n "${HOST_UID:-}" ] && chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$STORAGE"
echo "[osmatrix] prepared: $(cd "$STORAGE" && ls)"
