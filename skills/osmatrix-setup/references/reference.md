# osmatrix-setup reference

## Contents

- CLI ↔ MCP tool map
- Compatibility matrix
- Guest backends
- Devcontainers and remote Docker
- Config (every option, `homebrew`, `act_linux_image`)
- Guest-side layout

## CLI ↔ MCP tool map

Every command accepts `--json`. Exit code is non-zero on errors.

| MCP tool | CLI |
|---|---|
| `host_doctor` | `osmatrix doctor` |
| `host_report` | `osmatrix report <guest> --outcome works\|partly\|fails [--notes "..."]` |
| `host_report_file` | `osmatrix report-file <draft>` |
| `env_status` | `osmatrix status [guest]` |
| `env_setup` | `osmatrix setup <guest> [--accept-license] [--background] [--force]` |
| `env_up` | `osmatrix up <guest> [--wait [sec]]` |
| `env_down` | `osmatrix down <guest>` |
| `env_configure` | `osmatrix configure <guest> [--cpus n] [--memory 8G] [--disk 96G] [--apply]` |
| `env_reset` | `osmatrix reset <guest> [--wait [sec]]` |
| `env_viewer` | `osmatrix viewer <guest>` |
| `env_screenshot` | `osmatrix screenshot <guest> -o shot.png` |
| `env_input` | `osmatrix input <guest> [--click x,y] [--text "..."] [--keys enter ctrl+a]` |

