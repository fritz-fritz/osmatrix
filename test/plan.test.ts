import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { expandMatrix, msvcHint, msvcUses, plan, runCommands, rustUse, setDefaultRunShell, substitute } from "../src/ci/plan.ts";
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

test("every dependent leg, host or VM, waits for the one run of its needs, also when planned with --job", () => {
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
  // plan isn't selected, but runs once because gw needs it.
  assert.deepEqual(
    legs.map((l) => [l.id, l.neededOnly ?? false]),
    [
      ["plan", true],
      ["gw-ubuntu-latest", false],
      ["gw-macos-latest", false],
      ["gw-windows-latest", false],
    ],
  );
  assert.deepEqual(legs[0].neededBy, ["gw-ubuntu-latest", "gw-macos-latest", "gw-windows-latest"]);
  for (const leg of legs.slice(1)) {
    assert.deepEqual(leg.replayNeeds, ["plan"]);
    assert.deepEqual(leg.waitsFor, ["plan"]);
    assert.deepEqual(leg.inlineNeeds, []);
    assert.deepEqual(leg.needsLabels, []);
    assert.equal(leg.neededBy, undefined);
  }
  for (const os of ["windows", "macos"]) {
    const leg = legs.find((l) => l.targetOs === os)!;
    assert.deepEqual(leg.linuxNeeds, []);
    assert.ok(leg.warnings.some((w) => w.includes(`needs "plan" runs on linux; it runs once, as its own leg, and osmatrix replays its result, outputs and artifacts`)));
  }
  const linux = legs.find((l) => l.id === "gw-ubuntu-latest")!;
  assert.equal(linux.linuxNeeds, undefined);
  assert.ok(!linux.warnings.some((w) => w.includes("needs")));
});

test("fan-in jobs run once after their needs; needed legs the filter leaves out still run", () => {
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
`);
  const all = plan(repo, linuxCfg()).legs;
  const gate = all.find((l) => l.job === "gate")!;
  assert.equal(gate.skip, undefined);
  assert.deepEqual(gate.waitsFor, ["unit-ubuntu-latest", "unit-windows-latest", "lint"]);
  assert.ok(all.every((l) => !l.neededOnly));
  assert.deepEqual(all.find((l) => l.id === "unit-windows-latest")!.neededBy, ["gate"]);
  // Asked for by name, or with only Linux legs selected: the Windows unit leg still runs, once, in its guest.
  for (const filter of [{ job: "gate" }, { only: ["linux"] }]) {
    const legs = plan(repo, linuxCfg(), filter).legs;
    const win = legs.find((l) => l.id === "unit-windows-latest")!;
    assert.equal(win.neededOnly, true);
    assert.equal(win.target, "windows");
  }
  assert.deepEqual(
    plan(repo, linuxCfg(), { job: "gate" }).legs.map((l) => l.id),
    ["unit-ubuntu-latest", "unit-windows-latest", "lint", "gate"],
  );
});

test("a matrix filter selects legs, and leaves the legs of needed jobs without its key alone", () => {
  const repo = tmpRepo(`
on: push
jobs:
  prep:
    runs-on: ubuntu-latest
    strategy: { matrix: { tool: [a, b] } }
    steps: [{ run: echo }]
  build:
    needs: prep
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    steps: [{ run: echo }]
  test:
    needs: build
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    steps: [{ run: echo }]
`);
  const legs = plan(repo, linuxCfg(), { job: "test", matrix: { os: "windows-latest" } }).legs;
  // As act's --matrix: build's other OS is filtered out, prep (no os key) runs whole.
  assert.deepEqual(
    legs.map((l) => l.id),
    ["prep-a", "prep-b", "build-windows-latest", "test-windows-latest"],
  );
  assert.deepEqual(legs.at(-1)!.waitsFor, ["build-windows-latest"]);
  assert.deepEqual(legs.find((l) => l.job === "build")!.waitsFor, ["prep-a", "prep-b"]);
});

test("needs that can't run as their own legs run inside the leg, down to the needs that can", () => {
  const repo = tmpRepo(`
on: push
jobs:
  base:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gpu:
    needs: base
    runs-on: [self-hosted, gpu-box]
    steps: [{ run: echo }]
  lin:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  called:
    uses: ./.github/workflows/called.yml
  ship:
    needs: [gpu, called, lin]
    runs-on: windows-latest
    steps: [{ run: echo }]
`);
  const legs = plan(repo, linuxCfg(), { job: "ship" }).legs;
  const ship = legs.find((l) => l.job === "ship")!;
  // gpu has no local target: act runs it inside the leg, and base (which gpu needs) is replayed into it.
  // A local reusable workflow call is a Linux leg of its own.
  assert.deepEqual(ship.inlineNeeds, ["gpu"]);
  assert.deepEqual(ship.replayNeeds, ["base", "called", "lin"]);
  assert.deepEqual(ship.waitsFor, ["base", "lin", "called"]);
  assert.deepEqual(ship.needsLabels, ["self-hosted", "gpu-box"]);
  assert.deepEqual(ship.linuxNeeds, []);
  assert.ok(ship.warnings.some((w) => w.includes(`needs "gpu" can't run as its own leg (no configured guest serves runs-on ["self-hosted","gpu-box"]); act runs it inside this leg's environment`)));
  assert.deepEqual(
    legs.map((l) => l.id),
    ["base", "lin", "called", "ship"],
  );
});

test("Linux needs without a local target run inside a Windows leg, with Git Bash", () => {
  const repo = tmpRepo(`
on: push
jobs:
  plan:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  ship:
    needs: plan
    runs-on: windows-latest
    steps: [{ run: echo }]
`);
  const cfg = mergeConfig(linuxCfg(), { guests: { ubuntu: { labels: ["my-linux"] } } });
  const legs = plan(repo, cfg, { job: "ship" }).legs;
  assert.deepEqual(
    legs.map((l) => l.id),
    ["ship"],
  );
  assert.deepEqual(legs[0].inlineNeeds, ["plan"]);
  assert.deepEqual(legs[0].linuxNeeds, ["plan"]);
  assert.deepEqual(legs[0].waitsFor, []);
  assert.ok(legs[0].warnings.some((w) => w.includes(`needs "plan" targets Linux but can't run as its own leg`) && w.includes("Git Bash")));
});

