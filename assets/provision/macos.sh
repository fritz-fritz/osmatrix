#!/bin/bash
# osmatrix macOS guest provisioning (dockur or tart). Idempotent; run via `osmatrix provision <guest>`.
set -euo pipefail
log() { printf '[osmatrix] %s\n' "$*"; }

# Root is needed for Xcode CLT (softwareupdate), the Homebrew installer and pmset.
# `osmatrix provision` runs this in a terminal, so sudo asks for the password once and we keep it cached.
if ! sudo -n true 2>/dev/null; then
  if [ ! -t 0 ]; then
    log "sudo needs a password but there is no terminal; run: osmatrix provision <guest>"
    exit 2
  fi
  log "sudo password for $USER (asked once):"
  sudo -v
fi
# Keep the sudo timestamp fresh for the rest of the run.
( while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit; done ) 2>/dev/null &

if [ "${1:-}" = "--passwordless-sudo" ]; then
  # GitHub's macOS runners have passwordless sudo; workflows with `sudo ...` steps need it to run locally.
  log "enabling passwordless sudo for $USER"
  echo "$USER ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/osmatrix >/dev/null
  sudo chmod 440 /etc/sudoers.d/osmatrix
fi

log "disabling sleep"
sudo pmset -a sleep 0 displaysleep 0 disksleep 0 >/dev/null 2>&1 || true

if ! xcode-select -p >/dev/null 2>&1; then
  log "installing Xcode Command Line Tools"
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  label=$(softwareupdate -l 2>/dev/null | sed -n 's/^\* Label: \(Command Line Tools for Xcode.*\)$/\1/p' | sort -V | tail -1)
  [ -n "$label" ] && sudo softwareupdate -i "$label" --verbose
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi

if [ "$(uname -m)" = "arm64" ]; then
  # Apple Silicon (tart): Homebrew, like GitHub's macOS runners.
  if ! command -v brew >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/brew ]; then
    log "installing Homebrew"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  BREW=$(command -v brew || echo /opt/homebrew/bin/brew)
  eval "$("$BREW" shellenv)"
  # Make brew visible to non-interactive ssh sessions (zsh reads .zshenv for every invocation).
  line="eval \"\$($BREW shellenv)\""
  grep -qxF "$line" ~/.zshenv 2>/dev/null || echo "$line" >> ~/.zshenv
  grep -qxF "$line" ~/.bashrc 2>/dev/null || echo "$line" >> ~/.bashrc
  log "installing toolchain"
  brew install --quiet git node python act jq
