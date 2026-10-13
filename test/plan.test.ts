import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { expandMatrix, msvcHint, msvcUses, plan, runCommands, setDefaultRunShell, substitute } from "../src/ci/plan.ts";
import { defaultConfig, mergeConfig } from "../src/core/config.ts";

test("expandMatrix: cartesian product", () => {
  const c = expandMatrix({ os: ["a", "b"], node: [20, 22] });
  assert.equal(c.length, 4);
  assert.deepEqual(c[0], { os: "a", node: 20 });
});

test("expandMatrix: exclude and include", () => {
  const c = expandMatrix({
    os: ["ubuntu-latest", "windows-latest"],
    node: [20, 22],
    exclude: [{ os: "windows-latest", node: 20 }],
    include: [
      { os: "windows-latest", experimental: true },
      { os: "macos-latest", node: 22 },
    ],
  });
  assert.equal(c.length, 4);
  assert.deepEqual(c.find((x) => x.os === "windows-latest"), { os: "windows-latest", node: 22, experimental: true });
  assert.ok(c.some((x) => x.os === "macos-latest" && x.node === 22));
});

test("expandMatrix: include-only matrix", () => {
  const c = expandMatrix({ include: [{ os: "x" }, { os: "y" }] });
  assert.deepEqual(c, [{ os: "x" }, { os: "y" }]);
});

test("expandMatrix: expression matrix warns", () => {
  const w: string[] = [];
  assert.deepEqual(expandMatrix("${{ fromJSON(needs.a.outputs.m) }}", w), [{}]);
  assert.equal(w.length, 1);
});

test("substitute matrix expressions", () => {
  assert.deepEqual(substitute("${{ matrix.os }}", { os: "windows-2025" }), { value: "windows-2025", unresolved: [] });
  assert.equal(substitute("${{ matrix.cfg.runner }}", { cfg: { runner: "macos-15" } }).value, "macos-15");
  assert.deepEqual(substitute("${{ inputs.x }}", {}).unresolved, ["${{ inputs.x }}"]);
});

