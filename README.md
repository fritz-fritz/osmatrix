<img src="assets/logo.svg" alt="osmatrix logo" height="100px">

# osmatrix

[![CI](https://img.shields.io/github/actions/workflow/status/fritz-fritz/osmatrix/ci.yml?branch=main&label=CI)](https://github.com/fritz-fritz/osmatrix/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/osmatrix)](https://www.npmjs.com/package/osmatrix)
[![skills.sh](https://skills.sh/b/fritz-fritz/osmatrix)](https://skills.sh/fritz-fritz/osmatrix)
[![license](https://img.shields.io/github/license/fritz-fritz/osmatrix)](LICENSE)
[![Socket Security](https://badge.socket.dev/npm/package/osmatrix)](https://socket.dev/npm/package/osmatrix)

<p align="center"><img src="assets/social-preview.svg" alt="osmatrix social card" width="65%"></p>

Local **Ubuntu, Windows and macOS** environments plus **local GitHub Actions matrix runs** for coding agents (Claude Code, Cursor, Codex) and for humans. It's one CLI that also serves as an MCP server, and it ships with four agent skills: three for the work and one map.

- **Guests**: `exec`, file push/pull, **port forwarding** (both directions), screenshots and keyboard/mouse input, and a browser viewer for every VM guest that opens on its desktop without a sign-in.
- **Local CI**: `ci plan` / `ci run` expand workflow matrices. `ubuntu-*` legs run with [act](https://github.com/nektos/act) on the host's Docker. `windows-*` and `macos-*` legs run act **inside** the matching VM, so a Windows leg really runs on Windows.
- **Cross-platform hosts**: Linux, Windows (WSL2) and macOS; see the [compatibility matrix](#compatibility-matrix). Guests this host can't run can be any machine you can reach over ssh.

```
Claude Code / Cursor / Codex
  ├─ skills (SKILL.md ×4: osmatrix, the map; -setup, -guests, -ci, the work): when and how
  └─ MCP server (osmatrix mcp, stdio) ─┐
human / scripts ── osmatrix CLI ───────┴─ core ─┬─ ubuntu  : act runner image + sshd (container)
                                               ├─ windows : dockur/windows VM (KVM) | host QEMU (Macs, Windows on ARM)
                                               ├─ macos   : dockur/macos VM (KVM) | host QEMU (Intel Macs) | tart (Apple Silicon)
                                               └─ any     : existing machine over ssh
```

## Install

### As an agent plugin (recommended)

The repository is a plugin marketplace for each client, and its root is the plugin. The plugin bundles the skills and the MCP server, which runs from npm as `npx -y osmatrix@0 mcp`, pinned to the current major version.

| Client | Install |
|---|---|
| Claude Code | `/plugin marketplace add fritz-fritz/osmatrix`, then `/plugin install osmatrix@fritztech` |
| Codex / ChatGPT | `codex plugin marketplace add fritz-fritz/osmatrix`, then enable **osmatrix** under Plugins |
| Cursor | **Dashboard → Plugins → Team Marketplaces → Add Marketplace → Import from Repo** |
| Skills only, any agent (via [skills.sh](https://skills.sh)) | `npx skills add fritz-fritz/osmatrix` |

Requirements:

- Node.js 22.18+ with npm.
- Docker.
- KVM for the Windows/macOS VMs; on Macs and Windows on ARM, QEMU for Windows; on Apple Silicon, tart for macOS (see the [compatibility matrix](#compatibility-matrix)).

The plugin adds four skills, so an agent loads only the guidance a task needs:

| Skill | Loads when the task is... |
|---|---|
| `osmatrix` | unclear which skill applies, or what osmatrix can do: a short map to the other three |
| `osmatrix-ci` | running a repo's GitHub Actions workflows locally, debugging a leg that failed on another OS |
| `osmatrix-guests` | running or debugging code inside a Ubuntu/Windows/macOS guest, reaching a guest app from the host (port forwarding), driving a VM's GUI |
| `osmatrix-setup` | first use, checking the host, creating or repairing guests, adding an ssh guest |

Then try: "Check which operating systems this host supports, then plan this repository's CI." Planning starts no guests. For repository tools, the agent passes your checkout's absolute path explicitly.

> If the osmatrix MCP server shows as failed after you install or switch plugins, toggle it off and on in your client's MCP settings. Some clients, Cursor for one, remember a server's failure by name even across reinstalls.

### As a CLI (npm)

```bash
npm install -g osmatrix
osmatrix init                  # config + ssh key + host check
osmatrix install-agents        # register the MCP server + skills with Claude Code, Cursor and Codex
```

`install-agents` registers in your home after a global install, and in the project when osmatrix is one of its dependencies (`npm i -D osmatrix`, then `npx osmatrix install-agents`). `--scope user|project` overrides the detection, `--dry-run` shows the plan, `--uninstall` reverses it.

| | Your home (global install) | The project (dependency) |
|---|---|---|
| Claude Code | `claude mcp add --scope user`, or `~/.claude.json` when the `claude` CLI isn't on PATH; skills in `~/.claude/skills/` | `.mcp.json` (Claude Code asks once to approve it); skills in `.claude/skills/` |
| Cursor | `~/.cursor/mcp.json`; skills in `~/.agents/skills/` | `.cursor/mcp.json`; skills in `.agents/skills/` |
| Codex | `~/.codex/config.toml` `[mcp_servers.osmatrix]`; skills in `~/.agents/skills/` | `.codex/config.toml` (read in trusted projects only); skills in `.agents/skills/` |

In a project the server runs `npx -y osmatrix@<major> mcp`, which uses the project's own copy, and the skills are relative links into `node_modules/osmatrix` (`--copy-skill` copies them instead), so the files can be committed. Skill directories an earlier osmatrix created under those names (the single `osmatrix` skill of 0.1, say) are replaced; a directory osmatrix didn't create is left alone and reported.

Options:

- `--claude`, `--cursor` or `--codex` limits it to one agent.
- `--npx` registers `npx -y osmatrix@<major> mcp` instead of the local path.
- `--dry-run` previews the changes.
- `--uninstall` removes them.
- A backup of every file it edits is written next to it as `*.osmatrix.bak`.

## Host requirements

### Compatibility matrix

| Host | ubuntu | windows | macos |
|---|---|---|---|
| Linux x86_64 + KVM | ✅ container | ✅ dockur: Windows Server 2025 | ✅\* dockur: macOS 15 (Intel) |
| Linux arm64 + KVM | 🧪 container | 🧪 dockur: Windows 11 on ARM | ❌ |
| Windows 11 x86_64 + Docker Desktop (WSL2 with nested virtualization) | 🧪 container | 🧪 dockur: Windows Server 2025 | 🧪\* dockur: macOS 15 (Intel), best effort |
| Windows 11 arm64 | 🧪 container | 🧪 QEMU + Windows Hypervisor Platform: Windows 11 on ARM | ❌ |
| macOS Apple Silicon | 🧪 container | 🧪 QEMU + Hypervisor.framework: Windows 11 on ARM | 🧪\* tart |
| macOS Intel | 🧪 container | 🧪 QEMU + Hypervisor.framework: Windows Server 2025 | 🧪\* QEMU + Hypervisor.framework: macOS 15 (Intel) |

- ✅ supported and tested. 🧪 supported by the code but not yet tested on that kind of host (CI covers install, the MCP server and planning on Windows and macOS, but GitHub's runners can't start guests there); please tell us how it went with a [compatibility report](https://github.com/fritz-fritz/osmatrix/issues/new?template=compatibility.yml). `osmatrix report <guest> --outcome works|partly|fails` fills one in (sanitized, sends nothing), `osmatrix report-file <draft>` files it with your `gh` login, and agents offer to file one, with your consent, when a result differs from this matrix (an untested combination either way, or a tested one that fails). ❌ not possible on that host.
- Any cell marked ❌ can still be served by an `ssh` guest: an existing machine you can reach over ssh (see [Configuration](#configuration)).
- \* **macOS guests are licensed only on Apple hardware.** Apple's [macOS Software License Agreement](https://www.apple.com/legal/sla/) permits macOS virtual machines only on Apple-branded computers, so only the Mac rows are within the licence. On other hosts the dockur macOS guest works technically, but running it is outside Apple's terms; osmatrix asks you to accept the licence before installing it (below).
- macOS guests on arm64 Linux or Windows hosts aren't possible: Apple Silicon macOS only boots on the virtual machine Apple's Virtualization.framework provides (QEMU's copy of it, `vmapple`, needs macOS's own frameworks too), and the Intel macOS image is x86_64-only (emulating it is 14–27x slower than KVM in our measurements).
- On Intel Macs, the macOS guest is dockur's Intel macOS (OpenCore and the recovery image, prepared once with dockur's `macos` image in Docker), run by the Mac's own QEMU (`brew install qemu`) with Hypervisor.framework.

On hosts whose Docker has no KVM, the Windows guest runs on the host's own QEMU instead of dockur's container:

- **Macs** use Hypervisor.framework (`brew install qemu`): Windows 11 on ARM on Apple Silicon, Windows Server 2025 on Intel.
- **Windows on ARM** uses the Windows Hypervisor Platform: install [QEMU 11 or later](https://qemu.weilnetz.de/aarch64/) (its default folder, `C:\Program Files\qemu`, is found without PATH) and turn on the Windows feature "Windows Hypervisor Platform".

Docker is still needed once: setup runs dockur's image (`windows-arm` or `windows`) to download Windows and build the unattended install media, then boots them with the host's QEMU. A Windows on ARM guest runs x64-only tools under Windows' own emulation; osmatrix installs native ARM64 builds of PowerShell, Git, Node.js, Python and act.

Run `osmatrix doctor` to see what this host can do. It also needs an OpenSSH client and `tar`, both built into current Windows, macOS and Linux. You don't need to install act: osmatrix builds its own (see [act](#act)).

> **macOS licensing\*:** installing a macOS guest accepts Apple's [macOS Software License Agreement](https://www.apple.com/legal/sla/), which only permits macOS on Apple hardware. osmatrix asks for this consent once, through `osmatrix setup macos --accept-license` or an agent's `env_setup` call with `accept_license` after you agree, and records it as `macos_eula_acknowledged = true`.

### Guest resources

| Guest | CPUs (min / default) | RAM (min / default) | Virtual disk (min / default) | Host disk once set up |
|---|---|---|---|---|
| ubuntu (container) | 1 / unlimited | 1G / unlimited | none | the act image |
| windows: Server 2025, x86_64 | 2 / 4 | 4G / 8G | 40G / 64G (48G or more with the MSVC Build Tools) | ~20G (estimate: ~12G measured without the MSVC Build Tools), plus the install ISO (~6G) during first setup |
| windows: Windows 11 ARM | 2 / 4 | 4G / 8G | 64G / 64G | ~28G (estimate) |
| macos: dockur (Intel) | 2 / 4 | 4G / 8G | 48G / 64G | ~25G (measured) |
| macos: tart | 2 / 4 | 4G / 8G | from the image (50G) | ~25G (estimate) |

- VM disks are sparse: the host only stores what the guest has written. Each VM's golden snapshot is another copy (less on copy-on-write filesystems such as btrfs).
- Each running VM holds its full RAM. Running Windows and macOS together at the defaults takes 16G for the guests alone, so plan on 24G or more of host RAM. Below about 24G, `max_vms` defaults to 1, so CI runs one VM leg at a time (set `max_vms = 2` to override).
- The minimums are what the OS and osmatrix's provisioning still work with. Builds go faster with the defaults or more.
- Windows guests include the Visual Studio 2022 Build Tools C++ workload (MSVC and the Windows SDK), like GitHub's `windows-latest`. They take about 8G of the guest's disk and add 10–20 minutes to setup. Set `msvc = false` on the guest to skip them (see [Configuration](#configuration)).

Change a guest's size with `osmatrix configure` (MCP: `env_configure`). It checks the new values against the minimums and what the host has:

```bash
osmatrix configure windows --memory 12G --cpus 6          # takes effect at the next start
osmatrix configure windows --disk 96G --apply             # dockur VMs only: restart now; the partition grows to fill the disk
```

`disk` applies to dockur VMs (Windows and macOS on Linux/Windows hosts); tart and the QEMU guests keep their image's disk size. Disks can only grow. After a disk grows, osmatrix extends the system partition on the next boot. On Windows that removes the Recovery partition that sits after C:, and Windows RE moves onto C:.

### Devcontainers, Codespaces and remote Docker

osmatrix expects to run on the machine that runs Docker. Each local guest is a container. osmatrix reaches it over ssh on a port that Docker publishes on `127.0.0.1`, and the Windows guest receives its unattended-install files through a bind mount of a directory in the osmatrix data dir. Both of those only work when the Docker daemon shares osmatrix's loopback and filesystem.

Inside a devcontainer or Codespace, that depends on how the container gets Docker:

| Setup | Daemon shares loopback / files | ubuntu guest | Windows / macOS VMs | Linux CI legs | `ssh` guests |
|---|---|---|---|---|---|
| No Docker in the container | — | no | no | no | yes |
| **Docker-in-Docker** (a daemon inside the container, e.g. the `docker-in-docker` feature) | yes / yes | yes | only if `/dev/kvm` is passed into the container (never on Codespaces) | yes | yes |
| **Docker-outside-of-Docker** (the host's socket mounted in, e.g. the `docker-outside-of-docker` feature) | no / no | refused | refused | yes, with caveats | yes |
| Remote `DOCKER_HOST` (`tcp://`, `ssh://`) | usually no / no | refused | refused | yes, with caveats | yes |

What goes wrong with Docker-outside-of-Docker:

- **Ports.** `-p 127.0.0.1:2221:22` binds the *host's* loopback. The devcontainer has its own network namespace, so its `127.0.0.1:2221` has nothing listening, and ssh to the guest never connects. The guest would look like it was booting forever.
- **Paths.** A bind mount names a path, and the daemon resolves it on the *host's* filesystem. The Windows guest's install folder (`~/.local/share/osmatrix/guests/windows/oem` inside the devcontainer) doesn't exist there. Docker would mount an empty directory, and Windows would spend 20–60 minutes installing without the script that enables ssh.
- **Linux CI legs** still work, because act copies the checkout into its job containers instead of mounting it. Steps can still fail if they upload or download artifacts or use the actions cache, which reach back to act's servers in the devcontainer, or if they bind-mount host paths themselves.

`osmatrix doctor` (MCP: `host_doctor`) detects devcontainers (`REMOTE_CONTAINERS`, `DEVCONTAINER`), Codespaces (`CODESPACES`), other containers (`/.dockerenv`, `/run/.containerenv`) and remote `DOCKER_HOST` values. In those cases it probes the daemon: it bind-mounts a marker file and publishes a port on `127.0.0.1`, then checks that both are visible from where osmatrix runs. It reports the result under `nesting`: `container` (which kind, and why it thinks so), `dockerHost` (a remote daemon) and `docker.{files,loopback}`. When the probe shows a local guest can't work, `up`, `setup` and CI legs on that guest fail straight away with the reason, rather than hanging. The same happens when the probe itself can't run, for example if busybox can't be pulled, because reachability is then unknown. A failed probe is retried on the next call. On a plain host, none of this runs.

**What works well from a devcontainer:** `ssh` guests. They need only an ssh client, so a real Windows PC or Mac, or a Linux box, configured as an `ssh` guest (see [Configuration](#configuration)) gives you `exec`, `push`/`pull`, port forwarding and CI legs from anywhere. Forwards land on the devcontainer's loopback, where your editor's port forwarding can pick them up. If you want local VMs, run osmatrix on the Docker host itself.

## Setting up guests

Guests are disposable development VMs, so `osmatrix setup <guest>` makes every choice for you. It installs the OS, creates the user, enables SSH, sets up passwordless sudo, installs the toolchain and saves a golden snapshot. You don't take any steps yourself, apart from the macOS license consent above.

```bash
osmatrix setup ubuntu                       # seconds
osmatrix setup windows                      # ~20-60 min on first run
osmatrix setup macos --accept-license       # ~30-60 min on first run
osmatrix status                             # progress shows up as setup.phase
```

Agents use `env_setup` and poll `env_status`. Afterwards, `osmatrix reset <guest>` brings a guest back to the golden snapshot: the disk restore takes seconds, and a VM then boots again (1–3 min).

How each guest gets there:

- **ubuntu**: a container built from the same image as Linux CI legs (see [Configuration](#configuration)) with sshd added.
- **windows**: dockur downloads Windows Server 2025 (evaluation) from Microsoft and installs it unattended. [`provision.ps1`](assets/oem/windows/provision.ps1) installs PowerShell 7, Git, Node LTS, Python, stock act (used only when osmatrix's [patched act](#act) isn't) and the MSVC Build Tools with the Windows SDK ([`msvc.ps1`](assets/oem/windows/msvc.ps1), which checks the installer's Microsoft signature before running it), then enables sshd. Like GitHub's image, it enables Git symlinks and Developer Mode (so symlinks can be created) and leaves `core.autocrlf` at Git for Windows' default (`true`). Its log is at `C:\OEM\provision.log`.
- **macos (dockur, or QEMU on Intel Macs)**:
  1. osmatrix boots macOS Recovery. It drives Recovery's Terminal through the VNC display and a small command bridge, erases the disk, and runs `startosinstall --agreetolicense`. The bridge runs [inside dockur's container](assets/macos/bridge.py), or for QEMU in osmatrix itself on the host's loopback, behind a random URL that only the guest is told.
  2. After the install it boots Recovery again and runs [`configure.sh`](assets/macos/configure.sh) on the new system. That creates the `osmatrix` admin user with the SSH key, Remote Login, passwordless sudo and auto-login, and skips Setup Assistant.
  3. Finally [`macos.sh`](assets/provision/macos.sh) installs the Xcode command-line tools, Node, Python, act and Homebrew, and creates `/Users/runner/hostedtoolcache`, where the macOS packages behind `actions/setup-python` and similar actions install on GitHub's runners. It also turns off sleep and the screen saver, so the screen never locks (as on the Windows guest); tart guests get the same provisioning.

  These guests are Intel (x86_64). Homebrew stopped building Intel bottles in August 2026 and its installer no longer supports Intel, so osmatrix installs Homebrew into `/usr/local` (as on GitHub's Intel runner) pinned to brew 6.0.22 and the last homebrew-core commit whose formulae have Intel bottles. `brew install` then pours bottles instead of compiling, at the formula versions of that commit, which are older than on GitHub's runners. The `homebrew` guest setting changes the pins or turns Homebrew off ([reference](skills/osmatrix-setup/references/reference.md)). Guests set up before this get it with `osmatrix provision macos`, then `osmatrix snapshot macos` to keep it in the golden snapshot.
- **macos (tart)**: clones a cirruslabs image, installs the key through the guest agent, then provisions with Homebrew, set to the brew version GitHub's arm64 runner image for that macOS ships (looked up in actions/runner-images, cached for a day).

The generated guest passwords are stored in the osmatrix data dir under `guests/<name>/credentials.json`, for RDP. The browser viewer (`osmatrix viewer <guest>`) doesn't need them: guests sign in automatically and don't lock their screen.

## Everyday use

```bash
osmatrix status
osmatrix exec windows -- 'Get-ChildItem env: | Select -First 5'
osmatrix push windows ./myrepo            # -> ~/work/myrepo (respects .gitignore)
osmatrix forward windows 3000             # app in the guest on :3000 -> http://127.0.0.1:3000 on the host
osmatrix forward macos --reverse 5432     # host Postgres reachable inside the guest at 127.0.0.1:5432
osmatrix screenshot windows -o shot.png

osmatrix ci plan                          # legs, targets, warnings; runs nothing
osmatrix ci run --only windows -m node=22 # background run; poll with:
osmatrix ci status
osmatrix ci logs test-windows --tail 100
osmatrix ci cancel                        # stop the latest running run and remove its act containers
osmatrix ci run --wait                    # foreground, exit code reflects the result
```

Secrets for CI go in `<repo>/.osmatrix/secrets` (or `.secrets`) as `KEY=value` lines. Run logs land in `<repo>/.osmatrix/runs/`, which is git-ignored automatically.

For Windows and macOS legs, osmatrix checks your working tree out in the guest with Git, as `actions/checkout` does on GitHub's runners. Uncommitted changes and untracked files that aren't ignored are included. The guest's Git settings decide line endings, file modes and symlinks, so Windows legs get CRLF files and a clean `git status`, as on GitHub. Each run gets a fresh clone, so config or hooks that a previous run's steps changed don't carry over. The guest and the host (in the osmatrix data dir) keep the objects, so later runs send only what changed. `HEAD` in the guest is your commit and branch, so `GITHUB_SHA` and `GITHUB_REF` are yours, and the index is your index: uncommitted changes show up in `git status` and `git diff` exactly as on the host, as they do on Linux legs. Directories outside a Git repository and repositories that use Git LFS (or another filter), submodules or nested repositories are copied file by file instead; then line endings, modes and symlinks follow the host, and the leg's log says so. `osmatrix push` always copies files as they are, without `.git`.

### act

osmatrix runs a patched build of act 0.2.89, on the host and in every guest. [The patch](assets/act/act-v0.2.89-osmatrix.patch) fixes two ways stock act differs from GitHub's runners:

- File commands (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`) live under `$RUNNER_TEMP/_runner_file_commands/` as on GitHub, so scripts that check those paths stay inside `RUNNER_TEMP` pass. Docker container actions share the directory through a per-job volume ([#23](https://github.com/fritz-fritz/osmatrix/issues/23)).
- The artifact server works with `actions/upload-artifact` v7 and `download-artifact` v7/v8, including single files uploaded with `archive: false`, which keep their name ([#24](https://github.com/fritz-fritz/osmatrix/issues/24); the artifact-server part is the open upstream fix nektos/act#6174).

The first CI run builds it: osmatrix downloads act's source archive (checksum-pinned), applies the patch and cross-compiles it in a pinned `golang` Docker image, for the host and every configured guest's OS and architecture. That takes a few minutes once; Go's caches live in the `osmatrix-act-go-cache` Docker volume, so rebuilds after a patch change are quick. The binaries are cached in the data dir under `bin/act-patched/`. Before a Windows or macOS leg, osmatrix copies the guest's build to `~/.osmatrix/bin/act` (`act.exe` on Windows), unless the guest already has that exact build. `osmatrix install-act` builds it ahead of time, and `osmatrix doctor` shows which act is used and whether it's built.

An `act` on your PATH isn't used unless you ask for it. In `config.toml`, `act_path = "act"` (or a full path) runs your own act on the host; guests then use the act their provisioning installed. `act_version = "v0.2.x"` runs that stock release instead. Without Docker, osmatrix can't build the patched act and falls back to the stock v0.2.89 release, with a warning on each leg. Legs that run stock act get a hint when they fail in one of the ways above.

## Configuration

`osmatrix config` prints the effective config and its file path. See [skills/osmatrix-setup/references/reference.md](skills/osmatrix-setup/references/reference.md) for every option, including adding `ssh` guests such as a real Mac on your network.

Linux CI legs run in `act_linux_image`. Its default, `catthehacker/ubuntu:act-24.04`, lacks the Rust toolchain GitHub's ubuntu runners preinstall, so with the default osmatrix builds a thin layer over it, `osmatrix/ubuntu:act-24.04-<hash>-rust<version>` from [`ubuntu-parity.Dockerfile`](assets/container/ubuntu-parity.Dockerfile). It adds rustup with rustfmt and clippy at the Rust version of GitHub's latest ubuntu24 runner image, which osmatrix reads from that release's readme once a day, installed as `stable` as on GitHub. A new Rust version in the runner image, or an osmatrix update that changes the Dockerfile, rebuilds the image on the next Linux leg. Offline, Linux legs use the newest local image, or build one with the current stable Rust; if that fails too, they run on act's plain image, without Rust, and the leg's log warns. A `ubuntu` guest without a golden snapshot is recreated from a new image on its next `up`; one with a snapshot is kept, and `osmatrix status`/`doctor` show how to recreate it. Set `act_linux_image` to another image to use that image unchanged.

Windows guests get the MSVC Build Tools and Windows SDK during setup, because Rust's default `x86_64-pc-windows-msvc` target and C/C++ builds link with them. Without them, rustc falls back to Git's coreutils `link.exe` and fails with `link: extra operand`. They cost about 8G of disk and 10–20 minutes of setup. To leave them out, set this before `osmatrix setup windows`:

```toml
[guests.windows]
msvc = false
```

Windows guests set up before osmatrix installed the Build Tools don't have them, and neither does their golden snapshot. A Windows CI leg that uses a Rust toolchain action (including any `actions-rs/*`), runs `rustup` or `cargo`, or uses `ilammy/msvc-dev-cmd` or `microsoft/setup-msbuild` warns when its guest lacks the C++ tools or a Windows SDK. Jobs it `needs:` count too when act runs them in the same guest (needs without a local target of their own); needs that run on their own legs and are replayed don't. `osmatrix provision` also completes an install that has the C++ tools but no SDK; `ci plan` already warns for a guest with `msvc = false`. To add them to an existing guest:

```bash
osmatrix provision windows    # installs the Build Tools over ssh; does nothing if they're there
osmatrix snapshot windows     # keep them in the golden snapshot
```

## What local runs don't reproduce

`ci plan` warns about each of these:

- `services:` on non-Linux legs.
- OIDC.
- Some `needs:`. osmatrix runs every job of a run once, on its own `runs-on` target, and replays its result, outputs and artifacts into each leg that needs it, as GitHub hands them over between runners: a Windows/macOS leg gets a Linux job's results from its one run on the host, and a Linux leg gets a Windows job's artifacts from its VM. A needed job with no local target runs inside each leg that needs it instead (on Windows with Git Bash for `run:` steps without a `shell:`), and `ci plan` says so. Either way osmatrix leaves the guest's synced tree untouched: act gets a derived copy of the workflow from outside it.
- Matrices built from expressions.
- Remote reusable workflows.
- `brew` steps on Intel macOS guests, whose Homebrew is pinned to older formula versions.
- Linux legs that use Rust when `act_linux_image` is set to an image other than the default, which may lack the Rust GitHub preinstalls.

osmatrix's [patched act](#act) puts the file-command files (`GITHUB_OUTPUT`, `GITHUB_ENV`, …) under `RUNNER_TEMP` and works with `upload-artifact` v7, which stock act doesn't. A leg that runs stock act anyway (see [act](#act)) says so in its warnings.

Guests are also leaner than GitHub's hosted images, so prefer `setup-*` actions.

## Privacy and terms

osmatrix runs on your machine, with no telemetry or accounts, and does not independently transmit your data to FritzTech. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md). The Codex/ChatGPT listing links to both.

osmatrix is developed with AI coding agents under human review. [AI_POLICY.md](AI_POLICY.md) covers how the project uses AI, what's expected of AI-assisted contributions, and the rules for agents that file issues or pull requests for their users.

## Repository structure

```
osmatrix/                              # the repository root is the plugin, for every client
├── src/, assets/                      # the CLI + MCP server (npm package "osmatrix"); assets/logo.* is the plugin artwork, assets/act/ the act patch
├── skills/osmatrix*/                  # the skills, each self-contained (SKILL.md + references/): osmatrix maps to osmatrix-{setup,guests,ci}
├── .claude-plugin/                    # Claude Code: marketplace.json → ./, plugin.json
├── .cursor-plugin/                    # Cursor:      marketplace.json → ./, plugin.json
├── .agents/plugins/marketplace.json   # Codex:       marketplace    → ./
├── plugin.json, mcp.json              # Agent Plugins 1.0.0 manifest (Codex) and the MCP config all clients share
└── scripts/  sync-manifests.mjs, validate-skills.mjs, validate-plugins.mjs, package-plugins.mjs
```

Each client reads its own manifest at the root; `skills/`, `mcp.json` and the artwork are shared, so nothing is generated. After bumping the version in `package.json`, run `npm run sync`. CI runs `npm run validate`, which fails if a manifest version, the MCP pin or the skills' exact-version npx fallback has drifted, and checks every skill with the clients' own validators.

Nothing else at the root may use a name a client discovers as a plugin component: no `CLAUDE.md`, `bin/`, `commands/`, `agents/` or `hooks/`.

## Releasing

Every release is one immutable version. The tag is `v<x.y.z>`, matching `osmatrix@<x.y.z>` on npm. There are no moving git tags; "latest compatible" comes from npm's own version ranges:

| Spec | Resolves to |
|---|---|
| `osmatrix@0.1.0` | exactly that version (immutable) |
| `osmatrix@0.1` | the newest 0.1.x |
| `osmatrix@0` | the newest 0.x; the marketplace plugins run `npx -y osmatrix@<major> mcp` |
| `osmatrix@latest` | the newest stable release (prereleases publish under `next`) |

To release:

1. Bump the version with `npm version patch --no-git-tag-version` (or `minor` / `major`; a breaking CLI/MCP change means a new major), then run `npm run sync` to stamp it into the three plugin manifests and the skills' npx fallback, and the major-version pin into their MCP configs.
2. Run `npm run verify` and `npm run release:rehearse`. The rehearsal runs `release.yml` locally as if `v<version>` had been pushed, with an `npm publish --dry-run` in place of attestation, publishing and the GitHub release (they need GitHub's OIDC token). It refuses a version that's already on npm, and ends with a preview of the release notes.
3. Commit and push `main`, and let GitHub CI run.
4. Run `npm run release:tag` (add `--wait` to wait for CI). It creates and pushes the tag only if `HEAD` is pushed, the version and tag are unused, and the commit's CI and other checks, such as CodeQL, have passed. So a tag isn't spent on a commit that can't be released.

When the tag lands, [`release.yml`](.github/workflows/release.yml):
   - checks again that the commit's CI and checks passed, waiting if they're still running; nothing irreversible happens before that;
   - validates, tests and builds the bundled plugins;
   - attests build provenance for the npm tarball and the plugin archives;
   - publishes that same tarball to npm with trusted publishing and provenance;
   - creates the GitHub release with all four files attached. Its notes are GitHub's generated list of merged PRs, grouped by label as set in [`.github/release.yml`](.github/release.yml); see "Pull requests" in [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests) for how PRs get their labels.

If the checks fail after tagging, nothing has been published, so you can delete the tag, fix, and tag again.

One-time setup:
- In the GitHub repository settings, enable immutable releases.
- Trusted publishing can only be configured for a package that already exists. Claim the name once (a placeholder version is enough), then go to npmjs.com → osmatrix → Settings → Trusted publishing: publisher GitHub Actions, repository `fritz-fritz/osmatrix`, workflow `release.yml`, no environment, and "Allow npm publish". Every real version, including the first, then goes through the release workflow. Disallow token publishing afterwards.

## Contributing

Contributions are welcome under the MIT license; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm ci
npm test          # unit tests (node:test, TypeScript run directly by Node)
npm run build     # tsc -> dist/
npm run validate  # skills, manifest versions, listing limits, assets and MCP commands
npm run check     # typecheck + tests + validate
npm run ci:local  # this repo's ci.yml via act: Linux on Docker, Windows/macOS in guests (ci:local:linux: Linux only)
npm run release:rehearse # release.yml for v<version>, publishing as a dry run
npm run release:tag # tag + push v<version> once the pushed commit's checks passed (maintainers)
npm run verify    # check + codeql + ci:local: run before pushing
npm run package:plugins # bundled Claude/Cursor/Codex plugins + local marketplace in artifacts/
npm run codeql    # GitHub's code-scanning queries, locally (needs the CodeQL CLI)
node src/cli.ts   # run from source
```

Set `OSMATRIX_HOME=/some/dir` to isolate config and state, for example in tests.

To use the checkout's CLI and MCP server directly, without packaging: `npm run build && npm link`, then `osmatrix install-agents`.

### Try unreleased changes as plugins

`npm run package:plugins` builds a plugin for each of Claude, Cursor and Codex that bundles this checkout's runtime, for trying changes that aren't released on npm yet. `artifacts/` is then a local marketplace named `fritztech-local` for all three clients, committed to its own git repo because Cursor imports marketplaces with git.

```bash
npm ci
npm run package:plugins
```

| Client | Install from `artifacts/` |
|---|---|
| Claude Code | `/plugin marketplace add ./artifacts`, then `/plugin install osmatrix@fritztech-local` |
| Codex | `codex plugin marketplace add ./artifacts`, then enable **osmatrix** under Plugins |
| Cursor | Add the local `artifacts/` folder as a marketplace (plugin cards may lack the logo for local marketplaces). If you switch from the npm-backed plugin, toggle its MCP server off and on. |

Each client's plugin is also archived as `artifacts/osmatrix-<client>-<version>.tar.gz` (one `osmatrix/` directory). Node.js 22.18+ and npm are required, and npx downloads runtime dependencies on first launch. Docker and virtualization requirements depend on which guests you use. Re-run `npm run package:plugins` after changes, then refresh the marketplace in your client.
