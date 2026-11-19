import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";

const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function parse(files: Record<string, string>): Promise<string> {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = strToU8(value);
  const stream = await RipstreamInputStream.from(zipSync(archive));
  const handler = new BodyContentHandler();
  try {
    await new OoxmlParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
  return handler.toString();
}

const slide = (text: string): string =>
  `<p:sld xmlns:p="x" xmlns:a="a"><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sld>`;
const slideRelationship = (target: string): string =>
  `<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/slide" Target="${target}"/></Relationships>`;
const PRESENTATION = `<p:presentation xmlns:p="x" xmlns:r="${OFFICE_RELS}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`;
const MALFORMED = "<Relationships><oops";

const pptx = (files: Record<string, string>): Record<string, string> => ({
  "[Content_Types].xml": "<Types/>",
  "ppt/presentation.xml": PRESENTATION,
  "ppt/slides/slide1.xml": slide("FIRST"),
  "ppt/slides/slide2.xml": slide("SECOND"),
  ...files,
});

// The same relationships part is read for the types of embedded parts and for the slide and sheet lookups, and is parsed
// once. The packages below share every part name, so a tree kept past its own package would show up as the wrong slide.
test("two packages with the same relationship part names each read their own", async () => {
  const first = await parse(pptx({ "ppt/_rels/presentation.xml.rels": slideRelationship("slides/slide1.xml") }));
  const second = await parse(pptx({ "ppt/_rels/presentation.xml.rels": slideRelationship("slides/slide2.xml") }));
  const firstAgain = await parse(pptx({ "ppt/_rels/presentation.xml.rels": slideRelationship("slides/slide1.xml") }));
  // The slide the presentation lists comes first; the other follows.
  assert.ok(first.indexOf("FIRST") >= 0 && first.indexOf("FIRST") < first.indexOf("SECOND"), first);
  assert.ok(second.indexOf("SECOND") >= 0 && second.indexOf("SECOND") < second.indexOf("FIRST"), second);
  assert.equal(firstAgain, first);
});

test("a malformed presentation relationships part still fails the parse after the embedded-part pass has read it", async () => {
  await assert.rejects(parse(pptx({ "ppt/_rels/presentation.xml.rels": MALFORMED })), /unclosed tag/);
});

test("a malformed slide relationships part still fails the parse", async () => {
  await assert.rejects(
    parse(pptx({
      "ppt/_rels/presentation.xml.rels": slideRelationship("slides/slide1.xml"),
      "ppt/slides/_rels/slide1.xml.rels": MALFORMED,
    })),
    /unclosed tag/,
  );
});

test("a malformed workbook relationships part still fails the parse", async () => {
  await assert.rejects(
    parse({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": `<workbook xmlns="x" xmlns:r="${OFFICE_RELS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": MALFORMED,
      "xl/worksheets/sheet1.xml": '<worksheet xmlns="x"><sheetData/></worksheet>',
    }),
    /unclosed tag/,
  );
});

test("a malformed relationships part of a word document does not fail it", async () => {
  const text = await parse({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>kept</w:t></w:r></w:p></w:body></w:document>',
    "word/_rels/document.xml.rels": MALFORMED,
  });
  assert.match(text, /kept/);
});
