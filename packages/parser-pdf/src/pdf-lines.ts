export interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
  readonly transform?: number[];
}

/** Groups pdf.js text items into visual lines by baseline. */
export function lines(items: PdfTextItem[], sortByPosition = false): string[] {
  if (sortByPosition) {
    items = [...items].sort((left, right) => {
      const leftY = left.transform?.[5] ?? 0;
      const rightY = right.transform?.[5] ?? 0;
      if (leftY !== rightY) return rightY - leftY;
      return (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0);
    });
  }
  const result: string[] = [];
  let current = "";
  let lastY: number | null = null;

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 1) {
      result.push(current.trimEnd());
      current = "";
    }
    if (current.length > 0 && !current.endsWith(" ")) current += " ";
    current += item.str;
    if (item.hasEOL === true) {
      result.push(current.trimEnd());
      current = "";
      lastY = null;
    } else if (y !== undefined) {
      lastY = y;
    }
  }
  if (current.length > 0) result.push(current.trimEnd());
  return result;
}
