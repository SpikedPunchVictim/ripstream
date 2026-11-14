import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function parse(files: Record<string, string>, ctx = new ParseContext()): Promise<string> {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = strToU8(value);
  const stream = await RipstreamInputStream.from(zipSync(archive));
  const handler = new BodyContentHandler();
  try {
    await new OoxmlParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

const WORKBOOK = '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>';

// tikajs-ybtt: a backward cell reference must still count, or XFD1/A1 pairs walk the counter down past the cap.
test("xlsx cap holds when cell references go backwards", async () => {
  const pairs = '<c r="XFD1"><v>1</v></c><c r="A1"><v>1</v></c>'.repeat(3000);
  await assert.rejects(
    parse(
      {
        "[Content_Types].xml": "<Types/>",
        "xl/workbook.xml": WORKBOOK,
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="x"><sheetData><row>${pairs}</row></sheetData></worksheet>`,
      },
      new ParseContext({ limits: { maxDecompressionRatio: 1_000_000 } }),
    ),
    LimitExceededError,
  );
});

// tikajs-ybtt: the number-format affix scan was quadratic in the length of a format section.
test("xlsx number format with a very long digit section is read in linear time", async () => {
  const started = performance.now();
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": WORKBOOK,
    "xl/styles.xml": `<styleSheet xmlns="x"><numFmts><numFmt numFmtId="164" formatCode="${"#".repeat(200_000)}"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="x"><sheetData><row><c r="A1" s="0"><v>5</v></c></row></sheetData></worksheet>',
  });
  assert.match(text, /5/);
  assert.ok(performance.now() - started < 3000, "number format parse is not linear");
});

// tikajs-r77m: Word writes a text box twice (mc:Choice and mc:Fallback); nested boxes were rendered once per ancestor.
test("docx text box is emitted once when Word wrote a Choice and a Fallback copy", async () => {
  const box = (text: string): string => `<w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent>`;
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document ${W} xmlns:mc="m"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${box("BOXTEXT")}</mc:Choice><mc:Fallback>${box("BOXTEXT")}</mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>`,
  });
  assert.equal(text.split("BOXTEXT").length - 1, 1);
});

test("docx nested text boxes are not rendered once per enclosing box", async () => {
  let inner = "<w:txbxContent><w:p><w:r><w:t>INNERMOST</w:t></w:r></w:p></w:txbxContent>";
  for (let level = 0; level < 18; level++) inner = `<w:txbxContent><w:p><w:r><w:r>${inner}</w:r></w:r></w:p></w:txbxContent>`;
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document ${W}><w:body><w:p><w:r>${inner}</w:r></w:p></w:body></w:document>`,
  });
  assert.equal(text.split("INNERMOST").length - 1, 1);
});

// tikajs-r77m: CDATA is character data; a shared string written as CDATA was read as empty.
test("xlsx shared string written as CDATA is kept", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": WORKBOOK,
    "xl/sharedStrings.xml": '<sst xmlns="x"><si><t><![CDATA[Cdata <string>]]></t></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="x"><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  });
  assert.match(text, /Cdata <string>/);
});

const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// tikajs-r77m: a sheet's name and content are paired through the workbook's relationships, not by file number.
test("xlsx pairs each sheet name with its own content through the workbook relationships", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook xmlns="x" xmlns:r="${OFFICE_RELS}"><sheets><sheet name="Summary" sheetId="1" r:id="rId9"/><sheet name="Data" sheetId="2" r:id="rId3"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${RELS}"><Relationship Id="rId9" Type="${OFFICE_RELS}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${OFFICE_RELS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="x"><sheetData><row><c r="A1" t="inlineStr"><is><t>DATA-CONTENT</t></is></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet xmlns="x"><sheetData><row><c r="A1" t="inlineStr"><is><t>SUMMARY-CONTENT</t></is></c></row></sheetData></worksheet>',
  });
  assert.ok(text.indexOf("Summary") < text.indexOf("SUMMARY-CONTENT"));
  assert.ok(text.indexOf("SUMMARY-CONTENT") < text.indexOf("Data"));
  assert.ok(text.indexOf("Data") < text.indexOf("DATA-CONTENT"));
});

test("xlsx writes booleans as TRUE and FALSE, General numbers unrounded, and survives a date serial out of range", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": WORKBOOK,
    "xl/styles.xml": '<styleSheet xmlns="x"><numFmts><numFmt numFmtId="164" formatCode="General"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="x"><sheetData><row><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" s="1"><v>3.14159</v></c><c r="D1" s="2"><v>123456789</v></c></row></sheetData></worksheet>',
  });
  assert.equal(text, "S\n\tTRUE\tFALSE\t3.14159\t123456789\n\n\n");
});

// Oracle (Tika 4.2.0 /tika, tikajs-ibvq follow-up): Tika does not apply date1904; serial 0 under numFmtId 14 is "12/31/99" in a 1904
// workbook as in a 1900 one. It used to be asserted as 1904-01-01.
test("xlsx dates of a 1904-based workbook are read in the 1900 system, as Tika does", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns="x"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    "xl/styles.xml": '<styleSheet xmlns="x"><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="x"><sheetData><row><c r="A1" s="0"><v>0</v></c></row></sheetData></worksheet>',
  });
  assert.match(text, /12\/31\/99/);
});