CLI-only: `osmatrix init` (config + ssh key + host check), `config`, `install-act [--all-targets]` (build the patched act now instead of on the first `ci run`), `install-agents`, `setup-ssh <guest> --user u` (ssh guests only accepting passwords), `provision <guest> [--passwordless-sudo]` (re-run the macOS toolchain install; on Windows guests, install the MSVC Build Tools if they're missing), `destroy <guest> --yes`.

## Compatibility matrix

| Host | ubuntu | windows | macos |
|---|---|---|---|
| Linux x86_64 + KVM | ✅ container | ✅ dockur: Windows Server 2025 | ✅\* dockur: macOS 15 (Intel) |
| Linux arm64 + KVM | 🧪 container | 🧪 dockur: Windows 11 on ARM | ❌ |
| Windows 11 x86_64 + Docker Desktop (WSL2 with nested virtualization) | 🧪 container | 🧪 dockur: Windows Server 2025 | 🧪\* dockur: macOS 15 (Intel), best effort |
| Windows 11 arm64 | 🧪 container | 🧪 QEMU + Windows Hypervisor Platform: Windows 11 on ARM | ❌ |
| macOS Apple Silicon | 🧪 container | 🧪 QEMU + Hypervisor.framework: Windows 11 on ARM | 🧪\* tart |
| macOS Intel | 🧪 container | 🧪 QEMU + Hypervisor.framework: Windows Server 2025 | 🧪\* QEMU + Hypervisor.framework: macOS 15 (Intel) |

✅ tested · 🧪 supported, not yet tested on that kind of host (`host_doctor`: `untested`) · ❌ not possible (`unsupported`; use an `ssh` guest). \* macOS guests are licensed only on Apple hardware (Apple's macOS SLA); on other hosts they need the user's explicit consent (`accept_license`). The same matrix is in the README.

## Guest backends

| backend | used for | lifecycle | notes |
|---|---|---|---|
| `container` | ubuntu | docker | act runner image (with osmatrix's Rust layer when it's the default) + sshd; ssh port preferably 2221 (actual port in `env_status`) |
| `dockur` | windows, macos on Linux/Windows hosts | docker compose, disks in docker volumes `osmatrix-<guest>-storage` / `-golden` | needs KVM in containers; web viewer preferably 127.0.0.1:8006 (windows) / 8007 (macos); the actual URL from `env_viewer` |
| `tart` | macos on Apple Silicon | tart clone/run (`--vnc-experimental`: Virtualization.framework's VNC server on 127.0.0.1, with a password made up for each run that osmatrix keeps to itself) | key installed automatically via tart guest agent; VNC display for `env_screenshot`/`env_input` and the browser viewer `env_viewer` serves |
| `qemu` | windows on Macs (Windows 11 on ARM on Apple Silicon, Windows Server 2025 on Intel) and Windows on ARM hosts; macos on Intel Macs | host `qemu-system-aarch64` for `dockurr/windows-arm`, `qemu-system-x86_64` for `dockurr/windows` and `dockurr/macos` (HVF on Macs, WHPX on Windows, KVM on Linux, TCG emulation when guest and host CPU differ; `accel` overrides); install media (macOS: recovery image and OpenCore) prepared once with the dockur image in Docker; macOS installs through Recovery like dockur's (`env_setup`); disk under the osmatrix data dir `guests/<guest>/disk`, golden snapshot cloned (APFS `cp -c`, reflinks, ReFS block clone) | needs `brew install qemu` on macOS, QEMU 11+ and the "Windows Hypervisor Platform" feature on Windows; ssh forwarded to 127.0.0.1 (port in `env_status`); VNC display for `env_screenshot`/`env_input`, and the browser viewer `env_viewer` serves |
| `ssh` | any existing machine | none (up/down are no-ops; reset/snapshot unsupported) | host keys checked (trust on first use) |

## Devcontainers and remote Docker

Local guests are containers that osmatrix reaches over ssh on ports Docker publishes on `127.0.0.1`. The Windows guest also gets its install folder through a bind mount. Both need the Docker daemon to share osmatrix's loopback and filesystem.

`host_doctor` detects a devcontainer, Codespace, other container or remote `DOCKER_HOST`. In those cases it probes the daemon and reports `nesting.container`, `nesting.dockerHost` and `nesting.docker.{files,loopback}`. If the probe can't run (`nesting.docker.error`), local guests are refused until it succeeds.

| `files` / `loopback` | typical setup | local guests | Linux CI legs | `ssh` guests |
|---|---|---|---|---|
| true / true | Docker-in-Docker | work (VMs also need `/dev/kvm` in the container; never on Codespaces) | work | work |
| any / false | Docker-outside-of-Docker, remote `DOCKER_HOST` | refused: ssh to the guest can't connect | run; artifact/cache steps may fail | work |
| false / true | unusual | ubuntu and macOS work; Windows refused (its install folder would be empty) | run | work |
| no Docker | | unavailable | unavailable | work |

Refused guests fail at `env_up`/`env_setup`/`ci_run` with the reason. They don't hang in `booting`.

## Config (`osmatrix config` shows the effective values)

Linux: `~/.config/osmatrix/config.toml` · macOS: `~/Library/Preferences/osmatrix/config.toml` · Windows: `%APPDATA%\osmatrix\Config\config.toml`.

```toml
max_vms = 2                      # VM guests running CI legs at the same time
macos_eula_acknowledged = true   # required for dockur macOS on non-Apple hardware
# act_path = "act"               # use your own act (a path, or a name on PATH) instead of osmatrix's patched build
# act_version = "v0.2.88"        # a stock act release instead of the patched v0.2.89
# act_linux_image = "catthehacker/ubuntu:full-24.04"  # another image for Linux CI legs (see below)

[guests.windows]
memory = "12G"                   # min 4G; prefer env_configure, which checks the values
cpus = 6                         # min 2
disk = "96G"                     # dockur VMs; min 40G, 48G+ with msvc (Windows 11 ARM 64G, macOS 48G); grow only
msvc = false                     # Windows: skip the MSVC Build Tools + Windows SDK (default true: ~8G, +10-20 min setup)

[guests.macos]
enabled = false                  # drop a default guest

[guests.mac_mini]                # a real Mac on the network
os = "macos"
backend = "ssh"
host = "mac-mini.lan"
user = "ci"
identity = "~/.ssh/id_ed25519"
labels = ["macos-*"]
```

`msvc` is read when Windows installs, so set it before `env_setup`. Rust's default `*-pc-windows-msvc` targets and C/C++ builds need the Build Tools; without them rustc picks up Git's `link.exe` (`link: extra operand`). Guests set up before osmatrix installed them, and their golden snapshots, lack them: run `osmatrix provision <guest>` (several GB, 10-20 min, idempotent), then `env_snapshot` to keep them. Windows CI legs that use Rust or C/C++ toolchain steps (their own or in jobs they `needs:`, which act runs in the same guest) warn when the guest lacks the C++ tools or a Windows SDK.

`ssh_port`, `web_port` and `vnc_port` are preferences: a busy port is replaced by a free one when the guest starts, and `osmatrix status` shows the ports in use.

Labels decide which guest serves a `runs-on` label (globs, first match wins). Linux labels are served by act on the host.

`homebrew` (macOS guests):

```toml
[guests.macos]
homebrew = { brew = "6.0.22", core = "a5783fb0df65b1eeeaee4dbdf7e0c41b133c72ac" }  # Intel defaults; a missing field keeps its default
# homebrew = false                                                                   # Intel: provisioning skips Homebrew (an installed one stays)
```

All macOS guests get the Homebrew settings of GitHub's macOS runner images (their `bashrc`) for ssh sessions and CI steps: `HOMEBREW_NO_AUTO_UPDATE=1`, `HOMEBREW_NO_INSTALL_CLEANUP=1` and `HOMEBREW_CASK_OPTS="--no-quarantine"`, plus `brew analytics off`.

**Apple Silicon** guests (tart, or an Apple Silicon Mac as an `ssh` guest): `osmatrix provision` checks brew out at the version GitHub's arm64 runner image for the guest's macOS ships (`macos-15-arm64` for Sequoia). The version comes from the `- Homebrew x.y.z` line of that image's readme at its newest full release in actions/runner-images (main's readme if none is listed), and is cached for a day in the data dir. Formulae come from Homebrew's live API, as on the runner, so formula versions are current. With auto-update off, brew stays at that version until the next `osmatrix provision`. If the lookup fails, the guest keeps its brew and provisioning says why. `homebrew = { brew = "x.y.z" }` pins a version instead; `homebrew = false` leaves brew as it is (Homebrew provides the toolchain there, so it isn't skipped); `core` doesn't apply.

**Intel** guests (dockur, or an Intel Mac as an `ssh` guest): Homebrew stopped building Intel bottles on 2026-08-27 and its installer no longer supports Intel. Intel guests get Homebrew in `/usr/local`, as on GitHub's Intel runner, with brew cloned at the `brew` tag and homebrew-core checked out at the `core` commit. The defaults are brew 6.0.22 (the last release before 7.0.0 made Intel Tier 3) and the last homebrew-core commit before updates stopped getting Intel bottles. Unlike GitHub's runners, `HOMEBREW_NO_INSTALL_FROM_API` is also set, so formulae come from that commit. The tradeoff: `brew install` pours bottles instead of building from source, but formula versions stay as they were then, older than on GitHub's runners. Moving `core` later trades bottles for newer versions: formulae updated after the cutoff build from source (slow, and often failing). A step that runs `brew update` moves the guest off the pins until `reset`. Changes apply at the next `osmatrix provision <guest>` (then `osmatrix snapshot <guest>` to keep them); `homebrew = false` skips Homebrew for guests provisioned afterwards (it doesn't remove an installed one).

