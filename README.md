# osmatrix

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

### Try the plugins from this checkout

`npm run package:plugins` builds a plugin for each of Claude, Cursor and Codex that bundles this checkout's runtime, so they work before anything is on npm. `artifacts/` is then a local marketplace named `fritztech-local` for all three clients, committed to its own git repo because Cursor imports marketplaces with git.

```bash
npm ci
npm run package:plugins
```

| Client | Install from `artifacts/` |
|---|---|
| Claude Code | `/plugin marketplace add ./artifacts`, then `/plugin install osmatrix@fritztech-local` |
| Codex | `codex plugin marketplace add ./artifacts`, then `codex plugin add osmatrix@fritztech-local` |
| Cursor | Add the local `artifacts/` folder as a marketplace (plugin cards may lack the logo until the marketplace is on GitHub). If an earlier osmatrix plugin failed to start, toggle its MCP server off and on in Cursor's MCP settings: Cursor remembers the failure by server name, even across reinstalls. |

Each client's plugin is also archived as `artifacts/osmatrix-<client>-<version>.tar.gz` (one `osmatrix/` directory). Node.js 22.18+ and npm are required, and npx downloads runtime dependencies on first launch. Docker and virtualization requirements depend on which guests you use. Re-run `npm run package:plugins` after changes, then refresh the marketplace in your client.

Start with "Check which operating systems this host supports, then plan this repository's CI." Planning starts no guests. For repository tools, the agent passes your checkout's absolute path explicitly.

### As an agent plugin

After the first npm release, the repository root is a plugin marketplace for each client. Every plugin bundles the skill and registers the MCP server (`npx -y osmatrix@0 mcp`, pinned to the current major version). Until then, use the local export above; the npm-backed marketplace cannot start an unpublished package.

| Client | Install |
|---|---|
| Claude Code | `/plugin marketplace add fritz-fritz/osmatrix`, then `/plugin install osmatrix@fritztech` |
| Codex | `codex plugin marketplace add fritz-fritz/osmatrix`, then `codex plugin add osmatrix@fritztech` |
| Cursor | **Dashboard → Plugins → Team Marketplaces → Add Marketplace → Import from Repo** |
| Skill only (any agent, via [skills.sh](https://skills.sh)) | `npx skills add fritz-fritz/osmatrix` |

### From npm, or from a checkout

```bash
npm install -g osmatrix        # or from a checkout: npm ci && npm run build && npm link
osmatrix init                  # config + ssh key + host check
osmatrix install-agents        # register MCP server + skill with Claude Code, Cursor and Codex
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
- `needs:` across OSes. act runs the dependency in the same environment.
- Matrices built from expressions.
- Remote reusable workflows.

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

1. Bump `version` in `package.json`. A breaking CLI/MCP change means a new major.
2. Run `npm run sync`. It stamps the version into the three plugin manifests and the major-version pin into their MCP configs.
3. Commit, tag `v<version>` and push the tag. [`release.yml`](.github/workflows/release.yml) then:
   - validates and tests;
   - builds the bundled plugins;
   - attests build provenance for the npm tarball and the plugin archives;
   - publishes that same tarball to npm with trusted publishing and provenance;
   - creates the GitHub release with all four files attached.

Rehearse a release locally first. This runs everything except attestation, the real npm publish and the GitHub release, which need GitHub's OIDC token; it does an `npm publish --dry-run` instead:

```bash
echo '{"ref":"refs/tags/v0.1.0"}' > /tmp/tag.json
osmatrix ci run -W release.yml --event-file /tmp/tag.json --wait
```

One-time setup:
- In the GitHub repository settings, enable immutable releases.
- Trusted publishing can only be configured for a package that already exists. Publish the first version by hand with `npm login && npm publish --access public` (2FA). Then go to npmjs.com → osmatrix → Settings → Trusted publishing, add this repository and `release.yml`, and disallow token publishing.

## Development

```bash
npm ci
npm test          # unit tests (node:test, TypeScript run directly by Node)
npm run build     # tsc -> dist/
npm run validate  # skill sync, versions, listing limits, assets and MCP commands
npm run package:plugins # bundled Claude/Cursor/Codex plugins + local marketplace in artifacts/
node src/cli.ts   # run from source
```

Set `OSMATRIX_HOME=/some/dir` to isolate config and state, for example in tests.
