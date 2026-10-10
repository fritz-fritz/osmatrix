#!/bin/sh
# osmatrix: configure a freshly installed macOS from Recovery, before its first boot.
# Creates an admin user, authorizes the osmatrix ssh key, enables Remote Login, passwordless sudo,
# auto-login, and marks Setup Assistant as done. Disposable dev VMs only.
# Inputs (env): DV_USER, DV_PASS, DV_KEY, DV_NAME (full name), DV_HOST (computer name)
set -eu
log() { echo "[configure] $*"; }

DATA=""
for v in "/Volumes/Macintosh HD - Data" /Volumes/*Data; do
  [ -d "$v/private/var/db" ] && DATA="$v" && break
done
if [ -z "$DATA" ]; then
  diskutil mount "Macintosh HD - Data" >/dev/null 2>&1 || true
  [ -d "/Volumes/Macintosh HD - Data/private/var/db" ] && DATA="/Volumes/Macintosh HD - Data"
fi
[ -n "$DATA" ] || { log "installed Data volume not found"; diskutil list; exit 3; }
log "data volume: $DATA"

DS="$DATA/private/var/db/dslocal/nodes/Default"
U="$DV_USER"
if dscl -f "$DS" localhost -read "/Local/Default/Users/$U" >/dev/null 2>&1; then
  log "user $U exists"
else
  log "creating admin user $U"
  uid=501
  while dscl -f "$DS" localhost -list /Local/Default/Users UniqueID | awk '{print $2}' | grep -qx "$uid"; do uid=$((uid + 1)); done
  dscl -f "$DS" localhost -create "/Local/Default/Users/$U"
  dscl -f "$DS" localhost -create "/Local/Default/Users/$U" UserShell /bin/zsh
  dscl -f "$DS" localhost -create "/Local/Default/Users/$U" RealName "$DV_NAME"
  dscl -f "$DS" localhost -create "/Local/Default/Users/$U" UniqueID "$uid"
  dscl -f "$DS" localhost -create "/Local/Default/Users/$U" PrimaryGroupID 20
  dscl -f "$DS" localhost -create "/Local/Default/Users/$U" NFSHomeDirectory "/Users/$U"
  dscl -f "$DS" localhost -passwd "/Local/Default/Users/$U" "$DV_PASS"
  dscl -f "$DS" localhost -append /Local/Default/Groups/admin GroupMembership "$U"
fi
uid=$(dscl -f "$DS" localhost -read "/Local/Default/Users/$U" UniqueID | awk '{print $2}')

H="$DATA/Users/$U"
mkdir -p "$H/.ssh" "$H/Library/Preferences"
grep -qxF "$DV_KEY" "$H/.ssh/authorized_keys" 2>/dev/null || echo "$DV_KEY" >> "$H/.ssh/authorized_keys"
chmod 700 "$H/.ssh"; chmod 600 "$H/.ssh/authorized_keys"
chown -R "$uid:20" "$H"

log "skipping Setup Assistant"
touch "$DATA/private/var/db/.AppleSetupDone"
# startosinstall --agreetolicense already recorded acceptance; without this the "MiniBuddy" pass
# re-prompts for the same Terms and Conditions at first boot.
rm -f "$DATA/private/var/db/.AppleSetupTermsOfService"
PB=/usr/libexec/PlistBuddy
SA="$H/Library/Preferences/com.apple.SetupAssistant.plist"
for k in DidSeeCloudSetup DidSeeSiriSetup DidSeePrivacy DidSeeScreenTime DidSeeTouchIDSetup DidSeeAppearanceSetup DidSeeAccessibility DidSeeActivationLock DidSeeTermsOfAddress DidSeeIntelligence DidSeeApplePaySetup DidSeeiCloudLoginForStorageServices; do
  $PB -c "Delete :$k" "$SA" >/dev/null 2>&1 || true
  $PB -c "Add :$k bool true" "$SA" >/dev/null
done
# The per-user "MiniBuddy" (Apple Account, Siri, ...) runs unless the user has "seen" this OS build.
SV="/Volumes/Macintosh HD/System/Library/CoreServices/SystemVersion.plist"
if [ -f "$SV" ]; then
  ver=$($PB -c "Print :ProductVersion" "$SV"); build=$($PB -c "Print :ProductBuildVersion" "$SV")
  for kv in "LastSeenCloudProductVersion:$ver" "LastSeenBuddyBuildVersion:$build" "LastPreLoginTasksPerformedVersion:$ver" "LastPreLoginTasksPerformedBuild:$build"; do
    $PB -c "Delete :${kv%%:*}" "$SA" >/dev/null 2>&1 || true
    $PB -c "Add :${kv%%:*} string ${kv#*:}" "$SA" >/dev/null
  done
else
  log "warning: $SV not found; the per-user setup assistant may appear at first login"
fi
for k in SkipFirstLoginOptimization DidSeeLockdownMode DidSeeAppStore; do
  $PB -c "Delete :$k" "$SA" >/dev/null 2>&1 || true
  $PB -c "Add :$k bool true" "$SA" >/dev/null
done
chown "$uid:20" "$SA"

log "enabling Remote Login (sshd)"
DIS="$DATA/private/var/db/com.apple.xpc.launchd/disabled.plist"
mkdir -p "$(dirname "$DIS")"
$PB -c "Delete :com.openssh.sshd" "$DIS" >/dev/null 2>&1 || true
$PB -c "Add :com.openssh.sshd bool false" "$DIS" >/dev/null

log "passwordless sudo"
mkdir -p "$DATA/private/etc/sudoers.d"
echo "$U ALL=(ALL) NOPASSWD: ALL" > "$DATA/private/etc/sudoers.d/osmatrix"
chmod 440 "$DATA/private/etc/sudoers.d/osmatrix"; chown 0:0 "$DATA/private/etc/sudoers.d/osmatrix"

log "auto-login as $U (GUI tests and screenshots land on a desktop)"
LW="$DATA/Library/Preferences/com.apple.loginwindow.plist"
$PB -c "Delete :autoLoginUser" "$LW" >/dev/null 2>&1 || true
$PB -c "Add :autoLoginUser string $U" "$LW" >/dev/null
$PB -c "Delete :autoLoginUserScreenLocked" "$LW" >/dev/null 2>&1 || true
$PB -c "Add :autoLoginUserScreenLocked bool false" "$LW" >/dev/null
# /etc/kcpassword: password XORed with Apple's fixed key, padded to a multiple of 12 bytes.
perl -e '
  my @k = (0x7d,0x89,0x52,0x23,0xd2,0xbc,0xdd,0xea,0xa3,0xb9,0x1f);
  my @p = map { ord } split //, $ARGV[0];
  push @p, 0; push @p, 0 while @p % 12;
  print map { chr($p[$_] ^ $k[$_ % 11]) } 0..$#p;
' "$DV_PASS" > "$DATA/private/etc/kcpassword"
chmod 600 "$DATA/private/etc/kcpassword"; chown 0:0 "$DATA/private/etc/kcpassword"

log "registering the QEMU keyboard as ANSI (avoids Keyboard Setup Assistant)"
KT="$DATA/Library/Preferences/com.apple.keyboardtype.plist"
$PB -c "Add :keyboardtype dict" "$KT" >/dev/null 2>&1 || true
for id in 1-1575-0 0-0-0; do  # QEMU USB keyboard (vendor 0x627, product 1); generic fallback
  $PB -c "Delete :keyboardtype:$id" "$KT" >/dev/null 2>&1 || true
  $PB -c "Add :keyboardtype:$id integer 40" "$KT" >/dev/null
done

# The assistant still launches for QEMU's keyboard on some versions; close it right after login.
LA="$DATA/Library/LaunchAgents/dev.osmatrix.dismiss-keyboard-assistant.plist"
mkdir -p "$(dirname "$LA")"
cat > "$LA" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.osmatrix.dismiss-keyboard-assistant</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>i=0; while [ $i -lt 30 ]; do pkill -x KeyboardSetupAssistant; i=$((i+1)); sleep 1; done</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
chmod 644 "$LA"; chown 0:0 "$LA"

if [ -n "${DV_HOST:-}" ]; then
  SC="$DATA/Library/Preferences/SystemConfiguration/preferences.plist"
  if [ -f "$SC" ]; then
    for k in ComputerName HostName LocalHostName; do
      $PB -c "Delete :System:System:$k" "$SC" >/dev/null 2>&1 || true
      $PB -c "Add :System:System:$k string $DV_HOST" "$SC" >/dev/null 2>&1 || true
    done
  fi
fi

sync
log "done"
