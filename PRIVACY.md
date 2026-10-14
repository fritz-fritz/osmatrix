# osmatrix privacy policy

_Last updated: 2026-10-10_

osmatrix is an open-source command-line tool and MCP server that runs entirely on your own computer. It is published by FritzTech under the MIT license.

## What osmatrix collects

osmatrix has no telemetry or analytics and does not independently transmit your data to FritzTech. It has no accounts and operates no servers of its own. User-requested commands, file transfers and tool results follow the destinations you configure.

## What osmatrix stores, on your machine

- **Configuration:** `config.toml` in your user config directory (on Linux, `~/.config/osmatrix`).
- **Data:** guest state, an SSH key generated for your guests, generated guest passwords (`credentials.json`), logs, a downloaded `act` binary and the cached Rust version of GitHub's runner image (`runner-image.json`), in your user data directory (on Linux, `~/.local/share/osmatrix`).
- **Guest disks and snapshots:** in local Docker volumes or tart VMs.
- **CI run logs:** in `.osmatrix/runs/` inside each repository you test. That directory is git-ignored automatically.

You can delete all of it at any time: `osmatrix destroy <guest> --yes` for each guest, then remove the directories above.

## Network access

osmatrix connects to the network only to fetch software that you ask it to set up:

- `act` releases from GitHub
- the release list and readme of GitHub's runner images (actions/runner-images; a successful lookup is reused for 24 hours, a failed one is retried after 15 minutes), to match the Linux CI image's Rust version, and Rust from rustup.rs
- container images from Docker Hub
- Windows Server evaluation media from Microsoft
- macOS recovery and installer images from Apple
- guest toolchains from their publishers: Node.js (nodejs.org), Python (python.org), Git for Windows and PowerShell (GitHub), Homebrew on Apple Silicon
- the osmatrix package itself from npm, when started through `npx`

Each of those services handles requests under its own privacy policy. The commands and CI workflow steps that you, or an AI agent acting for you, run inside guests may contact other services; osmatrix does not inspect or restrict them.

## Data shared with AI clients

When osmatrix runs as an MCP server inside an AI client (Claude, Codex/ChatGPT, Cursor), the tool results go to that client: command output, CI logs, file listings and guest screenshots. The client and its model provider handle that data under their own policies. osmatrix only returns what a tool call asks for. It does not read your chat history.

## Contact

Questions and issues: https://github.com/fritz-fritz/osmatrix/issues
