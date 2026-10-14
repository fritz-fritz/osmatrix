---
name: osmatrix-ci
description: Run a repository's GitHub Actions workflows locally with act before pushing, including OS matrices - ubuntu legs on the host's Docker, windows/macos legs inside local VMs. Plan, run, poll, read the logs of failed legs, re-run a single leg, and report what a local run cannot reproduce. Use when asked to "run CI locally" or "test the Windows/macOS job", when a GitHub Actions leg failed on another OS, or when a change touches workflow files or OS-specific code (paths, shells, line endings, native deps).
---

# osmatrix-ci: run GitHub Actions workflows locally

osmatrix gives agents local **guests** (an `ubuntu` container, `windows`/`macos` VMs, or any machine over ssh) and **local GitHub Actions runs** with act. This skill covers the CI loop. Sibling skills in the same plugin: `osmatrix-guests` (run commands, copy files, forward ports and drive the GUI inside a guest) and `osmatrix-setup` (host checks, creating guests, troubleshooting).

Use the **MCP tools** (`ci_plan`, `ci_run`, ...) when they are available: they are the supported interface, and their safety annotations let the client ask for confirmation where it matters.

**If the osmatrix MCP tools are missing from this session, tell the user before doing anything else.** Say that the osmatrix MCP server isn't loaded, so you'll use the `osmatrix` CLI instead, and suggest the likely fix: enable or restart the osmatrix MCP server in the client's MCP/plugin settings (a server that failed once may stay failed until it is toggled off and on). Then continue with the CLI: every tool has a matching command (see [references/reference.md](references/reference.md)); add `--json` for machine output. Check `osmatrix --version` first; if the command isn't found, `npx -y osmatrix@0 <command>` works once osmatrix is published on npm. Otherwise tell the user it isn't installed, and stop.

Always pass the repository's **absolute host path** as `repo` to every `ci_*` tool: the MCP server's working directory may be the plugin cache, not the user's checkout.

## How legs run

A workflow's matrix is expanded into legs. `ubuntu-*` legs run with act on the host's Docker; `windows-*` / `macos-*` legs run act *inside* the matching VM (host mode), after checking the working tree out in it with Git, as `actions/checkout` does (details in [references/reference.md](references/reference.md)).

Linux legs use `act_linux_image` from the osmatrix config. At its default (`catthehacker/ubuntu:act-24.04`), osmatrix runs them in `osmatrix/ubuntu:act-24.04-<hash>-rust<version>` instead: that image plus rustup with rustfmt and clippy, at the Rust version of GitHub's latest ubuntu24 runner image (looked up once a day) and installed as `stable`, as on GitHub. The first Linux leg after the runner's Rust version changes builds it locally (a few minutes, needs network) and says so in the leg's log; concurrent runs wait for that one build. Offline, legs use the newest local `osmatrix/ubuntu` image, or build one with the current stable Rust; if that fails too, they run on act's plain image without Rust, and the log warns. Report Rust failures after such a warning as an environment gap. A user-set `act_linux_image` is used as is.

A windows/macos leg needs that guest to be `ready` (`env_status`, CLI `osmatrix status`). If the guest is `absent` or its status `detail` says "not set up", follow `osmatrix-setup` first; VM setup takes 20–60 min. VMs are slow to boot (1–3 min), so **don't start VMs you don't need**, and leave a VM running while you iterate.

## The loop

1. **Plan**: `ci_plan` (`osmatrix ci plan`). Shows every leg, where it runs, and warnings for things act can't reproduce. Starts nothing.
2. **Run**: `ci_run` (`osmatrix ci run`). Returns a run id immediately. Narrow it as much as you can:
   - `only: ["windows"]` / `--only windows` (targets: `linux`, `windows`, `macos`, or guest names)
   - `job`, `workflow`, `matrix: {node: "22"}` / `-m node=22`
   - Run uncommitted work as-is: the working tree (respecting `.gitignore`) is what gets tested.
   - Tag- or release-triggered workflows: pass `event_payload`, e.g. `{"ref": "refs/tags/v1.2.3"}` (CLI: `--event-file`), so `github.ref`/`GITHUB_REF_NAME` look like a real tag push. Steps that need GitHub's OIDC token (attestations, trusted publishing, creating releases) can't run locally; workflows usually guard them with `if: ${{ !env.ACT }}`.
3. **Poll**: `ci_status` every 30–60 s until `state: done`. Each failed leg has `failedStep` and a log `tail`.
   - Concurrent runs are safe: a leg that needs an act job container or a guest another run is using stays `pending` with `waitingFor` naming that run, and starts when it's free. act names job containers after the workflow name and job id only, so this applies across checkouts too.
