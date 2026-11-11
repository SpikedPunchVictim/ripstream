import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import { javaDoubleString, javaIsBlank, javaSplit, javaTrim, parseJavaDouble, parseJavaInt } from "../src/java-compat.ts";
import { KeyPrefixWriter } from "../src/key-prefix.ts";

/*
 * What java-compat.test.ts leaves open, found by mutation testing of src/java-compat.ts and src/key-prefix.ts. Expected values
 * are what the JDK documents: String.trim, Character.isWhitespace, String.split, Double.parseDouble, Integer.parseInt and
 * Double.toString (JDK 19 and later, the shortest-decimal specification of JDK-4511638).
 */

const chars = (...codes: number[]): string => String.fromCharCode(...codes);

test("javaTrim: U+0020 and U+001F go, U+0021 stays, from either end, and a lone edge character is taken", () => {
  assert.equal(javaTrim(chars(0x20) + "x"), "x");
  assert.equal(javaTrim("x" + chars(0x20)), "x");
  assert.equal(javaTrim(chars(0x1f) + "x" + chars(0x1f)), "x");
  assert.equal(javaTrim("!x!"), "!x!");
  assert.equal(javaTrim(" "), "");
  assert.equal(javaTrim(chars(0)), "");
  assert.equal(javaTrim(""), "");
  assert.equal(javaTrim("x"), "x");
  // Inner characters are never touched.
  assert.equal(javaTrim(" a  b "), "a  b");
});

test("javaIsBlank: Character.isWhitespace code point by code point", () => {
  const whitespace = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000,
  ];
  for (const code of whitespace) assert.equal(javaIsBlank(chars(code)), true, `U+${code.toString(16)}`);
  // U+00A0, U+2007 and U+202F are spaces to Unicode but not to Character.isWhitespace. U+0085 and U+180E are not either.
  const notWhitespace = [0x00, 0x01, 0x08, 0x0e, 0x1b, 0x21, 0x41, 0x85, 0xa0, 0x180e, 0x2007, 0x200b, 0x202f, 0xfeff];
  for (const code of notWhitespace) assert.equal(javaIsBlank(chars(code)), false, `U+${code.toString(16)}`);
});

test("javaIsBlank looks at every character of the string, from both ends", () => {
  assert.equal(javaIsBlank("a "), false);
  assert.equal(javaIsBlank(" a"), false);
  assert.equal(javaIsBlank(" a "), false);
  assert.equal(javaIsBlank("   "), true);
  assert.equal(javaIsBlank(""), true);
});

test("javaSplit: the separator inside, at the ends, and nothing but separators", () => {
  assert.deepEqual(javaSplit("a,b", ","), ["a", "b"]);
  assert.deepEqual(javaSplit("a,,,", ","), ["a"]);
  assert.deepEqual(javaSplit(",,,", ","), []);
  assert.deepEqual(javaSplit("a,,,b,,", ","), ["a", "", "", "b"]);
  assert.deepEqual(javaSplit(",,a", ","), ["", "", "a"]);
});

test("parseJavaDouble: every form of Double.parseDouble's grammar, each on its own", () => {
  const accepted: Array<[string, number]> = [
    ["+Infinity", Infinity],
    ["-0", -0],
    ["+1", 1],
    ["1.e2", 100],
    [".5e1", 5],
    ["1e+2", 100],
    ["1e-2", 0.01],
    ["1E2", 100],
    ["1e2f", 100],
    ["1e2F", 100],
    ["1e2d", 100],
    ["1e2D", 100],
    ["12", 12],
    ["1.25", 1.25],
    ["\t 7 \n", 7],
    ["1d", 1],
    ["00012", 12],
  ];
  for (const [text, expected] of accepted) assert.equal(parseJavaDouble(text), expected, JSON.stringify(text));
  assert.ok(Number.isNaN(parseJavaDouble("+NaN")));
  assert.ok(Number.isNaN(parseJavaDouble("-NaN")));
  assert.ok(Number.isNaN(parseJavaDouble(" NaN ")));
  const refused = ["Nan", "NAN", "INFINITY", "Inf", "d", "f", "1ff", "1e2e3", "e5", "+", "-", "1.2.3", "1,5", " 1", "1 ", ".e1", "1e+", "0x1p3", "١٢"];
  for (const text of refused) assert.equal(parseJavaDouble(text), null, JSON.stringify(text));
});

test("parseJavaDouble trims only what String.trim trims: U+0001 goes, the no-break space stays", () => {
  assert.equal(parseJavaDouble(chars(1) + "5" + chars(0x1f)), 5);
  assert.equal(parseJavaDouble(chars(0xa0) + "5"), null);
});

test("parseJavaInt: sign, leading zeros, and the exact int bounds", () => {
  assert.equal(parseJavaInt("+0"), 0);
  assert.equal(parseJavaInt("007"), 7);
  assert.equal(parseJavaInt("2147483647"), 2_147_483_647);
  assert.equal(parseJavaInt("-2147483648"), -2_147_483_648);
  assert.equal(parseJavaInt("2147483648"), null);
  assert.equal(parseJavaInt("-2147483649"), null);
  assert.equal(parseJavaInt("99999999999"), null);
  assert.equal(parseJavaInt("-99999999999"), null);
  for (const text of ["+", "-", "--1", "+-1", "1+", "1_0", "١٢", "0x1"]) assert.equal(parseJavaInt(text), null, JSON.stringify(text));
});

