/*
 * The few java.lang behaviours Tika's scientific parsers lean on, written out because JavaScript's differ: `String.trim()` takes
 * every character up to U+0020 off (not Unicode spaces), `String.isBlank()` and `Character.isWhitespace` leave the no-break
 * spaces alone, `String.split` drops trailing empty strings, `Double.parseDouble` and `Integer.parseInt` accept a narrower
 * grammar than `Number()`, and `Double.toString` always writes a digit after the point.
 */

export { javaDoubleString } from "@spikedpunch/ripstream-core";

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