4. **Dig in**: `ci_logs` with `leg` (id or substring), `grep`, `tail`.
5. **Reproduce interactively** in the same guest (see `osmatrix-guests`): the synced repo is at `work/<repo-name>` (relative to the guest user's home).
   - `env_exec {guest: "windows", cwd: "work/myrepo", command: "npm test"}`
6. **Fix on the host**, then re-run **only the failing leg(s)**. A final full `ci_run` before pushing is a good habit.

Secrets: put `KEY=value` lines in `.osmatrix/secrets` (or act's default `.secrets`) in the repo; they're passed with `--secret-file` and never printed by osmatrix. `GITHUB_TOKEN` is not provided automatically — add it there if a workflow needs it (e.g. `gh auth token`).

## Reading results honestly

Local green is strong evidence, not proof. Report anything that didn't run or differs from GitHub:
- `ci_plan` warnings: `services:` on non-Linux legs, OIDC (`id-token`), `needs:` that cross OSes, matrices built from expressions, remote reusable workflows (skipped), and Linux legs that use Rust (a Rust setup action, `rustup`/`cargo`/`rustc` in `run:`, or a `rust-toolchain(.toml)` file) while a user-set `act_linux_image` may lack the Rust GitHub preinstalls.
- `needs:`: every job runs once, as its own legs on its own target, and each leg that needs it gets its result, outputs and artifacts replayed, as on GitHub (a Windows leg gets a Linux job's results from its one run on the host, and the reverse). Needed jobs the filter leaves out still run (`neededOnly` legs), and a leg stays `pending` with `waitingFor` naming the legs it needs until they finish. A leg whose needed job failed is `skipped` (as on GitHub) unless its `if:` lets it run; debug the needed job's own leg. A needed job with no local target runs inside each leg that needs it, and `ci_plan` says so.
- osmatrix runs its own patched build of act 0.2.89 on the host and in every guest. It keeps the file commands (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, …) under `RUNNER_TEMP` as GitHub does, and its artifact server works with `actions/upload-artifact` v7 (also `archive: false`) and `download-artifact` v8. Stock act gets both wrong. A leg that runs stock act anyway says so in its `warnings`: the user set `act_path` or another `act_version`, or Docker wasn't available to build the patched act. In those legs, a failure that mentions `act/workflow/outputcmd.txt` or `unknown field "mime_type"` is an act difference, not a code bug; the leg's `warnings` point it out.
- macOS guests on Linux/Windows hosts are Intel (x86_64). Homebrew stopped building Intel bottles in August 2026, so their Homebrew is pinned to the last homebrew-core that has them (`ci_plan` warns on `brew` steps): `brew install` pours a bottle, but of the formula version from then, older than on GitHub's runners. A formula added or changed later isn't there or builds from source, and a step that runs `brew update`/`brew upgrade` leaves the pins (`env_reset` restores them). Report a version difference as an environment gap. With `homebrew = false` provisioning skips Homebrew, but a Homebrew installed earlier stays; check with `env_exec` (`command -v brew`) before calling a brew step impossible. On Apple Silicon hosts (tart), brew is the version GitHub's arm64 runner image ships, with current formulae as on GitHub.
- Guests are leaner than GitHub-hosted images: preinstalled SDKs (Xcode versions, Visual Studio, Android SDK, many language versions) may be missing. Prefer `setup-*` actions; if a tool is missing in a guest, say so instead of concluding the code is broken.
- macOS legs: GitHub's runners allow passwordless sudo. dockur macOS guests (Linux/Windows hosts) get it during setup; on tart and `ssh` macOS guests `sudo` steps only work after `osmatrix provision <guest> --passwordless-sudo`. A sudo password prompt there is an environment gap, not a code bug.
- Windows legs with Rust or C/C++ toolchains need the MSVC Build Tools, which Windows guests get at setup. A leg warning about missing MSVC tools (or a `link: extra operand` failure) means the guest predates them or set `msvc = false`: that's an environment gap, not a code bug. Follow the warning (`osmatrix provision <guest>`, then `env_snapshot`) with the user's agreement; it takes several GB and 10-20 min.
- Windows legs run in host mode inside the VM: `shell: bash` steps need Git Bash (installed), Docker-based actions don't work there. When a Linux need of a Windows leg has no local target and runs in the VM, osmatrix runs its `run:` steps that have no `shell:` with Git Bash (GitHub would use bash), but Linux-only tools in it (`apt-get`, `docker`, …) fail. To check such a job itself, run it on its own Linux leg.

## Artifacts

Run artifacts and logs live in `<repo>/.osmatrix/runs/<id>/` (git-ignored automatically). `env_down` a VM when you're done with it (frees 8 GB RAM each) and mention to the user if you leave one running.
