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

# The macOS tool packages that actions/setup-python and the other actions/*-versions installers download
# are built for GitHub's runner layout: they install into /Users/runner/hostedtoolcache whatever
# RUNNER_TOOL_CACHE says. The guest user isn't `runner`, so create that path and give it to this user.
# (`osmatrix ci run` repeats this check before each macOS leg, for guests provisioned before it was added.)
log "creating GitHub's tool cache at /Users/runner/hostedtoolcache"
sudo mkdir -p /Users/runner/hostedtoolcache
sudo chown -R "$(id -un)":staff /Users/runner

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
  # Intel (dockur/QEMU): Homebrew no longer supports Intel macOS, so use the vendors' installers.
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
fi

git config --global init.defaultBranch main
mkdir -p ~/work
log "done: $(act --version), node $(node --version), $(python3 --version), $(git --version)"
