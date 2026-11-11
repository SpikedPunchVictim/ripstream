import { civilFromDays, daysFromCivil, formatDate, formatMonth, formatTime, formatUtc, formatYear } from "./civil-time.ts";
import { compileJavaRegex } from "./java-regex.ts";

/**
 * The one parser for date strings from documents (Tika's `TikaDates`). A value is routed by its leading shape to a
 * family (ISO 8601 and W3C-DTF, PDF `D:`, EXIF, RFC 5322 and the other month-name forms, ctime, slash dates, and
 * 8, 12 or 14 digit strings) and must match that family whole; there is no prefix matching.
 *
 * - Years outside 1000..2200 and offsets outside -12:00..+14:00 are refused. The calendar is the proleptic Gregorian one
 *   as written.
 * - A slash date is month-first unless the first field is over 12 (day-first) or over 31 (yy/M/d). A two-digit year
 *   below 50 is 20xx, else 19xx.
 * - A named zone is a fixed offset (EDT is -4 all year). An unknown name of two to five letters means the zone is
 *   unknown (RFC 5322 4.3). A date-only value has no zone even if one was written.
 * - Producer quirks are accepted: `HH:mmss`, `HH.mm.ss`, one-digit seconds, a trailing `:cc` after the seconds,
 *   `Z00:00`, apostrophes in an offset (`-06'00'`), AM/PM after an ISO time, `D:` followed by ISO, a trailing
 *   `(comment)`, a missing sign on a `0000` offset, and, in the mail forms only, junk after a complete time and
 *   numeric offset.
 * - A value over 256 characters (after trimming) is refused unread.
 *
 * The text is trimmed as Java's `String.trim` does (every character up to U+0020, and not a no-break space), a run of
 * ASCII whitespace is one space, and digits and letters are ASCII only, as in Tika's patterns.
 */
export const TIKA_DATES_MIN_YEAR = 1000;
export const TIKA_DATES_MAX_YEAR = 2200;
const MAX_LENGTH = 256;

export type TikaDatePrecision = "YEAR" | "MONTH" | "DAY" | "MINUTE" | "SECOND";

/** A date as written: the local fields, an offset in seconds or null when the source had none, and how much it said. */
export class ParsedTikaDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Null when the source had no zone. */
  readonly offsetSeconds: number | null;
  readonly precision: TikaDatePrecision;

  constructor(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    offsetSeconds: number | null,
    precision: TikaDatePrecision,
  ) {
    this.year = year;
    this.month = month;
    this.day = day;
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.offsetSeconds = offsetSeconds;
    this.precision = precision;
  }

  get hasZone(): boolean {
    return this.offsetSeconds !== null;
  }

  /** Day precision or finer. */
  get isFullPrecision(): boolean {
    return this.precision !== "YEAR" && this.precision !== "MONTH";
  }

  /** Seconds since the epoch; a value with no zone reads as UTC, so a date-only value is midday UTC. */
  get epochSeconds(): number {
    const local = daysFromCivil(this.year, this.month, this.day) * 86_400 + this.hour * 3_600 + this.minute * 60 + this.second;
    return local - (this.offsetSeconds ?? 0);
  }

  /** `yyyy-MM-dd'T'HH:mm:ss'Z'` in UTC. */
  toCanonicalString(): string {
    return formatUtc(this.epochSeconds);
  }

  /** The stored form: `yyyy-MM-dd` for a date-only value, else the canonical string when it has a zone, else the local time. */
  toMetadataString(): string {
    if (this.precision === "DAY") return formatDate(this.year, this.month, this.day);
    if (this.offsetSeconds !== null) return this.toCanonicalString();
    return `${formatDate(this.year, this.month, this.day)}T${formatTime(this.hour, this.minute, this.second)}`;
  }
}

