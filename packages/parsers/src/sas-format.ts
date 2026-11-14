import type { SasColumn, SasValue } from "./sas7bdat-file.ts";

/*
 * The text of one cell of a SAS7BDAT table, as Tika's SAS7BDATParser gets it from parso's DataWriterUtil and
 * java.text.SimpleDateFormat: a date or date-time column is a Date formatted in UTC with the pattern parso's
 * DateTimeConstants maps its format name to; a time column is hours, minutes and seconds; a percent is scaled; and
 * anything else is the number. The calendar is Java's: Julian up to 1582-10-14 and Gregorian from 1582-10-15.
 */

const MS_PER_DAY = 86_400_000;
const SAS_VS_EPOCH_SECONDS = 3_653 * 86_400;
const SAS_DAYS_29FEB4000 = 745_154;
const SAS_DAYS_29FEB8000 = 2_206_123;
/** The first day that Java's GregorianCalendar counts in the Gregorian calendar, in days since 1970-01-01. */
const GREGORIAN_CUTOVER_DAY = Date.UTC(1582, 9, 15) / MS_PER_DAY;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** parso's DateTimeConstants.DATE_FORMAT_STRINGS. */
const DATE_FORMATS = new Map<string, string>([
  ["B8601DA", "yyyyMMdd"],
  ["E8601DA", "yyyy-MM-dd"],
  ["DATE", "ddMMMyyyy"],
  ["DAY", "dd"],
  ["DDMMYY", "dd/MM/yyyy"],
  ["DDMMYYB", "dd MM yyyy"],
  ["DDMMYYC", "dd:MM:yyyy"],
  ["DDMMYYD", "dd-MM-yyyy"],
  ["DDMMYYN", "ddMMyyyy"],
  ["DDMMYYP", "dd.MM.yyyy"],
  ["DDMMYYS", "dd/MM/yyyy"],
  ["JULDAY", "D"],
  ["JULIAN", "yyyyD"],
  ["MMDDYY", "MM/dd/yyyy"],
  ["MMDDYYB", "MM dd yyyy"],
  ["MMDDYYC", "MM:dd:yyyy"],
  ["MMDDYYD", "MM-dd-yyyy"],
  ["MMDDYYN", "MMddyyyy"],
  ["MMDDYYP", "MM.dd.yyyy"],
  ["MMDDYYS", "MM/dd/yyyy"],
  ["MMYY", "MM'M'yyyy"],
  ["MMYYC", "MM:yyyy"],
  ["MMYYD", "MM-yyyy"],
  ["MMYYN", "MMyyyy"],
  ["MMYYP", "MM.yyyy"],
  ["MMYYS", "MM/yyyy"],
  ["MONNAME", "MMMM"],
  ["MONTH", "M"],
  ["MONYY", "MMMyyyy"],
  ["WEEKDATE", "EEEE, MMMM dd, yyyy"],
  ["WEEKDATX", "EEEE, dd MMMM, yyyy"],
  ["WEEKDAY", "u"],
  ["DOWNAME", "EEEE"],
  ["WORDDATE", "MMMM d, yyyy"],
  ["WORDDATX", "d MMMM yyyy"],
  ["YYMM", "yyyy'M'MM"],
  ["YYMMC", "yyyy:MM"],
  ["YYMMD", "yyyy-MM"],
  ["YYMMN", "yyyyMM"],
  ["YYMMP", "yyyy.MM"],
  ["YYMMS", "yyyy/MM"],
  ["YYMMDD", "yyyy-MM-dd"],
  ["YYMMDDB", "yyyy MM dd"],
  ["YYMMDDC", "yyyy:MM:dd"],
  ["YYMMDDD", "yyyy-MM-dd"],
  ["YYMMDDN", "yyyyMMdd"],
  ["YYMMDDP", "yyyy.MM.dd"],
  ["YYMMDDS", "yyyy/MM/dd"],
  ["YYMON", "yyyyMMM"],
  ["YEAR", "yyyy"],
]);