test("parseJavaInt: Integer.parseInt('-0') is 0, not negative zero", () => {
  assert.ok(Object.is(parseJavaInt("-0"), 0), "got negative zero");
  assert.ok(Object.is(parseJavaInt("-000"), 0));
});

test("javaDoubleString: the decimal range is 10^-3 up to but not including 10^7, with the digits Double.toString writes", () => {
  const cases: Array<[number, string]> = [
    [1e6, "1000000.0"],
    [1234567, "1234567.0"],
    [9999999.5, "9999999.5"],
    [12345678.9, "1.23456789E7"],
    [1e7, "1.0E7"],
    [1e10, "1.0E10"],
    [100, "100.0"],
    [10, "10.0"],
    [1.5, "1.5"],
    [123456.789, "123456.789"],
    [0.5, "0.5"],
    [0.001, "0.001"],
    [0.00123, "0.00123"],
    [0.002, "0.002"],
    [0.00099999, "9.9999E-4"],
    [0.0001, "1.0E-4"],
    [0.00012, "1.2E-4"],
    [1e-10, "1.0E-10"],
    [0.1 + 0.2, "0.30000000000000004"],
    [-0.5, "-0.5"],
    [-1e7, "-1.0E7"],
    [-1e-4, "-1.0E-4"],
    [-123456.789, "-123456.789"],
    [1e21, "1.0E21"],
    [1e23, "1.0E23"],
    [9.223372036854776e18, "9.223372036854776E18"],
    [Number.MAX_VALUE, "1.7976931348623157E308"],
    [2.2250738585072014e-308, "2.2250738585072014E-308"],
    [1.5e-5, "1.5E-5"],
  ];
  for (const [value, expected] of cases) assert.equal(javaDoubleString(value), expected, String(value));
});

test("javaDoubleString: a value of one significant digit has two digits when the second still reads back (Double.MIN_VALUE is 4.9E-324)", () => {
  // JDK 19+ Double.toString: when the shortest decimal has one digit, the closest two-digit decimal in the rounding interval is
  // written. JavaScript's shortest form is 5e-324, Java's is 4.9E-324.
  assert.equal(javaDoubleString(Number.MIN_VALUE), "4.9E-324");
  assert.equal(javaDoubleString(2 * Number.MIN_VALUE), "9.9E-324");
  assert.equal(javaDoubleString(-Number.MIN_VALUE), "-4.9E-324");
});

test("javaDoubleString: the specials", () => {
  assert.equal(javaDoubleString(Number.NaN), "NaN");
  assert.equal(javaDoubleString(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(javaDoubleString(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(javaDoubleString(0), "0.0");
  assert.equal(javaDoubleString(-0), "-0.0");
});

test("KeyPrefixWriter: a name of 1024 characters is kept and 1025 is not, and the prefix is part of the key", () => {
  const metadata = new Metadata();
  const writer = new KeyPrefixWriter(metadata, "pre:");
  writer.add("a".repeat(1024), "kept");
  writer.add("b".repeat(1025), "skipped");
  assert.deepEqual(metadata.names(), [`pre:${"a".repeat(1024)}`]);
  assert.equal(metadata.get(`pre:${"a".repeat(1024)}`), "kept");
});

test("KeyPrefixWriter: the 10000th distinct name is kept, the 10001st is not, and a known name still takes values", () => {
  const metadata = new Metadata();
  const writer = new KeyPrefixWriter(metadata, "q:");
  for (let index = 0; index < 10_000; index++) writer.add(`n${index}`, "v");
  assert.equal(metadata.names().length, 10_000);
  writer.add("one-too-many", "v");
  assert.equal(metadata.has("q:one-too-many"), false);
  assert.equal(metadata.names().length, 10_000);
  writer.add("n9999", "again");
  assert.deepEqual([...metadata.getAll("q:n9999")], ["v", "again"]);
});

test("KeyPrefixWriter: values for one name accumulate, and a name that differs only by case is another name", () => {
  const metadata = new Metadata();
  const writer = new KeyPrefixWriter(metadata, "p:");
  writer.add("k", "1");
  writer.add("k", "2");
  writer.add("K", "3");
  assert.deepEqual([...metadata.getAll("p:k")], ["1", "2"]);
  assert.deepEqual([...metadata.getAll("p:K")], ["3"]);
});

test("KeyPrefixWriter: a name of only no-break spaces is not blank (String.isBlank), and a name of other whitespace is", () => {
  const metadata = new Metadata();
  const writer = new KeyPrefixWriter(metadata, "p:");
  writer.add(chars(0xa0), "nbsp");
  writer.add(chars(0x2003, 0x0a), "blank");
  assert.deepEqual(metadata.names(), [`p:${chars(0xa0)}`]);
});
