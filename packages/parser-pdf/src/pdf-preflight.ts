/**
 * Cheap structural checks on in-memory PDF bytes that reject inputs known to
 * make pdf.js spin or exhaust memory, before pdf.js parses them. They only
 * look at uncompressed object dictionaries; anything hidden in object streams
 * falls through to the worker timeout and memory budget.
 */

/** Largest indirect object number the PDF specification allows (Annex C). */
export const MAX_OBJECT_NUMBER = 8_388_607;

/** Largest embedded font program (`/Length1`..`/Length3`) accepted, in bytes. */
export const MAX_FONT_PROGRAM_BYTES = 128 * 1024 * 1024;

export function preflightPdf(data: Uint8Array): void {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
  rejectHugeObjectNumbers(text);
  rejectFormXObjectCycles(text);
  rejectHugeFontLengths(text);
}

/**
 * pdf.js allocates `/Length1` bytes for an embedded font up front; a bogus
 * multi-terabyte value makes it reserve a lazy buffer the memory budget counts.
 */
function rejectHugeFontLengths(text: string): void {
  for (const match of text.matchAll(/\/Length([123])\s+(\d{9,})(?![\d.])/g)) {
    if (Number(match[2]) > MAX_FONT_PROGRAM_BYTES) {
      throw new Error(
        `PDF font program /Length${match[1]} ${match[2]} exceeds the ${MAX_FONT_PROGRAM_BYTES} byte limit`,
      );
    }
  }
}

/**
 * pdf.js recovery indexes `entries[num]`; an object number near 2^31 makes it
 * walk a multi-billion-element sparse array (a 219-byte file spins for minutes).
 */
function rejectHugeObjectNumbers(text: string): void {
  for (const match of text.matchAll(/(?<![0-9])(\d{7,})\s+\d+\s+obj\b/g)) {
    if (Number(match[1]) > MAX_OBJECT_NUMBER) {
      throw new Error(
        `PDF object number ${match[1]} exceeds the ${MAX_OBJECT_NUMBER} limit`,
      );
    }
  }
}

/**
 * Form XObjects that (transitively) paint each other make pdf.js text
 * extraction recurse thousands of levels at quadratic cost.
 */
function rejectFormXObjectCycles(text: string): void {
  const edges = new Map<number, number[]>();
  for (const match of text.matchAll(/(?<![0-9])(\d+)\s+\d+\s+obj\b/g)) {
    const start = match.index + match[0].length;
    const end = endOfObject(text, start);
    const dictionary = text.slice(start, end);
    if (!/\/Subtype\s*\/Form\b/.test(dictionary)) continue;
    const xobjects = /\/XObject\s*<<([^>]*)>>/.exec(dictionary);
    if (xobjects === null) continue;
    const body = plainStreamBody(text, end);
    const targets: number[] = [];
    for (const ref of xobjects[1]!.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R\b/g)) {
      // A resource entry only matters if the (readable) content paints it.
      if (body === null || paints(body, ref[1]!)) targets.push(Number(ref[2]));
    }
    edges.set(Number(match[1]), targets);
  }

  const done = new Set<number>();
  for (const root of edges.keys()) {
    if (done.has(root)) continue;
    const onPath = new Set<number>([root]);
    const stack: Array<{ node: number; next: number }> = [{ node: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = edges.get(frame.node) ?? [];
      if (frame.next >= targets.length) {
        onPath.delete(frame.node);
        done.add(frame.node);
        stack.pop();
        continue;
      }
      const target = targets[frame.next++]!;
      if (onPath.has(target)) {
        throw new Error(`PDF form XObject ${target} paints itself recursively`);
      }
      if (done.has(target) || !edges.has(target)) continue;
      onPath.add(target);
      stack.push({ node: target, next: 0 });
    }
  }
}

/** End of an object's dictionary: its stream keyword or endobj. */
function endOfObject(text: string, start: number): number {
  const endobj = text.indexOf("endobj", start);
  const limit = endobj === -1 ? text.length : endobj;
  const stream = text.indexOf("stream", start);
  return stream !== -1 && stream < limit ? stream : limit;
}

/** Stream data of the object whose dictionary ends at `end`, or null if filtered or absent. */
function plainStreamBody(text: string, end: number): string | null {
  if (!text.startsWith("stream", end)) return null;
  const stop = text.indexOf("endstream", end);
  if (stop === -1) return null;
  const body = text.slice(end, stop);
  const dictionaryStart = text.lastIndexOf("obj", end);
  return /\/Filter\b/.test(text.slice(dictionaryStart, end)) ? null : body;
}

function paints(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/${escaped}\\s+Do\\b`).test(body);
}
