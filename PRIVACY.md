# osmatrix privacy policy

_Last updated: 2026-10-20_

osmatrix is an open-source command-line tool and MCP server that runs entirely on your own computer. It is published by FritzTech under the MIT license.

## What osmatrix collects

osmatrix has no telemetry or analytics and does not independently transmit your data to FritzTech. It has no accounts and operates no servers of its own. User-requested commands, file transfers and tool results follow the destinations you configure.

## What osmatrix stores, on your machine

- **Configuration:** `config.toml` in your user config directory (on Linux, `~/.config/osmatrix`).
- **Data:** guest state, an SSH key generated for your guests, generated guest passwords (`credentials.json`), compatibility report drafts (`reports/`), logs, osmatrix's builds of `act` (`bin/`) and the cached toolchain versions of GitHub's runner images (`runner-image.json`, `runner-images-macos.json`), in your user data directory (on Linux, `~/.local/share/osmatrix`).
- **Guest disks and snapshots:** in local Docker volumes or tart VMs.
- **CI run logs:** in `.osmatrix/runs/` inside each repository you test. That directory is git-ignored automatically.

You can delete all of it at any time: `osmatrix destroy <guest> --yes` for each guest, then remove the directories above.

## Network access

osmatrix connects to the network to fetch software that you ask it to set up, and to file a compatibility report when you agree to one:

- `act`'s source archive and releases from GitHub, and the `golang` image it is built with from Docker Hub
- the release list and readme of GitHub's runner images (actions/runner-images; a successful lookup is reused for 24 hours, a failed one is retried after 15 minutes), to match the Linux CI image's Rust version, and Rust from rustup.rs
- container images from Docker Hub
- Windows Server evaluation media and the Visual Studio Build Tools installer from Microsoft (the Build Tools unless the guest sets `msvc = false`)
- macOS base images for tart guests from GitHub's container registry (ghcr.io/cirruslabs)
- macOS recovery and installer images from Apple
- guest toolchains from their publishers: Node.js (nodejs.org), Python (python.org), Git for Windows and PowerShell (GitHub), Homebrew and its packages for macOS guests (GitHub and ghcr.io), and the Homebrew version of GitHub's runner images (actions/runner-images on GitHub) for Apple Silicon macOS guests
- the osmatrix package itself from npm, when started through `npx`
- GitHub, through your own `gh` login, only when you agree to file a compatibility report (`osmatrix report-file`): it looks for an open report with the same title, then adds a comment or opens an issue with the report you were shown

Each of those services handles requests under its own privacy policy. The commands and CI workflow steps that you, or an AI agent acting for you, run inside guests may contact other services; osmatrix does not inspect or restrict them.

## Data shared with AI clients

When osmatrix runs as an MCP server inside an AI client (Claude, Codex/ChatGPT, Cursor), the tool results go to that client: command output, CI logs, file listings and guest screenshots. The client and its model provider handle that data under their own policies. osmatrix only returns what a tool call asks for. It does not read your chat history.

## Contact

Questions and issues: https://github.com/fritz-fritz/osmatrix/issues
