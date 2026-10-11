import assert from "node:assert/strict";
import { test } from "node:test";
import { nestingNotes } from "../src/core/host.ts";
import { detectContainerHost, localGuestBlockReason, remoteDockerHost } from "../src/core/nesting.ts";

const none = () => false;

test("container host detection", () => {
  assert.equal(detectContainerHost({}, none, "linux"), undefined);
  assert.deepEqual(detectContainerHost({ CODESPACES: "true", REMOTE_CONTAINERS: "true" }, none, "linux"), { kind: "codespaces", evidence: ["CODESPACES=true"] });
  assert.deepEqual(detectContainerHost({ REMOTE_CONTAINERS: "true" }, none, "linux"), { kind: "devcontainer", evidence: ["REMOTE_CONTAINERS=true"] });
  assert.equal(detectContainerHost({ DEVCONTAINER: "true" }, none, "darwin")?.kind, "devcontainer");
  assert.deepEqual(detectContainerHost({}, (p) => p === "/.dockerenv", "linux"), { kind: "container", evidence: ["/.dockerenv"] });
  assert.deepEqual(detectContainerHost({ container: "podman" }, (p) => p === "/run/.containerenv", "linux"), {
    kind: "container",
    evidence: ["/run/.containerenv", "container=podman"],
  });
  // Marker files only mean something on Linux.
  assert.equal(detectContainerHost({}, () => true, "darwin"), undefined);
});

test("remote DOCKER_HOST", () => {
  assert.equal(remoteDockerHost({}), undefined);
  assert.equal(remoteDockerHost({ DOCKER_HOST: "unix:///var/run/docker.sock" }), undefined);
  assert.equal(remoteDockerHost({ DOCKER_HOST: "npipe:////./pipe/docker_engine" }), undefined);
  assert.equal(remoteDockerHost({ DOCKER_HOST: "tcp://docker:2375" }), "tcp://docker:2375");
  assert.equal(remoteDockerHost({ DOCKER_HOST: "ssh://me@box" }), "ssh://me@box");
});

test("local guests are refused only for what actually breaks", () => {
  const dev = { kind: "devcontainer" as const, evidence: [] };
  // Plain host or Docker-in-Docker: allowed.
  assert.equal(localGuestBlockReason(undefined, "linux", undefined, undefined), undefined);
  assert.equal(localGuestBlockReason({ files: true, loopback: true }, "windows", dev, undefined), undefined);
  // A probe that couldn't run leaves reachability unknown: refused, without claiming Docker-outside-of-Docker.
  const unknown = localGuestBlockReason({ files: false, loopback: false, error: "pull access denied" }, "linux", dev, undefined)!;
  assert.match(unknown, /inside a devcontainer, and osmatrix could not verify .*pull access denied/);
  assert.doesNotMatch(unknown, /Docker-outside-of-Docker/);
  // Unreachable loopback breaks every local guest.
  const r = localGuestBlockReason({ files: true, loopback: false }, "linux", dev, undefined);
  assert.match(r!, /inside a devcontainer.*Docker-outside-of-Docker.*127\.0\.0\.1.*ssh guest/);
  // Unshared files only break Windows (OEM bind mount).
  assert.equal(localGuestBlockReason({ files: false, loopback: true }, "linux", dev, undefined), undefined);
  assert.equal(localGuestBlockReason({ files: false, loopback: true }, "macos", dev, undefined), undefined);
  assert.match(localGuestBlockReason({ files: false, loopback: true }, "windows", dev, undefined)!, /provisioning script/);
  assert.match(localGuestBlockReason({ files: false, loopback: false }, "linux", undefined, "tcp://docker:2375")!, /DOCKER_HOST=tcp:\/\/docker:2375/);
});

test("doctor notes for nested environments", () => {
  const cs = { kind: "codespaces" as const, evidence: [] };
  assert.match(nestingNotes(cs, undefined, null, undefined)[0], /GitHub Codespace without Docker.*ssh guests/);
  assert.match(nestingNotes(undefined, "tcp://d:2375", null, undefined)[0], /^Docker is remote \(DOCKER_HOST=tcp:\/\/d:2375\) but not reachable/);
  assert.match(nestingNotes(cs, undefined, "27", { files: false, loopback: false, error: "x" })[0], /could not check.*refused until/);
  assert.match(nestingNotes(cs, undefined, "27", { files: true, loopback: true })[0], /Docker-in-Docker.*\/dev\/kvm/);
  const dood = nestingNotes(cs, undefined, "27", { files: false, loopback: false }).join("\n");
  assert.match(dood, /shares neither/);
  assert.match(dood, /Local guests .* are refused/);
  assert.match(dood, /Linux CI legs still run/);
});
