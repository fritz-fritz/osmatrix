# osmatrix-ci reference

## CLI ↔ MCP tool map

Every command accepts `--json`. Exit code is non-zero on errors (for `ci run --wait`, failure of any leg).

| MCP tool | CLI |
|---|---|
| `ci_plan` | `osmatrix ci plan [--repo dir] [-W wf] [-j job] [--only t...] [-m k=v...]` |
| `ci_run` | `osmatrix ci run [same filters] [--wait] [--event e] [--event-file payload.json] [--secret-file f] [--timeout min]` |
| `ci_status` | `osmatrix ci status [runId] [--repo dir] [--full]` |
| `ci_logs` | `osmatrix ci logs <leg> [--run id] [--tail n] [--grep re]` |
| `env_status` | `osmatrix status [guest]` |
| `env_exec` | `osmatrix exec <guest> [--cwd dir] [--timeout sec] [--background] -- <command...>` |

CLI-only: `osmatrix ci runs` (list runs of a repo).

## Where things are

- Repos synced into a guest by `ci_run`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`).
- Run artifacts and logs: `<repo>/.osmatrix/runs/<id>/` on the host.
- act: osmatrix's patched build, made in Docker on the first run (a few minutes; the leg log shows the progress) and cached in the data dir. Each guest gets its copy at `~/.osmatrix/bin/act` (Windows: `act.exe`) before its first leg, and again after the patch changes. `host_doctor` shows which act is used and whether it's built.
- Secrets: `<repo>/.osmatrix/secrets` or `<repo>/.secrets`, `KEY=value` lines.
- `max_vms` in the osmatrix config limits how many VM guests run CI legs at the same time (default 2).
- Labels in the config decide which guest serves a `runs-on` label (globs, first match wins); Linux labels are served by act on the host. See `osmatrix-setup` for the config file.
