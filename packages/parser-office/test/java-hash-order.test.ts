import assert from "node:assert/strict";
import { test } from "node:test";
import { javaHashMapOrder } from "../src/java-hash-order.ts";

/*
 * The order java.util.HashMap iterates its keys in. Hand-computed: String.hashCode of a one-character string is its code, so
 * "a", "b", "c" hash to 97, 98, 99, which in a table of 16 are buckets 1, 2 and 3. "Aa" and "BB" are the classic equal hash
 * (2112), so they share a bucket and keep the order they were put in.
 */

test("keys come out by bucket, not by insertion", () => {
  assert.deepEqual(javaHashMapOrder(["c", "a", "b"]), ["a", "b", "c"]);
});

test("keys of one bucket keep their insertion order", () => {
  assert.deepEqual(javaHashMapOrder(["BB", "Aa"]), ["BB", "Aa"]);
  assert.deepEqual(javaHashMapOrder(["Aa", "BB"]), ["Aa", "BB"]);
});

test("a repeated key is put again and keeps its first position", () => {
  assert.deepEqual(javaHashMapOrder(["BB", "Aa", "BB"]), ["BB", "Aa"]);
});

test("the table doubles past 12 entries, which moves keys between buckets", () => {
  // In a table of 16, "a" (97) is bucket 1 and "q" (113) is bucket 1 as well, so "q" put first comes first. With 13 keys the
  // table is 32: "a" is bucket 1 and "q" is bucket 17, so "a" comes first.
  assert.deepEqual(javaHashMapOrder(["q", "a"]), ["q", "a"]);
  const thirteen = ["q", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  assert.equal(javaHashMapOrder(thirteen)[0], "a");
});

test("no keys, no order", () => {
  assert.deepEqual(javaHashMapOrder([]), []);
});

test("a hash with high bits is spread by h ^ (h >>> 16)", () => {
  // "polygenelubricants" hashes to Integer.MIN_VALUE; spread gives 0x80000000 ^ 0x8000 = 0x80008000, bucket 0 of 16.
  // "a" is bucket 1, so the long key comes first although it is put last.
  assert.deepEqual(javaHashMapOrder(["a", "polygenelubricants"]), ["polygenelubricants", "a"]);
});

/*
 * The cases below are hand-computed from the algorithm as it is remembered (hash code, spread, mask), not taken from a run of
 * a real java.util.HashMap: there is no JDK here.
 */

/** `count` distinct filler keys that hash to buckets away from the ones the tests look at, so only the size of the map matters. */
const fillers = (count: number): string[] => Array.from({ length: count }, (_, index) => `filler-${index}`);

/** Whether `first` comes before `second` in the order the map iterates `keys`. */
const before = (keys: string[], first: string, second: string): boolean => {
  const order = javaHashMapOrder(keys);
  return order.indexOf(first) < order.indexOf(second);
};

test("12 keys fit the table of 16: 'q' and 'a' share bucket 1 and keep their put order", () => {
  assert.equal(before(["q", "a", ...fillers(10)], "q", "a"), true);
});

test("13 keys double the table to 32: 'q' is bucket 17 and 'a' bucket 1", () => {
  assert.equal(before(["q", "a", ...fillers(11)], "a", "q"), true);
});

test("a table of 16 holds 'a' (97) and 'i' (105) in buckets 1 and 9, so they are not in put order", () => {
  assert.deepEqual(javaHashMapOrder(["i", "a"]), ["a", "i"]);
});

test("24 keys fit the table of 32: 'a' (97) and 'A' (65) share bucket 1 there", () => {
  assert.equal(before(["a", "A", ...fillers(22)], "a", "A"), true);
});

test("25 keys double the table to 64: 'A' stays in bucket 1 and 'a' moves to bucket 33", () => {
  assert.equal(before(["a", "A", ...fillers(23)], "A", "a"), true);
});

test("the table doubles once per time it is full: 49 keys make a table of 128", () => {
  // '!' (33) and 'a' (97) share bucket 33 in a table of 64 and are buckets 33 and 97 in one of 128.
  assert.equal(before(["a", "!", ...fillers(47)], "!", "a"), true);
  assert.equal(before(["a", "!", ...fillers(46)], "a", "!"), true);
});

test("the spread folds the high half of the hash into the low bits, whatever the sign", () => {
  // "ch9ay6i.png" hashes to -1800683686; its spread low four bits are 1 (bucket 1, with 'a'), where the bare hash would say 10,
  // so it stays before 'a', which was put after it.
  assert.deepEqual(javaHashMapOrder(["ch9ay6i.png", "a"]), ["ch9ay6i.png", "a"]);
});

test("a hash of a negative sign still lands in a bucket", () => {
  assert.deepEqual(javaHashMapOrder(["ch24yng.png", "a"]), ["a", "ch24yng.png"]);
});

test("characters are UTF-16 code units, so an emoji hashes by its surrogate pair", () => {
  // U+1F600 is D83D DE00: hash 1772899, spread low four bits 8. As one code point it would be bucket 13, after 'j' (106, bucket 10).
  assert.deepEqual(javaHashMapOrder(["\u{1F600}", "j"]), ["\u{1F600}", "j"]);
});
