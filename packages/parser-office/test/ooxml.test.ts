import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";
import { OpcPackage } from "../src/opc.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function parse(files: Record<string, string>): Promise<{
  text: string;
  metadata: Metadata;
}> {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = strToU8(value);
  const stream = await RipstreamInputStream.from(zipSync(archive));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new OoxmlParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("extracts docx paragraphs and core metadata", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "docProps/core.xml":
      '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:title>Doc</dc:title><dc:creator>Ada</dc:creator></cp:coreProperties>',
    "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>`,
  });
  assert.match(result.text, /Hello DOCX/);
  assert.match(result.text, /Second/);
  assert.equal(result.metadata.get("dc:title"), "Doc");
  assert.equal(result.metadata.get("dc:creator"), "Ada");
});

test("extracts xlsx sheets and shared strings", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml":
      '<workbook xmlns="x"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml":
      '<sst xmlns="x"><si><t>Alpha</t></si><si><t>Beta</t></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  assert.match(result.text, /Alpha/);
  assert.match(result.text, /Beta/);
});

test("extracts pptx slide text", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": "<p:presentation xmlns:p=\"x\"/>",
    "ppt/slides/slide1.xml":
      '<p:sld xmlns:p="x" xmlns:a="y"><a:p><a:r><a:t>Slide One</a:t></a:r></a:p></p:sld>',
  });
  assert.match(result.text, /Slide One/);
});

test("renders docx tables, headers, footnotes and deleted runs", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document ${W}><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:del><w:r><w:delText>Removed</w:delText></w:r></w:del><w:r><w:tab/><w:t>Kept</w:t></w:r></w:p></w:body></w:document>`,
    "word/header1.xml": `<w:hdr ${W}><w:p><w:r><w:t>Header Text</w:t></w:r></w:p></w:hdr>`,
    "word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:type="separator"><w:p><w:r><w:t>sep</w:t></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Footnote Text</w:t></w:r></w:p></w:footnote></w:footnotes>`,
  });
  assert.match(result.text, /Cell A/);
  assert.match(result.text, /Cell B/);
  assert.match(result.text, /Removed/);
  assert.match(result.text, /Kept/);
  assert.match(result.text, /Header Text/);
  assert.match(result.text, /Footnote Text/);
  assert.doesNotMatch(result.text, /sep/);
});

test("formats xlsx serial dates using cell styles", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml":
      '<workbook xmlns="x"><sheets><sheet name="Dates" sheetId="1"/></sheets></workbook>',
    "xl/styles.xml":
      '<styleSheet xmlns="x"><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" s="1"><v>45292</v></c></row></sheetData></worksheet>',
  });
  assert.match(result.text, /2024-01-01/);
});

test("renders xlsx charts and custom document properties", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml":
      '<workbook xmlns="x"><sheets><sheet name="Data" sheetId="1"/></sheets></workbook>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="x"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    "xl/charts/chart1.xml":
      '<c:chartSpace xmlns:c="c" xmlns:a="a"><c:title><a:t>Sales</a:t></c:title><c:ser><c:tx><c:v>Revenue</c:v></c:tx><c:cat><c:pt><c:v>Q1</c:v></c:pt></c:cat><c:val><c:pt><c:v>10</c:v></c:pt></c:val></c:ser></c:chartSpace>',
    "docProps/custom.xml":
      '<Properties xmlns="p" xmlns:vt="v"><property name="Project" pid="2"><vt:lpwstr>Atlas</vt:lpwstr></property></Properties>',
  });
  assert.match(result.text, /Sales/);
  assert.match(result.text, /Revenue/);
  assert.match(result.text, /Q1/);
  assert.match(result.text, /10/);
  assert.deepEqual(result.metadata.getAll("custom:Project"), ["Atlas"]);
});

test("renders pptx tables and speaker notes", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": "<p:presentation xmlns:p=\"x\"/>",
    "ppt/slides/slide1.xml":
      '<p:sld xmlns:p="x" xmlns:a="y"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Grid</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:sld>',
    "ppt/notesSlides/notesSlide1.xml":
      '<p:notes xmlns:p="x" xmlns:a="y"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>',
  });
  assert.match(result.text, /Grid/);
  assert.match(result.text, /Speaker note/);
});

test("rejects OLE2-wrapped encrypted OOXML", async () => {
  const bytes = new Uint8Array(512);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const stream = await RipstreamInputStream.from(bytes);
  await assert.rejects(
    new OoxmlParser().parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      new ParseContext(),
    ),
    (error: unknown) => (error as { code?: string }).code === "ENCRYPTED_DOCUMENT",
  );
  await stream.close();
});

test("renders SmartArt diagram text", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": "<p:presentation xmlns:p=\"x\"/>",
    "ppt/diagrams/data1.xml":
      '<dgm:dataModel xmlns:dgm="d" xmlns:a="a"><a:t>Root Idea</a:t><a:t>Child Idea</a:t></dgm:dataModel>',
  });
  assert.match(result.text, /Root Idea/);
  assert.match(result.text, /Child Idea/);
});

test("records macro presence", async () => {
  const result = await parse({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Macro doc</w:t></w:r></w:p></w:body></w:document>',
    "word/vbaProject.bin": "fake",
  });
  assert.equal(result.metadata.get("msoffice:has-macros"), "true");
});

test("rejects xlsx cell references beyond the column limit", async () => {
  await assert.rejects(
    parse({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml":
        '<workbook xmlns="x"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
      "xl/worksheets/sheet1.xml":
        '<worksheet xmlns="x"><sheetData><row r="1"><c r="ZZZZZZ1"><v>1</v></c></row></sheetData></worksheet>',
    }),
    MalformedDocumentError,
  );
});

test("rejects sparse xlsx sheets whose padded cell total is too large", async () => {
  const rows = Array.from(
    { length: 100 },
    (_, index) => `<row r="${index + 1}"><c r="XFD${index + 1}"><v>1</v></c></row>`,
  ).join("");
  await assert.rejects(
    parse({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml":
        '<workbook xmlns="x"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="x"><sheetData>${rows}</sheetData></worksheet>`,
    }),
    LimitExceededError,
  );
});

test("closes the OPC package when reading a part throws", async () => {
  const close = mock.method(OpcPackage.prototype, "close");
  try {
    const archive = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8("x".repeat(10_000)),
    });
    const stream = await RipstreamInputStream.from(archive);
    await assert.rejects(
      new OoxmlParser().parse(
        stream,
        new BodyContentHandler(),
        new Metadata(),
        new ParseContext({ limits: { maxEmbeddedResourceBytes: 100 } }),
      ),
      LimitExceededError,
    );
    await stream.close();
    assert.equal(close.mock.callCount(), 1);
  } finally {
    close.mock.restore();
  }
});