/** parso's DateTimeConstants.DATETIME_FORMAT_STRINGS. */
const DATETIME_FORMATS = new Map<string, string>([
  ["B8601DN", "yyyyMMdd"],
  ["B8601DT", "yyyyMMdd'T'HHmmssSSS"],
  ["B8601DX", "yyyyMMdd'T'HHmmssZ"],
  ["B8601DZ", "yyyyMMdd'T'HHmmssZ"],
  ["B8601LX", "yyyyMMdd'T'HHmmssZ"],
  ["E8601DN", "yyyy-MM-dd"],
  ["E8601DT", "yyyy-MM-dd'T'HH:mm:ss.SSS"],
  ["E8601DX", "yyyy-MM-dd'T'HH:mm:ssZ"],
  ["E8601DZ", "yyyy-MM-dd'T'HH:mm:ssZ"],
  ["E8601LX", "yyyy-MM-dd'T'HH:mm:ssZ"],
  ["DATEAMPM", "ddMMMyyyy:HH:mm:ss.SS a"],
  ["DATETIME", "ddMMMyyyy:HH:mm:ss.SS"],
  ["DTDATE", "ddMMMyyyy"],
  ["DTMONYY", "MMMyyyy"],
  ["DTWKDATX", "EEEE, dd MMMM, yyyy"],
  ["DTYEAR", "yyyy"],
  ["MDYAMPM", "MM/dd/yyyy H:mm a"],
  ["TOD", "HH:mm:ss.SS"],
]);

/** The formats DataWriterUtil writes as hours, minutes and seconds, whatever their name says about the layout. */
const TIME_FORMATS = new Set(["TIME", "HHMM", "E8601LZ", "E8601TM", "HOUR", "MMSS", "TIMEAMPM"]);

/** toFixed refuses more than a hundred digits; a format's precision is never near it. */
const MAX_PERCENT_DIGITS = 20;

export function formatCell(column: SasColumn, value: SasValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  const name = column.format?.name.toUpperCase() ?? "";
  const datePattern = DATE_FORMATS.get(name);
  if (datePattern !== undefined) return dateText(daysToMillis(value), datePattern, value);
  const dateTimePattern = DATETIME_FORMATS.get(name);
  if (dateTimePattern !== undefined) return dateText(secondsToMillis(value), dateTimePattern, value);
  if (TIME_FORMATS.has(name)) return timeText(value);
  if (name === "PERCENT") return `${percentText(value, column.format?.precision ?? 0)}%`;
  return numberText(value);
}

/** A date as parso makes it: SAS days since 1960-01-01, with the leap days SAS removes after the year 4000 put back. */
function daysToMillis(days: number): number {
  let fixed = days;
  if (fixed >= SAS_DAYS_29FEB4000) {
    if (fixed >= SAS_DAYS_29FEB8000) fixed += 1;
    fixed += 1;
  }
  return Math.trunc((fixed * 86_400 - SAS_VS_EPOCH_SECONDS) * 1000);
}

/** Seconds since 1960-01-01 as parso makes a date of them; the cast in Java truncates toward zero. */
function secondsToMillis(seconds: number): number {
  let fixed = seconds;
  const seconds4000 = SAS_DAYS_29FEB4000 * 86_400;
  if (fixed >= seconds4000) {
    if (fixed >= SAS_DAYS_29FEB8000 * 86_400) fixed += 86_400;
    fixed += 86_400;
  }
  return Math.trunc((fixed - SAS_VS_EPOCH_SECONDS) * 1000);
}

/**
 * DataWriterUtil writes an empty cell for a Date at exactly 1970-01-01T00:00:00Z. A value beyond what a JavaScript Date
 * holds is written as the number it is rather than as a date no reader can give.
 */
function dateText(millis: number, pattern: string, value: number): string {
  if (!Number.isFinite(millis) || Math.abs(millis) > 8.64e15) return numberText(value);
  return millis === 0 ? "" : renderJavaDate(millis, pattern);
}

/** DataWriterUtil writes every time format as HH:mm:ss from the whole seconds since midnight. */
function timeText(value: number): string {
  const seconds = Math.trunc(value);
  const two = (part: number): string => String(part).padStart(2, "0");
  return `${two(Math.trunc(seconds / 3600))}:${two(Math.trunc(seconds / 60) % 60)}:${two(seconds % 60)}`;
}

interface CalendarFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly dayOfYear: number;
  readonly weekday: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly milliseconds: number;
}