test("docx sym element with a code point past Unicode does not fail the document", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>kept</w:t><w:sym w:char="FFFFFFFF"/></w:r></w:p></w:body></w:document>`,
  });
  assert.match(text, /kept/);
});

const PRESENTATION = `<p:presentation xmlns:p="x" xmlns:r="${OFFICE_RELS}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`;

test("pptx orders slides by the presentation list and pairs notes through the slide relationships", async () => {
  const slide = (text: string): string => `<p:sld xmlns:p="x" xmlns:a="a"><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sld>`;
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": PRESENTATION,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${OFFICE_RELS}/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide("SLIDE-1-NO-NOTES"),
    "ppt/slides/slide2.xml": slide("SLIDE-2-HAS-NOTES"),
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/notesSlide" Target="../notesSlides/notesSlide7.xml"/></Relationships>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="${RELS}"></Relationships>`,
    "ppt/notesSlides/notesSlide7.xml": slide("NOTES-OF-SLIDE-2"),
  });
  const order = ["SLIDE-2-HAS-NOTES", "NOTES-OF-SLIDE-2", "SLIDE-1-NO-NOTES"].map((marker) => text.indexOf(marker));
  assert.ok(order[0]! >= 0 && order[0]! < order[1]! && order[1]! < order[2]!, text);
});

// Oracle (Tika 4.2.0 /tika, built xlsx with one cellXfs entry per builtin id, value 1234.5678): the date and time builtins are written
// with POI's codes rather than as ISO text, and the currency ones with their symbol. Id 47 is "mm:ss.0", where the tenth is the
// milliseconds rounded and not carried: 0.96 s reads ".10".
test("xlsx builtin number formats 5, 7, 14-17, 20-22 and 47 are written as POI writes them", async () => {
  const expected: Record<number, string> = {
    5: "$1,235", 7: "$1,234.57", 14: "5/18/03", 15: "18-May-03", 16: "18-May", 17: "May-03",
    20: "13:37", 21: "13:37:37", 22: "5/18/03 13:37", 47: "37:37.9",
  };
  const ids = Object.keys(expected).map(Number);
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    "xl/styles.xml": `<styleSheet xmlns="x"><cellXfs>${ids.map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="x"><sheetData><row>${ids.map((_, index) => `<c r="${String.fromCharCode(65 + index)}1" s="${index}"><v>1234.5678</v></c>`).join("")}</row></sheetData></worksheet>`,
  });
  assert.ok(text.includes(ids.map((id) => expected[id]).join("\t")), text);
});

test("xlsx tenths of a second of format 47 are rounded without a carry", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    "xl/styles.xml": '<styleSheet xmlns="x"><cellXfs><xf numFmtId="47"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="x"><sheetData><row><c r="A1" s="0"><v>${1.5 + 0.96 / 86400}</v></c></row></sheetData></worksheet>`,
  });
  assert.match(text, /00:00\.10/);
});

// Oracle (Tika 4.2.0 /tika, built xlsx with its parts renamed in case: XL/Workbook.XML, xl/SharedStrings.xml, xl/Styles.xml,
// xl/Worksheets/Sheet1.xml): the package is read in full. Part names are compared without regard to case.
test("xlsx parts are found whatever the case of their names", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "XL/Workbook.XML": '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    "xl/Styles.xml": '<styleSheet xmlns="x"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    "xl/SharedStrings.xml": '<sst xmlns="x"><si><t>Shared1</t></si></sst>',
    "xl/Worksheets/Sheet1.xml": '<worksheet xmlns="x"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>45292</v></c></row></sheetData></worksheet>',
  });
  assert.match(text, /Shared1\t1\/1\/24/);
});

// Oracle (Tika 4.2.0 /tika): phonetic runs of a shared string are written, each after a space; an error cell is "ERROR:" and the error.
test("xlsx phonetic runs follow their text after a space and error cells are marked", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml":
      '<sst xmlns="x"><si><t>Only</t><rPh sb="0" eb="1"><t>A</t></rPh><rPh sb="1" eb="2"><t>B</t></rPh></si><si><r><t>Rich</t></r><r><t>Text</t></r><rPh sb="0" eb="4"><t>P</t></rPh></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="x"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>',
  });
  assert.match(text, /Only A B\tRichText P\tERROR:#DIV\/0!/);
});

// Oracle (Tika 4.2.0 /tika): "General" writes at most 15 significant digits and 10 decimals, and is scientific past 1E15.
test("xlsx General numbers are written as Tika writes them", async () => {
  const values = ["1e16", "1234567890123456", "1e-7", "0.1234567890125", "12345.678901234567", "1.5e-10", "-4e-11", "1000000000000001"];
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook xmlns="x"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="x"><sheetData><row>${values.map((value, index) => `<c r="${String.fromCharCode(65 + index)}1"><v>${value}</v></c>`).join("")}</row></sheetData></worksheet>`,
  });
  assert.ok(
    text.includes(["1E+16", "1.23456789012346E+15", "0.0000001", "0.123456789", "12345.6789012346", "0.0000000001", "-0", "1000000000000000"].join("\t")),
    text,
  );
});
