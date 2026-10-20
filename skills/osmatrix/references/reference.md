# osmatrix reference: every tool, and the skill that explains it

The MCP server and the CLI expose the same operations. Load the skill named in the last column for how and when to use one; the other skills' references (linked at the end) carry the full option lists.

## Host

| MCP tool | CLI | Skill |
|---|---|---|
| `host_doctor` | `osmatrix doctor` | osmatrix-setup |
| `host_report` | `osmatrix report <guest> --outcome works\|partly\|fails [--notes "..."]` | osmatrix-setup |
| `host_report_file` | `osmatrix report-file <draft>` | osmatrix-setup (only after the user agreed to file it) |

## Guests

| MCP tool | CLI | Skill |
|---|---|---|
| `env_status` | `osmatrix status [guest]` | all three: the first call of any task |
| `env_setup` | `osmatrix setup <guest> [--accept-license] [--background] [--force]` | osmatrix-setup |
| `env_up` / `env_down` | `osmatrix up <guest> [--wait [sec]]` / `osmatrix down <guest>` | osmatrix-guests (osmatrix-setup on first use) |
| `env_configure` | `osmatrix configure <guest> [--cpus n] [--memory 8G] [--disk 96G] [--apply]` | osmatrix-guests |
| `env_reset` | `osmatrix reset <guest> [--wait [sec]]` | osmatrix-setup (a stuck guest), osmatrix-guests (a clean slate) |
| `env_snapshot` | `osmatrix snapshot <guest>` | osmatrix-guests |
| `env_exec` | `osmatrix exec <guest> [--cwd dir] [--timeout sec] [--background] -- <command...>` | osmatrix-guests (osmatrix-ci to reproduce a failed leg) |
| `env_push` / `env_pull` | `osmatrix push <guest> <local> [remoteDir] [--clean] [--all]` / `osmatrix pull <guest> <remotePath> [localDir]` | osmatrix-guests |
| `env_forward` / `env_forwards` / `env_unforward` | `osmatrix forward <guest> <guestPort>[:<hostPort>]` (`--reverse` for host → guest) / `osmatrix forwards [guest]` / `osmatrix unforward <guest> [port] [--all]` | osmatrix-guests |
| `env_viewer` | `osmatrix viewer <guest>` | osmatrix-guests (osmatrix-setup to watch a setup) |
| `env_screenshot` / `env_input` | `osmatrix screenshot <guest> -o shot.png` / `osmatrix input <guest> [--click x,y] [--text "..."] [--keys enter ctrl+a]` | osmatrix-guests (osmatrix-setup for a stuck installer) |

Guest names on a typical host: `ubuntu` (container, bash), `windows` (VM, PowerShell 7), `macos` (VM, zsh). A guest this host can't run can be configured as an `ssh` guest pointing at another machine (osmatrix-setup).

## Local CI

| MCP tool | CLI | Skill |
|---|---|---|
| `ci_plan` | `osmatrix ci plan [--repo dir] [-W wf] [-j job] [--only t...] [-m k=v...]` | osmatrix-ci |
| `ci_run` | `osmatrix ci run [same filters] [--wait] [--event-file payload.json] [--secret-file f] [--timeout min] [--cancel-previous]` | osmatrix-ci |
| `ci_status` | `osmatrix ci status [runId] [--repo dir] [--full]` | osmatrix-ci |
| `ci_logs` | `osmatrix ci logs <leg> [--run id] [--tail n] [--grep re]` | osmatrix-ci |
| `ci_cancel` | `osmatrix ci cancel [runId] [--repo dir]` | osmatrix-ci |

Every `ci_*` call takes the repository's absolute host path as `repo` (CLI: `--repo`, default `.`).

## The other references

- [osmatrix-setup/references/reference.md](https://github.com/fritz-fritz/osmatrix/blob/main/skills/osmatrix-setup/references/reference.md): backends per host, what each guest comes with, the config file, compatibility reports.
- [osmatrix-guests/references/reference.md](https://github.com/fritz-fritz/osmatrix/blob/main/skills/osmatrix-guests/references/reference.md): the guest-side layout (`work/<repo>`, logs, passwords), forwarding, GUI input.
- [osmatrix-ci/references/reference.md](https://github.com/fritz-fritz/osmatrix/blob/main/skills/osmatrix-ci/references/reference.md): where runs, logs and artifacts live, how `needs:` is replayed, act's known differences from GitHub.
