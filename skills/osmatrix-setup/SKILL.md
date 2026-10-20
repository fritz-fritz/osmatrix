---
name: osmatrix-setup
description: Check what this host can run (Docker, KVM, Apple Silicon) and create or repair osmatrix guests - set up Ubuntu, Windows and macOS environments unattended, obtain the user's consent for the macOS licence, register existing machines as ssh guests, read setup progress, and recover a guest stuck during boot or provisioning. Use on first use of osmatrix, when env_status reports a guest as absent or needs-ssh-setup, when host_doctor fails, or when the osmatrix MCP server or its tools are missing from the session.
---

# osmatrix-setup: host prerequisites, creating guests, troubleshooting

osmatrix gives agents local **guests** (an `ubuntu` container, `windows`/`macos` VMs, or any machine over ssh) and **local GitHub Actions runs** with act. This skill covers getting guests ready. Sibling skills in the same plugin: `osmatrix-ci` (run workflows locally) and `osmatrix-guests` (run commands, copy files, forward ports and drive the GUI inside a guest).

Use the **MCP tools** (`host_doctor`, `env_setup`, ...) when they are available: they are the supported interface. Tools that change guests or post outside this host (`env_setup`, `env_reset`, `env_snapshot`, `host_report_file`, …) carry annotations that let the client ask the user to confirm them.

**If the osmatrix MCP tools are missing from this session, tell the user before doing anything else.** Say that the osmatrix MCP server isn't loaded, so you'll use the `osmatrix` CLI instead, and suggest the likely fix: enable or restart the osmatrix MCP server in the client's MCP/plugin settings (a server that failed once may stay failed until it is toggled off and on). Then continue with the CLI: every tool has a matching command (see [references/reference.md](references/reference.md)); add `--json` for machine output. Check `osmatrix --version` first. If the command isn't found, tell the user osmatrix isn't installed and offer to run it from npm, as `npx osmatrix@0.3.0 <command>` or after `npm i -g osmatrix@0.3.0`. Running either downloads and executes the package, so wait for the user to agree; if they don't, stop.

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

Only start the guests a task needs: each VM takes its full RAM (8 GB by default). `host_doctor` lists each guest's `resources` (configured vs minimum and recommended) and notes sizing problems; resize with `env_configure`.

## Setting up a guest

`env_setup` (CLI: `osmatrix setup <guest>`) is fully automatic: it installs the OS, creates the user, enables ssh, provisions the toolchain and saves a golden snapshot. It runs in the background; poll `env_status` and read `setup.phase`. Expect 20–60 min for Windows or macOS; ubuntu takes seconds. `force: true` (`--force`) redoes setup of an existing guest.

- **macOS needs the user's consent once** (below).
- macOS guests on Linux/Windows hosts (dockur) are Intel (x86_64) and get Homebrew pinned to the last homebrew-core with Intel bottles (older formula versions than GitHub's runners; `homebrew` in the guest's config, see the reference); on Apple Silicon (tart) brew is set to the version GitHub's arm64 runner image for that macOS ships. Guests set up before osmatrix did this get it from `osmatrix provision <guest>` (CLI only, asks for the guest's sudo password unless it has passwordless sudo); then ask the user before saving it with `env_snapshot`. dockur guests get passwordless sudo during setup; for tart and `ssh` macOS guests, `osmatrix provision <guest> --passwordless-sudo` (CLI only) re-runs the toolchain install and lets `sudo` steps in workflows run as they do on GitHub's runners.
- Windows guests also get the MSVC Build Tools and Windows SDK (about 8 GB, 10–20 min more setup), which Rust and C/C++ builds need. A user who doesn't want them sets `msvc = false` on the guest before setup. Guests set up by older osmatrix versions lack them: `osmatrix provision <guest>` (CLI only) installs them, then `env_snapshot` keeps them in the golden snapshot.
- If setup reports an error, take an `env_screenshot` of the guest to see where it stopped, then tell the user.

<consent>
Installing macOS accepts Apple's macOS Software License Agreement (https://www.apple.com/legal/sla/), and running it on non-Apple hardware is outside that license. That's the user's decision, not yours: ask them, and pass `accept_license: true` only after they explicitly agree. Once given, it's remembered in config (`macos_eula_acknowledged`).
</consent>

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

The maintainers track which host/guest combinations work through GitHub issues. Offer a report **only when the result differs from the matrix**:

| guest's `compatibility` | worked | failed (in osmatrix: setup, boot, ssh, provisioning; not the user's code) |
|---|---|---|
| `tested` | no report | offer |
| `untested` | offer (moves it to tested) | offer |
| `unsupported` | offer (unexpected) | no report |

`host_report` returns `differsFromMatrix` for the outcome you pass; if it's `false`, don't mention a report at all. Offer at most once per guest and session, at a natural stopping point, not in the middle of urgent work.

<consent>
Filing posts to a public GitHub repository under the user's own account, so it needs their explicit yes for this report, after they have seen it. An earlier yes, or a yes for another guest, doesn't count. If they decline or don't answer, drop it.
</consent>

1. Build the report (it sends nothing): `host_report` (CLI: `osmatrix report <guest> --outcome works|partly|fails --notes "..."`). In `notes`, say what worked or failed and at which step (setup phase, boot, `env_exec`, CI leg), briefly. Never put secrets, IPs, hostnames, user names, or repository code or names in it. The report sanitizes the home directory, user name and host name, but check the rest yourself.
2. Show the user the `title` and `body` and ask whether to file it on github.com/fritz-fritz/osmatrix. If they want changes, build the report again with new `notes` and show it again.
3. Only after they agree: `host_report_file` with the report's `draft` (CLI: `osmatrix report-file <draft>`). It files exactly what they saw, with their `gh` login. When an open report with the same title exists (same host, guest and outcome), it adds a comment there instead of a duplicate. It returns only the issue number and URL; there's no need to read other reports. Without `gh`, it fails and gives the report's prefilled `url`: hand that to the user to submit themselves.
4. Tell the user the issue link.

## When a guest is stuck

- During boot or setup: `env_screenshot` shows the VM display; `env_input` can nudge a dialog (`"enter"`, clicks). If the user wants to watch, give them `env_viewer`'s URL (a browser page for every VM guest; no sign-in). Windows provisioning logs to `C:\OEM\provision.log` inside the guest.
- A guest you've polluted: `env_reset` restores the golden snapshot (discards everything changed inside).
- Broken beyond that: `osmatrix destroy <guest> --yes` (CLI only) then `env_setup` again.
- A setup that keeps failing on the same phase is usually a host problem: re-run `host_doctor` and report its output to the user. If it looks like an osmatrix problem, offer a compatibility report (above).
- `env_down` frees the VM's RAM when it's not needed.
