# osmatrix for Cursor

Local Ubuntu, Windows and macOS environments for your agent, plus local GitHub Actions matrix runs with [act](https://github.com/nektos/act). Test Windows and macOS legs before you push, run commands in each OS, sync files, forward ports to reach apps running in a guest, and take screenshots.

## Install

In Cursor: **Dashboard → Plugins → Team Marketplaces → Add Marketplace → Import from Repo**, enter `fritz-fritz/osmatrix`, then enable **osmatrix**.

The plugin adds the **osmatrix** skill and the **osmatrix** MCP server (`npx -y osmatrix@0 mcp`, so Node.js 22.18+ is required). The host also needs Docker, plus KVM for the Windows and macOS VMs. On Apple Silicon, macOS guests use [tart](https://tart.run) instead. Run `npx osmatrix doctor` to see what your machine supports.

## First use

Ask the agent to "set up the windows guest" or "run this repo's CI locally". Guest setup is fully automatic: `env_setup` installs and provisions the OS. macOS guests need your one-time consent to Apple's macOS Software License Agreement, and the agent will ask for it.

See the [main README](https://github.com/fritz-fritz/osmatrix#readme) for details.
