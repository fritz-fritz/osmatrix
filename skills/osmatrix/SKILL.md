---
name: osmatrix
description: What osmatrix is and which of its skills to load - osmatrix-setup (check the host, create or repair Ubuntu, Windows and macOS guests), osmatrix-guests (run code, copy files, forward ports, see and drive the screen inside a guest), osmatrix-ci (run a repository's GitHub Actions workflows locally, OS matrices included). Use when unsure which osmatrix skill applies, when asked what osmatrix can do or how its MCP tools (host_*, env_*, ci_*) fit together, or as the entry point when osmatrix was installed as a single skill.
---

# osmatrix: the map

osmatrix gives an agent local **guests** (an Ubuntu container, Windows and macOS VMs, or any machine reachable over ssh) and **local CI** (a repository's GitHub Actions workflows run with act: `ubuntu-*` legs on the host's Docker, `windows-*` and `macos-*` legs inside the matching VM, so a Windows leg really runs on Windows). It is one plugin: an MCP server plus three working skills. This skill only says which one to load.

## Which skill

| You need to… | Load | It covers |
|---|---|---|
| Find out what this host can run, create a guest, fix one that is `absent`, `needs-ssh-setup` or stuck, register an existing machine as an ssh guest, file a compatibility report | **osmatrix-setup** | `host_doctor`, `env_setup`, `env_reset`, the macOS licence consent, setup phases, `host_report` |
| Run or debug code on another OS, copy files in or out, reach a guest's server from the host (or the host from a guest), watch or drive a guest's screen | **osmatrix-guests** | `env_exec`, `env_push` / `env_pull`, `env_forward`, `env_viewer`, `env_screenshot`, `env_input` |
| Run the repository's workflows locally before pushing, re-run a failed Windows or macOS leg, read a leg's log, know what act can't reproduce | **osmatrix-ci** | `ci_plan`, `ci_run`, `ci_status`, `ci_logs`, `ci_cancel` |

Most tasks use two in order: osmatrix-setup once per host (prerequisites, the first `env_setup`), then osmatrix-guests or osmatrix-ci. The table of every tool, its CLI command and the skill that explains it is in [references/reference.md](references/reference.md).

## Rules that hold whichever skill you load

- Prefer the **MCP tools** (`host_*`, `env_*`, `ci_*`) when the session has them: their safety annotations let the client ask for confirmation where it matters. If they are missing, tell the user first (the osmatrix MCP server isn't loaded; enabling or restarting it in the client's plugin settings usually fixes it), then use the `osmatrix` CLI, where every tool has a command and `--json` gives machine output. If the CLI isn't installed either, say so and offer to run it from npm (`npx osmatrix@0.3.0 <command>`, or after `npm i -g osmatrix@0.3.0`); that downloads and executes the package, so wait for the user to agree, and stop if they don't.
- Pass the repository's absolute host path as `repo` to every `ci_*` tool: the MCP server's working directory may be the plugin cache, not the user's checkout.
- `env_status` first (states: `absent`, `stopped`, `booting`, `needs-ssh-setup`, `ready`). VM guests boot slowly (minutes; a first Windows or macOS setup takes 20–60 min): don't start ones you don't need, keep one up while iterating, `env_down` when finished.
- Installing macOS needs the user's explicit consent to Apple's licence each time it is asked for. Never assume it.
- Local green is evidence, not proof: report what didn't run or differs from GitHub (osmatrix-ci lists the differences).

## Where the detail lives

Each skill is self-contained and ships its own reference (CLI ↔ tool map, paths in the guest, troubleshooting): [osmatrix-setup](https://github.com/fritz-fritz/osmatrix/blob/main/skills/osmatrix-setup/SKILL.md) · [osmatrix-guests](https://github.com/fritz-fritz/osmatrix/blob/main/skills/osmatrix-guests/SKILL.md) · [osmatrix-ci](https://github.com/fritz-fritz/osmatrix/blob/main/skills/osmatrix-ci/SKILL.md). The whole thing (skills and MCP server) installs as a plugin: `/plugin marketplace add fritz-fritz/osmatrix` in Claude Code, `codex plugin marketplace add fritz-fritz/osmatrix` in Codex, or the skills alone with `npx skills add fritz-fritz/osmatrix`. Project, README, compatibility matrix, privacy and terms: https://github.com/fritz-fritz/osmatrix.
