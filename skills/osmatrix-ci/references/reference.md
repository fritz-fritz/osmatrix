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

- Repos synced into a guest by `ci_run`: `~/work/<name>` (Windows: `C:\Users\<user>\work\<name>`). osmatrix leaves the synced tree untouched after syncing it (a Git checkout of your working tree, uncommitted changes included; see below): what it hands act for a leg (a derived workflow, the event payload, secrets, act's artifact store) goes in `~/work/.osmatrix/<run>/<leg>/` and is removed when the leg ends. A derived workflow is also saved on the host as `<repo>/.osmatrix/runs/<id>/workflows/<leg>/<file>`; Linux legs run it from there.
- Run artifacts and logs: `<repo>/.osmatrix/runs/<id>/` on the host: a log per leg (`<leg>.log`) and act's artifact store per workflow in `artifacts/<workflow file name>/<GITHUB_RUN_ID>/<artifact>/`.
- act: osmatrix's patched build, made in Docker on the first run (a few minutes; the leg log shows the progress) and cached in the data dir. Each guest gets its copy at `~/.osmatrix/bin/act` (Windows: `act.exe`) before its first leg, and again after the patch changes. `host_doctor` shows which act is used and whether it's built.
- Secrets: `<repo>/.osmatrix/secrets` or `<repo>/.secrets`, `KEY=value` lines.
- Linux legs' image: `act_linux_image` in the osmatrix config. Left at the default `catthehacker/ubuntu:act-24.04`, legs run in the locally built `osmatrix/ubuntu:act-24.04-<hash>-rust<version>` (adds rustup with rustfmt and clippy at the Rust version of GitHub's latest ubuntu24 runner image, installed as `stable`; the hash follows osmatrix's Dockerfile, so a new Rust version in the runner image or an osmatrix update that changes the Dockerfile rebuilds it once). The runner's version is cached for a day in the osmatrix data dir (`runner-image.json`), or for 15 minutes after a failed lookup. Offline, the newest local `osmatrix/ubuntu` image is used; with none, and if building one fails, legs run on `catthehacker/ubuntu:act-24.04` itself, without Rust, and the leg log warns. Any other value is passed to act unchanged and must have what the workflows expect.
- `max_vms` in the osmatrix config limits how many VM guests run CI legs at the same time (default 2).
- Labels in the config decide which guest serves a `runs-on` label (globs, first match wins); Linux labels are served by act on the host. See `osmatrix-setup` for the config file.

## Needs: each job runs once

On GitHub every job of a run runs once, on its own runner, and the jobs that need it get its result, outputs and artifacts. `act -j <job>` would run the needed jobs again inside every dependent leg, on the dependent's OS. So `ci_run` schedules the run itself:

1. `ci_plan` gives each leg `waitsFor` (the legs of its needed jobs), `neededBy` (the legs that wait for it) and `replayNeeds` (the needed jobs replayed into it). Legs of needed jobs that the filter (`job`, `only`, `matrix`) leaves out are added with `neededOnly: true`; a `matrix` filter, like act's `--matrix`, leaves the legs of a needed job without that key alone. Each target runs its legs one at a time, each after the legs it waits for; a VM leg doesn't hold a `max_vms` slot while it waits.
2. A leg that others need runs through a derived workflow with a collector job (`osmatrix-record`) that needs the leg's job with `if: always()` and prints `toJSON(needs)`: the job's result and outputs, as act evaluated them. It runs on the leg's own runner, as a Node.js script.
3. A leg that needs other jobs gets a derived workflow in which each needed job is a stub with the same job id and `outputs:` keys, on the leg's own runner. Its `replay` step (Node.js) writes the recorded values to `$GITHUB_OUTPUT`, multi-line values in the heredoc form. A matrix job's legs combine as on GitHub: it failed if any leg failed, was skipped if all were, and each output is the last non-empty value a leg set.
4. Artifacts: every act run of a workflow uses the same `GITHUB_RUN_ID` and act's artifact store on the host (`artifacts/<workflow>/` in the run directory), so `download-artifact` finds what earlier legs uploaded. A VM leg's store in the guest starts as a copy of it, and when other legs need the VM leg, what it uploaded is copied back (an artifact name the store already has stays: a run can't have two by one name).

osmatrix's patched act accepts `actions/upload-artifact` v7. Stock act 0.2.89, which runs when `act_path` or another `act_version` is set or Docker can't build the patched one, rejects it (osmatrix issue #24), so a workflow that uploads with v7 fails there.

A needed job that was skipped gets a stub with `if: false`, so its dependents are skipped as on GitHub. One that failed (or was cancelled) gets a stub that replays the outputs it set (GitHub evaluates job outputs whatever the result) and then fails, so act runs the leg's job only if its `if:` allows it (`always()`, `failure()`, a check of `needs.<job>.result`). act reports nothing for a job it skips, so the leg is then `skipped`, with an `error` naming the failed need. When a needed leg left no result (it errored, or its result wasn't recorded), the legs that need it error without running.

A needed job that can't run as its own leg (no configured guest serves its `runs-on`) runs inside each leg that needs it, as `act -j` does, and is listed in the leg's `inlineNeeds`; its own needs are replayed as above. On Windows legs, the `run:` steps without a `shell:` of such a Linux-only job run under Git Bash.

The fields of a leg in `ci_status` include `neededOnly` and `replayed` (each needed job with the result the leg got and the legs that produced it).

## How the repo gets into a guest

- `ci_run` snapshots the host working tree (tracked files plus untracked files that aren't ignored, uncommitted changes included) and checks it out with Git in the guest, in a fresh clone each run (config, hooks and refs that a previous run's steps changed don't carry over). The guest's Git config decides line endings, file modes and symlinks, as on GitHub's runners: Windows legs get CRLF text files, a clean `git status` for committed files, and real symlinks. Objects are kept on both sides, so later runs send only what changed, untracked files included.
- `HEAD` in the guest is the host's commit and branch (`GITHUB_SHA`, `GITHUB_REF`), and `origin` is the host's `origin` URL (`GITHUB_REPOSITORY`). The guest's index is the host's index, so staged and unstaged changes show in `git status` and `git diff` as on the host, as they do on Linux legs; a cleanliness check (`git diff --exit-code`) fails locally for them but passes on GitHub once they're committed.
- Each run starts from a clean tree: ignored files, build output and earlier runs' files in `work/<name>` are removed.
- Fallback: directories outside a Git repository, and repositories with Git LFS or other filters, submodules or nested repositories, are copied file by file with the host's `.git`. Then line endings, modes and symlinks follow the host (LF on Windows legs), and the leg's log says "copying files instead of a git checkout". If the checkout fails in the guest, the leg copies too and lists a warning. Report such a leg's line-ending results as a difference from GitHub.
