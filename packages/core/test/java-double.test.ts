import assert from "node:assert/strict";
import { test } from "node:test";
import { javaDoubleString } from "../src/java-double.ts";

/*
 * `Double.toString`, which is how Tika writes a REAL metadata value (`Metadata.set(Property, double)`). The expected texts
 * are the ones its javadoc and JDK 19+ give: the shortest digits that read back as the same double, in decimal from 10^-3
 * up to but not including 10^7 and in computerized scientific notation outside that, always with a digit after the point.
 */

const CASES: ReadonlyArray<readonly [number, string]> = [
  [0, "0.0"],
  [-0, "-0.0"],
  [1, "1.0"],
  [-1, "-1.0"],
  [0.5, "0.5"],
  [100, "100.0"],
  [0.001, "0.001"],
  [0.0009999, "9.999E-4"],
  [0.0001, "1.0E-4"],
  [1234567, "1234567.0"],
  [9999999, "9999999.0"],
  [10000000, "1.0E7"],
  [12345678.9, "1.23456789E7"],
  [1.5e300, "1.5E300"],
  [5e-324, "4.9E-324"],
  [Number.MAX_VALUE, "1.7976931348623157E308"],
  [-2.5e-10, "-2.5E-10"],
  [0.1 + 0.2, "0.30000000000000004"],
  [Number.NaN, "NaN"],
  [Number.POSITIVE_INFINITY, "Infinity"],
  [Number.NEGATIVE_INFINITY, "-Infinity"],
];

for (const [value, expected] of CASES) {
  test(`javaDoubleString(${Object.is(value, -0) ? "-0" : String(value)}) is ${expected}`, () => {
    assert.equal(javaDoubleString(value), expected);
  });
}

test("a 32-bit float is written as the double it widens to, with all of that double's digits", () => {
  // (double) 0.9f is 0.8999999761581421, not 0.9: the float has no shorter text once it is a double.
  assert.equal(javaDoubleString(Math.fround(0.9)), "0.8999999761581421");
  assert.equal(javaDoubleString(Math.fround(0.5)), "0.5");
  assert.equal(javaDoubleString(Math.fround(0.99999)), "0.9999899864196777");
});
