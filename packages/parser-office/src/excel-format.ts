/** Date/number format helpers shared by the XLSX and XLS parsers. */

/** An elapsed-time token: [h], [hh], [m], [mm], [s], [ss] (the bracketed unit counts the whole serial, not a time of day). */
const ELAPSED_TOKEN = /^\[(h+|m+|s+)\]/i;

export function isDateFormat(code: string): boolean {
  if (/\[(h+|m+|s+)\]/i.test(code)) return true;
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((month) => month.slice(0, 3));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_SHORT = DAYS.map((day) => day.slice(0, 3));

/** A cell's date/time serial as a UTC Date (the 1900 date system, with Excel's 1900 leap-year bug). */
/** The last day Excel can show (9999-12-31); a serial outside 0..this is not a date, and Date would throw on it. */
const MAX_EXCEL_SERIAL = 2_958_466;

function isExcelSerial(serial: number): boolean {
  return Number.isFinite(serial) && serial >= 0 && serial < MAX_EXCEL_SERIAL;
}

export function excelSerialDate(serial: number): Date {
  const days = Math.floor(serial);
  const unixDays = days - 25569 + (days < 61 ? 1 : 0);
  const milliseconds = Math.round((serial - days) * 86_400_000);
  return new Date(unixDays * 86_400_000 + milliseconds);
}

/** The digits after "ss." as POI writes them: the milliseconds rounded to that many places, never carried into the seconds ("0.96 s" in ".0" is ".10"). */
function fractionalSeconds(serial: number, places: number): string {
  const milliseconds = Math.round((serial - Math.floor(serial)) * 86_400_000) % 1000;
  return String(Math.round(milliseconds / 10 ** (3 - Math.min(places, 3)))).padStart(places, "0");
}

/**
 * A date/time serial written with an Excel format code, as POI's DataFormatter writes it: quoted literals, escaped
 * characters, and the y/m/d/h/s tokens, with `m` read as minutes after an hour token or before a seconds token.
 */
export function formatExcelDateCode(code: string, serial: number): string {
  if (!isExcelSerial(serial)) return String(serial);
  const date = excelSerialDate(serial);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const usesAmPm = /AM\/PM/i.test(code);
  const hour = usesAmPm ? (date.getUTCHours() % 12 === 0 ? 12 : date.getUTCHours() % 12) : date.getUTCHours();
  let out = "";
  let previous = "";
  for (let index = 0; index < code.length; ) {
    const char = code[index]!;
    if (char === '"') {
      const end = code.indexOf('"', index + 1);
      out += code.slice(index + 1, end < 0 ? code.length : end);
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    if (char === "\\") {
      out += code[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "[") {
      const elapsed = ELAPSED_TOKEN.exec(code.slice(index));
      if (elapsed !== null) {
        // POI's DataFormatter counts the whole serial in the bracketed unit: 1.5 in [h]:mm is 36:00. The unit that
        // follows it ("mm" after [h]) is the remainder of the hour, which the time-of-day fields already hold.
        const unit = elapsed[1]!.toLowerCase();
        const totalSeconds = Math.round(serial * 86_400);
        const divisor = unit[0] === "h" ? 3600 : unit[0] === "m" ? 60 : 1;
        const total = Math.floor(totalSeconds / divisor);
        out += String(total).padStart(unit.length, "0");
        previous = unit[0]!;
        index += elapsed[0].length;
        continue;
      }
      const end = code.indexOf("]", index + 1);
      index = end < 0 ? code.length : end + 1;
      continue;
    }
    const fraction = previous === "s" || previous === "ss" ? /^\.(0+)/.exec(code.slice(index)) : null;
    if (fraction !== null) {
      out += `.${fractionalSeconds(serial, fraction[1]!.length)}`;
      previous = "";
      index += fraction[0].length;
      continue;
    }
    const token = /^(AM\/PM|am\/pm|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s)/i.exec(code.slice(index))?.[0];
    if (token === undefined) {
      out += char;
      index++;
      continue;
    }
    const lower = token.toLowerCase();
    const next = code.slice(index + token.length).replace(/[^A-Za-z]/g, "").toLowerCase();
    if (lower === "am/pm") out += date.getUTCHours() < 12 ? (token === "AM/PM" ? "AM" : "am") : token === "AM/PM" ? "PM" : "pm";
    else if (lower === "yyyy") out += date.getUTCFullYear();
    else if (lower === "yy") out += String(date.getUTCFullYear()).slice(-2);
    else if (lower === "mmmm") out += MONTHS[date.getUTCMonth()];
    else if (lower === "mmm") out += MONTHS_SHORT[date.getUTCMonth()];
    else if (lower === "mm" || lower === "m") {
      if (previous === "h" || previous === "hh" || next.startsWith("s")) {
        out += lower === "mm" ? pad(date.getUTCMinutes()) : date.getUTCMinutes();
      } else {
        out += lower === "mm" ? pad(date.getUTCMonth() + 1) : date.getUTCMonth() + 1;
      }
    } else if (lower === "dddd") out += DAYS[date.getUTCDay()];
    else if (lower === "ddd") out += DAYS_SHORT[date.getUTCDay()];
    else if (lower === "dd") out += pad(date.getUTCDate());
    else if (lower === "d") out += date.getUTCDate();
    else if (lower === "hh" || lower === "h") out += lower === "hh" ? pad(hour) : hour;
    else if (lower === "ss") out += pad(date.getUTCSeconds());
    else if (lower === "s") out += date.getUTCSeconds();
    previous = lower;
    index += token.length;
  }
  return out;
}

export function formatExcelDate(serial: number): string {
  if (!isExcelSerial(serial)) return String(serial);
  const days = Math.floor(serial);
  const date = excelSerialDate(serial);
  const iso = date.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 19);
  if (serial < 1) return timePart;
  return serial - days === 0 ? datePart : `${datePart}T${timePart}`;
}

/**
 * The "General" display of a number, as Tika 4.2.0 writes it (oracle /tika, tikajs-ibvq follow-up): the value rounded to 15
 * significant digits, then written by a ten-decimal format that rounds the shortest digits half-even, a tie being settled by
 * the exact binary value as Java's DecimalFormat does ("0.1234567890125" is "0.123456789", "1e-7" is "0.0000001", 1.5e-10 is
 * "0.0000000001", 4e-11 is "0" and -4e-11 is "-0"). Past 1E15 it is scientific, mantissa digits trimmed, exponent signed
 * ("1234567890123456" is "1.23456789012346E+15", 1e16 is "1E+16"). JavaScript's own text switches to exponents at 1e21 and
 * 1e-7 and keeps 17 digits.
 */
export function formatGeneralNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const rounded = Math.abs(Number(Math.abs(value).toPrecision(15)));
  if (rounded > 1e15) {
    const [mantissa = "", exponent = ""] = rounded.toExponential(14).split("e");
    return `${sign}${mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa}E${exponent}`;
  }
  // The shortest digits of the rounded value, as a whole part and a fraction.
  const [shortest = "0", exponentText = "0"] = rounded.toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = shortest.replace(".", "");
  const whole = exponent >= 0 ? digits.slice(0, exponent + 1).padEnd(exponent + 1, "0") : "0";
  const fraction = exponent >= 0 ? digits.slice(exponent + 1) : "0".repeat(-exponent - 1) + digits;
  let scaled = BigInt(whole + fraction.slice(0, 10).padEnd(10, "0"));
  const rest = fraction.slice(10);
  if (rest.length > 0) {
    const first = rest.charCodeAt(0) - 0x30;
    let up = first > 5 || (first === 5 && /[1-9]/.test(rest.slice(1)));
    if (first === 5 && rest.length === 1) {
      // The digits end at the tie: the exact binary value says which side it is on, and an exact tie goes to the even digit.
      const exact = (rounded.toFixed(40).split(".")[1] ?? "").slice(10);
      const tie = `5${"0".repeat(29)}`;
      up = exact > tie || (exact === tie && scaled % 2n === 1n);
    }
    if (up) scaled += 1n;
  }
  const text = scaled.toString().padStart(11, "0");
  return `${sign}${`${text.slice(0, -10)}.${text.slice(-10)}`.replace(/\.?0+$/, "")}`;
}

/**
 * Builtin number formats (ECMA-376 18.8.30) with POI's codes, the subset whose display differs from the raw value. Oracle
 * (Tika 4.2.0 /tika, tikajs-ibvq follow-up): the date and time builtins are written with these codes, not as ISO text:
 * 1234.5678 gives "5/18/03" (14), "18-May-03" (15), "13:37" (20), "5/18/03 13:37" (22) and "37:37.9" (47).
 */
export const BUILTIN_NUMBER_FORMATS: Readonly<Record<number, string>> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  5: "$#,##0_);($#,##0)", 6: "$#,##0_);[Red]($#,##0)", 7: "$#,##0.00_);($#,##0.00)", 8: "$#,##0.00_);[Red]($#,##0.00)",
  9: "0%", 10: "0.00%", 11: "0.00E+00",
  14: "m/d/yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
  20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
};

