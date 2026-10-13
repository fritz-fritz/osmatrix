import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { expandMatrix, plan, setDefaultRunShell, substitute } from "../src/ci/plan.ts";
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

  const off = mergeConfig(defaultConfig(), { guests: { macos: { os: "macos", backend: "dockur", homebrew: false } } });
  const offLeg = plan(repo, off, { job: "build" }).legs.find((l) => l.targetOs === "macos")!;
  assert.ok(offLeg.warnings.some((w) => w.includes("has homebrew = false") && w.includes("doesn't remove one installed earlier")));
  // Apple Silicon (tart) guests match GitHub's Homebrew: nothing to warn about.
  const tart = mergeConfig(defaultConfig(), { guests: { macos: { os: "macos", backend: "tart" } } });
  assert.ok(!plan(repo, tart, { job: "build" }).legs.find((l) => l.targetOs === "macos")!.warnings.some((w) => w.includes("brew")));
});
