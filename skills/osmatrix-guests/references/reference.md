# osmatrix-guests reference

## CLI ↔ MCP tool map

Every command accepts `--json`. Exit code is non-zero on errors (for `exec`, the guest command's exit code).

| MCP tool | CLI |
|---|---|
| `env_status` | `osmatrix status [guest]` |
| `env_up` | `osmatrix up <guest> [--wait [sec]]` |
| `env_down` | `osmatrix down <guest>` |
| `env_configure` | `osmatrix configure <guest> [--cpus n] [--memory 8G] [--disk 96G] [--apply]` |
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

CLI-only: `osmatrix ssh <guest>` (prints an ssh command line).

## Guest-side layout

- Repos synced by `ci_run`/`env_push`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`).
- Windows: user `osmatrix` (admin), sshd default shell `pwsh`, tools: Git (+bash), Node LTS, Python, PowerShell 7, act. Provisioning log: `C:\OEM\provision.log`.
- macOS: user `osmatrix` (admin, passwordless sudo, auto-login to the desktop), Xcode Command Line Tools, git, Node LTS, Python, act, jq; Homebrew (on Apple Silicon at the brew version of GitHub's arm64 runner image; on Intel pinned to the last homebrew-core with Intel bottles, so formula versions are older than on GitHub's runners). Password in the host's osmatrix data dir (`guests/<name>/credentials.json`).
- ubuntu: the act runner image plus sshd; ssh port preferably 2221 (actual port in `env_status`).
- VM web viewers (dockur): preferably 127.0.0.1:8006 (windows) / 8007 (macos); actual ports and URLs in `env_status`.
