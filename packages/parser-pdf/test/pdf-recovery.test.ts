import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { BodyContentHandler, MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser } from "../src/index.ts";
import { classicPdf, onePageObjects, streamObject } from "./fixtures.ts";

/** Recovery of damaged files (tikajs-4hfu) and what the result says about it. */

async function parse(text: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(new Uint8Array(Buffer.from(text, "latin1")));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new PdfParser().parse(stream, handler, metadata, new ParseContext());
    return { text: handler.toString(), metadata };
  } finally {
    await stream.close();
  }
}

/** The file with object `num`'s xref entry marked free. */
function markFree(text: string, num: number): string {
  const lines = text.split("\n");
  const entry = lines.indexOf("xref") + 2 + num;
  lines[entry] = lines[entry]!.replace(" n ", " f ");
  return lines.join("\n");
}

const image = streamObject("\xff", " /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray");

test("a sound file says nothing about repair", async () => {
  const { metadata } = await parse(classicPdf(onePageObjects("Hello")));
  assert.equal(metadata.get("tk:pdf:repaired"), null);
  assert.deepEqual(metadata.getAll("tk:pdf:repair-steps"), []);
});

test("a content stream the xref marks free is found by the rebuild", async () => {
  const { text, metadata } = await parse(markFree(classicPdf(onePageObjects("Freed content")), 4));
  assert.match(text, /Freed content/);
  assert.equal(metadata.get("tk:pdf:repaired"), "true");
  assert.deepEqual(metadata.getAll("tk:pdf:repair-steps"), ["brute-force-scan", "rebuilt-xref", "synthetic-trailer"]);
});

test("a startxref that points nowhere is a repair pdf.js makes by indexing the objects itself", async () => {
  const { text, metadata } = await parse(classicPdf(onePageObjects("Reindexed")).replace(/startxref\n\d+/, "startxref\n12"));
  assert.match(text, /Reindexed/);
  assert.deepEqual(metadata.getAll("tk:pdf:repair-steps"), ["rebuilt-xref"]);
});

test("pages are gathered into a new page tree when the tree root is gone from a damaged file", async () => {
  const objects = onePageObjects("Orphan page");
  objects[1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  // pdf.js alone reads the damaged root as a page with no content; the rebuild goes first because the xref is unusable.
  const { text, metadata } = await parse(classicPdf(objects).replace(/startxref\n\d+/, "startxref\n12"));
  assert.match(text, /Orphan page/);
  assert.equal(metadata.get("xmpTPg:NPages"), "1");
  assert.ok(metadata.getAll("tk:pdf:repair-steps").includes("page-tree-rebuilt"));
});

test("a font with a damaged /Subtype is repaired when the file needs a rebuilt xref anyway", async () => {
  const objects = onePageObjects("Font repaired");
  objects[4] = "<< /Type /Font /Subtyp /Type1 /BaseFont /Helvetica >>";
  const { text, metadata } = await parse(classicPdf(objects).replace(/startxref\n\d+/, "startxref\n12"));
  assert.match(text, /Font repaired/);
  assert.ok(metadata.getAll("tk:pdf:repair-steps").includes("font-repaired"));
});

test("a repaired file whose only page paints an image is an empty, image-only result, not a failure", async () => {
  const objects = onePageObjects("unused");
  objects[2] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>";
  objects[3] = streamObject("q 612 0 0 792 0 0 cm /Im1 Do Q");
  objects[4] = image;
  const { text, metadata } = await parse(classicPdf(objects).replace(/startxref\n\d+/, "startxref\n12"));
  assert.equal(text.trim(), "");
  assert.equal(metadata.get("tk:pdf:repaired"), "true");
  assert.equal(metadata.get("tk:pdf:image-only-page-count"), "1");
  assert.deepEqual(metadata.getAll("tk:pdf:image-only-pages"), ["1"]);
});

test("a repaired file with no text that cannot be shown text-less fails and names the damage", async () => {
  const objects = onePageObjects("lost");
  objects[3] = streamObject("BT /F1 24 Tf 72 700 Td (lost) Tj ET", " /Filter /JBIG2Decode");
  const damaged = classicPdf(objects).replace(/startxref\n\d+/, "startxref\n12");
  await assert.rejects(parse(damaged), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.equal(
      error.message,
      "PDF is damaged and no text could be recovered (startxref offset 12 points at no xref; 1 page could not be read)",
    );
    return true;
  });
});

test("a file cut before its pages fails and names the damage", async () => {
  const whole = classicPdf(onePageObjects("Cut"));
  const cut = whole.slice(0, whole.indexOf("3 0 obj") + "3 0 obj\n<< /Type /Page /Parent 2 0 R".length);
  await assert.rejects(parse(cut), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.equal(
      error.message,
      "PDF is damaged and no text could be recovered (missing %%EOF; no startxref; 1 object cut off; page tree object 3 is cut off; page 1 is cut off)",
    );
    return true;
  });
});

