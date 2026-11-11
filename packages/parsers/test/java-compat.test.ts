import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import { javaDoubleString, javaIsBlank, javaSplit, javaTrim, parseJavaDouble, parseJavaInt } from "../src/java-compat.ts";
import { KeyPrefixWriter } from "../src/key-prefix.ts";

/* The java.lang behaviours the scientific parsers (ENVI, ISA-Tab, ISO 19139) lean on, as the JDK documents them. */

/** The characters by code point: the source stays readable where a literal would be an invisible space or a lone surrogate. */
const chars = (...codes: number[]): string => String.fromCharCode(...codes);
const NBSP = chars(0xa0);

test("javaTrim takes every character up to U+0020 off, and only those", () => {
  assert.equal(javaTrim(chars(1, 0x20, 9) + " x y " + chars(10, 0)), "x y");
  assert.equal(javaTrim(NBSP + "x" + NBSP), NBSP + "x" + NBSP);
  assert.equal(javaTrim("   "), "");
});

test("javaIsBlank is Character.isWhitespace for every character, the no-break spaces excepted", () => {
  assert.equal(javaIsBlank(""), true);
  // space, tab, CR, LF, VT, FF, U+001C, em space, ideographic space, line and paragraph separators
  assert.equal(javaIsBlank(chars(0x20, 9, 13, 10, 0x0b, 0x0c, 0x1c, 0x2003, 0x3000, 0x2028, 0x2029)), true);
  assert.equal(javaIsBlank(" " + NBSP), false);
  assert.equal(javaIsBlank(chars(0x2007)), false);
  assert.equal(javaIsBlank(chars(0x202f)), false);
  assert.equal(javaIsBlank(" a "), false);
});

test("javaSplit drops trailing empty strings, and returns the input when the separator is absent", () => {
  assert.deepEqual(javaSplit("a,b,,", ","), ["a", "b"]);
  assert.deepEqual(javaSplit(",a", ","), ["", "a"]);
  assert.deepEqual(javaSplit(",", ","), []);
  assert.deepEqual(javaSplit("", ","), [""]);
  assert.deepEqual(javaSplit("abc", ","), ["abc"]);
  assert.deepEqual(javaSplit("a,,b", ","), ["a", "", "b"]);
});

test("parseJavaDouble reads Double.parseDouble's decimal forms and nothing else", () => {
  for (const [text, expected] of [
    ["1", 1],
    [" -2.5 ", -2.5],
    ["+.5", 0.5],
    ["5.", 5],
    ["1e3", 1000],
    ["1.5E-2", 0.015],
    ["2f", 2],
    ["3.0D", 3],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ] as const) {
    assert.equal(parseJavaDouble(text), expected, text);
  }
  assert.ok(Number.isNaN(parseJavaDouble("NaN")));
  for (const text of ["", " ", "abc", "1,5", "1 2", "0x10", "1e", ".", "--1", "1_000", "infinity"]) {
    assert.equal(parseJavaDouble(text), null, JSON.stringify(text));
  }
});

test("parseJavaInt reads an optionally signed decimal int and refuses anything outside the int range", () => {
  assert.equal(parseJavaInt("12"), 12);
  assert.equal(parseJavaInt("-7"), -7);
  assert.equal(parseJavaInt("+3"), 3);
  assert.equal(parseJavaInt("2147483647"), 2_147_483_647);
  assert.equal(parseJavaInt("2147483648"), null);
  assert.equal(parseJavaInt("-2147483648"), -2_147_483_648);
  assert.equal(parseJavaInt("-2147483649"), null);
  for (const text of ["", "1.0", " 1", "1 ", "x", "1e2"]) assert.equal(parseJavaInt(text), null, JSON.stringify(text));
});

test("javaDoubleString writes Double.toString: a digit after the point, scientific notation outside 10^-3 to 10^7", () => {
  for (const [value, expected] of [
    [5, "5.0"],
    [-157.24, "-157.24"],
    [0.001, "0.001"],
    [0.0001, "1.0E-4"],
    [1e7, "1.0E7"],
    [9999999, "9999999.0"],
    [123456789.5, "1.234567895E8"],
    [0, "0.0"],
    [36.79077627261556, "36.79077627261556"],
  ] as const) {
    assert.equal(javaDoubleString(value), expected, String(value));
  }
  assert.equal(javaDoubleString(Object.is(-0, -0) ? -0 : 0), "-0.0");
  assert.equal(javaDoubleString(NaN), "NaN");
  assert.equal(javaDoubleString(-Infinity), "-Infinity");
});

test("KeyPrefixWriter skips a blank name, a name over 1024 characters and new names after 10000, as Metadata.add(KeyPrefix, ...) does", () => {
  const metadata = new Metadata();
  const writer = new KeyPrefixWriter(metadata, "p:");
  writer.add(" \t", "blank");
  writer.add("n".repeat(1025), "long");
  writer.add("n".repeat(1024), "ok");
  assert.deepEqual(metadata.names(), [`p:${"n".repeat(1024)}`]);

  const many = new Metadata();
  const flood = new KeyPrefixWriter(many, "q:");
  for (let index = 0; index < 10_050; index++) flood.add(`k${index}`, "v");
  assert.equal(many.names().length, 10_000);
  // A name already written still takes values after the cap, because it is not new.
  flood.add("k0", "again");
  assert.deepEqual([...many.getAll("q:k0")], ["v", "again"]);
});

test("KeyPrefixWriter makes an unpaired surrogate in a name or a value U+FFFD", () => {
  const metadata = new Metadata();
  new KeyPrefixWriter(metadata, "p:").add("a" + chars(0xd800) + "b", "c" + chars(0xdc00) + "d");
  assert.deepEqual([...metadata], [["p:a" + chars(0xfffd) + "b", "c" + chars(0xfffd) + "d"]]);
});
