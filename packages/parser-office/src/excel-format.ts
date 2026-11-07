/** Date/number format helpers shared by the XLSX and XLS parsers. */

export function isDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped);
}

export function formatExcelDate(serial: number): string {
  const days = Math.floor(serial);
  const unixDays = days - 25569 + (days < 61 ? 1 : 0);
  const milliseconds = Math.round((serial - days) * 86_400_000);
  const date = new Date(unixDays * 86_400_000 + milliseconds);
  const iso = date.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 19);
  if (serial < 1) return timePart;
  return serial - days === 0 ? datePart : `${datePart}T${timePart}`;
}
