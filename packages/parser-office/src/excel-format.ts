/** Date/number format helpers shared by the XLSX and XLS parsers. */

export function isDateFormat(code: string): boolean {
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
export function excelSerialDate(serial: number): Date {
  const days = Math.floor(serial);
  const unixDays = days - 25569 + (days < 61 ? 1 : 0);
  const milliseconds = Math.round((serial - days) * 86_400_000);
  return new Date(unixDays * 86_400_000 + milliseconds);
}

/**
 * A date/time serial written with an Excel format code, as POI's DataFormatter writes it: quoted literals, escaped
 * characters, and the y/m/d/h/s tokens, with `m` read as minutes after an hour token or before a seconds token.
 */
export function formatExcelDateCode(code: string, serial: number): string {
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
      const end = code.indexOf("]", index + 1);
      index = end < 0 ? code.length : end + 1;
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
  const days = Math.floor(serial);
  const date = excelSerialDate(serial);
  const iso = date.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 19);
  if (serial < 1) return timePart;
  return serial - days === 0 ? datePart : `${datePart}T${timePart}`;
}