/** Reads a date, or null when it is not one. A partial date (a year, or a year and month) is read too. */
export function parseTikaDate(raw: string | null | undefined): ParsedTikaDate | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = javaTrim(raw);
  if (trimmed.length > MAX_LENGTH) return null;
  const text = trimmed.replace(WHITESPACE_RUN, " ").toUpperCase();
  if (text === "") return null;
  try {
    const parsed = route(text);
    return parsed !== null && inYearBounds(parsed.epochSeconds * 1000) ? parsed : null;
  } catch (error) {
    if (error instanceof Reject) return null;
    throw error;
  }
}

/** Canonical UTC (`yyyy-MM-dd'T'HH:mm:ss'Z'`) for a full-precision date, else null. */
export function normalizeTikaDate(raw: string | null | undefined): string | null {
  const parsed = parseTikaDate(raw);
  return parsed !== null && parsed.isFullPrecision ? parsed.toCanonicalString() : null;
}

/** `ParsedTikaDate.toMetadataString` for a full-precision date, else null. */
export function tikaDateMetadataString(raw: string | null | undefined): string | null {
  const parsed = parseTikaDate(raw);
  return parsed !== null && parsed.isFullPrecision ? parsed.toMetadataString() : null;
}

/** Like `tikaDateMetadataString` but keeps `yyyy` and `yyyy-MM`; for source-specific keys only. */
export function tikaDateMetadataStringKeepPartial(raw: string | null | undefined): string | null {
  const parsed = parseTikaDate(raw);
  if (parsed === null) return null;
  if (parsed.precision === "YEAR") return formatYear(parsed.year);
  if (parsed.precision === "MONTH") return `${formatYear(parsed.year)}-${formatMonth(parsed.month)}`;
  return parsed.toMetadataString();
}

/** Whether an instant, in milliseconds since the epoch, falls in the years 1000..2200 UTC. For dates decoded from binary fields. */
export function inYearBounds(epochMillis: number): boolean {
  if (!Number.isFinite(epochMillis)) return false;
  const [year] = civilFromDays(Math.floor(epochMillis / 86_400_000));
  return year >= TIKA_DATES_MIN_YEAR && year <= TIKA_DATES_MAX_YEAR;
}

/** Thrown for a value that matches a family and is not a date (a month 13, an offset of +17:00); caught in `parseTikaDate`. */
class Reject extends Error {}

/** A zone found in a value: its offset in seconds, or null for unknown. A null `Zone` is a refusal. */
type Zone = { readonly seconds: number | null } | null;
const NO_ZONE: Zone = { seconds: null };

const OFFSET = String.raw`(?:(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?)`;
const ZONE = String.raw`(?:\s*(?:${OFFSET}|(Z|[A-Z]{1,5})))?`;
const TIME = String.raw`(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,]\d{1,9})?)?(?:\s*([AP])\.?M\.?)?`;

/** A pattern that has to match the whole value, as Java's `Matcher.matches` does. */
function whole(pattern: string): RegExp {
  return compileJavaRegex(String.raw`\A(?:${pattern})\z`);
}

