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

/**
 * A one-page document of a table whose text runs up the page (the matrix `0 1 -1 0`), as on a landscape page: two columns, two
 * text runs a row, a row to every 40 points of x.
 */
function rotatedPageTable(): Buffer {
  const cell = (x: number, y: number, text: string): string => `BT /F1 10 Tf 0 1 -1 0 ${x} ${y} Tm (${text}) Tj ET`;
  const rows = [
    ["Name", "Alice"],
    ["City", "Paris"],
    ["Total", "42"],
  ];
  const content = rows.map(([first, second], row) => `${cell(40 + 40 * row, 40, first!)} ${cell(40 + 40 * row, 100, second!)}`).join("\n");
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Rotate 90 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/**
 * A page of Helvetica 11 lines whose glyphs are shown a few at a time with a gap of `gap` em between them, as codes set letter by
 * letter are: one Tj for each glyph (`runs`), a TJ array with the gap as a kerning number (`kerned`), or two fonts with the gap
 * between them (`bold`).
 */
function glyphGaps(): Buffer {
  const width = (ch: string): number => (/[0-9]/.test(ch) ? 556 : ({ N: 722, H: 722, S: 667, D: 722, E: 667, K: 667, M: 833, G: 778, i: 222, l: 222, t: 278 } as Record<string, number>)[ch]!);
  const size = 11;
  let y = 180;
  let content = "";
  const runs = (text: string, gap: number): void => {
    let x = 10;
    for (const ch of text) {
      content += `BT /F1 ${size} Tf ${x.toFixed(4)} ${y} Td (${ch}) Tj ET\n`;
      x += (width(ch) * size) / 1000 + gap * size;
    }
    y -= 18;
  };
  const kerned = (text: string, gap: number): void => {
    content += `BT /F1 ${size} Tf 10 ${y} Td [${[...text].map((ch) => `(${ch})`).join(` ${-Math.round(gap * 1000)} `)}] TJ ET\n`;
    y -= 18;
  };
  const bold = (first: string, second: string, gap: number): void => {
    const x = 10 + ([...first].reduce((sum, ch) => sum + width(ch), 0) * size) / 1000 + gap * size;
    content += `BT /F1 ${size} Tf 10 ${y} Td (${first}) Tj ET\nBT /F2 ${size} Tf ${x.toFixed(4)} ${y} Td (${second}) Tj ET\n`;
    y -= 18;
  };
  runs("NHS2012D1298E", 0.12);
  runs("NHS2012D1298E", 0.2);
  kerned("KME2014D4023G", 0.12);
  kerned("KME2014D4023G", 0.2);
  runs("illiillitl", 0.08);
  runs("illiillitl", 0.04);
  bold("1234", "5678", 0.12);
  bold("1234", "5678", 0.2);
  return pageWith(content, "/F1 5 0 R /F2 6 0 R", HELVETICA, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
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
  // tikajs-jmd0: a table on a page rotated by /Rotate 90 whose text runs up the page. Tika 4.2.0 reads the rows upright:
  // "Name Alice", "City Paris", "Total 42".
  "pdf-rotated-page-table.pdf": rotatedPageTable(),
  // tikajs-4c5k: glyphs a gap apart, in a code set letter by letter. PDFBox puts a space where the gap is over min(0.5 x the space
  // width, 0.3 x the average glyph width): 0.139 em in Helvetica, 0.07 em between narrow letters. pdf.js puts one at 0.102 em.
  "pdf-glyph-gaps.pdf": glyphGaps(),
  // tikajs-xxud: a TrueType font whose /FontFile2 is ten junk bytes. Tika 4.2.0 (PDFBox) cannot read the program, so it
  // is a damaged font and also counts as not embedded: both keys true.
  "pdf-damaged-font-program.pdf": onePage(
    "BT /F1 18 Tf 20 100 Td (H) Tj ET",
    "<< /Type /Font /Subtype /TrueType /BaseFont /Junk /FirstChar 72 /LastChar 72 /Widths [500] /FontDescriptor 6 0 R /Encoding /WinAnsiEncoding >>",
    "<< /Type /FontDescriptor /FontName /Junk /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
    "<< /Length 10 >>\nstream\n0123456789\nendstream",
  ),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../packages/parsers/test/fixtures/repros");
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(out, name), bytes);
}
