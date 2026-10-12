# osmatrix-setup reference

## CLI ↔ MCP tool map

Every command accepts `--json`. Exit code is non-zero on errors.

| MCP tool | CLI |
|---|---|
| `host_doctor` | `osmatrix doctor` |
| `host_report` | `osmatrix report <guest> --outcome works\|partly\|fails [--notes "..."]` |
| `env_status` | `osmatrix status [guest]` |
| `env_setup` | `osmatrix setup <guest> [--accept-license] [--background] [--force]` |
| `env_up` | `osmatrix up <guest> [--wait [sec]]` |
| `env_down` | `osmatrix down <guest>` |
| `env_configure` | `osmatrix configure <guest> [--cpus n] [--memory 8G] [--disk 96G] [--apply]` |
| `env_reset` | `osmatrix reset <guest> [--wait [sec]]` |
| `env_screenshot` | `osmatrix screenshot <guest> -o shot.png` |
| `env_input` | `osmatrix input <guest> [--click x,y] [--text "..."] [--keys enter ctrl+a]` |

CLI-only: `osmatrix init` (config + ssh key + host check), `config`, `install-act`, `install-agents`, `setup-ssh <guest> --user u` (ssh guests only accepting passwords), `provision <guest> [--passwordless-sudo]` (re-run the macOS toolchain install), `destroy <guest> --yes`.

## Compatibility matrix

| Host | ubuntu | windows | macos |
|---|---|---|---|
| Linux x86_64 + KVM | ✅ container | ✅ dockur: Windows Server 2025 | ✅\* dockur: macOS 15 (Intel) |
| Linux arm64 + KVM | 🧪 container | 🧪 dockur: Windows 11 on ARM | ❌ |
| Windows 11 x86_64 + Docker Desktop (WSL2 with nested virtualization) | 🧪 container | 🧪 dockur: Windows Server 2025 | 🧪\* dockur: macOS 15 (Intel), best effort |
| Windows 11 arm64 | 🧪 container | ❌¹ | ❌ |
| macOS Apple Silicon | 🧪 container | 🧪 QEMU + Hypervisor.framework: Windows 11 on ARM | 🧪\* tart |
| macOS Intel | 🧪 container | ❌ | ❌ |

✅ tested · 🧪 supported, not yet tested on that kind of host (`host_doctor`: `untested`) · ❌ not possible (`unsupported`; use an `ssh` guest). \* macOS guests are licensed only on Apple hardware (Apple's macOS SLA); on other hosts they need the user's explicit consent (`accept_license`). ¹ dockur needs KVM inside Docker, which Windows on ARM doesn't provide. The same matrix is in the README.

## Guest backends

| backend | used for | lifecycle | notes |
|---|---|---|---|
| `container` | ubuntu | docker | act runner image (with osmatrix's Rust layer when it's the default) + sshd; ssh port preferably 2221 (actual port in `env_status`) |
| `dockur` | windows, macos on Linux/Windows hosts | docker compose, disks in docker volumes `osmatrix-<guest>-storage` / `-golden` | needs KVM in containers; web viewer preferably 127.0.0.1:8006 (windows) / 8007 (macos); actual ports in `env_status` |
| `tart` | macos on Apple Silicon | tart clone/run | key installed automatically via tart guest agent |
| `qemu` | windows (Windows 11 on ARM) on Apple Silicon | host `qemu-system-aarch64` (HVF; KVM on arm64 Linux, TCG emulation elsewhere); install media prepared once with dockur's `windows-arm` image in Docker; disk under the osmatrix data dir `guests/<guest>/disk`, golden snapshot cloned (APFS `cp -c`) | needs `brew install qemu`; ssh forwarded to 127.0.0.1 (port in `env_status`); VNC display for `env_screenshot`/`env_input` |
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
# act_linux_image = "catthehacker/ubuntu:full-24.04"  # another image for Linux CI legs (see below)

[guests.windows]
memory = "12G"                   # min 4G; prefer env_configure, which checks the values
cpus = 6                         # min 2
disk = "96G"                     # dockur VMs; min 40G (Windows 11 ARM 64G, macOS 48G); grow only

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

`ssh_port`, `web_port` and `vnc_port` are preferences: a busy port is replaced by a free one when the guest starts, and `osmatrix status` shows the ports in use.

Labels decide which guest serves a `runs-on` label (globs, first match wins). Linux labels are served by act on the host.

`act_linux_image` defaults to `catthehacker/ubuntu:act-24.04`. With the default, Linux legs and the `ubuntu` guest use `osmatrix/ubuntu:act-24.04-<hash>`, a local layer over it that adds rustup stable with rustfmt and clippy (preinstalled on GitHub's ubuntu runners). It's built on first use, in a few minutes, and again when an osmatrix update changes its Dockerfile. Set another image to use it unchanged; it must exist locally or be pullable, and `ci_plan` warns on Linux legs that use Rust, since such an image may lack it.

## Guest-side layout

- Windows: user `osmatrix` (admin), sshd default shell `pwsh`, tools: Git (+bash), Node LTS, Python, PowerShell 7, act. Provisioning log: `C:\OEM\provision.log`.
- macOS: user `osmatrix` (admin, passwordless sudo, auto-login to the desktop), Xcode Command Line Tools, git, Node LTS, Python, act, jq; Homebrew on Apple Silicon only. Password in the host's osmatrix data dir (`guests/<name>/credentials.json`).
- Data dir (guest state, ssh key, credentials, logs, downloaded act): Linux `~/.local/share/osmatrix`.
