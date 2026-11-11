/*
 * The few java.lang behaviours Tika's scientific parsers lean on, written out because JavaScript's differ: `String.trim()` takes
 * every character up to U+0020 off (not Unicode spaces), `String.isBlank()` and `Character.isWhitespace` leave the no-break
 * spaces alone, `String.split` drops trailing empty strings, `Double.parseDouble` and `Integer.parseInt` accept a narrower
 * grammar than `Number()`, and `Double.toString` always writes a digit after the point.
 */

/** String.trim(). */
export function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

// Character.isWhitespace: the space, line and paragraph separators except the no-break ones, and the ASCII controls U+0009-U+000D, U+001C-U+001F.
const NO_BREAK_SPACES = String.fromCharCode(0xa0, 0x2007, 0x202f);
const JAVA_BLANK = new RegExp(`^(?:(?![${NO_BREAK_SPACES}])[\\t-\\r\\x1C-\\x1F\\p{Zs}\\p{Zl}\\p{Zp}])*$`, "u");

/** String.isBlank(). */
export function javaIsBlank(value: string): boolean {
  return JAVA_BLANK.test(value);
}

/** `value.split(separator)` for a literal one-character separator: no separator gives `[value]`, and trailing empty strings are dropped. */
export function javaSplit(value: string, separator: string): string[] {
  if (!value.includes(separator)) return [value];
  const parts = value.split(separator);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Double.parseDouble's decimal forms: a sign, NaN or Infinity or digits with an optional point and exponent, and a trailing f, F, d or D.
// The hexadecimal floating-point form is not accepted (no ENVI or ISO 19139 file writes it).
const JAVA_DOUBLE = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;

/** Double.parseDouble(text), or null where Java throws NumberFormatException. */
export function parseJavaDouble(text: string): number | null {
  const trimmed = javaTrim(text);
  if (!JAVA_DOUBLE.test(trimmed)) return null;
  return Number(trimmed.replace(/[fFdD]$/, ""));
}

/** Integer.parseInt(text) (radix 10, ASCII digits), or null where Java throws NumberFormatException. */
export function parseJavaInt(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  if (value < -2_147_483_648 || value > 2_147_483_647) return null;
  // A Java int has no negative zero, and Number("-0") is one.
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Double.toString(value): the shortest decimal that reads back as the same double (JDK 19 and later; JDK 17 gives more digits
 * for a few doubles), in decimal from 10^-3 up to but not including 10^7 and in scientific notation outside that, always with
 * a digit after the point. The same algorithm as packages/core/src/java-double.ts, which core does not export.
 */
export function javaDoubleString(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const magnitude = Math.abs(value);
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
