/*
 * Java's `Double.toString`, which POI's OldExcelExtractor uses (`StringBuilder.append(double)`) to write a number cell, so
 * Tika's <p> for a cell holding five reads "5.0". Copied from packages/core/src/java-double.ts, which core does not
 * export; keep the two the same until core does.
 *
 * The text is the shortest decimal that reads back as the same double (JDK 19 and later), written in decimal from 10^-3
 * up to but not including 10^7 and in computerized scientific notation outside that, always with a digit after the point.
 */
export function javaDoubleString(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const magnitude = Math.abs(value);
  // JavaScript's shortest digits, `d.ddde+x`. Java wants at least two digits, and when a second one still reads back as
  // the same double it takes the closest such pair (Double.MIN_VALUE is 4.9E-324, not 5.0E-324).
  let scientific = magnitude.toExponential();
  const mantissa = scientific.split("e")[0]!;
  if (!mantissa.includes(".")) {
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
