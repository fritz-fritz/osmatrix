# osmatrix for Codex

Local Ubuntu, Windows and macOS environments for your agent, plus local GitHub Actions matrix runs with [act](https://github.com/nektos/act). Test Windows and macOS legs before you push, run commands in each OS, sync files, forward ports to reach apps running in a guest, and take screenshots.

## Install

```bash
codex plugin marketplace add fritz-fritz/osmatrix
codex plugin add osmatrix@fritztech
```

Then enable **osmatrix** under Plugins.

The plugin adds the **osmatrix** skill and the **osmatrix** MCP server (`npx -y osmatrix@0 mcp`, so Node.js 22.18+ is required). The host also needs Docker, plus KVM for the Windows and macOS VMs. On Apple Silicon, macOS guests use [tart](https://tart.run) instead. Run `npx osmatrix doctor` to see what your machine supports.

## First use

Start with "Check this host's prerequisites and plan this repo's CI." The agent uses `host_doctor` and `ci_plan` before starting guests, and passes the absolute repository path to the CI tools.

Then ask to "run just the Windows CI legs" or "start the dev server in Windows and forward its port." Guest setup is automatic: `env_setup` installs and provisions the OS. macOS guests need your one-time consent to Apple's macOS Software License Agreement, and the agent will ask for it. Available guests depend on the host; an existing SSH machine can supply an OS your host cannot run.

See the [main README](https://github.com/fritz-fritz/osmatrix#readme) for details.
