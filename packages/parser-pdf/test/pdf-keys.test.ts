import assert from "node:assert/strict";
import { test } from "node:test";
import { repairFontKeys } from "../src/pdf-keys.ts";

const CID_FONT = (system: string, widths = "/W [ 1 [ 600 ] ]"): string =>
  `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialMT /CIDSystemInfo << ${system} >> /FontDescriptor 7 0 R /DW 0 ${widths} >>`;
const SYSTEM = "/Registry (Adobe) /Ordering (Identity) /Supplement 0";

test("a font that is right is returned as it is", () => {
  const body = CID_FONT(SYSTEM);
  assert.equal(repairFontKeys(body), body);
});

for (const [damaged, right] of [
  ["/Registr (Adobe) /Ordering (Identity) /Supplement 0", SYSTEM],
  ["/Registry (Adobe) /Orderin (Identity) /Supplement 0", SYSTEM],
  ["/Registry (Adobe) /Ordering (Identity) /Supplemen 0", SYSTEM],
] as const) {
  test(`CIDSystemInfo: ${damaged.split(" ").find((word) => /Registr$|Orderin$|Supplemen$/.test(word))} is put right`, () => {
    assert.equal(repairFontKeys(CID_FONT(damaged)), CID_FONT(right));
  });
}

test("a key one character short is completed in a font, a descriptor and an inline descendant", () => {
  assert.equal(repairFontKeys("<< /Typ /Font /Subtype /Type0 /BaseFon /ArialMT >>"), "<< /Type /Font /Subtype /Type0 /BaseFont /ArialMT >>");
  assert.equal(
    repairFontKeys("<< /Type /FontDescriptor /FontNam /ArialMT /Flags 4 /FontBBo [0 0 1 1] >>"),
    "<< /Type /FontDescriptor /FontName /ArialMT /Flags 4 /FontBBox [0 0 1 1] >>",
  );
  assert.equal(
    repairFontKeys(`<< /Type /Font /Subtype /Type0 /DescendantFonts [ ${CID_FONT("/Registry (A) /Orderin (I) /Supplement 0")} ] >>`),
    `<< /Type /Font /Subtype /Type0 /DescendantFonts [ ${CID_FONT("/Registry (A) /Ordering (I) /Supplement 0")} ] >>`,
  );
});

test("a CID font's widths under a key with no name get /W back", () => {
  assert.equal(repairFontKeys(CID_FONT(SYSTEM, "/ [ 1 [ 600 600 ] ]")), CID_FONT(SYSTEM, "/W [ 1 [ 600 600 ] ]"));
  assert.equal(repairFontKeys(CID_FONT(SYSTEM, "/ [ 1 5 600 ]")), CID_FONT(SYSTEM, "/W [ 1 5 600 ]"));
});

test("a nameless key is left alone when the dictionary has /W, is not a CID font, or does not hold widths", () => {
  const withW = CID_FONT(SYSTEM, "/W [ 1 [ 600 ] ] / [ 2 [ 500 ] ]");
  assert.equal(repairFontKeys(withW), withW);
  const simple = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica / [ 1 [ 600 ] ] >>";
  assert.equal(repairFontKeys(simple), simple);
  const notWidths = CID_FONT(SYSTEM, "/ [ /Name ]");
  assert.equal(repairFontKeys(notWidths), notWidths);
});

test("a key that is valid is never renamed, and neither is one that has two completions or whose completion is there", () => {
  const fontFile = "<< /Type /FontDescriptor /FontName /X /Flags 4 /FontFile 12 0 R >>"; // FontFile2 would be a guess
  assert.equal(repairFontKeys(fontFile), fontFile);
  const stem = "<< /Type /FontDescriptor /FontName /X /Flags 4 /Stem 80 >>"; // StemV or StemH
  assert.equal(repairFontKeys(stem), stem);
  const both = "<< /Type /Font /Subtype /Type0 /BaseFont /A /BaseFon /B >>";
  assert.equal(repairFontKeys(both), both);
});

test("a dictionary that is not a font is not touched, however its keys look", () => {
  const page = "<< /Type /Page /Registr (x) /Typ /Font /FontNam /X >>";
  assert.equal(repairFontKeys(page), page);
  const stream = "<< /Length 5 /Filte /FlateDecode /Orderin 1 >>";
  assert.equal(repairFontKeys(stream), stream);
});

test("text outside the key names is never changed: a value that looks like a key stays", () => {
  const body = "<< /Type /Font /Subtype /Type0 /BaseFont /Registr /Encoding /Identity-H /DescendantFonts [ 6 0 R ] >>";
  assert.equal(repairFontKeys(body), body);
});

test("an object that is cut off in the middle of a font is repaired as far as it reads", () => {
  assert.equal(repairFontKeys("<< /Typ /Font /Subtype /Type0 /BaseFont /Ari"), "<< /Type /Font /Subtype /Type0 /BaseFont /Ari");
  assert.equal(
    repairFontKeys("<< /Typ /Font /Subtype /Type0 /BaseFon /ArialMT /Encoding"),
    "<< /Type /Font /Subtype /Type0 /BaseFont /ArialMT /Encoding",
  );
});
