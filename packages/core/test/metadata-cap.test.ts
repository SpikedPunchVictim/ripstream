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

/*
 * The total-metadata cap (ParseLimits.maxMetadataTotalChars). The per-value cap bounds one value, not their sum, so a
 * document could carry tens of MiB of metadata in-process and be refused only when isolated. The total counts every
 * string stored, each name once and each value, as its length plus one (so an empty string is not free, and the total
 * bounds the JSON an isolated child sends: at most 6 bytes per counted character).
 */

test("setMaxTotalChars: add past the total throws LimitExceededError and leaves the metadata as it was", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(10);
  metadata.add("ab", "cdef"); // (2 + 1) + (4 + 1) = 8
  assert.throws(() => metadata.add("ab", "xxxx"), LimitExceededError); // 8 + 5 = 13
  assert.deepEqual(metadata.getAll("ab"), ["cdef"]);
  metadata.add("ab", "x"); // 8 + 2 = 10, exactly the cap
  assert.deepEqual(metadata.getAll("ab"), ["cdef", "x"]);
});

test("setMaxTotalChars: a total exactly at the cap is accepted, one past it is refused", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(8);
  metadata.add("ab", "cdef"); // exactly 8
  assert.throws(() => metadata.add("z", ""), LimitExceededError); // a new name costs (1 + 1) + (0 + 1)
});

test("setMaxTotalChars: a new name counts its own length, so many small keys are bounded too", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(20);
  assert.throws(() => {
    for (let i = 0; i < 100; i++) metadata.add(`key-${i}`, "v");
  }, LimitExceededError);
  assert.ok(metadata.size() < 100);
});

test("setMaxTotalChars: empty values are not free", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(10);
  assert.throws(() => {
    for (let i = 0; i < 50; i++) metadata.add("k", "");
  }, LimitExceededError);
  assert.ok(metadata.getAll("k").length < 50);
});

test("setMaxTotalChars: set replaces a key, so its old cost is released", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(12);
  metadata.set("k", "x".repeat(8)); // (1 + 1) + (8 + 1) = 11
  metadata.set("k", "y".repeat(9)); // replaced: 2 + 10 = 12
  assert.equal(metadata.get("k"), "y".repeat(9));
  assert.throws(() => metadata.set("k", "z".repeat(11)), LimitExceededError); // 14
  assert.equal(metadata.get("k"), "y".repeat(9));
  assert.throws(() => metadata.add("j", ""), LimitExceededError); // the refused set did not leave the total lowered
});

test("setMaxTotalChars: a name counts its length plus one", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(7);
  assert.throws(() => metadata.add("ab", "cdef"), LimitExceededError); // (2 + 1) + (4 + 1) = 8
  assert.equal(metadata.size(), 0);
});

test("setMaxTotalChars: set(name, null) and remove release the cost", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(11);
  metadata.set("k", "x".repeat(8)); // 11
  metadata.set("k", null);
  metadata.set("j", "x".repeat(8)); // 11 again
  metadata.remove("j");
  metadata.set("i", "x".repeat(8)); // 11 again
  assert.equal(metadata.get("i"), "x".repeat(8));
});

test("setMaxTotalChars: setAll replaces the whole key and is checked as a whole", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(12);
  metadata.setAll("k", ["aa", "bb"]); // 2 + 3 + 3 = 8
  metadata.setAll("k", ["aaaa", "bb"]); // 2 + 5 + 3 = 10, the old 8 released
  assert.throws(() => metadata.setAll("k", ["aaaa", "bbbb", "c"]), LimitExceededError); // 2 + 5 + 5 + 2 = 14
  assert.deepEqual(metadata.getAll("k"), ["aaaa", "bb"]);
  metadata.setAll("k", []); // the key goes, so does its cost
  metadata.setAll("o", ["x".repeat(9)]); // 2 + 10 = 12
  assert.equal(metadata.getAll("o").length, 1);
});

test("setMaxTotalChars: a value truncated by the per-value cap costs its truncated length", () => {
  const metadata = new Metadata();
  metadata.setMaxValueChars(5);
  metadata.setMaxTotalChars(8);
  metadata.add("k", "x".repeat(1000)); // truncated to 5: 2 + 6 = 8
  assert.equal(metadata.get("k"), "xxxxx");
  assert.throws(() => metadata.add("k", "y"), LimitExceededError); // 8 + 2 = 10
});

test("setMaxValueChars truncating existing values releases their cost", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(20);
  metadata.add("k", "x".repeat(15)); // 2 + 16 = 18
  metadata.setMaxValueChars(2); // now 2 + 3 = 5
  metadata.add("j", "yy"); // 5 + 5 = 10
  metadata.add("i", "zz");
  metadata.add("h", "ww");
  assert.equal(metadata.size(), 4);
});

test("setMaxTotalChars on metadata that is already over the cap throws", () => {
  const metadata = new Metadata({ title: "x".repeat(50) });
  assert.throws(() => metadata.setMaxTotalChars(10), LimitExceededError);
});

test("setMaxTotalChars rejects a cap that is not a non-negative number", () => {
  const metadata = new Metadata();
  for (const bad of [-1, Number.NaN]) assert.throws(() => metadata.setMaxTotalChars(bad), RangeError, String(bad));
  metadata.setMaxTotalChars(0);
  assert.throws(() => metadata.add("k", "v"), LimitExceededError);
});

test("clone and the copy constructor keep the total cap", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(10);
  metadata.add("k", "abc"); // 2 + 4 = 6
  const copy = metadata.clone();
  assert.throws(() => copy.add("k", "x".repeat(10)), LimitExceededError);
  assert.equal(copy.get("k"), "abc");
  copy.add("k", "d"); // 6 + 2 = 8, and the copy knows the 6 it started with
  assert.throws(() => copy.add("j", "xxxx"), LimitExceededError); // 8 + 7 = 15
});

test("merge counts what it brings in", () => {
  const metadata = new Metadata();
  metadata.setMaxTotalChars(10);
  const other = new Metadata({ a: "x".repeat(20) });
  assert.throws(() => metadata.merge(other), LimitExceededError);
  assert.equal(metadata.has("a"), false);
});

test("without a cap the total is not limited", () => {
  const metadata = new Metadata();
  for (let i = 0; i < 1000; i++) metadata.add(`k${i}`, "x".repeat(1000));
  assert.equal(metadata.size(), 1000);
});