test("a needed matrix job's legs that can't run are named; needs cycles are refused", () => {
  const repo = tmpRepo(`
on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, freebsd-14] } }
    steps: [{ run: echo }]
  test:
    needs: build
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  a:
    needs: b
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`);
  const legs = plan(repo, linuxCfg()).legs;
  const t = legs.find((l) => l.job === "test")!;
  assert.deepEqual(t.waitsFor, ["build-ubuntu-latest"]);
  assert.ok(t.warnings.some((w) => w.includes(`needs "build": its leg build-freebsd-14 can't run here`)));
  for (const j of ["a", "b"]) assert.match(legs.find((l) => l.job === j)!.skip ?? "", /needs form a cycle/);
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

test("setDefaultRunShell edits only the lines it adds", () => {
  const src = `on:
  push:
    branches: [main]   # spacing kept
jobs:
  plan:
    runs-on: ubuntu-latest
    steps: [{ run: "echo ok" }]
  wd:
    defaults:
      run:
        working-directory: sub
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  partial:
    defaults:
      other: 1
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
  const shell = `"C:/Program Files/Git/bin/bash.exe" -e {0}`;
  const { text, changed } = setDefaultRunShell(src, ["plan", "wd", "partial"], shell);
  assert.deepEqual(changed, ["plan", "wd", "partial"]);
  // Only added lines; everything else is byte for byte the original.
  const q = `'"C:/Program Files/Git/bin/bash.exe" -e {0}'`;
  const expected = src
    .replace("  plan:\n", `  plan:\n    defaults:\n      run:\n        shell: ${q}\n`)
    .replace("      run:\n        working-directory", `      run:\n        shell: ${q}\n        working-directory`)
    .replace("      other: 1\n", `      run:\n        shell: ${q}\n      other: 1\n`);
  assert.equal(text, expected);
  const jobs = YAML.parse(text).jobs;
  for (const j of changed) assert.equal(jobs[j].defaults.run.shell, shell);
  assert.equal(jobs.wd.defaults.run["working-directory"], "sub");
  assert.equal(jobs.partial.defaults.other, 1);
  // CRLF files get CRLF lines.
  const crlf = setDefaultRunShell(src.replace(/\n/g, "\r\n"), ["plan"], shell).text;
  assert.ok(!/[^\r]\n/.test(crlf));
  // Flow-style jobs can't take inserted lines; the document is re-serialised instead.
  const flow = setDefaultRunShell("jobs:\n  plan: { runs-on: ubuntu-latest, steps: [{ run: echo }] }\n", ["plan"], shell);
  assert.equal(YAML.parse(flow.text).jobs.plan.defaults.run.shell, shell);
});

test("needed jobs with legs on Linux and other OSes run as their own legs, not inside the leg", () => {
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
  const ship = plan(repo, linuxCfg(), { job: "ship" }).legs.find((l) => l.job === "ship")!;
  assert.deepEqual(ship.linuxNeeds, []);
  assert.deepEqual(ship.waitsFor, ["build-ubuntu-latest", "build-windows-latest"]);
  assert.ok(ship.warnings.some((w) => w.includes(`needs "build" runs on linux/windows; it runs once, as its own legs`)));
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

test("plan adds MSVC uses of the needed jobs act runs in the Windows guest, not of replayed ones", () => {
  const repo = tmpRepo(`
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: cargo clippy }]
  gpu:
    runs-on: [self-hosted, gpu]
    steps: [{ run: cargo build }]
  win:
    needs: [lint, gpu]
    runs-on: windows-latest
    steps: [{ run: npm test }]
`);
  const optedOut = mergeConfig(defaultConfig(), { guests: { windows: { os: "windows", backend: "dockur", msvc: false } } });
  const win = plan(repo, optedOut, { job: "win" }).legs.find((l) => l.job === "win")!;
  // lint runs once on its own Linux leg and is replayed; gpu has no local target, so act runs it in the guest.
  assert.deepEqual(win.replayNeeds, ["lint"]);
  assert.deepEqual(win.inlineNeeds, ["gpu"]);
  assert.deepEqual(win.msvcUses, ["run: cargo (needs: gpu)"]);
  assert.ok(win.warnings.some((w) => /run: cargo \(needs: gpu\).*msvc = false/.test(w)));
  // A Linux leg never needs MSVC, even with Rust steps.
  assert.equal(plan(repo, optedOut, { job: "lint" }).legs.find((l) => l.job === "lint")!.msvcUses, undefined);
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

test("rustUse: setup actions, run steps and toolchain files", () => {
  assert.equal(rustUse({ steps: [{ uses: "dtolnay/rust-toolchain@stable" }] }), "the job uses dtolnay/rust-toolchain");
  assert.equal(rustUse({ steps: [{ run: "echo hi" }, { run: "rustup component add clippy" }] }), "the job runs rustup");
  assert.equal(rustUse({ steps: [{ run: "cargo test --locked" }] }), "the job runs cargo");
  assert.equal(rustUse({ steps: [{ run: "npm test" }, { uses: "actions/checkout@v4" }] }), undefined);
  assert.equal(rustUse({ steps: [{ run: "npm test" }] }, "rust-toolchain.toml"), "the repo has rust-toolchain.toml");
  assert.equal(rustUse({ uses: "./.github/workflows/x.yml" }), undefined);
  // Commands only in command position, as for MSVC (runCommands); every actions-rs action counts.
  assert.equal(rustUse({ steps: [{ run: "echo cargo build" }, { run: "npm run cargo" }, { run: "cargo-cult" }] }), undefined);
  assert.equal(rustUse({ steps: [{ run: "RUSTFLAGS=-Dwarnings cargo build" }] }), "the job runs cargo");
  assert.equal(rustUse({ steps: [{ uses: "actions-rs/cargo@v1" }] }), "the job uses actions-rs/cargo");
});

test("plan warns about Rust only on a user-configured Linux image", () => {
  const repo = tmpRepo(`
on: push
jobs:
  rs:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    steps: [{ uses: dtolnay/rust-toolchain@stable }, { run: cargo test }]
  js:
    runs-on: ubuntu-latest
    steps: [{ run: npm test }]
`);
  const rust = (cfg: ReturnType<typeof linuxCfg>, job: string, os = "ubuntu-latest") =>
    plan(repo, cfg).legs.find((l) => l.job === job && l.runsOn.includes(os))!.warnings.filter((w) => w.includes("rustup stable"));
  assert.deepEqual(rust(linuxCfg(), "rs"), []);
  const custom = mergeConfig(linuxCfg(), { act_linux_image: "example/ubuntu:24.04" });
  assert.equal(rust(custom, "rs").length, 1);
  assert.match(rust(custom, "rs")[0], /dtolnay\/rust-toolchain, and act_linux_image is set to example\/ubuntu:24\.04/);
  assert.deepEqual(rust(custom, "rs", "windows-latest"), []);
  assert.deepEqual(rust(custom, "js"), []);
  fs.writeFileSync(path.join(repo, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n');
  assert.match(rust(custom, "js")[0], /the repo has rust-toolchain\.toml/);
});

test("brew steps on Intel macOS guests warn about the pinned Homebrew", () => {
  const repo = tmpRepo(`
on: push
jobs:
  build:
    strategy: { matrix: { os: [ubuntu-latest, macos-latest] } }
    runs-on: \${{ matrix.os }}
    steps:
      - run: sudo apt-get install -y capnproto
        if: runner.os == 'Linux'
      - run: brew install capnp
        if: runner.os == 'macOS'
  linuxbrew:
    runs-on: macos-latest
    steps:
      - run: brew update
        if: runner.os == 'Linux'
      - run: brew update
        if: \${{ runner.os == 'Windows' }}
  either:
    runs-on: macos-latest
    steps:
      - run: brew install capnp
        if: runner.os == 'Linux' || runner.os == 'macOS'
  upgrade:
    runs-on: macos-latest
    steps: [{ run: brew update && brew upgrade }]
  mention:
    runs-on: macos-latest
    steps:
      - run: |
          echo "brew install capnp"
          # brew update
`);
  const legs = plan(repo, linuxCfg()).legs;
  const mac = legs.find((l) => l.job === "build" && l.targetOs === "macos")!;
  assert.ok(mac.warnings.some((w) => w.startsWith("steps run brew install: guest macos is Intel macOS") && w.includes("6.0.22")));
  assert.ok(!legs.find((l) => l.job === "build" && l.targetOs === "linux")!.warnings.some((w) => w.includes("brew")));
  // A brew step guarded to Linux doesn't run on the macOS leg.
  assert.deepEqual(legs.find((l) => l.job === "linuxbrew")!.warnings, []);
  // A condition that also admits macOS still runs there.
  assert.ok(legs.find((l) => l.job === "either")!.warnings.some((w) => w.startsWith("steps run brew install:")));
  assert.ok(legs.find((l) => l.job === "upgrade")!.warnings.some((w) => w.includes("osmatrix reset macos")));
  // brew mentioned in an argument or a comment isn't run.
  assert.deepEqual(legs.find((l) => l.job === "mention")!.warnings, []);

  const off = mergeConfig(defaultConfig(), { guests: { macos: { os: "macos", backend: "dockur", homebrew: false } } });
  const offLeg = plan(repo, off, { job: "build" }).legs.find((l) => l.targetOs === "macos")!;
  assert.ok(offLeg.warnings.some((w) => w.includes("has homebrew = false") && w.includes("doesn't remove one installed earlier")));
  // Apple Silicon (tart) guests match GitHub's Homebrew: nothing to warn about.
  const tart = mergeConfig(defaultConfig(), { guests: { macos: { os: "macos", backend: "tart" } } });
  assert.ok(!plan(repo, tart, { job: "build" }).legs.find((l) => l.targetOs === "macos")!.warnings.some((w) => w.includes("brew")));
});