// also producer quirks: HH:mmss, HH.mm.ss, 1-digit seconds, trailing :cc
const ISO = whole(
  String.raw`(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})` +
    String.raw`(?:(?:T|\s+)(\d{1,2})([:.])(\d{2})(?:(?:\5|(?<=:\d\d))(\d{1,2})(?::\d{2})?(?:[.,]\d{1,9})?)?` +
    String.raw`(?:\s*([AP])\.?M\.?)?)?)?)?${ZONE}`,
);
const PDF = whole(
  String.raw`(D:)?\s*(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?` +
    String.raw`(?:(Z)(?:00'?00'?|')?|([+-])(\d{1,2})(?:'?(\d{2})'{0,2})?)?`,
);
const EXIF = whole(String.raw`(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?${ZONE}`);
// d MMM yyyy [time] [zone]
const DAY_MONTH = whole(String.raw`(\d{1,2})[ -]([A-Z]{3,9})\.?,?[ -](\d{4}|\d{2})(?:,?\s+${TIME})?${ZONE}`);
// MMM d[,] yyyy [time] [zone]
const MONTH_DAY = whole(String.raw`([A-Z]{3,9})\.?\s+(\d{1,2})(?:ST|ND|RD|TH)?,?\s+(\d{4})(?:,?\s+${TIME})?${ZONE}`);
// ctime: MMM d HH:mm:ss [zone-name] yyyy [offset]
const CTIME = whole(String.raw`([A-Z]{3,9})\s+(\d{1,2})\s+${TIME}(?:\s+([A-Z]{1,5}))?\s+(\d{4})${ZONE}`);
// M/d/yy[yy] or d/M/yy[yy] [time] [zone]
const SLASH = whole(String.raw`(\d{1,2})/(\d{1,2})/(\d{4}|\d{1,2})(?:,?\s+${TIME})?${ZONE}`);
const SLASH_YMD = whole(String.raw`(\d{4})/(\d{1,2})/(\d{1,2})(?:\s+${TIME})?${ZONE}`);

const WEEKDAY = compileJavaRegex(
  String.raw`^(?:MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)(?:DAY|NESDAY|SDAY|RSDAY|URDAY)?\.?,?\s+`,
);
const TRAILING_COMMENT = compileJavaRegex(String.raw`\s*\([^()]*\)$`);
const WHITESPACE_RUN = /[ \t\n\v\f\r]+/g;
// producer quirk: an explicit UTC marker followed by a redundant zero offset
const Z_ZERO = compileJavaRegex("Z00:?00");
// "-0400 EDT": a name after an explicit offset is redundant
const OFFSET_THEN_NAME = compileJavaRegex(String.raw`([+-]\d{2}:?\d{2})\s+[A-Z]{2,5}$`);
const AFTER_OFFSET = withFlags(compileJavaRegex(String.raw`\d:\d{2}(?::\d{2})?\s*([+-]\d{4})(?![\d:]).+$`), "d");
// RFC 5322 allows a missing sign only for the zero offset
const UNSIGNED_ZERO = compileJavaRegex(String.raw`\s0000$`);

const ZONE_HOURS: ReadonlyMap<string, number> = new Map([
  ["Z", 0], ["UT", 0], ["UTC", 0], ["GMT", 0],
  ["EST", -5], ["EDT", -4], ["CST", -6], ["CDT", -5],
  ["MST", -7], ["MDT", -6], ["PST", -8], ["PDT", -7],
  ["CET", 1], ["CEST", 2], ["MET", 1], ["MEST", 2],
  ["WET", 0], ["WEST", 1], ["EET", 2], ["EEST", 3],
  ["MSK", 3], ["JST", 9], ["HST", -10], ["AKST", -9],
  ["AKDT", -8], ["NZST", 12], ["NZDT", 13],
]);

const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
] as const;

function withFlags(regex: RegExp, flags: string): RegExp {
  return new RegExp(regex.source, regex.flags + flags);
}

/** `String.trim` in Java: strips every character up to U+0020 from both ends, and nothing else. */
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isLetter(char: string): boolean {
  return char >= "A" && char <= "Z";
}

function route(input: string): ParsedTikaDate | null {
  const s = input.replace(TRAILING_COMMENT, "");
  if (s === "") return null;
  const c = s[0]!;
  if (c === "D" && s.startsWith("D:")) return s.length > 6 && s[6] === "-" ? iso(s.slice(2)) : pdf(s);
  if (isDigit(c)) {
    if (s.length > 4 && isDigit(s[1]) && isDigit(s[2]) && isDigit(s[3])) {
      const separator = s[4]!;
      if (separator === "-") return iso(s);
      if (separator === ":") return exif(s);
      if (separator === "/") return slashYmd(s);
      if (isDigit(separator)) return pdf(s);
      return null;
    }
    if (s.length === 4) return iso(s);
    const slash = s.indexOf("/");
    if (slash > 0 && slash < 3) return slashDate(s);
    return dayMonth(stripMailNoise(s));
  }
  const t = s.replace(WEEKDAY, "");
  if (t === "" || (t === s && !isLetter(c))) return null;
  if (isDigit(t[0])) return route(t);
  const mail = stripMailNoise(t);
  return monthDay(mail) ?? ctime(mail);
}

