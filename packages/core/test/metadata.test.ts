import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "../src/metadata.ts";

test("add appends and get returns the first value", () => {
  const metadata = new Metadata();
  metadata.add("dc:creator", "Ada");
  metadata.add("dc:creator", "Grace");
  assert.equal(metadata.get("dc:creator"), "Ada");
  assert.deepEqual(metadata.getAll("dc:creator"), ["Ada", "Grace"]);
  assert.equal(metadata.size(), 1);
});

test("set replaces and null removes", () => {
  const metadata = new Metadata();
  metadata.add("k", "one");
  metadata.add("k", "two");
  metadata.set("k", "three");
  assert.deepEqual(metadata.getAll("k"), ["three"]);
  metadata.set("k", null);
  assert.equal(metadata.has("k"), false);
  assert.equal(metadata.get("k"), null);
});

test("add ignores null and preserves empty strings", () => {
  const metadata = new Metadata();
  metadata.add("k", null);
  metadata.add("k", "");
  assert.deepEqual(metadata.getAll("k"), [""]);
});

test("keys are exact and case-sensitive", () => {
  const metadata = new Metadata();
  metadata.set("Title", "upper");
  metadata.set("title", "lower");
  assert.equal(metadata.get("Title"), "upper");
  assert.equal(metadata.get("title"), "lower");
  assert.deepEqual(new Set(metadata.names()), new Set(["Title", "title"]));
});

test("merge replaces each key wholesale", () => {
  const left = new Metadata();
  left.setAll("k", ["a", "b"]);
  const right = new Metadata();
  right.set("k", "c");
  left.merge(right);
  assert.deepEqual(left.getAll("k"), ["c"]);
});

test("typed accessors match upstream coercion rules", () => {
  const metadata = new Metadata();
  metadata.set("int", "42");
  metadata.set("bad-int", "42x");
  metadata.set("long", "9007199254740993");
  metadata.set("bool", "TRUE");
  metadata.set("bad-bool", "yes");
  metadata.set("double", "1.5");

  assert.equal(metadata.getInt("int"), 42);
  assert.equal(metadata.getInt("bad-int"), null);
  assert.equal(metadata.getLong("long"), 9007199254740993n);
  assert.equal(metadata.getBoolean("bool"), true);
  assert.equal(metadata.getBoolean("bad-bool"), null);
  assert.equal(metadata.getDouble("double"), 1.5);
});

test("date-only values are midday UTC", () => {
  const metadata = new Metadata();
  metadata.set("date", "2024-02-03");
  const date = metadata.getDate("date");
  assert.ok(date);
  assert.equal(date.toISOString(), "2024-02-03T12:00:00.000Z");
});

test("zone-less timestamps are read as UTC", () => {
  const metadata = new Metadata();
  metadata.set("date", "2024-02-03T04:05:06");
  assert.equal(metadata.getDate("date")?.toISOString(), "2024-02-03T04:05:06.000Z");
});

test("iterates every value in key order", () => {
  const metadata = new Metadata();
  metadata.add("a", "1");
  metadata.add("a", "2");
  metadata.set("b", "3");
  assert.deepEqual([...metadata], [
    ["a", "1"],
    ["a", "2"],
    ["b", "3"],
  ]);
});

test("truncates values at maxValueChars on add, set and setAll", () => {
  const metadata = new Metadata();
  metadata.setMaxValueChars(4);
  metadata.add("a", "123456");
  metadata.set("b", "abcdefg");
  metadata.setAll("c", ["xxxxxx", "yy"]);
  assert.equal(metadata.get("a"), "1234");
  assert.equal(metadata.get("b"), "abcd");
  assert.deepEqual(metadata.getAll("c"), ["xxxx", "yy"]);
});

test("clone keeps maxValueChars; negative or NaN is rejected", () => {
  const metadata = new Metadata();
  metadata.setMaxValueChars(2);
  const copy = metadata.clone();
  copy.set("k", "abc");
  assert.equal(copy.get("k"), "ab");
  assert.throws(() => metadata.setMaxValueChars(Number.NaN), RangeError);
  assert.throws(() => metadata.setMaxValueChars(-1), RangeError);
});
