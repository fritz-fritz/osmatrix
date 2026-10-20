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
| `env_push` | `osmatrix push <guest> <local> [remoteDir] [--clean] [--all] [--allow-sensitive]` |
| `env_pull` | `osmatrix pull <guest> <remotePath> [localDir] [--allow-sensitive]` |
| `env_forward` | `osmatrix forward <guest> <guestPort>[:<hostPort>]` · `osmatrix forward <guest> --reverse <hostPort>[:<guestPort>]` |
| `env_forwards` | `osmatrix forwards [guest]` |
| `env_unforward` | `osmatrix unforward <guest> [port] [--all]` |
| `env_viewer` | `osmatrix viewer <guest>` |
| `env_screenshot` | `osmatrix screenshot <guest> -o shot.png` |
| `env_input` | `osmatrix input <guest> [--click x,y] [--text "..."] [--keys enter ctrl+a]` |

CLI-only: `osmatrix ssh <guest>` (prints an ssh command line).

## Guest-side layout

- Repos synced by `ci_run`/`env_push`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`). `ci_run` checks the tree out with Git in the guest (CRLF text files on Windows, as on GitHub); `env_push` copies files byte for byte (without `.git`), so a pushed tree keeps the host's line endings. The next `ci_run` resets `work/<name>` to its own checkout.
- Windows: user `osmatrix` (admin, as on GitHub's Windows runners), sshd default shell `pwsh`, tools: Git (+bash), Node LTS, Python, PowerShell 7, act (stock; CI legs run osmatrix's patched act from `~/.osmatrix/bin`), VS 2022 Build Tools C++ workload with the Windows SDK (unless the guest sets `msvc = false`; guests set up with older osmatrix versions lack it until `osmatrix provision <guest>`). Provisioning log: `C:\OEM\provision.log`.
- macOS: user `osmatrix` (admin, passwordless sudo as on GitHub's macOS runners, which workflows' `sudo` steps expect; auto-login to the desktop), Xcode Command Line Tools, git, Node LTS, Python, act (stock; CI legs run osmatrix's patched act from `~/.osmatrix/bin`), jq; Homebrew (on Apple Silicon at the brew version of GitHub's arm64 runner image; on Intel pinned to the last homebrew-core with Intel bottles, so formula versions are older than on GitHub's runners). `/Users/runner/hostedtoolcache` exists and belongs to that user, because the macOS packages `actions/setup-python` and the other `actions/*-versions` installers download install there, as on GitHub's runners (`ci_run` creates it before each macOS leg on guests set up without it). osmatrix keeps the guest's password in its data dir; you don't need it, so don't read or print it.
- ubuntu: the act runner image plus sshd (with the default image, also rustup with rustfmt and clippy at the Rust version of GitHub's ubuntu24 runner image). When that image changes, a guest without a golden snapshot is recreated on its next start; one with a snapshot keeps it, and `env_status`'s `detail` gives the command to recreate it, which deletes the guest's changes, so ask the user first; ssh port preferably 2221 (actual port in `env_status`).
- VM web viewers: dockur's preferably at 127.0.0.1:8006 (windows) / 8007 (macos); qemu and tart guests get one from osmatrix on a free port, started by `env_viewer` and stopped by `env_down`. Always take the URL from `env_viewer`.