else
  # Intel (dockur/QEMU): Homebrew made Intel macOS Tier 3, so the toolchain comes from the vendors' installers;
  # a pinned Homebrew is added below for workflows that `brew install`.
  tmp=$(mktemp -d)
  gh_asset() { # repo regex -> download url of the latest release asset
    # Fetch first: with pipefail, `curl | ... | head` fails when head closes the pipe early.
    rel=$(curl -fsSL "https://api.github.com/repos/$1/releases/latest")
    printf '%s' "$rel" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 | grep -E "$2" | sed -n 1p
  }
  export PATH="/usr/local/bin:$PATH"
  if ! command -v node >/dev/null 2>&1; then
    log "installing Node.js LTS"
    idx=$(curl -fsSL https://nodejs.org/dist/index.json)
    v=$(printf '%s' "$idx" | tr '{' '\n' | grep '"lts":"' | sed -n 1p | sed 's/.*"version":"\([^"]*\)".*/\1/')
    curl -fsSL -o "$tmp/node.pkg" "https://nodejs.org/dist/$v/node-$v.pkg"
    sudo installer -pkg "$tmp/node.pkg" -target / >/dev/null
  fi
  if ! /usr/local/bin/python3 --version >/dev/null 2>&1; then
    log "installing Python"
    rels=$(curl -fsSL "https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false")
    v=$(printf '%s' "$rels" | grep -oE '"name": *"Python 3\.[0-9]+\.[0-9]+"' | grep -oE '3\.[0-9]+\.[0-9]+' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    curl -fsSL -o "$tmp/python.pkg" "https://www.python.org/ftp/python/$v/python-$v-macos11.pkg"
    sudo installer -pkg "$tmp/python.pkg" -target / >/dev/null
  fi
  if ! command -v act >/dev/null 2>&1; then
    log "installing act"
    curl -fsSL -o "$tmp/act.tgz" "$(gh_asset nektos/act 'act_Darwin_x86_64\.tar\.gz$')"
    sudo mkdir -p /usr/local/bin && sudo tar -xzf "$tmp/act.tgz" -C /usr/local/bin act
  fi
  rm -rf "$tmp"
  # sshd gives non-login shells only /usr/bin:/bin:/usr/sbin:/sbin; path_helper (/etc/paths) runs for login shells only.
  line='export PATH="/usr/local/bin:$PATH"'
  grep -qxF "$line" ~/.zshenv 2>/dev/null || echo "$line" >> ~/.zshenv
  grep -qxF "$line" ~/.bashrc 2>/dev/null || echo "$line" >> ~/.bashrc
  export PATH="/usr/local/bin:$PATH"

  # Homebrew in /usr/local, as on GitHub's Intel runner, pinned to where Intel bottles exist. Homebrew stopped
  # building Intel bottles in August 2026 and its installer refuses Intel, so clone brew at a release tag and
  # check homebrew/core out at a commit from before the cutoff. osmatrix passes the pins from the guest's
  # `homebrew` config (OSMATRIX_BREW_TAG, OSMATRIX_BREW_CORE); OSMATRIX_HOMEBREW=0 means none.
  if [ "${OSMATRIX_HOMEBREW:-1}" = 0 ]; then
    log "Homebrew disabled for this guest (homebrew = false)"
  elif [ -z "${OSMATRIX_BREW_TAG:-}" ] || [ -z "${OSMATRIX_BREW_CORE:-}" ]; then
    log "no Homebrew pins given (run this through osmatrix provision); skipping Homebrew"
  else
    # Formula definitions come from the pinned tap, not the live JSON API (whose versions have no Intel
    # bottles); brew must not update itself or the tap away from the pins.
    export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_NO_INSTALL_CLEANUP=1
    repo=/usr/local/Homebrew
    if [ ! -d "$repo/.git" ]; then
      log "installing Homebrew $OSMATRIX_BREW_TAG into /usr/local"
      sudo mkdir -p "$repo"
      sudo chown "$USER:admin" "$repo"
      git -c advice.detachedHead=false clone -q --depth 1 --branch "$OSMATRIX_BREW_TAG" https://github.com/Homebrew/brew "$repo"
    elif [ "$(git -C "$repo" describe --tags --exact-match 2>/dev/null)" != "$OSMATRIX_BREW_TAG" ]; then
      log "switching Homebrew to $OSMATRIX_BREW_TAG"
      git -C "$repo" fetch -q --depth 1 origin tag "$OSMATRIX_BREW_TAG"
      git -C "$repo" -c advice.detachedHead=false checkout -q -f "$OSMATRIX_BREW_TAG"
    fi
    # What Homebrew's installer sets up: the prefix directories, owned by the user (not recursively:
    # the Node.js, Python and act files already in /usr/local stay root-owned).
    dirs="bin etc include lib sbin share opt var Frameworks Cellar Caskroom etc/bash_completion.d lib/pkgconfig
      share/aclocal share/doc share/info share/locale share/man share/man/man1 share/man/man2 share/man/man3
      share/man/man4 share/man/man5 share/man/man6 share/man/man7 share/man/man8 share/zsh share/zsh/site-functions
      var/homebrew var/homebrew/linked var/log"
    for d in $dirs; do
      if [ ! -d "/usr/local/$d" ] || [ ! -O "/usr/local/$d" ]; then
        sudo mkdir -p "/usr/local/$d"
        sudo chown "$USER:admin" "/usr/local/$d"
        sudo chmod u+rwx,g+rwx "/usr/local/$d"
      fi
    done
    ln -sf ../Homebrew/bin/brew /usr/local/bin/brew
    core="$repo/Library/Taps/homebrew/homebrew-core"
    if [ "$(git -C "$core" rev-parse HEAD 2>/dev/null)" != "$OSMATRIX_BREW_CORE" ]; then
      log "pinning homebrew/core to $OSMATRIX_BREW_CORE"
      mkdir -p "$core"
      git -C "$core" init -q
      git -C "$core" remote get-url origin >/dev/null 2>&1 || git -C "$core" remote add origin https://github.com/Homebrew/homebrew-core
      # Only that commit (no history): a full homebrew-core clone is over a gigabyte.
      git -C "$core" fetch -q --depth 1 origin "$OSMATRIX_BREW_CORE"
      git -C "$core" -c advice.detachedHead=false checkout -q -f FETCH_HEAD
    fi
    # Also installs Homebrew's portable Ruby now rather than in the first CI step that uses brew.
    brew config >/dev/null
    # act's host mode passes its own environment to steps, so non-interactive ssh shells need these too.
    line='export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_NO_INSTALL_CLEANUP=1'
    grep -qxF "$line" ~/.zshenv 2>/dev/null || echo "$line" >> ~/.zshenv
    grep -qxF "$line" ~/.bashrc 2>/dev/null || echo "$line" >> ~/.bashrc
    log "$(brew --version | sed -n 1p), homebrew/core pinned at ${OSMATRIX_BREW_CORE:0:12}"
  fi
fi

git config --global init.defaultBranch main
mkdir -p ~/work
log "done: $(act --version), node $(node --version), $(python3 --version), $(git --version)"
