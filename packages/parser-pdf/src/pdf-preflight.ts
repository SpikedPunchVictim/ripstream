import { streamDecryptor, type StreamDecryptor } from "./pdf-decrypt.ts";
import { decodeStream, dictEntries, type DecodeBudget } from "./pdf-syntax.ts";

/**
 * Cheap structural checks on in-memory PDF bytes that reject inputs known to
 * make pdf.js spin or exhaust memory, before pdf.js parses them. They only
 * look at uncompressed object dictionaries; anything hidden in object streams
 * falls through to pdf.js itself (the page timeout, and the process-isolation
 * layer's limits).
 */

/** Largest indirect object number the PDF specification allows (Annex C). */
export const MAX_OBJECT_NUMBER = 8_388_607;

/** Largest embedded font program (`/Length1`..`/Length3`) accepted, in bytes. */
export const MAX_FONT_PROGRAM_BYTES = 128 * 1024 * 1024;

/** Cap on form XObject content decoded (decrypted and inflated) to see what it paints. */
export const MAX_FORM_DECODED_BYTES = 16 * 1024 * 1024;

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
  const objects = [...text.matchAll(/(?<![0-9])(\d+)\s+(\d+)\s+obj\b/g)];
  const content = formContentReader(text);
  const nextEndobj = nextOccurrence(text, "endobj");
  const nextStream = nextOccurrence(text, "stream");
  const nextEndstream = nextOccurrence(text, "endstream");
  for (const [index, match] of objects.entries()) {
    const start = match.index + match[0].length;
    // An object that is never closed ends where the next one begins, not at the end of the file: each search below is
    // bounded by it, so a file of thousands of unterminated objects is not read once per object.
    const limit = objects[index + 1]?.index ?? text.length;
    const end = endOfObject(start, limit, nextEndobj, nextStream);
    const dictionary = text.slice(start, end);
    if (!/\/Subtype\s*\/Form\b/.test(dictionary)) continue;
    const xobjects = xobjectResources(dictionary);
    if (xobjects === null) continue;
    const body = content(Number(match[1]), Number(match[2]), dictionary, end, nextEndstream);
    const painted = body === null ? null : paintedNames(body);
    const targets: number[] = [];
    for (const ref of xobjects.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R\b/g)) {
      // A resource entry only matters if the (readable) content paints it.
      if (painted === null || painted.has(ref[1]!)) targets.push(Number(ref[2]));
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

/**
 * A finder for the first `needle` at or after a position. Positions are asked for in rising order, so one answer serves
 * every later question up to it, and "none" serves them all: the whole text is scanned once, however many ask.
 */
export function nextOccurrence(text: string, needle: string): (from: number) => number {
  let searchedFrom = -1;
  let found = -2;
  return (from) => {
    if (found !== -2 && from >= searchedFrom && (found === -1 || from <= found)) return found;
    searchedFrom = from;
    found = text.indexOf(needle, from);
    return found;
  };
}

/** The text of `/XObject << ... >>` in a dictionary, up to the first `>` (which a well-formed one follows with another). */
function xobjectResources(dictionary: string): string | null {
  for (let at = dictionary.indexOf("/XObject"); at !== -1; at = dictionary.indexOf("/XObject", at + 1)) {
    let open = at + "/XObject".length;
    while (/\s/.test(dictionary[open] ?? "")) open++;
    if (dictionary.startsWith("<<", open)) {
      const close = dictionary.indexOf(">", open + 2);
      // With no `>` after this opener there is none after a later one either.
      if (close === -1) return null;
      if (dictionary[close + 1] === ">") return dictionary.slice(open + 2, close);
    }
  }
  return null;
}

/** End of an object's dictionary: its stream keyword or endobj, no further than `limit`. */
function endOfObject(
  start: number,
  limit: number,
  nextEndobj: (from: number) => number,
  nextStream: (from: number) => number,
): number {
  const endobj = nextEndobj(start);
  const bound = endobj === -1 || endobj > limit ? limit : endobj;
  const stream = nextStream(start);
  return stream !== -1 && stream < bound ? stream : bound;
}

/**
 * Reads a form's content: decrypted when the file is encrypted (with the empty user password, as pdf.js opens it) and
 * run through its filters. Null when the content cannot be read, so every resource it names counts as painted.
 */
function formContentReader(
  text: string,
): (num: number, gen: number, dictionary: string, end: number, nextEndstream: (from: number) => number) => string | null {
  const budget: DecodeBudget = { left: MAX_FORM_DECODED_BYTES };
  let encrypted: boolean | undefined;
  let decrypt: StreamDecryptor | null | undefined;
  return (num, gen, dictionary, end, nextEndstream) => {
    if (!text.startsWith("stream", end)) return null;
    const stop = nextEndstream(end);
    if (stop === -1) return null;
    let start = end + "stream".length;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    let data = text.slice(start, Math.max(start, stop));
    encrypted ??= /\/Encrypt\b/.test(text);
    if (encrypted) {
      decrypt ??= streamDecryptor(text);
      const plain = decrypt === null ? null : decrypt(num, gen, data);
      if (plain === null) return null;
      data = plain;
    }
    return decodeStream(dictEntries(dictionary), data, budget);
  };
}

/** The resource names the content paints with `Do`. */
function paintedNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/\/([^\s/<>[\]()]+)\s+Do\b/g)) names.add(match[1]!);
  return names;
}
