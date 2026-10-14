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