function stripMailNoise(input: string): string {
  let s = input;
  const junk = AFTER_OFFSET.exec(s);
  if (junk !== null) s = s.slice(0, junk.indices![1]![1]);
  s = s.replace(TRAILING_COMMENT, "");
  s = s.replaceAll(" AT ", " ");
  s = s.replace(OFFSET_THEN_NAME, "$1");
  return s.replace(UNSIGNED_ZERO, " +0000");
}

/** The text of group `n`, which a successful match leaves undefined when the group did not take part. */
type Groups = RegExpExecArray;

function iso(s: string): ParsedTikaDate | null {
  // PDF-style offsets in ISO strings: -06'00'
  const m = ISO.exec(s.replaceAll("'", "").replace(Z_ZERO, "Z"));
  if (m === null) return null;
  const year = Number(m[1]);
  if (m[2] === undefined) return partial(year, 1, "YEAR");
  if (m[3] === undefined) return partial(year, Number(m[2]), "MONTH");
  return build(year, Number(m[2]), Number(m[3]), m[4], m[6], m[7], m[8], zone(m, 9));
}

function pdf(s: string): ParsedTikaDate | null {
  const m = PDF.exec(s);
  if (m === null) return null;
  const prefixed = m[1] !== undefined;
  let digits = 4;
  for (let g = 3; g <= 7 && m[g] !== undefined; g++) digits += 2;
  // bare digits are dates only at 8, 12 or 14 digits
  if (!prefixed && digits !== 8 && digits !== 12 && digits !== 14) return null;
  const year = Number(m[2]);
  if (m[3] === undefined) return partial(year, 1, "YEAR");
  if (m[4] === undefined) return partial(year, Number(m[3]), "MONTH");
  if (m[5] !== undefined && m[6] === undefined) return null;
  let offset: Zone = NO_ZONE;
  if (m[8] !== undefined) offset = { seconds: 0 };
  else if (m[9] !== undefined) offset = { seconds: offsetSeconds(m[9], m[10]!, m[11]) };
  return build(year, Number(m[3]), Number(m[4]), m[5], m[6], m[7], undefined, offset);
}

function exif(s: string): ParsedTikaDate | null {
  const m = EXIF.exec(s);
  if (m === null) return null;
  return build(Number(m[1]), Number(m[2]), Number(m[3]), m[4], m[5], m[6], undefined, zone(m, 7));
}

function dayMonth(s: string): ParsedTikaDate | null {
  const m = DAY_MONTH.exec(s);
  if (m === null) return null;
  const month = monthNumber(m[2]!);
  if (month < 0) return null;
  return build(twoOrFourDigitYear(m[3]!), month, Number(m[1]), m[4], m[5], m[6], m[7], zone(m, 8));
}

function monthDay(s: string): ParsedTikaDate | null {
  const m = MONTH_DAY.exec(s);
  if (m === null) return null;
  const month = monthNumber(m[1]!);
  if (month < 0) return null;
  return build(Number(m[3]), month, Number(m[2]), m[4], m[5], m[6], m[7], zone(m, 8));
}

function ctime(s: string): ParsedTikaDate | null {
  const m = CTIME.exec(s);
  if (m === null) return null;
  const month = monthNumber(m[1]!);
  if (month < 0) return null;
  let z = zone(m, 9);
  if (z === null) return null;
  if (m[7] !== undefined) {
    const named = namedOrUnknown(m[7]);
    if (named === null) return null;
    if (z.seconds === null) z = named;
    else if (named.seconds !== null && named.seconds !== z.seconds) return null; // a known name contradicting the numeric offset
  }
  return build(Number(m[8]), month, Number(m[2]), m[3], m[4], m[5], m[6], z);
}

