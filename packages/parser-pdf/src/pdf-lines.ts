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
  const rows: Array<{ items: PdfTextItem[]; y: number; height: number }> = [];
  let row: PdfTextItem[] = [];
  let rowY: number | undefined;
  const flush = (): void => {
    row.sort((left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0));
    rows.push({ items: row, y: rowY ?? 0, height: Math.max(0, ...row.map((item) => item.height ?? 0)) });
    row = [];
  };
  for (const item of byBaseline) {
    const y = item.transform?.[5] ?? 0;
    if (rowY !== undefined && Math.abs(y - rowY) > SAME_LINE) flush();
    if (row.length === 0) rowY = y;
    row.push(item);
  }
  flush();

  // Small text close to a line is its superscript or subscript and PDFBox keeps it on the line; small text a whole
  // height away (mth2's lowered 'i + b' at 5 points under a 12-point line) is a line of its own (tikajs-yt4g).
  // `skip`: the row's items were merged into another row, which writes them.
  const skip = new Array<boolean>(rows.length).fill(false);
  for (let index = 1; index < rows.length; index++) {
    const current = rows[index]!;
    const previous = rows[index - 1]!;
    if (!skip[index - 1] && current.height > 0 && current.height < previous.height && previous.y - current.y <= current.height / 2) {
      previous.items = [...previous.items, ...current.items].sort((left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0));
      skip[index] = true;
    }
  }
  for (let index = 0; index < rows.length; index++) {
    if (skip[index]) continue;
    const current = rows[index]!;
    const next = rows[index + 1];
    if (next !== undefined && !skip[index + 1] && current.height > 0 && current.height < next.height && current.y - next.y <= next.height / 2) {
      next.items = [...next.items, ...current.items].sort((left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0));
      skip[index] = true;
    }
  }
  const result: PdfTextItem[] = [];
  for (let index = 0; index < rows.length; index++) if (!skip[index]) result.push(...rows[index]!.items);
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

/**
 * Items that draw the same text at the same spot: PDFBox's extractor suppresses duplicate overlapping text, pdf.js
 * reports it. A glyph at a spot where a longer run also starts is the longer run's first character (an overprinted 'O' in
 * front of 'Oxygen-annealed'), so the longer item is kept.
 */
function withoutDuplicateText(items: PdfTextItem[]): PdfTextItem[] {
  const chosen = new Map<string, PdfTextItem>();
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    if (x === undefined || y === undefined) continue;
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    const existing = chosen.get(key);
    if (existing === undefined || item.str.length > (existing.str?.length ?? 0)) chosen.set(key, item);
  }
  if (chosen.size === 0) return items;
  return items.filter((item) => {
    if (typeof item.str !== "string") return false;
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    if (x === undefined || y === undefined) return true;
    return chosen.get(`${x.toFixed(2)},${y.toFixed(2)}`) === item;
  });
}

/** A vertical gap wider than this many font heights is a paragraph break: a blank line, as PDFBox's extractor writes. */
const PARAGRAPH_GAP = 2;

export function lines(items: PdfTextItem[], sortByPosition = false): string[] {
  items = withoutDuplicateText(items);
  if (sortByPosition) items = sortedByPosition(items);
  const result: string[] = [];
  let current = "";
  let previous: PdfTextItem | undefined;
  // The baseline and height of the last completed line, and of the one being written, for the paragraph gap.
  let lastLineY: number | undefined;
  let lastLineHeight = 0;
  let lineY: number | undefined;
  let lineHeight = 0;

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (current.length === 0 && item.str.length > 0) {
      if (lastLineY !== undefined && item.transform?.[5] !== undefined) {
        const height = Math.max(lastLineHeight, item.height ?? 0, 1);
        if (lastLineY - item.transform[5]! > PARAGRAPH_GAP * height) result.push("");
      }
      lineY = item.transform?.[5];
      lineHeight = item.height ?? 0;
    } else if (current.length > 0) {
      lineHeight = Math.max(lineHeight, item.height ?? 0);
    }

    const y = item.transform?.[5];
    // A lower baseline starts a line; a higher one is a superscript (or raised text) on the line being written: PDFBox
    // keeps it there, so 'E = mc' and its raised '2' are one line. The allowance is half the text's height, so the small
    // steps within a row of superscripts are not line breaks (tikajs-yt4g).
    const tolerance = Math.max(SAME_LINE, 0.5 * (item.height ?? 0));
    const lower = lineY !== undefined && y !== undefined && y < lineY - tolerance;
    // Text that goes up with the same or a larger height is a new line in stream order, not a superscript.
    const higher = lineY !== undefined && y !== undefined && y > lineY + SAME_LINE && (item.height ?? 0) >= lineHeight && current.length > 0;
    if (lower || higher) {
      // pdf.js gives an empty item of its own at the end of a line (hasEOL): its baseline change is not an empty line.
      if (current.length > 0) {
        result.push(current.trimEnd());
        lastLineY = lineY;
        lastLineHeight = lineHeight;
        if (lineY !== undefined && y !== undefined && lineY - y > PARAGRAPH_GAP * Math.max(lineHeight, item.height ?? 0, 1)) {
          result.push("");
          // This new line's gap is written; its first item must not write it again.
          lastLineY = y;
          lastLineHeight = Math.max(lineHeight, item.height ?? 0);
        }
      }
      current = "";
      previous = undefined;
      lineY = y;
      lineHeight = item.height ?? 0;
    }
    if (current.length > 0 && !current.endsWith(" ") && !item.str.startsWith(" ") && needsSpace(previous, item)) current += " ";
    current += item.str;
    previous = item;
    if (item.hasEOL === true) {
      if (current.length > 0) {
        result.push(current.trimEnd());
        lastLineY = lineY;
        lastLineHeight = lineHeight;
      }
      current = "";
      previous = undefined;
      lineY = undefined;
      lineHeight = 0;
    }
  }
  if (current.length > 0) result.push(current.trimEnd());
  return result;
}
