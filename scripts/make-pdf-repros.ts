/*
 * Writes the small PDF files of the repro fixtures in packages/parsers/test/fixtures/repros (tikajs-4xj6):
 *   node scripts/make-pdf-repros.ts [out-dir]
 * Each is a few hundred bytes of hand-written PDF with a single page and no third-party byte. The expected texts in the fixtures were
 * read off Apache Tika 4.2.0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A PDF of the objects given (object n is `objects[n - 1]`, written as `n 0 obj ... endobj`), object 1 being the catalog. */
function pdf(objects: string[]): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A one-page document with `content`, the page's font resources `fonts` and `objects` as objects 5 on. */
function pageWith(content: string, fonts: string, ...objects: string[]): Buffer {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << ${fonts} >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...objects,
  ]);
}

/** A one-page document showing `content` in the font object 5, with `fontObjects` as objects 5 on. */
function onePage(content: string, ...fontObjects: string[]): Buffer {
  return pageWith(content, "/F1 5 0 R", ...fontObjects);
}

const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
/** A Type3 font (its glyphs are drawn by the file itself, so it counts as embedded) whose one glyph H is object `glyph`. */
const type3 = (glyph: number): string =>
  `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /H ${glyph} 0 R >> /Encoding << /Type /Encoding /Differences [72 /H] >> /FirstChar 72 /LastChar 72 /Widths [500] >>`;
const GLYPH = "<< /Length 20 >>\nstream\n500 0 d0 0 0 500 500 re f\nendstream";

/**
 * A Type0 font that is not embedded and has no ToUnicode map: its characters are the two-byte codes of the predefined CMap
 * UniGB-UCS2-H (Unicode), which a reader has to load from its own CMap files to read as text. The text is <5173 4E8E>: U+5173 U+4E8E.
 */
const CJK_PREDEFINED_CMAP = onePage(
  "BT /F1 24 Tf 20 100 Td <51734E8E> Tj ET",
  "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
  "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>",
  "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 80 >>",
);

const FILES: Record<string, Buffer> = {
  // tikajs-j60e: Tika 4.2.0 pdf:contains-non-embedded-font is true only when text is shown in a font with no font file.
  // The standard 14 font Helvetica, shown: true.
  "pdf-font-not-embedded.pdf": onePage("BT /F1 18 Tf 20 100 Td (Hello) Tj ET", HELVETICA),
  // A Type3 font, shown: false.
  "pdf-font-type3-is-embedded.pdf": onePage("BT /F1 18 Tf 20 100 Td (H) Tj ET", type3(6), GLYPH),
  // Helvetica in the page's resources and never shown: false.
  "pdf-font-not-embedded-unused.pdf": onePage("0 0 10 10 re f", HELVETICA),
  // The Type3 font is selected, Helvetica is selected inside q ... Q, and the text is shown after Q: false.
  "pdf-font-restored-by-q.pdf": pageWith("/F1 12 Tf q /F2 12 Tf Q BT (H) Tj ET", "/F1 5 0 R /F2 6 0 R", type3(7), HELVETICA, GLYPH),
  "pdf-cjk-predefined-cmap.pdf": CJK_PREDEFINED_CMAP,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../packages/parsers/test/fixtures/repros");
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(out, name), bytes);
}