function slashDate(s: string): ParsedTikaDate | null {
  const m = SLASH.exec(s);
  if (m === null) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 31) {
    // only a year can be > 31: yy/M/d
    return build(twoOrFourDigitYear(m[1]!), b, Number(m[3]), m[4], m[5], m[6], m[7], zone(m, 8));
  }
  if (m[3]!.length === 1) return null;
  const month = a > 12 ? b : a;
  const day = a > 12 ? a : b;
  return build(twoOrFourDigitYear(m[3]!), month, day, m[4], m[5], m[6], m[7], zone(m, 8));
}

function slashYmd(s: string): ParsedTikaDate | null {
  const m = SLASH_YMD.exec(s);
  if (m === null) return null;
  return build(Number(m[1]), Number(m[2]), Number(m[3]), m[4], m[5], m[6], m[7], zone(m, 8));
}

/** The zone groups from group `g` on: sign, hours, minutes, name. Null means refuse. */
function zone(m: Groups, g: number): Zone {
  if (m[g] !== undefined) return { seconds: offsetSeconds(m[g]!, m[g + 1]!, m[g + 2]) };
  if (m[g + 3] !== undefined) return namedOrUnknown(m[g + 3]!);
  return NO_ZONE;
}

// RFC 5322 4.3: an unknown zone name means zone unknown
function namedOrUnknown(name: string): Zone {
  const hours = ZONE_HOURS.get(name);
  if (hours !== undefined) return { seconds: hours * 3_600 };
  return name.length >= 2 ? NO_ZONE : null;
}

function offsetSeconds(sign: string, hh: string, mm: string | undefined): number {
  const hours = Number(hh);
  const minutes = mm === undefined ? 0 : Number(mm);
  const total = hours * 60 + minutes;
  if (minutes > 59 || (sign === "-" ? total > 12 * 60 : total > 14 * 60)) throw new Reject("offset out of range");
  return (sign === "-" && total > 0 ? -total : total) * 60;
}

function monthNumber(name: string): number {
  if (name.length < 3) return -1;
  const index = MONTH_NAMES.findIndex((full) => full.startsWith(name));
  return index === -1 ? -1 : index + 1;
}

function twoOrFourDigitYear(text: string): number {
  const value = Number(text);
  if (text.length === 2) return value < 50 ? 2000 + value : 1900 + value;
  return value;
}

function partial(year: number, month: number, precision: "YEAR" | "MONTH"): ParsedTikaDate {
  return localDateTime(year, month, 1, 12, 0, 0, null, precision);
}

function build(
  year: number,
  month: number,
  day: number,
  hh: string | undefined,
  mi: string | undefined,
  ss: string | undefined,
  ampm: string | undefined,
  z: Zone,
): ParsedTikaDate | null {
  if (z === null) return null;
  if (hh === undefined) return localDateTime(year, month, day, 12, 0, 0, null, "DAY");
  let hour = Number(hh);
  if (ampm !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "P" ? 12 : 0);
  }
  const second = ss === undefined ? 0 : Number(ss);
  return localDateTime(year, month, day, hour, Number(mi), second, z.seconds, ss === undefined ? "MINUTE" : "SECOND");
}

/** The date, or a `Reject` when a field is out of range or the day is not in the month (Java's `LocalDateTime.of`). */
function localDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offset: number | null,
  precision: TikaDatePrecision,
): ParsedTikaDate {
  if (month < 1 || month > 12) throw new Reject(`month ${month}`);
  if (day < 1 || day > daysInMonth(year, month)) throw new Reject(`day ${day} of ${year}-${month}`);
  if (hour > 23 || minute > 59 || second > 59) throw new Reject("time out of range");
  return new ParsedTikaDate(year, month, day, hour, minute, second, offset, precision);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
