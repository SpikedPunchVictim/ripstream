/*
 * Java's `Double.toString` and `Float.toString`, which Tika's JDBCTableReader uses to write a floating-point cell (the
 * JDBC types DOUBLE and FLOAT). The text is the shortest decimal that reads back as the same number (JDK 19 and later;
 * JDK 17 sometimes gives more digits, for a few values), in decimal from 10^-3 up to but not including 10^7 and in
 * computerized scientific notation outside that, always with a digit after the point. The same algorithm as
 * packages/core/src/java-double.ts, which core does not export (and as packages/parsers/src/java-compat.ts).
 */
export function javaDoubleString(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const magnitude = Math.abs(value);
  // JavaScript's shortest digits, `d.ddde+x`. Java wants at least two digits, and when a second one still reads back as
  // the same number it takes the closest such pair.
  let scientific = magnitude.toExponential();
  if (!scientific.split("e")[0]!.includes(".")) {
    const twoDigits = magnitude.toExponential(1);
    if (Number(twoDigits) === magnitude) scientific = twoDigits;
  }
  const [mantissaText, exponentText] = scientific.split("e") as [string, string];
  const exponent = Number(exponentText);
  const digits = mantissaText.replace(".", "").replace(/0+$/, "") || "0";
  const sign = value < 0 ? "-" : "";

  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
      return `${sign}${whole}.${digits.slice(exponent + 1) || "0"}`;
    }
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  return `${sign}${digits[0]}.${digits.slice(1) || "0"}E${exponent}`;
}

/**
 * `Float.toString(f)` for the nearest 32-bit float to `value` (JDBC's `getFloat`): the fewest digits that read back as that
 * float, written as Java writes a double with those digits. Java wants two digits at least and, when one would do, takes the
 * closest pair (Float.MIN_VALUE is 1.4E-45, not 1.0E-45), so the search starts at two: a pair that is closer to the float
 * than the single digit reads back too.
 */
export function javaFloatString(value: number): string {
  const single = Math.fround(value);
  if (!Number.isFinite(single) || single === 0) return javaDoubleString(single);
  for (let digits = 2; digits <= 9; digits++) {
    const candidate = Number(single.toPrecision(digits));
    if (Math.fround(candidate) === single) return javaDoubleString(candidate);
  }
  return javaDoubleString(single);
}
