# Contributing to osmatrix

Thanks for your interest! Bug reports, fixes, new guest backends, docs and ideas are all welcome.

Using an AI coding agent is fine, and so is letting one help you file an issue. Read the [AI policy](AI_POLICY.md) first: you're responsible for what you submit, you say when AI did substantial work, and agents post only with their user's explicit consent.

## Licensing of contributions

osmatrix is MIT-licensed, and its copyright is held by "osmatrix contributors". By submitting a contribution (a pull request, patch or suggested change), you agree that it is licensed under the [MIT License](LICENSE), on the same terms as the rest of the project. You also confirm that you have the right to contribute it. Don't submit code you can't license this way, such as code copied from projects under incompatible licenses.

## Reporting issues

- **Bugs and feature requests:** open an issue at https://github.com/fritz-fritz/osmatrix/issues and pick the bug report or feature request form; it asks for your host OS, the output of `osmatrix doctor`, the guest involved, and the command or tool call that failed. CI run logs from `.osmatrix/runs/<id>/` help a lot.
- **Security vulnerabilities:** please don't open a public issue. Report them privately through GitHub's [security advisory form](https://github.com/fritz-fritz/osmatrix/security/advisories/new).

## Development setup

You need Node.js 22.18 or later and Docker. Running Windows or macOS guests also needs KVM (Linux, or Windows with WSL2), a Mac, or QEMU on Windows on ARM (see the compatibility matrix in the README). For `npm run codeql`, also install the CodeQL CLI. The recommended way is GitHub's `gh` extension, which keeps it up to date (steps under [Checks before you push](#checks-before-you-push)):

```bash
gh extension install github/gh-codeql && gh codeql set-version latest && gh codeql install-stub ~/.local/bin/
```

```bash
git clone https://github.com/fritz-fritz/osmatrix && cd osmatrix
npm ci
npm test            # unit + MCP tests (node:test; TypeScript runs directly)
npm run validate    # skills, manifest versions, listing limits, MCP commands
npm run build       # tsc -> dist/
node src/cli.ts doctor
```

To try your checkout as a plugin, run `npm run package:plugins`. It builds Claude, Cursor and Codex plugins that bundle the runtime, plus a local marketplace in `artifacts/`; the README explains how to install from it. To use your checkout from a terminal or agent without packaging, run `npm link` (or `node src/cli.ts …`), then `osmatrix install-agents`.

Set `OSMATRIX_HOME=/some/dir` to keep experiments apart from your real guests: config, data and Docker resource names are then all separate. (The patched act's Go cache volume and the lock around building it are shared by every install on the host.)

### Changing the act patch

osmatrix builds act from source with `assets/act/act-v0.2.89-osmatrix.patch` (see `src/core/act.ts`). To change it, apply it to the v0.2.89 source with `git apply`, edit, run `gofmt`, and write the result back with `git diff` (keep the header text). Any change to the patch, the Go image or the build script changes the build's cache key, so the next run rebuilds act and pushes it to guests again. Check it with `node src/cli.ts install-act --all-targets` and `node src/cli.ts ci run --repo fixtures/act-compat --only linux --job <job> --wait` for each of `file-commands`, `docker-action` and `download`. Moving to a newer act means a new source sha256 and patch in `act.ts`.

## Checks before you push

| Script | What it runs |
|---|---|
| `npm run check` | typecheck, unit + MCP tests, plugin validation (fast, no Docker) |
| `npm run codeql` | GitHub's code-scanning queries (JavaScript/TypeScript, Python, Actions), locally |
| `npm run ci:local` | `.github/workflows/ci.yml` through act with this checkout's osmatrix: Linux legs on Docker, Windows/macOS legs in your guests |
| `npm run ci:local:linux` | only the Linux legs (Docker only, no VMs needed) |
| `npm run release:rehearse` | `release.yml` as if `v<version>` were pushed; publishing is a dry run |
| `npm run verify` | `check` + `codeql` + `ci:local`, the full pre-push gate |
| `npm run release:tag` | maintainers: tag and push `v<version>`, only after the pushed commit's GitHub checks passed |

osmatrix runs its own CI locally, so a passing `npm run verify` (or `ci:local:linux` when you have no VMs) means GitHub CI should pass too. Guests you can't run on your host are fine to skip; GitHub CI covers all three OSes.

`npm run codeql` needs the CodeQL CLI. The easiest way to install it and keep it updated is GitHub's `gh` extension:

```bash
gh extension install github/gh-codeql
gh codeql set-version latest          # rerun to update; `gh extension upgrade gh-codeql` updates the manager
gh codeql install-stub ~/.local/bin/  # puts a `codeql` command on PATH
```

Query packs are downloaded and cached on first use.

## Where things live

| Path | What |
|---|---|
| `src/core/` | config, paths, processes, ssh (exec, file transfer, forwards), host checks |
| `src/backends/` | guest backends: `container`, `dockur`, `tart`, `ssh` (one `Backend` interface) |
| `src/setup.ts` | unattended guest setup (macOS Recovery automation lives here) |
| `src/ci/` | workflow planning (matrix expansion, routing), the act runner, and the scheduler that runs each job once and replays its results into the legs that need it |
| `src/mcp.ts`, `src/cli.ts` | the MCP server and the CLI, thin layers over the same functions |
| `assets/` | guest provisioning scripts, the container image and the act patch (shipped in the npm package) |
| `fixtures/` | workflows that CI runs through osmatrix: `matrix-demo` (an OS matrix) and `act-compat` (the act differences the patch fixes) |
| `skills/` | the agent skills: `osmatrix-ci`, `osmatrix-guests`, `osmatrix-setup`, each with its own `references/` |
| `.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/`, `plugin.json`, `mcp.json` | per-client manifests; the repository root is the plugin |
| `scripts/` | manifest sync, skill and plugin validation, packaging |

## Guidelines

- **Match the surrounding code:** TypeScript run directly by Node (erasable syntax only), small focused modules, comments that explain *why*.
- **Every MCP tool is also a CLI command.** Add both, and document new tools in the matching skill's `references/reference.md`.
- **New MCP tools need an entry in `TOOL_ANNOTATIONS`** (`src/mcp.ts`), with honest `readOnlyHint` / `destructiveHint` / `openWorldHint` values. The MCP test fails without one.
- **Cross-platform:** no shelling out through bash on the host; spawn with argument arrays. Paths come from `src/core/paths.ts`. Never assume a port is free.
- **Keep each skill self-contained** (links only inside its directory; names prefixed `osmatrix-`, except the bare `osmatrix`, which only maps to the others): Codex, Cursor and skills.sh install skills flat, and skills.sh never drops a skill it once listed, so a skill's name is for keeps. `npm run validate` checks this.
- **Keep the skills accurate.** Agents follow them literally, so describe real behavior and limits.
- **Add or update tests** in `test/` for behavior changes.
- **Pin GitHub Actions to full commit SHAs** with a version comment, like `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`. Tags can be moved; commits can't. `npm run validate` rejects unpinned actions, and Dependabot keeps the SHAs and comments current. npm tools that workflows run belong in `.github/ci-tools/package.json`. They're pinned by its lockfile, updated by Dependabot, and installed with `npm ci --prefix .github/ci-tools`, never with `npx -y` or `npm install <pkg>@<version>`, which the validator also rejects.

## Dependabot

`.github/dependabot.yml` checks npm packages (the package and the CI tools in `.github/ci-tools`) and GitHub Actions weekly. A new version must be at least 7 days old before Dependabot proposes it (a supply-chain cooldown), and minor/patch updates are grouped into one PR per ecosystem.

`.github/workflows/dependabot-auto-merge.yml` approves each Dependabot PR and turns on GitHub auto-merge (squash) for that PR only. GitHub merges it once the required `CI Gate` check passes; failing PRs stay open for a human. The repository's **Allow auto-merge** setting only makes per-PR auto-merge available, so other PRs merge exactly as before. Tighten the policy in the workflow's `with:` block: `target: minor` or `patch` leaves bigger bumps for review, and `exclude: 'pkg-a,pkg-b'` holds packages back.

One-time setup for maintainers:

1. **Settings → General → Pull Requests:** enable **Allow auto-merge**.
2. **A GitHub App** with repository permissions **Contents: read and write** and **Pull requests: read and write**, no webhook, installed on this repository. The Bookclerk merge App can be reused by adding this repository to its installation. The App token matters: merges made with `GITHUB_TOKEN` don't start `push` workflows, so CI on `main` would be skipped.
3. **Dependabot secrets** (Settings → Secrets and variables → **Dependabot**; Dependabot runs don't receive Actions secrets): `DEPENDABOT_MERGE_APP_CLIENT_ID` (the App's client ID) and `DEPENDABOT_MERGE_APP_KEY` (a private key generated for the App).
4. **A ruleset on `main` that requires the `CI Gate` status check.** Without a required check, there's nothing for auto-merge to wait on.

The workflow must run while checks are still pending: GitHub refuses to enable auto-merge on a PR that's already mergeable. To retry a Dependabot PR, for example after adding the secrets, comment `@dependabot rebase`.

## Pull requests

1. Fork, branch from `main`, and keep each PR focused on one change. Release notes list PRs by title, so a fix bundled into an unrelated PR is hard to find.
   Start the branch name with its type: `fix`, `feat`, `docs`, `ci`, `chore` or `security`, followed by `/`, `-` or `_`. A leading name segment is fine, so the defaults of coding agents work: `fix/login`, `claude/fix-login-x7k2`, `cursor/feat-guest-3f9a` and `copilot/fix-123` are all recognized. The type labels the PR (`bug`, `enhancement`, `documentation`, `ci`, `chore`, `security`), and the label decides its section in the release notes ([`.github/release.yml`](.github/release.yml)).
   If the PR closes an issue (write `Fixes #12` in the description), it also gets that issue's type labels (`bug`, `enhancement`, `breaking` and so on), so a fix for an issue filed as a bug report is labeled `bug` whatever the branch is called. Maintainers add `breaking` by hand, and `skip-release-notes` leaves a PR out. A label removed by hand stays removed on later pushes; add it back by hand to undo that.
2. Before you push, run `npm run verify` (or at least `npm run check` and `npm run ci:local:linux`); see [Checks before you push](#checks-before-you-push).
3. Describe what changed, why, and how you tested it, including which host OS and guests. If an AI tool wrote a substantial part of it, say which tool and what it did ([AI policy](AI_POLICY.md)); the pull request template asks.

Maintainers squash-merge pull requests. Releases are cut by maintainers by pushing a `v<x.y.z>` tag (see "Releasing" in the README); please don't bump the version in PRs.
