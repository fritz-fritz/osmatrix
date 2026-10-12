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

- Repos synced into a guest by `ci_run`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`). osmatrix leaves the synced checkout identical to the commit: what it hands act for a leg (a derived workflow, the event payload, secrets, act's artifact store) goes in `~/work/.osmatrix/<run>/<leg>/` and is removed when the leg ends. A derived workflow is also saved on the host as `<repo>/.osmatrix/runs/<id>/<leg>.workflow.yml`.
- Run artifacts and logs: `<repo>/.osmatrix/runs/<id>/` on the host.
- Secrets: `<repo>/.osmatrix/secrets` or `<repo>/.secrets`, `KEY=value` lines.
- `max_vms` in the osmatrix config limits how many VM guests run CI legs at the same time (default 2).
- Labels in the config decide which guest serves a `runs-on` label (globs, first match wins); Linux labels are served by act on the host. See `osmatrix-setup` for the config file.