/** The fields Java's GregorianCalendar reads from an instant: Julian before the 1582 cutover, Gregorian after it. */
function calendarFields(millis: number): CalendarFields {
  const day = Math.floor(millis / MS_PER_DAY);
  const ofDay = ((millis % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const hours = Math.floor(ofDay / 3_600_000);
  const minutes = Math.floor(ofDay / 60_000) % 60;
  const seconds = Math.floor(ofDay / 1000) % 60;
  const milliseconds = ofDay % 1000;
  // 1970-01-01 was a Thursday, so day 0 is weekday 4 with Sunday as 0.
  const weekday = (((day + 4) % 7) + 7) % 7;
  if (day >= GREGORIAN_CUTOVER_DAY) {
    const date = new Date(millis);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dayOfMonth = date.getUTCDate();
    const start = Date.UTC(year, 0, 1) / MS_PER_DAY;
    // Java counts the ten days the Gregorian cutover removed out of 1582, so its last day is the 355th.
    const skipped = year === 1582 ? 10 : 0;
    return { year, month, day: dayOfMonth, dayOfYear: day - start + 1 - skipped, weekday, hours, minutes, seconds, milliseconds };
  }
  const julian = julianDate(day);
  return { ...julian, dayOfYear: julianDayOfYear(julian.year, julian.month, julian.day), weekday, hours, minutes, seconds, milliseconds };
}

/** The Julian calendar date of a day count from 1970-01-01, by the Julian day number. */
function julianDate(day: number): { year: number; month: number; day: number } {
  const c = day + 2_440_588 + 32_082;
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    year: d - 4800 + Math.floor(m / 10),
    month: m + 3 - 12 * Math.floor(m / 10),
    day: e - Math.floor((153 * m + 2) / 5) + 1,
  };
}

function julianDayOfYear(year: number, month: number, day: number): number {
  let total = day;
  for (let index = 1; index < month; index++) total += JULIAN_MONTH_LENGTHS[index - 1]! + (index === 2 && year % 4 === 0 ? 1 : 0);
  return total;
}

const JULIAN_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** java.text.SimpleDateFormat with Locale.US and UTC, for the pattern letters parso's constants use. */
function renderJavaDate(millis: number, pattern: string): string {
  const fields = calendarFields(millis);
  let out = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]!;
    if (char === "'") {
      const end = pattern.indexOf("'", at + 1);
      if (end === -1) {
        out += pattern.slice(at + 1);
        break;
      }
      out += pattern.slice(at + 1, end);
      at = end;
      continue;
    }
    let length = 1;
    while (pattern[at + length] === char) length++;
    at += length - 1;
    const pad = (value: number, width: number): string => String(value).padStart(width, "0");
    switch (char) {
      case "y":
        out += pad(fields.year, 4);
        break;
      case "M":
        out += length >= 4 ? MONTHS[fields.month - 1]! : length === 3 ? MONTHS_SHORT[fields.month - 1]! : pad(fields.month, length);
        break;
      case "d":
        out += pad(fields.day, length);
        break;
      case "D":
        out += pad(fields.dayOfYear, length);
        break;
      case "E":
        out += length >= 4 ? WEEKDAYS[fields.weekday]! : WEEKDAYS[fields.weekday]!.slice(0, 3);
        break;
      case "u": {
        const dayNumber = fields.weekday === 0 ? 7 : fields.weekday;
        out += pad(dayNumber, length);
        break;
      }
      case "H":
        out += pad(fields.hours, length);
        break;
      case "m":
        out += pad(fields.minutes, length);
        break;
      case "s":
        out += pad(fields.seconds, length);
        break;
      case "S":
        out += pad(fields.milliseconds, length);
        break;
      case "a":
        out += fields.hours < 12 ? "AM" : "PM";
        break;
      case "Z":
        out += "+0000";
        break;
      default:
        out += char;
        break;
    }
  }
  return out;
}

function percentText(value: number, precision: number): string {
  return String(Number((value * 100).toFixed(Math.min(precision, MAX_PERCENT_DIGITS))));
}

/**
 * A number as DataWriterUtil writes one: Java's Double.toString (scientific below 10^-3 and from 10^7, upper-case E), the
 * trailing ".0" gone, and a representation longer than thirteen characters rounded to fifteen significant digits.
 */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // parso makes a number whose distance from a whole one is less than 1E-14 a Java Long, which is written as it is.
  const whole = Math.round(value);
  if (Number.isSafeInteger(whole) && Math.abs(value - whole) < 1e-14) return String(whole);
  let text = javaDoubleText(value);
  if (text.length > 13) {
    const before = Math.ceil(Math.log10(Math.abs(value)));
    text = javaDoubleText(Number(value.toFixed(15 - before)));
  }
  return trimZeros(text);
}

function javaDoubleText(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e7) {
    const [mantissa, exponent] = value.toExponential().split("e");
    return `${mantissa!.includes(".") ? mantissa! : `${mantissa!}.0`}E${Number(exponent)}`;
  }
  return String(value);
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0*$/, "").replace(/\.$/, "") : text;
}
