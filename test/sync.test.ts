import assert from "node:assert/strict";
import { test } from "node:test";
import { pins, stampDocs } from "../scripts/sync-manifests.mjs";

test("stampDocs: the pins reach every phrasing the docs use; examples and npm ranges stay", () => {
  const p = { version: "0.4.0", major: "1", act: "v0.2.95", linuxImage: "catthehacker/ubuntu:act-26.04", brew: "6.1.0", core: "ffffffffffffffffffffffffffffffffffffffff", node: "24.0" };
  const before = [
    "a patched build of act 0.2.89, [the patch](assets/act/act-v0.2.89-osmatrix.patch); apply it to the v0.2.89 source",
    "falls back to the stock v0.2.89 release; Stock act 0.2.89 rejects it; osmatrix builds act 0.2.89",
    '# act_version = "v0.2.88"        # a stock act release instead of the patched v0.2.89',
    '`act_version = "v0.2.x"` runs that stock release; contact 0.2.1 is not act',
    "| `osmatrix@0.1.0` | exactly | run `npx -y osmatrix@0 mcp`; `npx osmatrix@0.3.0 <command>` or `npm i -g osmatrix@0.3.0`",
    "Node.js 22.18+ with npm; Node.js 22.18 or later",
    'pinned to brew 6.0.22; homebrew = { brew = "6.0.22", core = "a5783fb0df65b1eeeaee4dbdf7e0c41b133c72ac" }',
    "Its default, `catthehacker/ubuntu:act-24.04`, lacks",
  ].join("\n");
  const after = [
    "a patched build of act 0.2.95, [the patch](assets/act/act-v0.2.95-osmatrix.patch); apply it to the v0.2.95 source",
    "falls back to the stock v0.2.95 release; Stock act 0.2.95 rejects it; osmatrix builds act 0.2.95",
    '# act_version = "v0.2.88"        # a stock act release instead of the patched v0.2.95',
    '`act_version = "v0.2.x"` runs that stock release; contact 0.2.1 is not act',
    "| `osmatrix@0.1.0` | exactly | run `npx -y osmatrix@1 mcp`; `npx osmatrix@0.4.0 <command>` or `npm i -g osmatrix@0.4.0`",
    "Node.js 24.0+ with npm; Node.js 24.0 or later",
    'pinned to brew 6.1.0; homebrew = { brew = "6.1.0", core = "ffffffffffffffffffffffffffffffffffffffff" }',
    "Its default, `catthehacker/ubuntu:act-26.04`, lacks",
  ].join("\n");
  assert.equal(stampDocs(before, p), after);
  assert.equal(stampDocs(after, p), after, "idempotent");
  // An image outside catthehacker's family needs the docs rewritten by hand: nothing is stamped for it.
  assert.equal(stampDocs("default `catthehacker/ubuntu:act-24.04`", { ...p, linuxImage: "other/image:1" }), "default `catthehacker/ubuntu:act-24.04`");
});

test("pins: package.json and the code's constants", () => {
  const p = pins({ version: "1.2.3", engines: { node: ">=22.18" } });
  assert.equal(p.version, "1.2.3");
  assert.equal(p.major, "1");
  assert.equal(p.node, "22.18");
  assert.match(p.act, /^v\d+\.\d+\.\d+$/);
  assert.match(p.brew, /^\d+\.\d+\.\d+$/);
  assert.match(p.core, /^[0-9a-f]{40}$/);
  assert.match(p.linuxImage, /\S/);
});
