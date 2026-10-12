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

## How the repo gets into a guest

- `ci_run` snapshots the host working tree (tracked files plus untracked files that aren't ignored, uncommitted changes included) and checks it out with Git in a repository kept in the guest. The guest's Git config decides line endings, file modes and symlinks, as on GitHub's runners: Windows legs get CRLF text files, a clean `git status` for committed files, and real symlinks. Later runs send only new objects.
- `HEAD` in the guest is the host's commit and branch (`GITHUB_SHA`, `GITHUB_REF`), and `origin` is the host's `origin` URL (`GITHUB_REPOSITORY`). Uncommitted host changes show as changes in the guest's `git status`, as they do on Linux legs; a cleanliness check (`git diff --exit-code`) fails locally for them but passes on GitHub once they're committed.
- Each run starts from a clean tree: ignored files, build output and earlier runs' files in `work/<name>` are removed.
- Fallback: directories outside a Git repository, and repositories with Git LFS or other filters, submodules or nested repositories, are copied file by file with the host's `.git`. Then line endings, modes and symlinks follow the host (LF on Windows legs), and the leg's log says "copying files instead of a git checkout". If the checkout fails in the guest, the leg copies too and lists a warning. Report such a leg's line-ending results as a difference from GitHub.
- Run artifacts and logs: `<repo>/.osmatrix/runs/<id>/` on the host.
- Secrets: `<repo>/.osmatrix/secrets` or `<repo>/.secrets`, `KEY=value` lines.
- `max_vms` in the osmatrix config limits how many VM guests run CI legs at the same time (default 2).
- Labels in the config decide which guest serves a `runs-on` label (globs, first match wins); Linux labels are served by act on the host. See `osmatrix-setup` for the config file.
