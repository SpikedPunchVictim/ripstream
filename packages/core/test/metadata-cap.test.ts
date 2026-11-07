import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError } from "../src/errors.ts";
import { Metadata } from "../src/metadata.ts";

const MAX_VALUES_PER_KEY = 100_000;

test("add throws LimitExceededError past the per-key value cap", () => {
  const metadata = new Metadata();
  for (let i = 0; i < MAX_VALUES_PER_KEY; i++) metadata.add("k", "v");
  assert.equal(metadata.getAll("k").length, MAX_VALUES_PER_KEY);
  assert.throws(() => metadata.add("k", "v"), LimitExceededError);
  assert.equal(metadata.getAll("k").length, MAX_VALUES_PER_KEY);
});

test("addAll inherits the per-key value cap", () => {
  const metadata = new Metadata();
  assert.throws(
    () => metadata.addAll("k", new Array<string>(MAX_VALUES_PER_KEY + 1).fill("v")),
    LimitExceededError,
  );
});

test("a handful of values per key is fine and other keys are independent", () => {
  const metadata = new Metadata();
  for (let i = 0; i < 5; i++) metadata.add("k", `v${i}`);
  metadata.add("other", "x");
  assert.equal(metadata.getAll("k").length, 5);
});

test("set is unaffected by the cap and replaces a full key", () => {
  const metadata = new Metadata();
  for (let i = 0; i < MAX_VALUES_PER_KEY; i++) metadata.add("k", "v");
  metadata.set("k", "fresh");
  assert.deepEqual(metadata.getAll("k"), ["fresh"]);
  metadata.add("k", "again");
  assert.deepEqual(metadata.getAll("k"), ["fresh", "again"]);
});
