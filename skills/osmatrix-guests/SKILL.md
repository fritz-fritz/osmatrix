---
name: osmatrix-guests
description: Run commands, start background processes, copy files, forward ports in both directions, take screenshots and send keyboard/mouse input in local Ubuntu, Windows and macOS guests. Use when code must be run or debugged on another OS ("test this on Windows/macOS"), when a dev server inside a guest must be reached from host tools (browser, curl, Playwright), when a guest needs a service running on the host, or when a GUI app inside a VM must be driven.
---

# osmatrix-guests: work inside Ubuntu, Windows and macOS guests

osmatrix gives agents local **guests** (an `ubuntu` container, `windows`/`macos` VMs, or any machine over ssh) and **local GitHub Actions runs** with act. This skill covers working inside a guest. Sibling skills in the same plugin: `osmatrix-ci` (run workflows locally) and `osmatrix-setup` (host checks, creating guests, troubleshooting).

Use the **MCP tools** (`env_exec`, `env_forward`, ...) when they are available: they are the supported interface, and their safety annotations let the client ask for confirmation where it matters.

**If the osmatrix MCP tools are missing from this session, tell the user before doing anything else.** Say that the osmatrix MCP server isn't loaded, so you'll use the `osmatrix` CLI instead, and suggest the likely fix: enable or restart the osmatrix MCP server in the client's MCP/plugin settings (a server that failed once may stay failed until it is toggled off and on). Then continue with the CLI: every tool has a matching command (see [references/reference.md](references/reference.md)); add `--json` for machine output. Check `osmatrix --version` first; if the command isn't found, `npx -y osmatrix@0 <command>` works once osmatrix is published on npm. Otherwise tell the user it isn't installed, and stop.

Local paths you pass to tools (`env_push`) must be **absolute host paths**: the MCP server's working directory may be the plugin cache, not the user's checkout.

## Guests and their shells

Check `env_status` (CLI: `osmatrix status`) for what this host has:

| guest | what it is | shell for `env_exec` |
|---|---|---|
| `ubuntu` | container from the same image act uses for `ubuntu-*` jobs | bash |
| `windows` | Windows Server VM (dockur/QEMU); Windows 11 on ARM on Apple Silicon and arm64 hosts | PowerShell 7 (`pwsh`) |
| `macos` | macOS VM (dockur on Linux, tart on Apple Silicon) | zsh/bash |

A guest must be `ready`. `stopped` → `env_up` (VMs take 1–3 min to boot; leave them running while you iterate). `absent`, `needs-ssh-setup`, or a `detail` saying "not set up" → follow `osmatrix-setup`. **Don't start VMs you don't need.**

## Running commands

- `env_exec` — one command per call; returns `exitCode`, `stdout`, `stderr`. Default timeout 600 s (`timeout_seconds` up to 3600). `cwd` is relative to the guest user's home; repos synced by `ci_run`/`env_push` are at `work/<name>`.
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
