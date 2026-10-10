# Contributing to osmatrix

Thanks for your interest! Bug reports, fixes, new guest backends, docs and ideas are all welcome.

## Licensing of contributions

osmatrix is MIT-licensed, and its copyright is held by "osmatrix contributors". By submitting a contribution (a pull request, patch or suggested change), you agree that it is licensed under the [MIT License](LICENSE), on the same terms as the rest of the project. You also confirm that you have the right to contribute it. Don't submit code you can't license this way, such as code copied from projects under incompatible licenses.

## Reporting issues

- **Bugs and feature requests:** open an issue at https://github.com/fritz-fritz/osmatrix/issues. Include your host OS, the output of `osmatrix doctor`, the guest involved, and the command or tool call that failed. CI run logs from `.osmatrix/runs/<id>/` help a lot.
- **Security vulnerabilities:** please don't open a public issue. Report them privately through GitHub's [security advisory form](https://github.com/fritz-fritz/osmatrix/security/advisories/new).

## Development setup

You need Node.js 22.18 or later and Docker. Running Windows or macOS guests also needs KVM (Linux, or Windows with WSL2) or an Apple Silicon Mac.

```bash
git clone https://github.com/fritz-fritz/osmatrix && cd osmatrix
npm ci
npm test            # unit + MCP tests (node:test; TypeScript runs directly)
npm run validate    # skill copies, artwork, manifests, listing limits, MCP commands
npm run build       # tsc -> dist/
node src/cli.ts doctor
```

To try your checkout as a plugin, run `npm run package:plugins`. It builds Claude, Cursor and Codex plugins that bundle the runtime, plus a local marketplace in `artifacts/`; the README explains how to install from it. To use your checkout from a terminal or agent without packaging, run `npm link` (or `node src/cli.ts …`), then `osmatrix install-agents`.

Set `OSMATRIX_HOME=/some/dir` to keep experiments apart from your real guests: config, data and Docker resource names are then all separate.

## Test your change across operating systems

osmatrix runs its own CI locally, so please rehearse before pushing:

```bash
osmatrix ci plan --repo .
osmatrix ci run --repo . -W ci.yml --wait          # Linux via act, plus Windows/macOS guests you have
osmatrix ci run --repo . -W ci.yml --only linux --wait
```

Guests you can't run on your host are fine to skip; GitHub CI covers all three OSes.

## Where things live

| Path | What |
|---|---|
| `src/core/` | config, paths, processes, ssh (exec, file transfer, forwards), host checks |
| `src/backends/` | guest backends: `container`, `dockur`, `tart`, `ssh` (one `Backend` interface) |
| `src/setup.ts` | unattended guest setup (macOS Recovery automation lives here) |
| `src/ci/` | workflow planning (matrix expansion, routing) and the act runner |
| `src/mcp.ts`, `src/cli.ts` | the MCP server and the CLI, thin layers over the same functions |
| `assets/` | guest provisioning scripts and the container image (shipped in the npm package) |
| `skills/osmatrix/` | the canonical agent skill |
| `claude/`, `cursor/`, `codex/` | per-client plugins; their `skills/` copies are generated |
| `scripts/` | skill/artwork sync, plugin validation and packaging |

## Guidelines

- **Match the surrounding code:** TypeScript run directly by Node (erasable syntax only), small focused modules, comments that explain *why*.
- **Every MCP tool is also a CLI command.** Add both, and document new tools in `skills/osmatrix/reference.md`.
- **New MCP tools need an entry in `TOOL_ANNOTATIONS`** (`src/mcp.ts`), with honest `readOnlyHint` / `destructiveHint` / `openWorldHint` values. The MCP test fails without one.
- **Cross-platform:** no shelling out through bash on the host; spawn with argument arrays. Paths come from `src/core/paths.ts`. Never assume a port is free.
- **Edit the skill only in `skills/`,** then run `npm run sync`. CI fails if the client copies drift.
- **Keep the skill accurate.** Agents follow it literally, so describe real behavior and limits.
- **Add or update tests** in `test/` for behavior changes.

## Pull requests

1. Fork, branch from `main`, and keep each PR focused on one change.
2. Before you push, run `npm test`, `npm run validate` and `npm run typecheck`, and ideally a local `osmatrix ci run` too.
3. Describe what changed, why, and how you tested it, including which host OS and guests.

Maintainers squash-merge pull requests. Releases are cut by maintainers by pushing a `v<x.y.z>` tag (see "Releasing" in the README); please don't bump the version in PRs.
