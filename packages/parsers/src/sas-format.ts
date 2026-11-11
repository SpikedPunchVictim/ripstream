import type { SasColumn, SasValue } from "./sas7bdat-file.ts";

/*
 * The text of one cell of a SAS7BDAT table. Tika gets it from parso's DataWriterUtil, whose source was not available. What is
 * known of it is what the two files of Tika's test show: a whole number has no decimal point ("3", "10"), the format
 * DDMMYYD writes "01-01-1960", and DATETIME writes "01Jan1960:00:00:10.00". The rest is this reader's own, from the SAS
 * names of the formats: the date formats it knows are the DATE format and the DDMMYY, MMDDYY and YYMMDD families, with the
 * TIME and DATETIME formats; any other format leaves the number as it is.
 */

const SAS_EPOCH_MS = Date.UTC(1960, 0, 1);
const MAX_DATE_MS = 8.64e15;
const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The letter at the end of a DDMMYY, MMDDYY or YYMMDD format name says what goes between the parts. */
const SEPARATORS = new Map([
  ["B", " "],
  ["C", ":"],
  ["D", "-"],
  ["N", ""],
  ["P", "."],
  ["S", "/"],
]);
const DATE_ORDERS = new Map([
  ["DDMMYY", ["dd", "MM", "yyyy"]],
  ["MMDDYY", ["MM", "dd", "yyyy"]],
  ["YYMMDD", ["yyyy", "MM", "dd"]],
]);
/** toFixed refuses more than a hundred digits; a format's precision is never near it. */
const MAX_PERCENT_DIGITS = 20;

export function formatCell(column: SasColumn, value: SasValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  const name = column.format?.name.toUpperCase() ?? "";
  const date = formatDate(name, value);
  if (date !== null) return date;
  if (name === "PERCENT") return `${percentText(value, column.format?.precision ?? 0)}%`;
  return numberText(value);
}

/** The value as a date or time in UTC when its format is one this reader knows, and the value is one a date can hold. */
function formatDate(name: string, value: number): string | null {
  const pattern = datePattern(name);
  if (pattern === null) return null;
  const millis = pattern.seconds ? SAS_EPOCH_MS + Math.round(value * 1000) : SAS_EPOCH_MS + Math.floor(value) * MS_PER_DAY;
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_DATE_MS) return null;
  return render(new Date(millis), pattern.text);
}

function datePattern(name: string): { text: string; seconds: boolean } | null {
  if (name === "DATE") return { text: "ddMMMyyyy", seconds: false };
  if (name === "DATETIME") return { text: "ddMMMyyyy:HH:mm:ss.SS", seconds: true };
  if (name === "TIME") return { text: "HH:mm:ss", seconds: true };
  const family = /^(DDMMYY|MMDDYY|YYMMDD)([BCDNPS])?$/.exec(name);
  if (family === null) return null;
  // Without a letter the parts are joined by a slash, except in YYMMDD, which has a dash.
  const separator = family[2] === undefined ? (family[1] === "YYMMDD" ? "-" : "/") : SEPARATORS.get(family[2])!;
  return { text: DATE_ORDERS.get(family[1]!)!.join(separator), seconds: false };
}

/** The pattern letters of java.text.SimpleDateFormat that the patterns above use; S is the milliseconds, in two digits at least. */
function render(date: Date, pattern: string): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return pattern.replace(/yyyy|MMM|MM|dd|HH|mm|ss|SS/g, (token) => {
    switch (token) {
      case "yyyy":
        return String(date.getUTCFullYear()).padStart(4, "0");
      case "MMM":
        return MONTHS[date.getUTCMonth()]!;
      case "MM":
        return two(date.getUTCMonth() + 1);
      case "dd":
        return two(date.getUTCDate());
      case "HH":
        return two(date.getUTCHours());
      case "mm":
        return two(date.getUTCMinutes());
      case "ss":
        return two(date.getUTCSeconds());
      default:
        return two(date.getUTCMilliseconds());
    }
  });
}

function percentText(value: number, precision: number): string {
  return String(Number((value * 100).toFixed(Math.min(precision, MAX_PERCENT_DIGITS))));
}

/** A whole number without a decimal point; anything else to fifteen significant digits, which hides the noise of a double. */
function numberText(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(15)));
}
