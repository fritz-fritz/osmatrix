# osmatrix reference

## CLI ↔ MCP tool map

Every command accepts `--json`. Exit code is non-zero on errors (and for `exec`, the guest command's exit code; for `ci run --wait`, failure of any leg).

| MCP tool | CLI |
|---|---|
| `host_doctor` | `osmatrix doctor` |
| `env_status` | `osmatrix status [guest]` |
| `env_setup` | `osmatrix setup <guest> [--accept-license] [--background] [--force]` |
| `env_up` | `osmatrix up <guest> [--wait [sec]]` |
| `env_down` | `osmatrix down <guest>` |
| `env_reset` | `osmatrix reset <guest> [--wait [sec]]` |
| `env_snapshot` | `osmatrix snapshot <guest>` |
| `env_exec` | `osmatrix exec <guest> [--cwd dir] [--timeout sec] [--background] -- <command...>` |
| `env_push` | `osmatrix push <guest> <local> [remoteDir] [--clean] [--all]` |
| `env_pull` | `osmatrix pull <guest> <remotePath> [localDir]` |
| `env_forward` | `osmatrix forward <guest> <guestPort>[:<hostPort>]` · `osmatrix forward <guest> --reverse <hostPort>[:<guestPort>]` |
| `env_forwards` | `osmatrix forwards [guest]` |
| `env_unforward` | `osmatrix unforward <guest> [port] [--all]` |
| `env_screenshot` | `osmatrix screenshot <guest> -o shot.png` |
| `env_input` | `osmatrix input <guest> [--click x,y] [--text "..."] [--keys enter ctrl+a]` |
| `ci_plan` | `osmatrix ci plan [--repo dir] [-W wf] [-j job] [--only t...] [-m k=v...]` |
| `ci_run` | `osmatrix ci run [same filters] [--wait] [--event e] [--event-file payload.json] [--secret-file f] [--timeout min]` |
| `ci_status` | `osmatrix ci status [runId] [--repo dir] [--full]` |
| `ci_logs` | `osmatrix ci logs <leg> [--run id] [--tail n] [--grep re]` |

CLI-only: `osmatrix init`, `config`, `install-act`, `install-agents`, `ssh <guest>` (prints an ssh command line), `setup-ssh <guest> --user u` (ssh guests only accepting passwords), `provision <guest>` (re-run the macOS toolchain install), `destroy <guest> --yes`, `ci runs`.

## Guest backends

| backend | used for | lifecycle | notes |
|---|---|---|---|
| `container` | ubuntu | docker | act runner image + sshd; ssh port preferably 2221 (actual port in `env_status`) |
| `dockur` | windows, macos on Linux/Windows hosts | docker compose, disks in docker volumes `osmatrix-<guest>-storage` / `-golden` | needs KVM in containers; web viewer preferably 127.0.0.1:8006 (windows) / 8007 (macos); actual ports in `env_status` |
| `tart` | macos on Apple Silicon | tart clone/run | key installed automatically via tart guest agent |
| `ssh` | any existing machine | none (up/down are no-ops; reset/snapshot unsupported) | host keys checked (trust on first use) |

## Devcontainers and remote Docker

Local guests are containers that osmatrix reaches over ssh on ports Docker publishes on `127.0.0.1`. The Windows guest also gets its install folder through a bind mount. Both need the Docker daemon to share osmatrix's loopback and filesystem.

`host_doctor` detects a devcontainer, Codespace, other container or remote `DOCKER_HOST`. In those cases it probes the daemon and reports `nesting.docker.{files,loopback}`.

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

[guests.windows]
memory = "12G"
cpus = 6

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

## Guest-side layout

- Repos synced by `ci_run`/`env_push`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`).
- Windows: user `osmatrix` (admin), sshd default shell `pwsh`, tools: Git (+bash), Node LTS, Python, PowerShell 7, act. Provisioning log: `C:\OEM\provision.log`.
- macOS: user `osmatrix` (admin, passwordless sudo, auto-login to the desktop), Xcode Command Line Tools, git, Node LTS, Python, act, jq; Homebrew on Apple Silicon only. Password in the host's osmatrix data dir (`guests/<name>/credentials.json`).
