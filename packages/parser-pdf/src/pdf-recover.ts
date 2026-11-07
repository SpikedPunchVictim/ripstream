import { inflateSync } from "node:zlib";

/**
 * Last-resort recovery for PDFs whose trailer or xref stream is missing or
 * corrupt, so pdf.js cannot locate the document catalog. PDFBox's brute-force
 * parser scans for objects; this does the same for the two cases pdf.js's own
 * recovery cannot handle: it appends a synthetic trailer pointing at the last
 * `/Type /Catalog` object, and re-emits Flate object-stream members as plain
 * top-level objects so the catalog and page tree inside them are reachable.
 */

/** Cap on bytes inflated from object streams during recovery. */
export const MAX_RECOVERED_BYTES = 16 * 1024 * 1024;

/** Matches pdf.js errors raised when the catalog cannot be located. */
export function isMissingCatalogError(message: string): boolean {
  return /Invalid Root reference|Invalid PDF structure/.test(message);
}

const OBJECT = /(?<![0-9])(\d{1,7})\s+(\d{1,5})\s+obj\b/g;

/**
 * Returns the bytes with recovered objects and a trailer appended, or null if
 * no catalog can be found or the file is encrypted (object streams would need
 * decrypting first).
 */
export function recoverDocument(data: Uint8Array): Uint8Array | null {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
  if (/\/Encrypt\b/.test(text)) return null;
  const extra = inlineObjectStreams(text);
  const root = lastCatalog(text) ?? lastCatalog(extra);
  if (root === null) return null;
  const tail = Buffer.from(
    `${extra}\ntrailer\n<</Root ${root.num} ${root.gen} R>>\n`,
    "latin1",
  );
  const result = new Uint8Array(data.byteLength + tail.byteLength);
  result.set(data);
  result.set(tail, data.byteLength);
  return result;
}

function lastCatalog(text: string): { num: string; gen: string } | null {
  let root: { num: string; gen: string } | null = null;
  for (const match of text.matchAll(OBJECT)) {
    const start = match.index + match[0].length;
    const head = text.slice(start, start + 512);
    const end = head.search(/\b(?:stream|endobj)\b/);
    if (/\/Type\s*\/Catalog\b/.test(end === -1 ? head : head.slice(0, end))) {
      root = { num: match[1]!, gen: match[2]! };
    }
  }
  return root;
}

/** Plain-object text for every member of every Flate object stream. */
function inlineObjectStreams(text: string): string {
  const defined = new Set<string>();
  for (const match of text.matchAll(OBJECT)) defined.add(match[1]!);

  let budget = MAX_RECOVERED_BYTES;
  let out = "";
  for (const match of text.matchAll(OBJECT)) {
    const start = match.index + match[0].length;
    const streamAt = text.indexOf("stream", start);
    const endobj = text.indexOf("endobj", start);
    if (streamAt === -1 || (endobj !== -1 && endobj < streamAt)) continue;
    const dictionary = text.slice(start, streamAt);
    if (!/\/Type\s*\/ObjStm\b/.test(dictionary) || !/\/FlateDecode\b/.test(dictionary)) continue;
    if (/\/Predictor\b/.test(dictionary)) continue;
    const count = Number(/\/N\s+(\d+)/.exec(dictionary)?.[1]);
    const first = Number(/\/First\s+(\d+)/.exec(dictionary)?.[1]);
    if (!Number.isInteger(count) || !Number.isInteger(first)) continue;

    let dataStart = streamAt + "stream".length;
    if (text[dataStart] === "\r") dataStart++;
    if (text[dataStart] === "\n") dataStart++;
    const dataEnd = text.indexOf("endstream", dataStart);
    if (dataEnd === -1) continue;

    let decoded: string;
    try {
      decoded = inflateSync(Buffer.from(text.slice(dataStart, dataEnd), "latin1"), {
        maxOutputLength: budget,
        finishFlush: 2, // Z_SYNC_FLUSH: keep what inflated from truncated streams
      }).toString("latin1");
    } catch {
      continue;
    }
    budget -= decoded.length;

    const header = decoded.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count && 2 * i + 1 < header.length; i++) {
      const num = header[2 * i]!;
      const offset = header[2 * i + 1]!;
      if (!Number.isInteger(num) || !Number.isInteger(offset) || defined.has(String(num))) continue;
      const next = 2 * i + 3 < header.length ? header[2 * i + 3]! : decoded.length - first;
      defined.add(String(num));
      out += `\n${num} 0 obj\n${decoded.slice(first + offset, first + next)}\nendobj\n`;
    }
    if (budget <= 0) break;
  }
  return out;
}
