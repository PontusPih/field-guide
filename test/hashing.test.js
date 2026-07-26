// Unit tests for sha256Hex. Known-vector values cross-checked against Node's
// own crypto.createHash("sha256"), not hand-typed from memory.
// Run: `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../hashing.js";

test("sha256Hex: matches the known vector for an empty blob", async () => {
  const hash = await sha256Hex(new Blob([]));
  assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha256Hex: matches the known vector for 'abc'", async () => {
  const hash = await sha256Hex(new Blob(["abc"]));
  assert.equal(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha256Hex: identical content hashes identically regardless of how the blob was built", async () => {
  const a = await sha256Hex(new Blob(["same bytes"]));
  const b = await sha256Hex(new Blob([new TextEncoder().encode("same bytes")]));
  assert.equal(a, b);
});

test("sha256Hex: different content hashes differently", async () => {
  const a = await sha256Hex(new Blob(["M8295"]));
  const b = await sha256Hex(new Blob(["M8296"])); // one-character difference
  assert.notEqual(a, b);
});

test("sha256Hex: output is 64 lowercase hex characters", async () => {
  const hash = await sha256Hex(new Blob(["anything"]));
  assert.match(hash, /^[0-9a-f]{64}$/);
});
