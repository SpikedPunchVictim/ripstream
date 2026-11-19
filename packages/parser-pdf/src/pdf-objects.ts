import { nextOccurrence } from "./pdf-preflight.ts";
import { decodeStream, dictEntries, skipSpace, skipValue, type DecodeBudget } from "./pdf-syntax.ts";

/**
 * A brute-force index of a PDF's objects, found by scanning for `N G obj` the way PDFBox's lenient parser does, without
 * trusting the xref. The last definition of an object number wins, as in an incrementally updated file, and the members
 * of object streams are read out as objects of their own.
 */

/** Cap on bytes inflated from object streams while indexing. */
export const MAX_INDEX_DECODED_BYTES = 16 * 1024 * 1024;

export interface PdfObject {
  readonly num: number;
  readonly gen: number;
  /** Offset of the `N G obj` header; for an object-stream member, its container's. */
  readonly at: number;
  /** The text after `obj` up to the `stream` keyword or `endobj` (the whole value for an object-stream member). */
  readonly body: string;
  /** The raw stream data range in the file text, or null for an object without a stream. */
  readonly stream: { readonly start: number; readonly end: number; readonly complete: boolean } | null;
  /** False when the object is cut off: no `endobj` (or `endstream`) before the next object or the end of the file. */
  readonly closed: boolean;
  /** The object stream it came from. */
  readonly container?: number;
}

export interface ObjectIndex {
  /** The whole file as latin1 text. */
  readonly text: string;
  /** Offset of `%PDF-` in the first 1024 bytes, or -1. */
  readonly headerAt: number;
  readonly objects: ReadonlyMap<number, PdfObject>;
  /** Object streams whose data could not be decoded. */
  readonly badObjectStreams: readonly number[];
  /** Members read out of object streams. */
  readonly inlined: number;
}

const HEADER = /(?<![0-9])(\d{1,7})\s+(\d{1,5})\s+obj\b/g;

export function indexObjects(text: string, budget: DecodeBudget = { left: MAX_INDEX_DECODED_BYTES }): ObjectIndex {
  const head = text.slice(0, 1024).indexOf("%PDF-");
  const objects = new Map<number, PdfObject>();
  const nextEndobj = nextOccurrence(text, "endobj");
  const nextEndstream = nextOccurrence(text, "endstream");
  const nextStream = nextOccurrence(text, "stream");
  const headers = new RegExp(HEADER.source, "g");
  const peek = new RegExp(HEADER.source, "g");
  let match: RegExpExecArray | null;
  while ((match = headers.exec(text)) !== null) {
    const start = match.index + match[0].length;
    peek.lastIndex = start;
    const following = peek.exec(text);
    const bound = following?.index ?? text.length;
    const endobj = nextEndobj(start);
    const close = endobj !== -1 && endobj < bound ? endobj : -1;
    const streamAt = streamKeyword(text, start, close === -1 ? bound : close, nextStream);
    let object: PdfObject;
    if (streamAt === -1) {
      object = {
        num: Number(match[1]),
        gen: Number(match[2]),
        at: match.index,
        body: text.slice(start, close === -1 ? bound : close),
        stream: null,
        closed: close !== -1,
      };
      headers.lastIndex = close === -1 ? bound : close + "endobj".length;
    } else {
      const body = text.slice(start, streamAt);
      let dataStart = streamAt + "stream".length;
      // Spaces before the line break are tolerated, as PDFBox and pdf.js do.
      let blanks = dataStart;
      while (text[blanks] === " ") blanks++;
      if (text[blanks] === "\r" || text[blanks] === "\n") dataStart = blanks;
      if (text[dataStart] === "\r") dataStart++;
      if (text[dataStart] === "\n") dataStart++;
      const declared = dictEntries(body).get("Length")?.trim() ?? "";
      const length = /^\d+$/.test(declared) ? Number(declared) : -1;
      let dataEnd =
        length >= 0 && /^\s*endstream/.test(text.slice(dataStart + length, dataStart + length + 32))
          ? dataStart + length
          : nextEndstream(dataStart);
      const complete = dataEnd !== -1;
      if (!complete) {
        // Cut off inside the stream: the data runs to the next object header, or to the end of the file.
        peek.lastIndex = dataStart;
        dataEnd = peek.exec(text)?.index ?? text.length;
      }
      const after = complete ? text.indexOf("endstream", dataEnd) + "endstream".length : dataEnd;
      peek.lastIndex = after;
      const next = peek.exec(text)?.index ?? text.length;
      const end = nextEndobj(after);
      const closed = complete && end !== -1 && end < next;
      object = {
        num: Number(match[1]),
        gen: Number(match[2]),
        at: match.index,
        body,
        stream: { start: dataStart, end: dataEnd, complete },
        closed,
      };
      headers.lastIndex = closed ? end + "endobj".length : Math.max(after, dataEnd);
    }
    objects.set(object.num, object);
  }

  const badObjectStreams: number[] = [];
  let inlined = 0;
  for (const container of [...objects.values()]) {
    if (container.stream === null || !/\/Type\s*\/ObjStm\b/.test(container.body)) continue;
    const members = objectStreamMembers(text, container, budget);
    if (members === null) {
      badObjectStreams.push(container.num);
      continue;
    }
    for (const [num, body] of members) {
      const existing = objects.get(num);
      // A definition later in the file (an incremental update) wins over the member, and the member over an earlier one.
      if (existing !== undefined && existing.at > container.at) continue;
      objects.set(num, { num, gen: 0, at: container.at, body, stream: null, closed: true, container: container.num });
      inlined++;
    }
  }
  return { text, headerAt: head, objects, badObjectStreams, inlined };
}