function tmpRepo(workflow: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-plan-"));
  fs.mkdirSync(path.join(d, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(d, ".github", "workflows", "ci.yml"), workflow);
  return d;
}

const linuxCfg = () =>
  mergeConfig(defaultConfig(), {
    guests: {
      windows: { os: "windows", backend: "dockur" },
      macos: { os: "macos", backend: "dockur" },
    },
  });

test("plan maps legs to host/guests", () => {
  const repo = tmpRepo(`
on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-15]
    steps: [{ run: echo hi }]
  odd:
    runs-on: [self-hosted, gpu-box]
    steps: [{ run: echo hi }]
`);
  const p = plan(repo, linuxCfg());
  const t = Object.fromEntries(p.legs.map((l) => [l.id, l.target ?? `skip:${l.skip}`]));
  assert.equal(t["build-ubuntu-latest"], "host");
  assert.equal(t["build-windows-latest"], "windows");
  assert.equal(t["build-macos-15"], "macos");
  assert.match(t["odd"], /^skip:/);
});

test("plan filters by target and matrix", () => {
  const repo = tmpRepo(`
on: [pull_request]
jobs:
  t:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest], node: [20, 22] } }
    steps: [{ run: echo }]
`);
  assert.equal(plan(repo, linuxCfg(), { only: ["windows"] }).legs.length, 2);
  assert.equal(plan(repo, linuxCfg(), { only: ["linux"], matrix: { node: "22" } }).legs.length, 1);
});

test("plan warns on cross-OS needs and services", () => {
  const repo = tmpRepo(`
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  b:
    needs: a
    runs-on: windows-latest
    services: { redis: { image: redis } }
    steps: [{ run: echo }]
`);
  const b = plan(repo, linuxCfg()).legs.find((l) => l.job === "b")!;
  assert.ok(b.warnings.some((w) => w.includes("needs")));
  assert.ok(b.warnings.some((w) => w.includes("services")));
});

test("plan collects labels of transitive needs", () => {
  const repo = tmpRepo(`
on: push
jobs:
  prep:
    runs-on: ubuntu-22.04
    steps: [{ run: echo }]
  mid:
    needs: prep
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  win:
    needs: [mid]
    runs-on: windows-latest
    steps: [{ run: echo }]
`);
  const win = plan(repo, linuxCfg()).legs.find((l) => l.job === "win")!;
  assert.deepEqual(win.needsLabels.sort(), ["ubuntu-22.04", "ubuntu-latest"]);
});

test("plan skips fan-in jobs whose needs already run as legs, unless asked for by name", () => {
  const repo = tmpRepo(`
on: push
jobs:
  unit:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    steps: [{ run: echo }]
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gate:
    needs: [unit, lint]
    if: always()
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  deploy:
    needs: [build]
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`);
  const legs = plan(repo, linuxCfg()).legs;
  assert.match(legs.find((l) => l.job === "gate")!.skip ?? "", /already run as legs/);
  // "build" is not a leg in this run (no such job), so deploy isn't treated as a fan-in.
  assert.equal(legs.find((l) => l.job === "deploy")!.skip, undefined);
  assert.equal(plan(repo, linuxCfg(), { job: "gate" }).legs[0].skip, undefined);
  // With only Linux legs selected, unit's Windows leg is filtered out but unit still runs on Linux.
  assert.match(plan(repo, linuxCfg(), { only: ["linux"] }).legs.find((l) => l.job === "gate")!.skip ?? "", /already run/);
});

test("Windows legs list their Linux needs, also when planned with --job", () => {
  const repo = tmpRepo(`
on: push
jobs:
  plan:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gw:
    needs: plan
    strategy: { matrix: { os: [ubuntu-latest, macos-latest, windows-latest] } }
    runs-on: \${{ matrix.os }}
    steps: [{ run: echo }]
`);
  const legs = plan(repo, linuxCfg(), { job: "gw" }).legs;
  const win = legs.find((l) => l.targetOs === "windows")!;
  assert.deepEqual(win.linuxNeeds, ["plan"]);
  assert.ok(win.warnings.some((w) => w.includes("Git Bash")));
  const mac = legs.find((l) => l.targetOs === "macos")!;
  assert.ok(mac.warnings.some((w) => w.includes(`needs "plan" runs on another OS`)));
  const linux = legs.find((l) => l.targetOs === "linux")!;
  assert.equal(linux.linuxNeeds, undefined);
  assert.ok(!linux.warnings.some((w) => w.includes("needs")));
});

test("setDefaultRunShell gives jobs a run shell unless one is set", () => {
  const src = `# CI
on: push
jobs:
  plan: # gate
    runs-on: ubuntu-latest
    steps:
      - run: |
          set -euo pipefail
          echo ok
  pinned:
    runs-on: ubuntu-latest
    defaults: { run: { shell: sh } }
    steps: [{ run: echo }]
  called:
    uses: ./.github/workflows/x.yml
`;
  const { text, changed } = setDefaultRunShell(src, ["plan", "pinned", "called", "missing"], "'C:/Git/bin/bash.exe' -e {0}");
  assert.deepEqual(changed, ["plan"]);
  assert.ok(text.includes("# gate") && text.includes("set -euo pipefail"));
  const jobs = (YAML.parse(text) as { jobs: Record<string, { defaults?: { run: { shell: string } } }> }).jobs;
  assert.equal(jobs.plan.defaults?.run.shell, "'C:/Git/bin/bash.exe' -e {0}");
  assert.equal(jobs.pinned.defaults?.run.shell, "sh");
  const wfDefault = "defaults: { run: { shell: bash } }\n" + src;
  assert.deepEqual(setDefaultRunShell(wfDefault, ["plan"], "x").changed, []);
});

test("needed jobs with legs on Linux and other OSes are not given a bash default", () => {
  const repo = tmpRepo(`
on: push
jobs:
  build:
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    runs-on: \${{ matrix.os }}
    steps: [{ run: echo }]
  ship:
    needs: build
    runs-on: windows-latest
    steps: [{ run: echo }]
`);
  const ship = plan(repo, linuxCfg(), { job: "ship" }).legs[0];
  assert.deepEqual(ship.linuxNeeds, []);
  assert.ok(ship.warnings.some((w) => w.includes(`needs "build" runs on Linux and other OSes`)));
});

test("msvcUses finds Rust and C/C++ toolchain steps", () => {
  assert.deepEqual(
    msvcUses({
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "dtolnay/rust-toolchain@stable" },
        { uses: "Swatinem/rust-cache@v2" },
        { run: "cargo build --release" },
      ],
    }),
    ["dtolnay/rust-toolchain", "run: cargo"],
  );
  assert.deepEqual(msvcUses({ steps: [{ uses: "actions-rust-lang/setup-rust-toolchain@9d7e65c3" }] }), ["actions-rust-lang/setup-rust-toolchain"]);
  assert.deepEqual(msvcUses({ steps: [{ uses: "ilammy/msvc-dev-cmd@v1" }, { uses: "microsoft/setup-msbuild@v2" }] }), [
    "ilammy/msvc-dev-cmd",
    "microsoft/setup-msbuild",
  ]);
  assert.deepEqual(msvcUses({ steps: [{ run: "npm ci\nrustup target add wasm32-unknown-unknown" }] }), ["run: rustup"]);
  // Not commands: paths, other words, other actions.
  assert.deepEqual(msvcUses({ steps: [{ run: 'echo "$HOME/.cargo/bin" >> $GITHUB_PATH' }, { run: "npm run cargo-cult" }, { uses: "actions/setup-node@v4" }] }), []);
  assert.deepEqual(msvcUses({}), []);
  // Every actions-rs action, reported by name.
  assert.deepEqual(msvcUses({ steps: [{ uses: "actions-rs/clippy-check@v1" }, { uses: "actions-rs/toolchain@v1" }] }), [
    "actions-rs/clippy-check",
    "actions-rs/toolchain",
  ]);
});