`act_linux_image` defaults to `catthehacker/ubuntu:act-24.04`. With the default, Linux legs and the `ubuntu` guest use `osmatrix/ubuntu:act-24.04-<hash>-rust<version>`, a local layer over it that adds rustup with rustfmt and clippy at the Rust version GitHub's latest ubuntu24 runner image preinstalls (read from that release's readme, cached for a day). It's built on first use, in a few minutes, and again when the runner image's Rust version or osmatrix's Dockerfile changes. Offline, the newest local one is used (or act's plain image, without Rust, when there's none and building fails). When that image changes, a `ubuntu` guest without a golden snapshot is recreated from it on its next `up`; one with a snapshot keeps it (it may hold your changes), and `env_status` and `host_doctor` say so and give the command to recreate it: `osmatrix destroy ubuntu --yes && osmatrix setup ubuntu`. Set another image to use it unchanged; it must exist locally or be pullable, and `ci_plan` warns on Linux legs that use Rust, since such an image may lack it.

## Guest-side layout

- Windows: user `osmatrix` (admin, as on GitHub's Windows runners), sshd default shell `pwsh`, tools: Git (+bash), Node LTS, Python, PowerShell 7, act (stock; CI legs run osmatrix's patched act from `~/.osmatrix/bin`), VS 2022 Build Tools C++ workload with the Windows SDK (unless `msvc = false`). Provisioning log: `C:\OEM\provision.log`.
- macOS: user `osmatrix` (admin, passwordless sudo as on GitHub's macOS runners, which workflows' `sudo` steps expect; auto-login to the desktop), Xcode Command Line Tools, git, Node LTS, Python, act (stock; CI legs run osmatrix's patched act from `~/.osmatrix/bin`), jq; Homebrew (see `homebrew` under Config). `/Users/runner/hostedtoolcache` exists and belongs to that user, because the macOS packages `actions/setup-python` and the other `actions/*-versions` installers download install there, as on GitHub's runners (`ci_run` creates it before each macOS leg on guests set up without it). osmatrix keeps the guest's password in its data dir; you don't need it, so don't read or print it.
- Data dir (guest state, ssh key, credentials, logs, the act builds in `bin/`): Linux `~/.local/share/osmatrix`.
- act: osmatrix builds act 0.2.89 with its patch (file commands under `RUNNER_TEMP`, artifact server that works with `upload-artifact` v7, Docker actions still get the file commands) from source in a pinned `golang` Docker image, for the host and the guests' platforms, the first time CI needs it. An `act` on PATH is not used unless `act_path` names it. Without Docker, osmatrix falls back to the stock release and warns. Guests' provisioned act (`C:\Program Files\act`, `/usr/local/bin/act`) is stock, and is only used when the patched build isn't.
