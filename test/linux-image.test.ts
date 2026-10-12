import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PARITY_DOCKERFILE, linuxImageFor, parityImageTag } from "../src/backends/linux-image.ts";
import { DEFAULT_LINUX_IMAGE } from "../src/core/config.ts";

test("the parity image tag follows the Dockerfile's content", () => {
  const tag = parityImageTag();
  assert.match(tag, /^osmatrix\/ubuntu:act-24\.04-[0-9a-f]{12}$/);
  assert.equal(parityImageTag(fs.readFileSync(PARITY_DOCKERFILE)), tag);
  assert.notEqual(parityImageTag("FROM scratch\n"), tag);
  assert.equal(parityImageTag("FROM scratch\n"), parityImageTag(Buffer.from("FROM scratch\n")));
});

test("the parity Dockerfile builds on act's default image", () => {
  const from = fs.readFileSync(PARITY_DOCKERFILE, "utf8").match(/^FROM (\S+)$/m)?.[1];
  assert.equal(from, DEFAULT_LINUX_IMAGE);
});

test("only the default image is replaced by the parity layer", () => {
  assert.equal(linuxImageFor(DEFAULT_LINUX_IMAGE, "osmatrix/ubuntu:act-24.04-abc"), "osmatrix/ubuntu:act-24.04-abc");
  assert.equal(linuxImageFor("catthehacker/ubuntu:full-24.04", "osmatrix/ubuntu:act-24.04-abc"), "catthehacker/ubuntu:full-24.04");
  assert.equal(linuxImageFor("my/image:latest"), "my/image:latest");
});
