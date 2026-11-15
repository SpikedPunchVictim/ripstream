import { deflateRawSync, crc32 } from "node:zlib";

/**
 * Deterministic generators for text-heavy documents: a PDF and a DOCX whose extractable text is about `textChars`
 * characters. Same shape as the Grizzly bake-off's `textheavy-*mb` files (random lowercase words, 14 per line, 100
 * lines per PDF page, uncompressed content streams), so a measurement on them says something about those.
 *
 * Seeded (mulberry32): the same arguments give the same bytes on every machine, so a regression test built on them
 * is deterministic.
 */

const WORDS_PER_LINE = 14;
const LINES_PER_PAGE = 100;
const LOWER = "abcdefghijklmnopqrstuvwxyz";
/** Four letters above U+00FF: a string with one of these is two bytes per character in V8 (the worst case). */
const WIDE = "abcdefghijklmnopqrstuvwxyz" + String.fromCharCode(0x151, 0x171, 0x17e, 0x10d);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TextHeavyOptions {
  readonly seed?: number;
  /** Letters words are made of. "wide" adds four letters above U+00FF, which make V8 hold the text at 2 bytes per character (DOCX only). */
  readonly alphabet?: "ascii" | "wide";
}

function wordSource(options: TextHeavyOptions): () => string {
  const next = mulberry32(options.seed ?? 1);
  const alphabet = options.alphabet === "wide" ? WIDE : LOWER;
  return () => {
    const length = 3 + Math.floor(next() * 8);
    let word = "";
    for (let i = 0; i < length; i += 1) word += alphabet[Math.floor(next() * alphabet.length)];
    return word;
  };
}

function line(word: () => string): string {
  const words: string[] = [];
  for (let i = 0; i < WORDS_PER_LINE; i += 1) words.push(word());
  return words.join(" ");
}

/** WinAnsi-encoded PDF string literal. Only the letters above are used, none needs an escape. */
function pdfLiteral(text: string): Buffer {
  return Buffer.concat([Buffer.from("(", "latin1"), Buffer.from(text, "latin1"), Buffer.from(")", "latin1")]);
}

/**
 * A PDF of `pages` pages, each of 100 lines of 14 random words in Helvetica 7, content streams uncompressed. The text
 * is about 10,500 characters per page (PDF_CHARS_PER_PAGE).
 */
export function buildTextHeavyPdf(pages: number, options: TextHeavyOptions = {}): Buffer {
  if (options.alphabet === "wide") throw new RangeError("the PDF builder writes WinAnsi: it has no wide alphabet");
  const word = wordSource(options);
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (buffer: Buffer): void => {
    chunks.push(buffer);
    size += buffer.length;
  };
  const object = (id: number, body: Buffer): void => {
    offsets[id] = size;
    push(Buffer.concat([Buffer.from(`${id} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]));
  };

  push(Buffer.from("%PDF-1.4\n", "latin1"));
  // Objects: 1 catalog, 2 pages, 3 font, then per page a page object and a content stream.
  object(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  object(2, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, "latin1"));
  object(3, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"));
  for (let page = 0; page < pages; page += 1) {
    const pageId = 4 + page * 2;
    const parts: Buffer[] = [Buffer.from("BT /F1 7 Tf 7 TL 36 760 Td\n", "latin1")];
    for (let i = 0; i < LINES_PER_PAGE; i += 1) {
      parts.push(pdfLiteral(line(word)), Buffer.from(" Tj T*\n", "latin1"));
    }
    parts.push(Buffer.from("ET", "latin1"));
    const content = Buffer.concat(parts);
    object(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
        "latin1",
      ),
    );
    object(pageId + 1, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]));
  }
  const count = 4 + pages * 2;
  const xref = size;
  const rows = ["0000000000 65535 f \n"];
  for (let id = 1; id < count; id += 1) rows.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(Buffer.from(`xref\n0 ${count}\n${rows.join("")}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

/** Characters of text one generated PDF page holds, on average (measured on the ascii alphabet). */
export const PDF_CHARS_PER_PAGE = 10_500;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A zip with each entry deflated (method 8). */
function deflatedZip(entries: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const packed = deflateRawSync(data, { level: 1 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

/** A DOCX of `paragraphs` paragraphs of 14 random words each (about 105 characters of text per paragraph). */
export function buildTextHeavyDocx(paragraphs: number, options: TextHeavyOptions = {}): Buffer {
  const word = wordSource(options);
  const body: string[] = [`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}"><w:body>`];
  for (let i = 0; i < paragraphs; i += 1) body.push(`<w:p><w:r><w:t>${line(word)}</w:t></w:r></w:p>`);
  body.push("</w:body></w:document>");
  return deflatedZip([
    [
      "[Content_Types].xml",
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    ],
    [
      "_rels/.rels",
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    ],
    ["word/document.xml", Buffer.from(body.join(""), "utf8")],
  ]);
}
