import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { PageContentScanner, scanContent } from "../src/pdf-content.ts";
import { streamDecryptor } from "../src/pdf-decrypt.ts";
import { indexObjects } from "../src/pdf-objects.ts";
import { classicPdf, encryptedPdf, streamObject } from "./fixtures.ts";

test("scanContent sees text shown with Tj, TJ, ' and \"", () => {
  for (const content of ["BT (a) Tj ET", "BT [(a) -120 (b)] TJ ET", "BT (a) ' ET", 'BT 1 2 (a) " ET', "BT <0041> Tj ET"]) {
    assert.equal(scanContent(content).showsText, true, content);
  }
});

test("scanContent does not count empty strings or strings that are not shown", () => {
  for (const content of ["BT () Tj ET", "BT [() 120 <>] TJ ET", "(a) pop BT ET", "/Name (a) BDC EMC"]) {
    assert.equal(scanContent(content).showsText, false, content);
  }
});

test("scanContent lists the names painted with Do and notes an inline image without reading its data", () => {
  const scan = scanContent("q /Im1 Do Q /Fm2 Do BI /W 1 /H 1 /BPC 8 /CS /G ID \x00(x) Tj\x00 EI (after) Tj");
  assert.deepEqual([...scan.painted], ["Im1", "Fm2"]);
  assert.equal(scan.inlineImage, true);
  assert.equal(scan.showsText, true); // from "(after) Tj", not from the image data
  assert.equal(scanContent("BI /W 1 ID (x) Tj EI").showsText, false);
});

test("scanContent lists the fonts text is shown in, as the graphics state stands at the show operator", () => {
  assert.deepEqual([...scanContent("BT /F1 12 Tf (a) Tj /F2 9 Tf [(b)] TJ ET").fonts], ["F1", "F2"]);
  assert.deepEqual([...scanContent("/F1 12 Tf q /F2 12 Tf Q BT (a) Tj ET").fonts], ["F1"]);
  assert.deepEqual([...scanContent("/F1 12 Tf q /F2 12 Tf BT (a) Tj ET Q").fonts], ["F2"]);
  assert.deepEqual([...scanContent("/F1 12 Tf BT () Tj ET").fonts], []);
  assert.deepEqual([...scanContent("BT (a) Tj ET").fonts], []);
});

test("scanContent ignores comments and nested parentheses in strings", () => {
  assert.equal(scanContent("% (a) Tj\nBT (a (b) c) Tj ET").showsText, true);
  assert.equal(scanContent("% (a) Tj\n").showsText, false);
});

