// Tiny cross-platform "test suite" used to exercise osmatrix CI legs.
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

assert.strictEqual(path.join("a", "b"), ["a", "b"].join(path.sep));
console.log(`ok platform=${process.platform} arch=${process.arch} node=${process.version} host=${os.hostname()}`);
if (process.env.OSMATRIX_DEMO_FAIL === process.platform) {
  console.error(`failing on purpose on ${process.platform}`);
  process.exit(1);
}
