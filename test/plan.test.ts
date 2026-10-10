import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expandMatrix, plan, substitute } from "../src/ci/plan.ts";
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