test("runCommands finds commands only in command position", () => {
  assert.deepEqual(runCommands("cargo build"), ["cargo"]);
  // Arguments are not commands.
  assert.ok(!runCommands("echo cargo build").includes("cargo"));
  assert.ok(!runCommands("npm run cargo").includes("cargo"));
  // Windows looks commands up case-insensitively; paths and .exe are stripped.
  assert.deepEqual(runCommands("Cargo build"), ["cargo"]);
  assert.deepEqual(runCommands('"$HOME/.cargo/bin/cargo" test'), ["cargo"]);
  assert.deepEqual(runCommands("C:\\Users\\me\\.cargo\\bin\\rustup.exe show"), ["rustup"]);
  // Separators and wrappers.
  assert.deepEqual(runCommands("npm ci && cargo test || rustup show; echo done | tee x"), ["npm", "cargo", "rustup", "echo", "tee"]);
  assert.deepEqual(runCommands("(cd crate; cargo fmt --check)"), ["cd", "cargo"]);
  assert.deepEqual(runCommands("sudo -E cargo install x"), ["cargo"]);
  assert.deepEqual(runCommands("time cargo build"), ["cargo"]);
  assert.deepEqual(runCommands("env RUSTFLAGS=-Dwarnings CARGO_INCREMENTAL=0 cargo build"), ["cargo"]);
  assert.deepEqual(runCommands("RUSTFLAGS=-Dwarnings cargo build"), ["cargo"]);
  assert.deepEqual(runCommands("& cargo build"), ["cargo"]);
  assert.deepEqual(runCommands("# cargo build\n  \nnpm test"), ["npm"]);
});

test("plan adds MSVC uses of needed jobs, which act runs in the Windows guest", () => {
  const repo = tmpRepo(`
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: cargo clippy }]
  win:
    needs: lint
    runs-on: windows-latest
    steps: [{ run: npm test }]
`);
  const optedOut = mergeConfig(defaultConfig(), { guests: { windows: { os: "windows", backend: "dockur", msvc: false } } });
  const leg = plan(repo, optedOut, { job: "win" }).legs[0];
  assert.deepEqual(leg.msvcUses, ["run: cargo (needs: lint)"]);
  assert.ok(leg.warnings.some((w) => /run: cargo \(needs: lint\).*msvc = false/.test(w)));
  // A Linux leg never needs MSVC, even with Rust steps.
  assert.equal(plan(repo, optedOut, { job: "lint" }).legs[0].msvcUses, undefined);
});

const rustWorkflow = `
on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    steps:
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo test
`;

test("plan marks Windows legs that need MSVC and warns when the guest opted out", () => {
  const repo = tmpRepo(rustWorkflow);
  const legs = Object.fromEntries(plan(repo, linuxCfg()).legs.map((l) => [l.id, l]));
  // Only Windows legs need MSVC; with the default (msvc on) the check waits until the leg runs.
  assert.equal(legs["build-ubuntu-latest"].msvcUses, undefined);
  assert.deepEqual(legs["build-windows-latest"].msvcUses, ["dtolnay/rust-toolchain", "run: cargo"]);
  assert.ok(!legs["build-windows-latest"].warnings.some((w) => /MSVC/.test(w)));

  const optedOut = mergeConfig(defaultConfig(), { guests: { windows: { os: "windows", backend: "dockur", msvc: false } } });
  const w = plan(repo, optedOut, { only: ["windows"] }).legs[0].warnings.join("\n");
  assert.match(w, /dtolnay\/rust-toolchain, run: cargo/);
  assert.match(w, /msvc = false/);
  assert.match(w, /osmatrix provision windows/);
  assert.match(w, /osmatrix snapshot windows/);
});

test("msvcHint tells how to install the tools", () => {
  const h = msvcHint({ name: "win" }, ["run: cargo"], "guest win has none");
  assert.match(h, /run `osmatrix provision win`/);
  assert.doesNotMatch(h, /remove msvc = false/);
  assert.match(msvcHint({ name: "win", msvc: false }, ["run: cargo"], "x"), /remove msvc = false from \[guests\.win\]/);
});
