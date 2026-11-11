/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The proleptic Gregorian `[year, month, day]` of a day count since 1970-01-01 (Howard Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1;
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function formatYear(year: number): string {
  return pad(year, 4);
}

export function formatMonth(month: number): string {
  return pad(month, 2);
}

export function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function formatTime(hour: number, minute: number, second: number): string {
  return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
}

/** `yyyy-MM-dd'T'HH:mm:ss'Z'` for a count of seconds since the epoch. */
export function formatUtc(epochSeconds: number): string {
  const days = Math.floor(epochSeconds / 86_400);
  const rest = epochSeconds - days * 86_400;
  const [year, month, day] = civilFromDays(days);
  return `${formatDate(year, month, day)}T${formatTime(Math.floor(rest / 3_600), Math.floor((rest % 3_600) / 60), rest % 60)}Z`;
}
