---
name: osmatrix
description: Run and debug code on local Ubuntu, Windows and macOS environments, and run a repo's GitHub Actions workflows (including OS matrices) locally with act before pushing. Use when a change touches OS-specific code (paths, shells, line endings, file locking, native deps, CI config), when a GitHub Actions leg failed on Windows/macOS/Linux, when asked to "run CI locally" or "test on Windows/macOS", or when an app running inside one of those OSes must be reached from the host (port forwarding).
---

# osmatrix: local OS guests + local GitHub Actions

osmatrix gives you three kinds of **guests** (check `env_status` for what this host has):

| guest | what it is | shell for `env_exec` |
|---|---|---|
| `ubuntu` | container from the same image act uses for `ubuntu-*` jobs | bash |
| `windows` | Windows Server VM (dockur/QEMU) | PowerShell 7 (`pwsh`) |
| `macos` | macOS VM (dockur on Linux, tart on Apple Silicon) | zsh/bash |

and **local CI**: workflow matrices expanded into legs. `ubuntu-*` legs run with act on the host's Docker; `windows-*` / `macos-*` legs run act *inside* the matching VM (host mode), after syncing the repo into it.

Use the **MCP tools** (`ci_plan`, `env_exec`, ...) when they are available: they are the supported interface, and their safety annotations let the client ask for confirmation where it matters.

**If the osmatrix MCP tools are missing from this session, tell the user before doing anything else.** Say that the osmatrix MCP server isn't loaded, so you'll use the `osmatrix` CLI instead, and suggest the likely fix: enable or restart the osmatrix MCP server in the client's MCP/plugin settings (a server that failed once may stay failed until it is toggled off and on). Then continue with the CLI: every tool has a matching command (see [reference.md](reference.md)); add `--json` for machine output. Check `osmatrix --version` first; if the command isn't found, `npx -y osmatrix@0 <command>` works once osmatrix is published on npm. Otherwise tell the user it isn't installed, and stop.

## Before you start

