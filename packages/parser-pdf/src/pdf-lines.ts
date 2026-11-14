export interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
  readonly transform?: number[];
  readonly width?: number;
  readonly height?: number;
}

/** Baselines closer than this (in points) are one line. */
const SAME_LINE = 1;
/** A gap between two items wider than this many font heights is a space; narrower is the same word (a font change). */
const WORD_GAP = 0.15;

/**
 * Items in reading order: top to bottom, and left to right along a line. A line is what `lines()` below calls one, so the
 * sort and the grouping agree: items on baselines a fraction of a point apart are sorted by x, not by that fraction.
 */
function sortedByPosition(items: PdfTextItem[]): PdfTextItem[] {
  const byBaseline = [...items].sort((left, right) => (right.transform?.[5] ?? 0) - (left.transform?.[5] ?? 0));
  const result: PdfTextItem[] = [];
  let row: PdfTextItem[] = [];
  let rowY: number | undefined;
  const flush = (): void => {
    row.sort((left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0));
    result.push(...row);
    row = [];
  };
  for (const item of byBaseline) {
    const y = item.transform?.[5] ?? 0;
    if (rowY !== undefined && Math.abs(y - rowY) > SAME_LINE) flush();
    if (row.length === 0) rowY = y;
    row.push(item);
  }
  flush();
  return result;
}

/** Whether a space belongs between `previous` and `next`, two items of one line. Without geometry, it does. */
function needsSpace(previous: PdfTextItem | undefined, next: PdfTextItem): boolean {
  const end = previous?.transform?.[4];
  const start = next.transform?.[4];
  const width = previous?.width;
  const height = next.height ?? previous?.height;
  if (end === undefined || start === undefined || width === undefined || height === undefined || height <= 0) return true;
  return start - (end + width) > WORD_GAP * height;
}

/** Groups pdf.js text items into visual lines by baseline. */
export function lines(items: PdfTextItem[], sortByPosition = false): string[] {
  if (sortByPosition) items = sortedByPosition(items);
  const result: string[] = [];
  let current = "";
  let lastY: number | null = null;
  let previous: PdfTextItem | undefined;

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > SAME_LINE) {
      result.push(current.trimEnd());
      current = "";
      previous = undefined;
    }
    if (current.length > 0 && !current.endsWith(" ") && !item.str.startsWith(" ") && needsSpace(previous, item)) current += " ";
    current += item.str;
    previous = item;
    if (item.hasEOL === true) {
      result.push(current.trimEnd());
      current = "";
      lastY = null;
      previous = undefined;
    } else if (y !== undefined) {
      lastY = y;
    }
  }
  if (current.length > 0) result.push(current.trimEnd());
  return result;
}