/** True for a character that cannot be part of a PDF regular token: white space, a delimiter, or the end of the text. */
function endsToken(char: string | undefined): boolean {
  return char === undefined || /[\s\0()<>[\]{}/%]/.test(char);
}

/**
 * The `stream` keyword that starts an object's data, searched for between `from` and `to`, or -1.
 *
 * The keyword is where the syntax puts it: right after the object's first value, its dictionary. The word inside a name
 * or a string (`/BaseFont /BitstreamVeraSans`, `(a stream of text)`) is not the keyword, and taking it for one made the
 * data run on to the next `endstream`, over the objects in between. Only when the dictionary is cut off (it never
 * closes before `to`) is there no syntax to follow, and the first standalone `stream` is taken, as before.
 */
function streamKeyword(text: string, from: number, to: number, nextStream: (from: number) => number): number {
  const at = skipSpace(text, from, to);
  if (at >= to) return -1;
  // One character past `to` tells a value that ends exactly at `to` from one that is cut off there.
  const probe = Math.min(text.length, to + 1);
  const end = skipValue(text, at, to, 0);
  const cutOff = end >= to && probe > to && skipValue(text, at, probe, 0) > to;
  if (!cutOff) {
    const keyword = skipSpace(text, end, to);
    return text.startsWith("stream", keyword) && keyword < to ? keyword : -1;
  }
  for (let found = nextStream(at); found !== -1 && found < to; found = nextStream(found + 1)) {
    if (text.startsWith("endstream", found - 3)) continue;
    if (endsToken(text[found - 1]) && endsToken(text[found + "stream".length])) return found;
  }
  return -1;
}

/** The members of an object stream, by object number, or null when its data does not decode. */
function objectStreamMembers(text: string, container: PdfObject, budget: DecodeBudget): Map<number, string> | null {
  const entries = dictEntries(container.body);
  const count = Number(entries.get("N"));
  const first = Number(entries.get("First"));
  if (!Number.isInteger(count) || !Number.isInteger(first) || count < 0 || first < 0) return null;
  const stream = container.stream!;
  const decoded = decodeStream(entries, text.slice(stream.start, stream.end), budget);
  if (decoded === null) return null;
  const header = decoded.slice(0, first).trim().split(/\s+/).map(Number);
  const members = new Map<number, string>();
  let kept = 0;
  for (let i = 0; i < count && 2 * i + 1 < header.length; i++) {
    const num = header[2 * i]!;
    const offset = header[2 * i + 1]!;
    if (!Number.isInteger(num) || !Number.isInteger(offset) || members.has(num)) continue;
    const next = 2 * i + 3 < header.length ? header[2 * i + 3]! : decoded.length - first;
    const body = decoded.slice(first + offset, first + Math.max(offset, next));
    // The decoded stream was charged when it was inflated, and members that tile it are slices of it. Members may
    // overlap (each can claim the whole stream), so only what is kept beyond the decoded length is charged again.
    kept += body.length;
    if (kept > decoded.length) budget.left -= Math.min(body.length, kept - decoded.length);
    if (budget.left < 0) break;
    members.set(num, body);
  }
  return members;
}

/** The raw stream data of an object as it is in the file (still filtered), or null. */
export function rawStreamData(index: ObjectIndex, object: PdfObject): string | null {
  return object.stream === null ? null : index.text.slice(object.stream.start, object.stream.end);
}
