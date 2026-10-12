---
name: osmatrix-setup
description: Check what this host can run (Docker, KVM, Apple Silicon) and create or repair osmatrix guests - set up Ubuntu, Windows and macOS environments unattended, obtain the user's consent for the macOS licence, register existing machines as ssh guests, read setup progress, and recover a guest stuck during boot or provisioning. Use on first use of osmatrix, when env_status reports a guest as absent or needs-ssh-setup, when host_doctor fails, or when the osmatrix MCP server or its tools are missing from the session.
---

# osmatrix-setup: host prerequisites, creating guests, troubleshooting

osmatrix gives agents local **guests** (an `ubuntu` container, `windows`/`macos` VMs, or any machine over ssh) and **local GitHub Actions runs** with act. This skill covers getting guests ready. Sibling skills in the same plugin: `osmatrix-ci` (run workflows locally) and `osmatrix-guests` (run commands, copy files, forward ports and drive the GUI inside a guest).

Use the **MCP tools** (`host_doctor`, `env_setup`, ...) when they are available: they are the supported interface, and their safety annotations let the client ask for confirmation where it matters.

**If the osmatrix MCP tools are missing from this session, tell the user before doing anything else.** Say that the osmatrix MCP server isn't loaded, so you'll use the `osmatrix` CLI instead, and suggest the likely fix: enable or restart the osmatrix MCP server in the client's MCP/plugin settings (a server that failed once may stay failed until it is toggled off and on). Then continue with the CLI: every tool has a matching command (see [references/reference.md](references/reference.md)); add `--json` for machine output. Check `osmatrix --version` first; if the command isn't found, `npx -y osmatrix@0 <command>` works once osmatrix is published on npm. Otherwise tell the user it isn't installed, and stop.

## First use

1. `host_doctor` (CLI: `osmatrix doctor`) checks prerequisites and explains why a guest can't run on this host (no Docker, no KVM, not Apple Silicon, ...). Each guest also has a `compatibility`: `tested`, `untested` (supported, but nobody has reported on this kind of host yet) or `unsupported` (see the matrix in [references/reference.md](references/reference.md)). Mention an `untested` guest to the user before relying on it. Guests a host can't run may be configured as `ssh` guests pointing at another machine (below).
2. `env_status` (`osmatrix status`) lists the guests and their state.
3. **Inside a devcontainer, Codespace or against a remote Docker daemon**, `host_doctor` reports `nesting`. If the daemon is outside this environment (Docker-outside-of-Docker), local guests are refused because their ssh ports and bind mounts land on the Docker host, not here. Don't work around the refusal. Tell the user, and offer two options: an `ssh` guest (a real machine; works from anywhere), or running osmatrix on the Docker host. Linux CI legs still run, but artifact/cache steps may fail there. See "Devcontainers and remote Docker" in [references/reference.md](references/reference.md).

## Guest states

| state | meaning | what to do |
|---|---|---|
| `absent` | never set up (or `detail` says "not set up") | `env_setup` |
| `stopped` | set up, not running | `env_up` (VMs: 1–3 min) |
| `booting` | starting | poll `env_status` |
| `needs-ssh-setup` | `ssh` guest without key access yet | `osmatrix setup-ssh <guest> --user u` (CLI only; asks for the password once) |
| `ready` | usable | use `osmatrix-guests` / `osmatrix-ci` |

Only start the guests a task needs: each VM takes 8 GB RAM.

## Setting up a guest

`env_setup` (CLI: `osmatrix setup <guest>`) is fully automatic: it installs the OS, creates the user, enables ssh, provisions the toolchain and saves a golden snapshot. It runs in the background; poll `env_status` and read `setup.phase`. Expect 20–60 min for Windows or macOS; ubuntu takes seconds. `force: true` (`--force`) redoes setup of an existing guest.

- **macOS needs the user's consent once.** Installing macOS accepts Apple's macOS Software License Agreement (https://www.apple.com/legal/sla/), and running it on non-Apple hardware is outside that license. Ask the user and pass `accept_license: true` only after they explicitly agree. Never assume consent. Once given, it's remembered in config (`macos_eula_acknowledged`).
- macOS guests on Linux/Windows hosts (dockur) are Intel (x86_64) and have no Homebrew; on Apple Silicon (tart) Homebrew is available. dockur guests get passwordless sudo during setup; for tart and `ssh` macOS guests, `osmatrix provision <guest> --passwordless-sudo` (CLI only) re-runs the toolchain install and lets `sudo` steps in workflows run as they do on GitHub's runners.
- If setup reports an error, take an `env_screenshot` of the guest to see where it stopped, then tell the user.

## ssh guests (an existing machine)

Any reachable machine — a real Mac on the network, a Windows box, a cloud VM — can serve as a guest. Add it to the config (`osmatrix config` shows the file path):

```toml
[guests.mac_mini]
os = "macos"
backend = "ssh"
host = "mac-mini.lan"
user = "ci"
identity = "~/.ssh/id_ed25519"   # optional; osmatrix's own key is used after setup-ssh
labels = ["macos-*"]             # which runs-on labels it serves
```

`up`/`down` are no-ops for ssh guests and `reset`/`snapshot` are unsupported. Host keys are checked (trust on first use). See [references/reference.md](references/reference.md) for every config option.

## Compatibility reports

The maintainers track which host/guest combinations work through GitHub issues. Offer a report **only when the result differs from the matrix**, and **never file one without the user's explicit yes**:

| guest's `compatibility` | worked | failed (in osmatrix: setup, boot, ssh, provisioning; not the user's code) |
|---|---|---|
| `tested` | no report | offer |
| `untested` | offer (moves it to tested) | offer |
| `unsupported` | offer (unexpected) | no report |

`host_report` returns `differsFromMatrix` for the outcome you pass; if it's `false`, don't mention a report at all. Offer at most once per guest and session, at a natural stopping point, not in the middle of urgent work.

1. Build the report (it sends nothing): `host_report` (CLI: `osmatrix report <guest> --outcome works|partly|fails --notes "..."`). In `notes`, say what worked or failed and at which step (setup phase, boot, `env_exec`, CI leg), briefly. Never put secrets, IPs, hostnames, user names, or repository code or names in it. The report sanitizes the home directory, user name and host name, but check the rest yourself.
2. Show the user the `title` and `body` and ask whether to file it on github.com/fritz-fritz/osmatrix. Let them edit or decline.
3. Only after they agree: check for an existing report first (`gh issue list --repo fritz-fritz/osmatrix --label compatibility --search "<host row> <guest>"`). If one exists, offer to add a comment there instead (`gh issue comment <n> --body-file <file>`). Otherwise write `body` to a temporary file and run `gh issue create --repo fritz-fritz/osmatrix --label compatibility --title "<title>" --body-file <file>`. If `gh` isn't installed or authenticated, give the user the report's `url` instead: it opens the issue form prefilled, for them to submit.
4. Tell the user the issue link.

## When a guest is stuck

- During boot or setup: `env_screenshot` shows the VM display; `env_input` can nudge a dialog (`"enter"`, clicks). Windows provisioning logs to `C:\OEM\provision.log` inside the guest.
- A guest you've polluted: `env_reset` restores the golden snapshot (discards everything changed inside).
- Broken beyond that: `osmatrix destroy <guest> --yes` (CLI only) then `env_setup` again.
- A setup that keeps failing on the same phase is usually a host problem: re-run `host_doctor` and report its output to the user. If it looks like an osmatrix problem, offer a compatibility report (above).
- `env_down` frees the VM's RAM when it's not needed.
