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

- Repos synced into a guest by `ci_run`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`). osmatrix leaves the synced tree untouched after syncing it (it is a copy of your working tree, uncommitted changes included): what it hands act for a leg (a derived workflow, the event payload, secrets, act's artifact store) goes in `~/work/.osmatrix/<run>/<leg>/` and is removed when the leg ends. A derived workflow is also saved on the host as `<repo>/.osmatrix/runs/<id>/<leg>.workflow.yml`.
- Run artifacts and logs: `<repo>/.osmatrix/runs/<id>/` on the host. A host run of replayed needs logs to `replay-<n>.log` there (the leg's log has a copy) and keeps its derived workflow, act's artifact store and the unpacked artifacts in `replay/<n>/`.
- Secrets: `<repo>/.osmatrix/secrets` or `<repo>/.secrets`, `KEY=value` lines.
- `max_vms` in the osmatrix config limits how many VM guests run CI legs at the same time (default 2).
- Labels in the config decide which guest serves a `runs-on` label (globs, first match wins); Linux labels are served by act on the host. See `osmatrix-setup` for the config file.

## Replayed cross-OS needs

For a Windows/macOS leg whose job needs Linux jobs (directly or through other needs), `ci_plan` lists them in the leg's `replayNeeds`, and `ci_run`:

1. Runs them once on the host with act on Docker, like a Linux leg, plus a collector job (`osmatrix-replay`) that needs them with `if: always()` and prints `toJSON(needs)`: each job's result and outputs, as act evaluated them. VM legs of the same run that need the same jobs share this host run, which happens before the leg takes a `max_vms` slot. Linux legs of the run still run those jobs themselves, as act's dependencies, so they run once more there.
2. Unpacks the artifacts they uploaded from act's artifact store (`<store>/<run id>/<name>/<name>.zip` for upload-artifact v4 and later; v3's per-file layout also works).
3. Gives the VM leg a derived workflow in which each replayed job is a stub with the same job id and `outputs:` keys, on the leg's own runner. Its `replay` step (a Node.js script, so the same one works on Windows and macOS) writes the recorded values to `$GITHUB_OUTPUT`, multi-line values in the heredoc form. An `osmatrix-replay-artifacts` job that every stub needs re-uploads each recorded artifact under its name, from the copy osmatrix puts next to the work tree (absolute paths: stubs have no checkout). It uses the `actions/upload-artifact` that the replayed jobs use (when they agree on one), else a pinned v4.6.2.
4. Gives the host run and the guest run the same `GITHUB_RUN_ID` (every act run of a `ci_run` shares one), as all jobs of a GitHub run do.

A job skipped on the host gets a stub with `if: false`, so its dependents are skipped as on GitHub. A job that failed (or was cancelled) on the host gets a stub that replays the outputs it set (GitHub evaluates job outputs whatever the result) and then fails, so act runs only the dependents whose `if:` allows it (`always()`, `failure()`, a check of `needs.<job>.result`). The leg then fails, as act exits non-zero when a needed job fails, and its `failedStep` reads `host run: <job>: <step>`. When the host run gives no usable result (act failed, timed out, or recorded nothing), the leg errors before the guest starts.

Stock act 0.2.89's artifact server rejects `actions/upload-artifact` v7 (osmatrix issue #24): a workflow that uploads with v7 fails in the host run until that's fixed, and the replay re-uploads with the same version.

The fields of a leg in `ci_status` include `replay` (`jobs`, `state`, `log`, `durationSec`, `failedStep`, `error`, `artifacts`) when it had a host run.
