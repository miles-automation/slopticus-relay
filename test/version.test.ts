import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTOCOL, VERSION } from "../src/protocol.js";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};
test("package.json and the protocol module carry the same release version", () => {
  assert.equal(pkg.version, VERSION);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(PROTOCOL, 1);
});