/** A one-page file whose page has `content` and `resources`, plus `extra` objects from number 4 on. */
function pageFile(content: string, resources: string, extra: string[] = []): ReturnType<typeof indexObjects> {
  return indexObjects(
    classicPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources ${resources} >>`,
      `<< /Type /Page /Parent 2 0 R /Contents ${content} >>`,
      ...extra,
    ]),
  );
}

const image = streamObject("\xff", " /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray");

test("PageContentScanner finds an image painted through a form, with inherited resources", () => {
  const index = pageFile("4 0 R", "<< /XObject << /Fm1 5 0 R >> >>", [
    streamObject("q /Fm1 Do Q"),
    streamObject("/Im1 Do", " /Type /XObject /Subtype /Form /Resources << /XObject << /Im1 6 0 R >> >>"),
    image,
  ]);
  assert.deepEqual(new PageContentScanner(index).page(3), { contents: "read", showsText: false, paintsImage: true, nonEmbeddedFont: false });
});

test("PageContentScanner reads text in a form and content split over an array of compressed streams", () => {
  const compressed = deflateSync(Buffer.from("/Fm1 Do")).toString("latin1");
  const index = pageFile("[4 0 R 5 0 R]", "<< /XObject << /Fm1 6 0 R >> >>", [
    streamObject("q"),
    `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed}\nendstream`,
    streamObject("BT (a) Tj ET", " /Subtype /Form"),
  ]);
  assert.deepEqual(new PageContentScanner(index).page(3), { contents: "read", showsText: true, paintsImage: false, nonEmbeddedFont: false });
});

test("PageContentScanner tells a blank page, missing content and content it cannot decode apart", () => {
  const blank = indexObjects(classicPdf(["<< /Type /Catalog >>", "<< >>", "<< /Type /Page >>"]));
  assert.deepEqual(new PageContentScanner(blank).page(3), { contents: "none", showsText: false, paintsImage: false, nonEmbeddedFont: false });
  assert.equal(new PageContentScanner(pageFile("9 0 R", "<< >>")).page(3)!.contents, "missing");
  const unreadable = pageFile("4 0 R", "<< /XObject << /Im1 5 0 R >> >>", [streamObject("xx", " /Filter /JBIG2Decode"), image]);
  // Content that does not decode falls back to the resources: they hold an image.
  assert.deepEqual(new PageContentScanner(unreadable).page(3), { contents: "unreadable", showsText: false, paintsImage: true, nonEmbeddedFont: false });
  assert.equal(new PageContentScanner(blank).page(42), null);
});

test("PageContentScanner does not loop on a form that paints itself", () => {
  const index = pageFile("4 0 R", "<< /XObject << /Fm1 5 0 R >> >>", [
    streamObject("/Fm1 Do"),
    streamObject("/Fm1 Do", " /Subtype /Form /Resources << /XObject << /Fm1 5 0 R >> >>"),
  ]);
  assert.deepEqual(new PageContentScanner(index).page(3), { contents: "read", showsText: false, paintsImage: false, nonEmbeddedFont: false });
});

test("PageContentScanner reads an encrypted page through the decryptor", () => {
  const text = Buffer.from(encryptedPdf("")).toString("latin1");
  const index = indexObjects(text);
  assert.equal(new PageContentScanner(index).page(3)!.showsText, false);
  assert.equal(new PageContentScanner(index, streamDecryptor(text)).page(3)!.showsText, true);
});

test("PageContentScanner does not call a page blank when it is cut off before naming its content", () => {
  const index = indexObjects("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R");
  assert.deepEqual(new PageContentScanner(index).page(3), { contents: "cut-off", showsText: false, paintsImage: false, nonEmbeddedFont: false });
});

test("PageContentScanner does not call a page blank when its content stream is cut off", () => {
  const whole = classicPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", streamObject("q 1 0 0 1 0 0 cm Q BT /F1 12 Tf (cut) Tj ET")]);
  const index = indexObjects(whole.slice(0, whole.indexOf("BT /F1")));
  assert.deepEqual(new PageContentScanner(index).page(3), { contents: "cut-off", showsText: false, paintsImage: false, nonEmbeddedFont: false });
});

test("PageContentScanner says whether text is shown in a font with no font file", () => {
  const fonts = (content: string, resources: string, extra: string[]): boolean | undefined =>
    new PageContentScanner(pageFile("4 0 R", resources, [streamObject(content), ...extra])).page(3)?.nonEmbeddedFont;
  const helvetica = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const embedded = "<< /Type /Font /Subtype /TrueType /FontDescriptor 6 0 R >>";
  const descriptor = (key: string): string => `<< /Type /FontDescriptor ${key} 7 0 R >>`;
  const show = "BT /F1 9 Tf (a) Tj ET";
  assert.equal(fonts(show, "<< /Font << /F1 5 0 R >> >>", [helvetica]), true);
  assert.equal(fonts("BT /F1 9 Tf ET", "<< /Font << /F1 5 0 R >> >>", [helvetica]), false);
  assert.equal(fonts(show, "<< /Font << /F1 5 0 R >> >>", [embedded, descriptor("/FontFile2"), "<< >>"]), false);
  assert.equal(fonts(show, "<< /Font << /F1 5 0 R >> >>", [embedded, descriptor("/FontName /X"), "<< >>"]), true);
  assert.equal(fonts(show, "<< /Font << /F1 << /Type /Font /Subtype /Type3 >> >> >>", []), false);
  // A Type0 font is as embedded as its descendant.
  const type0 = "<< /Type /Font /Subtype /Type0 /DescendantFonts [6 0 R] >>";
  const cid = "<< /Type /Font /Subtype /CIDFontType2 /FontDescriptor 7 0 R >>";
  assert.equal(fonts(show, "<< /Font << /F1 5 0 R >> >>", [type0, cid, descriptor("/FontFile2"), "<< >>"]), false);
  assert.equal(fonts(show, "<< /Font << /F1 5 0 R >> >>", [type0, cid, descriptor("/FontName /X")]), true);
});

test("PageContentScanner reads a stream whose keyword is followed by spaces before the line break", () => {
  const compressed = deflateSync(Buffer.from("BT /F1 9 Tf (a) Tj ET")).toString("latin1");
  const index = pageFile("4 0 R", "<< /Font << /F1 5 0 R >> >>", [
    streamObject(compressed, " /Filter /FlateDecode").replace("stream\n", "stream \r\n"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
  assert.deepEqual(new PageContentScanner(index).page(3), { contents: "read", showsText: true, paintsImage: false, nonEmbeddedFont: true });
});
