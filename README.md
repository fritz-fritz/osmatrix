<img src="assets/logo.svg" alt="osmatrix logo" height="100px">

# osmatrix

[![CI](https://img.shields.io/github/actions/workflow/status/fritz-fritz/osmatrix/ci.yml?branch=main&label=CI)](https://github.com/fritz-fritz/osmatrix/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/osmatrix)](https://www.npmjs.com/package/osmatrix)
[![skills.sh](https://skills.sh/b/fritz-fritz/osmatrix)](https://skills.sh/fritz-fritz/osmatrix/osmatrix)
[![license](https://img.shields.io/github/license/fritz-fritz/osmatrix)](LICENSE)
[![Socket Security](https://badge.socket.dev/npm/package/osmatrix)](https://socket.dev/npm/package/osmatrix)

<p align="center"><img src="assets/social-preview.svg" alt="osmatrix social card" width="65%"></p>

Local **Ubuntu, Windows and macOS** environments plus **local GitHub Actions matrix runs** for coding agents (Claude Code, Cursor, Codex) and for humans. It's one CLI that also serves as an MCP server, and it ships with an agent skill.

- **Guests**: `exec`, file push/pull, **port forwarding** (both directions), screenshots and keyboard/mouse input.
- **Local CI**: `ci plan` / `ci run` expand workflow matrices. `ubuntu-*` legs run with [act](https://github.com/nektos/act) on the host's Docker. `windows-*` and `macos-*` legs run act **inside** the matching VM, so a Windows leg really runs on Windows.
- **Cross-platform hosts**: Linux, Windows (WSL2) and macOS (Apple Silicon). Guests this host can't run can be any machine you can reach over ssh.

```
Claude Code / Cursor / Codex
  ├─ skill (SKILL.md): when and how
  └─ MCP server (osmatrix mcp, stdio) ─┐
human / scripts ── osmatrix CLI ───────┴─ core ─┬─ ubuntu  : act runner image + sshd (container)
                                               ├─ windows : dockur/windows VM (KVM)
                                               ├─ macos   : dockur/macos VM (KVM) | tart (Apple Silicon)
                                               └─ any     : existing machine over ssh
```

## Install

### As an agent plugin (recommended)

The repository is a plugin marketplace for each client. The plugin bundles the skill and the MCP server, which runs from npm as `npx -y osmatrix@0 mcp`, pinned to the current major version.

| Client | Install |
|---|---|
| Claude Code | `/plugin marketplace add fritz-fritz/osmatrix`, then `/plugin install osmatrix@fritztech` |
| Codex / ChatGPT | `codex plugin marketplace add fritz-fritz/osmatrix`, then `codex plugin add osmatrix@fritztech` |
| Cursor | **Dashboard → Plugins → Team Marketplaces → Add Marketplace → Import from Repo** |
| Skill only, any agent (via [skills.sh](https://skills.sh)) | `npx skills add fritz-fritz/osmatrix` |

Requirements:

- Node.js 22.18+ with npm.
- Docker.
- KVM for the Windows/macOS VMs, or an Apple Silicon Mac for macOS guests (see [Host requirements](#host-requirements)).

Then try: "Check which operating systems this host supports, then plan this repository's CI." Planning starts no guests. For repository tools, the agent passes your checkout's absolute path explicitly.

> If the osmatrix MCP server shows as failed after you install or switch plugins, toggle it off and on in your client's MCP settings. Some clients, Cursor for one, remember a server's failure by name even across reinstalls.

### As a CLI (npm)

```bash
npm install -g osmatrix
osmatrix init                  # config + ssh key + host check
osmatrix install-agents        # optional: register MCP server + skill with Claude Code, Cursor and Codex without the plugins
```

`install-agents` writes to these places:

- **Claude Code**: `claude mcp add --scope user`, or `~/.claude.json` when the `claude` CLI isn't on PATH. Also `~/.claude/skills/osmatrix`.
- **Cursor**: `~/.cursor/mcp.json`, plus the shared `~/.agents/skills/osmatrix`.
- **Codex**: `~/.codex/config.toml` `[mcp_servers.osmatrix]`, plus the shared `~/.agents/skills/osmatrix`.

Options:

- `--claude`, `--cursor` or `--codex` limits it to one agent.
- `--npx` registers `npx -y osmatrix@<major> mcp` instead of the local path.
- `--dry-run` previews the changes.
- `--uninstall` removes them.
- A backup of every file it edits is written next to it as `*.osmatrix.bak`.

## Host requirements

| Host | ubuntu | windows | macos |
|---|---|---|---|
| Linux x86_64 with KVM | Docker | dockur (KVM) | dockur (KVM), see licensing note |
| Windows 11 + Docker Desktop (WSL2, nested virtualization) | Docker | dockur | dockur (best effort) |
| macOS Apple Silicon | Docker | via `ssh` guest only | tart |

Run `osmatrix doctor` to see what this host can do. It also needs an OpenSSH client and `tar`, both built into current Windows, macOS and Linux. `act` is downloaded (checksum-verified) on first use if it isn't on PATH.

> **macOS licensing:** installing a macOS guest accepts Apple's [macOS Software License Agreement](https://www.apple.com/legal/sla/), which only permits macOS on Apple hardware. osmatrix asks for this consent once, through `osmatrix setup macos --accept-license` or an agent's `env_setup` call with `accept_license` after you agree, and records it as `macos_eula_acknowledged = true`.

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

Agents use `env_setup` and poll `env_status`. Afterwards, `osmatrix reset <guest>` brings a guest back to the golden snapshot in seconds.

How each guest gets there:

- **ubuntu**: a container built from `catthehacker/ubuntu:act-24.04` with sshd added.
- **windows**: dockur downloads Windows Server 2025 (evaluation) from Microsoft and installs it unattended. [`provision.ps1`](assets/oem/windows/provision.ps1) installs PowerShell 7, Git, Node LTS, Python and act, then enables sshd. Its log is at `C:\OEM\provision.log`.
- **macos (dockur)**:
  1. osmatrix boots macOS Recovery. It drives Recovery's Terminal through the VNC display and a small [command bridge](assets/macos/bridge.py) inside the container, erases the disk, and runs `startosinstall --agreetolicense`.
  2. After the install it boots Recovery again and runs [`configure.sh`](assets/macos/configure.sh) on the new system. That creates the `osmatrix` admin user with the SSH key, Remote Login, passwordless sudo and auto-login, and skips Setup Assistant.
  3. Finally [`macos.sh`](assets/provision/macos.sh) installs the Xcode command-line tools, Node, Python and act.

  These guests are Intel (x86_64), so they have no Homebrew; Homebrew dropped Intel support.
- **macos (tart)**: clones a cirruslabs image, installs the key through the guest agent, then provisions with Homebrew.

The generated guest passwords are stored in the osmatrix data dir under `guests/<name>/credentials.json`, for RDP or the VNC viewer.

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
osmatrix ci run --wait                    # foreground, exit code reflects the result
```

Secrets for CI go in `<repo>/.osmatrix/secrets` (or `.secrets`) as `KEY=value` lines. Run logs land in `<repo>/.osmatrix/runs/`, which is git-ignored automatically.

## Configuration

`osmatrix config` prints the effective config and its file path. See [skills/osmatrix/reference.md](skills/osmatrix/reference.md) for every option, including adding `ssh` guests such as a real Mac on your network.

## What local runs don't reproduce

`ci plan` warns about each of these:

- `services:` on non-Linux legs.
- OIDC.
- `needs:` across OSes. act runs the dependency in the same environment; on Windows legs, osmatrix runs a needed Linux job's `run:` steps without a `shell:` with Git Bash.
- Matrices built from expressions.
- Remote reusable workflows.

act also keeps the file-command files (`GITHUB_OUTPUT`, `GITHUB_ENV`, …) outside `RUNNER_TEMP`, so scripts that check those paths stay inside `RUNNER_TEMP` fail only locally. A failed leg says so in its warnings; skip such checks when `env.ACT` is set.

Guests are also leaner than GitHub's hosted images, so prefer `setup-*` actions.

## Privacy and terms

osmatrix runs on your machine, with no telemetry or accounts, and does not independently transmit your data to FritzTech. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md). The Codex/ChatGPT listing links to both.

## Repository structure

```
osmatrix/
├── src/, assets/                      # the CLI + MCP server (npm package "osmatrix")
├── skills/osmatrix/                    # canonical skill: edit this one (skills.sh reads it here)
├── .claude-plugin/marketplace.json    # Claude marketplace  → ./claude
├── .cursor-plugin/marketplace.json    # Cursor marketplace  → cursor
├── .agents/plugins/marketplace.json   # Codex marketplace   → ./codex
├── claude/   .claude-plugin/plugin.json, .mcp.json, skills/ (generated)
├── cursor/   .cursor-plugin/plugin.json, mcp.json, skills/ (generated)
├── codex/    plugin.json (Agent Plugins 1.0.0), mcp.json, skills/ (generated)
└── scripts/  sync-skills.mjs, validate-skills.mjs
```

Each client reads only its own marketplace and plugin directory. That's why every plugin ships its own copy of the skill. After editing `skills/` or bumping the version in `package.json`, run `npm run sync`. CI runs `npm run validate`, which fails if a copy or a manifest version has drifted.

Plugin artwork has two canonical files in `assets/`: the shaded vector `logo.svg` and its raster render `logo.png`. Both include a rounded navy tile with transparency outside its rounded corners. `npm run sync` distributes both formats to every client; `npm run validate` rejects missing or different copies.

## Releasing

Every release is one immutable version. The tag is `v<x.y.z>`, matching `osmatrix@<x.y.z>` on npm. There are no moving git tags; "latest compatible" comes from npm's own version ranges:

| Spec | Resolves to |
|---|---|
| `osmatrix@0.1.0` | exactly that version (immutable) |
| `osmatrix@0.1` | the newest 0.1.x |
| `osmatrix@0` | the newest 0.x; the marketplace plugins run `npx -y osmatrix@<major> mcp` |
| `osmatrix@latest` | the newest stable release (prereleases publish under `next`) |

To release:

1. Bump the version with `npm version patch --no-git-tag-version` (or `minor` / `major`; a breaking CLI/MCP change means a new major), then run `npm run sync` to stamp it into the three plugin manifests and the major-version pin into their MCP configs.
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
npm run validate  # skill sync, versions, listing limits, assets and MCP commands
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
| Codex | `codex plugin marketplace add ./artifacts`, then `codex plugin add osmatrix@fritztech-local` |
| Cursor | Add the local `artifacts/` folder as a marketplace (plugin cards may lack the logo for local marketplaces). If you switch from the npm-backed plugin, toggle its MCP server off and on. |

Each client's plugin is also archived as `artifacts/osmatrix-<client>-<version>.tar.gz` (one `osmatrix/` directory). Node.js 22.18+ and npm are required, and npx downloads runtime dependencies on first launch. Docker and virtualization requirements depend on which guests you use. Re-run `npm run package:plugins` after changes, then refresh the marketplace in your client.