/**
 * A display value for a cell's number format code, as POI's DataFormatter writes it. Covers the common case: a
 * positive/negative/zero section, thousands separators, fixed decimals, a percent sign, and quoted or currency
 * literals around the digits; anything else falls back to the raw value.
 */
export function formatNumber(code: string, value: number): string {
  const sections = code.split(";");
  const section = sections[value < 0 ? 1 : value === 0 ? 2 : 0] ?? sections[0]!;
  // "General" and "@" have no digit placeholder: the number is written as it is, not rounded to a whole number.
  if (!/[#0]/.test(section)) return formatGeneralNumber(value);
  const percent = section.includes("%");
  // toFixed throws a RangeError past 100 digits, and a format code is file input.
  const decimals = Math.min(/\.(0+)/.exec(section)?.[1]?.length ?? 0, 100);
  const grouping = /[#0],[#0]/.test(section);
  const magnitude = Math.abs(value) * (percent ? 100 : 1);
  let digits = magnitude.toFixed(decimals);
  if (grouping) {
    const [whole = "", fraction] = digits.split(".");
    digits = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
  }
  const [prefix, suffix] = numberAffixes(section);
  const negative = value < 0 && sections.length < 2 ? "-" : "";
  return `${negative}${prefix}${digits}${percent ? "%" : ""}${suffix}`;
}

/** Literal text before and after the digit placeholders: quoted text, escaped characters and currency symbols. */
function numberAffixes(section: string): [string, string] {
  const literal = (part: string): string => {
    let text = "";
    for (let index = 0; index < part.length; index++) {
      const char = part[index]!;
      if (char === '"') {
        const end = part.indexOf('"', index + 1);
        if (end < 0) break;
        text += part.slice(index + 1, end);
        index = end;
      } else if (char === "\\" && index + 1 < part.length) {
        text += part[++index]!;
      } else if (char === "_" || char === "*") {
        index++;
      } else if (char === "[") {
        const end = part.indexOf("]", index + 1);
        index = end < 0 ? part.length : end;
      } else if (!"#0.,%?/Ee+".includes(char)) {
        text += char;
      }
    }
    return text;
  };
  const first = section.search(/[#0]/);
  const last = Math.max(section.lastIndexOf("#"), section.lastIndexOf("0"));
  if (first < 0) return ["", ""];
  return [literal(section.slice(0, first)), literal(section.slice(last + 1))];
}