test("a page cut off after its /Contents still reads", async () => {
  const objects = onePageObjects("Cut page");
  const [catalog, , page, content, font] = objects;
  const reordered = [catalog!, "<< /Type /Pages /Kids [5 0 R] /Count 1 >>", content!, font!, page!.replace("4 0 R", "3 0 R").replace("5 0 R", "4 0 R")];
  const whole = classicPdf(reordered);
  const { text, metadata } = await parse(whole.slice(0, whole.indexOf("/F1 4 0 R") + "/F1 4 0 R".length));
  assert.match(text, /Cut page/);
  assert.ok(metadata.getAll("tk:pdf:repair-steps").includes("page-tree-rebuilt"));
});

test("a file no recovery can open names the damage in its failure", async () => {
  await assert.rejects(parse("%PDF-1.4\n1 0 obj\n<< /Pages 2 0 R >>\nendobj\n"), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.match(error.message, /missing %%EOF; no startxref; no catalog/);
    return true;
  });
});

/** A file whose Flate content stream (object 3) is cut part way, followed by its font and page as an update would add them. */
function cutFlateFile(content: string): string {
  const compressed = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
  return (
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n" +
    `3 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.slice(0, compressed.length >> 1)}\n` +
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n" +
    "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n"
  );
}

const words = (seed: number): string => Array.from({ length: 12 }, (_, i) => `w${((seed * 12 + i) * 7919) % 10007}`).join(" ");

test("the text before the cut in a cut-off Flate content stream is recovered", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `BT /F1 10 Tf 72 ${760 - i * 18} Td (Line ${i} ${words(i)}) Tj ET\n`);
  const { text, metadata } = await parse(cutFlateFile(lines.join("")));
  assert.match(text, /Line 0 w0 /);
  assert.doesNotMatch(text, /Line 39 /);
  assert.ok(metadata.getAll("tk:pdf:repair-steps").includes("stream-salvaged"));
});

test("a cut-off content stream whose readable start shows no text fails and names the cut", async () => {
  const content = `BT /F1 12 Tf 72 700 Td (One line ${words(0)} ${words(1)} ${words(2)}) Tj ET`;
  await assert.rejects(parse(cutFlateFile(content)), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.equal(error.message, "PDF is damaged and no text could be recovered (missing %%EOF; no startxref; 1 object cut off; page 1 is cut off)");
    return true;
  });
});

test("an empty page in a sound file stays an empty result", async () => {
  const objects = onePageObjects("unused");
  objects[3] = streamObject("");
  const { text, metadata } = await parse(classicPdf(objects));
  assert.equal(text.trim(), "");
  assert.equal(metadata.get("tk:pdf:image-only-page-count"), null);
});

/** An intact-xref one-page file whose CID font lost the last character of /Ordering (tikajs-w4ps). */
function orderinDamaged(): string {
  const font0 = "<< /Type /Font /Subtype /Type0 /BaseFont /ArialMT /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>";
  const cid =
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialMT /CIDSystemInfo << /Registry (Adobe) /Orderin (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 0 /W [ 1 [ 600 600 600 600 600 ] ] /CIDToGIDMap /Identity >>";
  const descriptor = "<< /Type /FontDescriptor /FontName /ArialMT /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>";
  const cmap = streamObject(
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 5 beginbfchar <0001> <0048> <0002> <0065> <0003> <006C> <0004> <006F> <0005> <0020> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  );
  const objects = onePageObjects("x");
  objects[3] = streamObject("BT /F1 24 Tf 72 700 Td <0001000200030003000400050001000200030003000400020003> Tj ET");
  objects[4] = font0;
  objects.push(cid, descriptor, cmap);
  return classicPdf(objects);
}

test("a CID font damaged under an intact xref is repaired when the page paints text pdf.js did not extract", async () => {
  const { text, metadata } = await parse(orderinDamaged());
  assert.match(text, /Hello Hello/);
  assert.equal(metadata.get("tk:pdf:repaired"), "true");
  assert.ok(metadata.getAll("tk:pdf:repair-steps").includes("font-repaired"));
});

test("a sound file with a CID font takes no repair", async () => {
  const { text, metadata } = await parse(orderinDamaged().replace("/Orderin ", "/Ordering "));
  assert.match(text, /Hello Hello/);
  assert.equal(metadata.get("tk:pdf:repaired"), null);
});

test("a page of text-less content under an intact xref is not repaired", async () => {
  const { metadata } = await parse(classicPdf(onePageObjects("")));
  assert.equal(metadata.get("tk:pdf:repaired"), null);
});