1. Resolve the repository's absolute host path from the current task. Pass it as `repo` to every `ci_*` tool: the MCP server's working directory may be the plugin cache, not the user's checkout. Run `host_doctor` on first use to check prerequisites, then `env_status` (CLI: `osmatrix status`). States: `absent`, `stopped`, `booting`, `needs-ssh-setup`, `ready`.
2. VM guests are slow to boot (1–3 min; first ever boot of Windows installs the OS, 20–60 min). **Don't start VMs you don't need**, and leave a VM running while you iterate.
3. A guest that has never been set up (`absent`, or status `detail` says "not set up") is made ready with **`env_setup`** (CLI: `osmatrix setup <guest>`). It is fully automatic: it installs the OS, creates the user, enables ssh, provisions the toolchain and saves a golden snapshot. It runs in the background; poll `env_status` and read `setup.phase`. Expect 20–60 min for Windows or macOS; ubuntu takes seconds.
   - **macOS needs the user's consent once.** Installing macOS accepts Apple's macOS Software License Agreement (https://www.apple.com/legal/sla/), and running it on non-Apple hardware is outside that license. Ask the user and pass `accept_license: true` only after they explicitly agree. Never assume consent. Once given, it's remembered in config.
   - If setup reports an error, take an `env_screenshot` of the guest to see where it stopped, then tell the user.
4. `host_doctor` explains why a guest can't run on this host (no KVM, not Apple Silicon, ...). Guests a host can't run may be configured as `ssh` guests pointing at another machine.

## Local CI loop (preferred before pushing)

1. **Plan**: `ci_plan` (`osmatrix ci plan`). Shows every leg, where it runs, and warnings for things act can't reproduce. Starts nothing.
2. **Run**: `ci_run` (`osmatrix ci run`). Returns a run id immediately. Narrow it as much as you can:
   - `only: ["windows"]` / `--only windows` (targets: `linux`, `windows`, `macos`, or guest names)
   - `job`, `workflow`, `matrix: {node: "22"}` / `-m node=22`
   - Run uncommitted work as-is: the working tree (respecting `.gitignore`) is what gets tested.
   - Tag- or release-triggered workflows: pass `event_payload`, e.g. `{"ref": "refs/tags/v1.2.3"}` (CLI: `--event-file`), so `github.ref`/`GITHUB_REF_NAME` look like a real tag push. Steps that need GitHub's OIDC token (attestations, trusted publishing, creating releases) can't run locally; workflows usually guard them with `if: ${{ !env.ACT }}`.
3. **Poll**: `ci_status` every 30–60 s until `state: done`. Each failed leg has `failedStep` and a log `tail`.
   - Concurrent runs are safe: a leg that needs an act job container or a guest another run is using stays `pending` with `waitingFor` naming that run, and starts when it's free. act names job containers after the workflow name and job id only, so this applies across checkouts too.
4. **Dig in**: `ci_logs` with `leg` (id or substring), `grep`, `tail`.
5. **Reproduce interactively** in the same guest: the synced repo is at `work/<repo-name>` (relative to the guest user's home).
   - `env_exec {guest: "windows", cwd: "work/myrepo", command: "npm test"}`
6. **Fix on the host**, then re-run **only the failing leg(s)**. A final full `ci_run` before pushing is a good habit.

Secrets: put `KEY=value` lines in `.osmatrix/secrets` (or act's default `.secrets`) in the repo; they're passed with `--secret-file` and never printed by osmatrix. `GITHUB_TOKEN` is not provided automatically — add it there if a workflow needs it (e.g. `gh auth token`).

### Reading results honestly

Local green is strong evidence, not proof. Report anything that didn't run or differs from GitHub:
- `ci_plan` warnings: `services:` on non-Linux legs, OIDC (`id-token`), `needs:` that cross OSes (act runs the needed job inside the same environment), matrices built from expressions, remote reusable workflows (skipped).
- macOS guests on Linux/Windows hosts are Intel (x86_64) and have no Homebrew (it dropped Intel support): steps that `brew install` fail there. On Apple Silicon hosts (tart) Homebrew is available.
- Guests are leaner than GitHub-hosted images: preinstalled SDKs (Xcode versions, Visual Studio, Android SDK, many language versions) may be missing. Prefer `setup-*` actions; if a tool is missing in a guest, say so instead of concluding the code is broken.
- macOS legs: `sudo` steps only work if the guest was provisioned with `--passwordless-sudo` (GitHub's runners allow passwordless sudo). A sudo failure there is an environment gap, not a code bug.
- Windows legs run in host mode inside the VM: `shell: bash` steps need Git Bash (installed), Docker-based actions don't work there.

## Working inside a guest

- `env_exec` — one command per call; returns `exitCode`, `stdout`, `stderr`. Default timeout 600 s (`timeout_seconds` up to 3600).
- **Long-running processes** (dev servers, watchers): `env_exec` with `background: true` (CLI: `exec --background`). It returns `pid`, a `log` file path and a `stop` command (kills the whole process tree). Don't use `&`, `nohup` or `Start-Process` yourself — on Windows anything started inside the ssh session is killed when the call returns. Read the log with a normal `env_exec` (`Get-Content <log>` / `tail -n 50 <log>`).
- `env_push` / `env_pull` — copy files. Directories that are git work trees respect `.gitignore`; default destination `work/<basename>`.
- Windows commands are **PowerShell**: use `;` not `&&` on Windows PowerShell 5, `$env:VAR`, `Get-ChildItem`; `cmd /c "..."` when you need cmd semantics.

## Reaching guest apps from the host (port forwarding)

Use this when an app runs **inside** a guest but you want to use **host** tools on it: a browser / Playwright MCP, `curl`, an API client, a debugger, or the host's test runner.

1. Start the app in the guest with `env_exec` + `background: true`, listening on `127.0.0.1` or `0.0.0.0` (not a LAN IP) — e.g. `npm run dev -- --port 3000 --host 127.0.0.1`. Check its `log` until it says it is listening.
2. `env_forward {guest: "windows", guest_port: 3000}` → returns `url` (e.g. `http://127.0.0.1:3000`) and a `use` line. Ports you request are preferences: if the host port is busy another free one is chosen and `note` says so. **Always use the returned `url`/`hostPort`, never the number you asked for.** Pass `host_port` only to prefer a specific one.
3. Use the URL from host tools. Forwards persist across tool calls until removed.
4. Clean up: run the `stop` command from step 1 with `env_exec`, then `env_unforward {guest, port}` (or `all: true`). `env_down` also removes a guest's forwards. `env_forwards` lists what's open.

The other direction — the guest needs a service on the host (a database, a dev API, a mock server):
- `env_forward {guest, host_port: 5432, guest_port: 5432, reverse: true}` → inside the guest connect to the returned `guestPort` (usually 5432; another port if 5432 is busy inside the guest).

Everything binds to 127.0.0.1 only; nothing is exposed to the network. Forwards go over ssh, so they work for every guest type and don't restart the VM.

**Never hardcode ports.** Guest ssh/web-viewer/VNC ports are assigned when a guest starts (configured values are only preferences) and can change after `env_up`/`env_reset`; forwards end when a guest stops or restarts. After a restart, re-create forwards and re-read URLs from the tool results or `env_status` (`ports`, `urls`, `forwards`).

## GUI (VM guests)

`env_screenshot` returns a PNG of the VM display; `env_input` sends keys (`"ctrl+alt+delete"`, `"cmd+space"`, `"enter"`), text, clicks and scrolls in screenshot pixel coordinates. Use for GUI apps or to inspect a VM stuck during boot. Take a screenshot after input to confirm the effect. Prefer `env_exec` whenever a command-line route exists.

## Housekeeping

- `env_down` when you're done with a VM (frees 8 GB RAM each). Mention to the user if you leave one running.
- `env_reset` restores the golden snapshot — use it instead of debugging a guest you've polluted. It discards everything changed inside the guest.
- `env_snapshot` overwrites the golden snapshot. Only do this when the user asks (e.g. after installing a toolchain they want to keep).
- Run artifacts and logs live in `<repo>/.osmatrix/runs/<id>/` (git-ignored automatically).
