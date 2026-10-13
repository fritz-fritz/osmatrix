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
- Secrets: `<repo>/.osmatrix/secrets` or `<repo>/.secrets`, `KEY=value` lines.
- Linux legs' image: `act_linux_image` in the osmatrix config. Left at the default `catthehacker/ubuntu:act-24.04`, legs run in the locally built `osmatrix/ubuntu:act-24.04-<hash>-rust<version>` (adds rustup with rustfmt and clippy at the Rust version of GitHub's latest ubuntu24 runner image, installed as `stable`; the hash follows osmatrix's Dockerfile, so a new Rust version in the runner image or an osmatrix update that changes the Dockerfile rebuilds it once). The runner's version is cached for a day in the osmatrix data dir (`runner-image.json`), or for 15 minutes after a failed lookup. Offline, the newest local `osmatrix/ubuntu` image is used; with none, and if building one fails, legs run on `catthehacker/ubuntu:act-24.04` itself, without Rust, and the leg log warns. Any other value is passed to act unchanged and must have what the workflows expect.
- `max_vms` in the osmatrix config limits how many VM guests run CI legs at the same time (default 2).
- Labels in the config decide which guest serves a `runs-on` label (globs, first match wins); Linux labels are served by act on the host. See `osmatrix-setup` for the config file.
