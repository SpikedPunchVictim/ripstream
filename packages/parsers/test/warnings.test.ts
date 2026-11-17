import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { LowYieldError, type ParseWarning } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

/*
 * The typed warnings of a result on the real parsers (tikajs-icjf, docs/warnings.md): a scan, a repair, pages and archive
 * entries that failed, a workbook whose sheets are gone. The default parse only records them; onLowYield: "throw" refuses
 * the low-yield ones. Tika's text and metadata are what they were (the tk: keys are asserted unchanged).
 */

const ripstream = createRipstream();

// ---- PDF builders (a classic xref, so a file is sound until a test damages it) ---------------------------------------

const IMAGE =
  "<< /Length 1 /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray >>\nstream\n\xff\nendstream";

function stream(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

/** A PDF of one page per entry of `pages`: a string shows that text, null paints an image and shows none. */
function pdf(pages: readonly (string | null)[]): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${6 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    IMAGE,
    "<< >>",
  ];
  pages.forEach((text, index) => {
    const contents = 7 + index * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> >>`,
      stream(text === null ? "q 612 0 0 792 0 0 cm /Im1 Do Q" : `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`),
    );
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** The file with its startxref pointing nowhere: pdf.js indexes the objects itself, a repair. */
function damaged(file: Buffer): Buffer {
  return Buffer.from(file.toString("latin1").replace(/startxref\n\d+/, "startxref\n12"), "latin1");
}

const LONG = "A page with enough words on it to be a page of text and not the footer of a scan";

// ---- PDF ---------------------------------------------------------------------------------------------------------------

test("a clean text PDF has an empty warnings array", async () => {
  const result = await ripstream.parse(pdf([LONG]), { filename: "a.pdf" });
  assert.deepEqual(result.warnings, []);
  const records = await ripstream.parseRecursive(pdf([LONG]), { filename: "a.pdf" });
  assert.deepEqual(records[0]?.warnings, []);
});

test("a one-page scan is image-only with no characters, and the tk: keys are as they were", async () => {
  const result = await ripstream.parse(pdf([null]), { filename: "scan.pdf" });
  assert.deepEqual(result.warnings, [{ kind: "image-only", pages: 1, of: 1, pageNumbers: [1], chars: 0 }]);
  assert.equal(result.metadata.get("tk:pdf:image-only-page-count"), "1");
  assert.deepEqual(result.metadata.getAll("tk:pdf:image-only-pages"), ["1"]);
  assert.equal(result.metadata.get("pdf:chars-per-page"), "0");
  assert.equal(result.metadata.getAll("tk:exception:warn").length, 0);
});

test("a five-page scan is image-only on every page", async () => {
  const result = await ripstream.parse(pdf([null, null, null, null, null]), { filename: "scan.pdf" });
  assert.deepEqual(result.warnings, [{ kind: "image-only", pages: 5, of: 5, pageNumbers: [1, 2, 3, 4, 5], chars: 0 }]);
});

test("onLowYield throw refuses a scan with a LowYieldError that carries the warning", async () => {
  await assert.rejects(
    ripstream.parse(pdf([null, null]), { filename: "scan.pdf", onLowYield: "throw" }),
    (error: unknown) =>
      error instanceof LowYieldError &&
      error.code === "LOW_YIELD" &&
      error.warnings.length === 1 &&
      error.warnings[0]?.kind === "image-only",
  );
  await assert.rejects(ripstream.parseRecursive(pdf([null]), { filename: "scan.pdf", onLowYield: "throw" }), LowYieldError);
  const recorded = await ripstream.parse(pdf([null, null]), { filename: "scan.pdf", onLowYield: "record" });
  assert.equal(recorded.warnings.length, 1);
});

test("one scanned page among text pages is a warning, and not a low yield", async () => {
  const file = pdf([LONG, LONG, null, LONG, LONG]);
  const result = await ripstream.parse(file, { filename: "mixed.pdf", onLowYield: "throw" });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.kind, "image-only");
  assert.equal((result.warnings[0] as { pages: number }).pages, 1);
});

test("a repaired file that gave its text is a repaired warning, not a low yield", async () => {
  const result = await ripstream.parse(damaged(pdf([LONG])), { filename: "cut.pdf", onLowYield: "throw" });
  assert.match(result.text, /enough words/);
  assert.equal(result.warnings.length, 1);
  const [warning] = result.warnings;
  assert.equal(warning?.kind, "repaired");
  assert.deepEqual((warning as { steps: string[] }).steps, result.metadata.getAll("tk:pdf:repair-steps"));
  assert.equal(result.metadata.get("tk:pdf:repaired"), "true");
});

test("a repaired scan is both warnings, and a low yield", async () => {
  const file = damaged(pdf([null]));
  const result = await ripstream.parse(file, { filename: "cut.pdf" });
  assert.deepEqual(
    result.warnings.map((warning) => warning.kind),
    ["repaired", "image-only"],
  );
  await assert.rejects(ripstream.parse(file, { filename: "cut.pdf", onLowYield: "throw" }), LowYieldError);
});

test("a page that fails to load is a partial warning out of the pages pdf.js counts (xmpTPg:NPages), and its pdf:chars-per-page 0 is as it was", async () => {
  const page = (contents: number): string => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  const shown = (text: string): string => stream(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R 7 0 R] /Count 3 >>",
    page(4),
    shown("Page one"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "42",
    page(8),
    shown("Page three"),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const result = await ripstream.parse(Buffer.from(out, "latin1"), { filename: "a.pdf" });
  assert.deepEqual(result.warnings, [{ kind: "partial", reason: "pages-failed", failed: 1, of: 2 }]);
  assert.equal(result.metadata.get("xmpTPg:NPages"), "2");
  assert.equal(result.metadata.getAll("pdf:chars-per-page")[1], "0");
});

// ---- archives ----------------------------------------------------------------------------------------------------------

test("a zip whose entries all fail to parse is partial, in a plain and a recursive parse", async () => {
  const zip = zipSync({ "a.docx": strToU8("PK\u0003\u0004garbage"), "b.pdf": strToU8("%PDF-1.4 garbage") });
  const expected: ParseWarning = { kind: "partial", reason: "entries-failed", failed: 2, of: 2 };
  const result = await ripstream.parse(zip, { filename: "t.zip" });
  assert.deepEqual(result.warnings, [expected]);
  const records = await ripstream.parseRecursive(zip, { filename: "t.zip" });
  assert.deepEqual(records[0]?.warnings, [expected]);
  await assert.rejects(ripstream.parse(zip, { filename: "t.zip", onLowYield: "throw" }), LowYieldError);
  await assert.rejects(ripstream.parseRecursive(zip, { filename: "t.zip", onLowYield: "throw" }), LowYieldError);
});

test("a zip with one bad entry among good ones counts the failure out of all the entries", async () => {
  const zip = zipSync({ "a.docx": strToU8("PK\u0003\u0004garbage"), "ok.txt": strToU8("hello there"), "ok2.txt": strToU8("hello again") });
  const result = await ripstream.parse(zip, { filename: "t.zip" });
  assert.deepEqual(result.warnings, [{ kind: "partial", reason: "entries-failed", failed: 1, of: 3 }]);
});

test("a zip of readable entries has no warnings", async () => {
  const zip = zipSync({ "ok.txt": strToU8("hello there"), "two.txt": strToU8("hello again") });
  const result = await ripstream.parse(zip, { filename: "t.zip", onLowYield: "throw" });
  assert.deepEqual(result.warnings, []);
});

test("a scan inside a zip is named by its path in a plain parse and sits on its own record in a recursive one", async () => {
  const zip = zipSync({ "scan.pdf": new Uint8Array(pdf([null])), "ok.txt": strToU8("hello there") });
  const result = await ripstream.parse(zip, { filename: "t.zip" });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.kind, "image-only");
  assert.equal(result.warnings[0]?.path, "/scan.pdf");
  const records = await ripstream.parseRecursive(zip, { filename: "t.zip" });
  assert.deepEqual(records.map((record) => record.warnings?.length), [0, 1, 0]);
  const error = await ripstream.parseRecursive(zip, { filename: "t.zip", onLowYield: "throw" }).catch((e: unknown) => e);
  assert.ok(error instanceof LowYieldError);
  assert.equal(error.warnings[0]?.path, "/t.zip/scan.pdf");
});

// ---- xlsx --------------------------------------------------------------------------------------------------------------

const OPC = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function workbook(parts: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries({
        "[Content_Types].xml":
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${OPC}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${OPC}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
        ...parts,
      }).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

const sheet = (text: string): string =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`;

test("an xlsx whose sheets are all missing from the package reads as empty and says every sheet failed", async () => {
  const file = workbook({});
  const result = await ripstream.parse(file, { filename: "t.xlsx" });
  assert.equal(result.text.trim(), "");
  assert.deepEqual(result.warnings, [{ kind: "partial", reason: "sheets-failed", failed: 2, of: 2 }]);
  await assert.rejects(ripstream.parse(file, { filename: "t.xlsx", onLowYield: "throw" }), LowYieldError);
});

test("an xlsx with one sheet missing says one of two", async () => {
  const result = await ripstream.parse(workbook({ "xl/worksheets/sheet1.xml": sheet("kept") }), { filename: "t.xlsx" });
  assert.match(result.text, /kept/);
  assert.deepEqual(result.warnings, [{ kind: "partial", reason: "sheets-failed", failed: 1, of: 2 }]);
});

test("a sound xlsx has no warnings", async () => {
  const file = workbook({ "xl/worksheets/sheet1.xml": sheet("one"), "xl/worksheets/sheet2.xml": sheet("two") });
  const result = await ripstream.parse(file, { filename: "t.xlsx", onLowYield: "throw" });
  assert.deepEqual(result.warnings, []);
});

// ---- truncation --------------------------------------------------------------------------------------------------------

test("a truncated output is a truncated warning and never a low yield", async () => {
  const result = await ripstream.parse(pdf([LONG, LONG]), {
    filename: "a.pdf",
    onOutputLimit: "truncate",
    onLowYield: "throw",
    limits: { maxOutputChars: 20 },
  });
  assert.deepEqual(result.warnings, [{ kind: "truncated", limit: "outputChars" }]);
  assert.equal(result.metadata.get("tk:exception:write-limit-reached"), "true");
});
