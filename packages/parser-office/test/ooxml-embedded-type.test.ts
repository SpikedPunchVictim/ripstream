import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";

/*
 * Tika's AbstractOOXMLExtractor types an embedded part by the relationship that reaches it: an image is INLINE; audio,
 * video, media, package and oleObject are ATTACHMENT. A part no relationship reaches, Tika never extracts.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MS_MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media";

const DOCX = {
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`,
};

function rels(...entries: ReadonlyArray<readonly [type: string, target: string, mode?: string]>): string {
  const items = entries.map(
    ([type, target, mode], index) =>
      `<Relationship Id="rId${index + 1}" Type="${type}" Target="${target}"${mode === undefined ? "" : ` TargetMode="${mode}"`}/>`,
  );
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;
}

/** The `tk:embedded-resource-type` of each embedded part, by the part's file name. */
async function typesOf(files: Record<string, string | Uint8Array>): Promise<Record<string, string | null>> {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = typeof value === "string" ? strToU8(value) : value;
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(zipSync(archive));
  try {
    await new OoxmlParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  } finally {
    await stream.close();
  }
  return Object.fromEntries(
    resources.resources.map((resource) => [
      resource.metadata.get("tk:resource-name") ?? "",
      resource.metadata.get("tk:embedded-resource-type"),
    ]),
  );
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const BIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

test("an image reached by an image relationship is INLINE", async () => {
  assert.deepEqual(
    await typesOf({ ...DOCX, "word/_rels/document.xml.rels": rels([`${OFFICE}/image`, "media/image1.png"]), "word/media/image1.png": PNG }),
    { "image1.png": "INLINE" },
  );
});

test("audio, video and media relationships make an ATTACHMENT", async () => {
  assert.deepEqual(
    await typesOf({
      ...DOCX,
      "word/_rels/document.xml.rels": rels(
        [`${OFFICE}/audio`, "media/a.wav"],
        [`${OFFICE}/video`, "media/v.mp4"],
        [MS_MEDIA, "media/m.mov"],
      ),
      "word/media/a.wav": BIN,
      "word/media/v.mp4": BIN,
      "word/media/m.mov": BIN,
    }),
    { "a.wav": "ATTACHMENT", "v.mp4": "ATTACHMENT", "m.mov": "ATTACHMENT" },
  );
});

test("package and oleObject relationships make an ATTACHMENT", async () => {
  assert.deepEqual(
    await typesOf({
      ...DOCX,
      "word/_rels/document.xml.rels": rels([`${OFFICE}/package`, "embeddings/book.xlsx"], [`${OFFICE}/oleObject`, "embeddings/oleObject1.bin"]),
      "word/embeddings/book.xlsx": BIN,
      "word/embeddings/oleObject1.bin": BIN,
    }),
    { "book.xlsx": "ATTACHMENT", "oleObject1.bin": "ATTACHMENT" },
  );
});

test("a relationship in another part resolves its `..` target from that part's folder", async () => {
  assert.deepEqual(
    await typesOf({
      "[Content_Types].xml": "<Types/>",
      "ppt/presentation.xml": '<p:presentation xmlns:p="x"/>',
      "ppt/slides/slide1.xml": '<p:sld xmlns:p="x" xmlns:a="y"><a:p><a:r><a:t>One</a:t></a:r></a:p></p:sld>',
      "ppt/slides/_rels/slide1.xml.rels": rels([`${OFFICE}/image`, "../media/photo.png"]),
      "ppt/media/photo.png": PNG,
    }),
    { "photo.png": "INLINE" },
  );
});

test("a workbook a chart embeds is an ATTACHMENT, found through the chart's own relationships", async () => {
  assert.deepEqual(
    await typesOf({
      ...DOCX,
      "word/charts/chart1.xml": '<c:chartSpace xmlns:c="x"/>',
      "word/charts/_rels/chart1.xml.rels": rels([`${OFFICE}/package`, "../embeddings/data.xlsx"]),
      "word/embeddings/data.xlsx": BIN,
    }),
    { "data.xlsx": "ATTACHMENT" },
  );
});

test("an absolute relationship target is read from the package root", async () => {
  assert.deepEqual(
    await typesOf({ ...DOCX, "word/_rels/document.xml.rels": rels([`${OFFICE}/image`, "/word/media/abs.png"]), "word/media/abs.png": PNG }),
    { "abs.png": "INLINE" },
  );
});

test("a part no relationship reaches has no type, as Tika would not have extracted it", async () => {
  assert.deepEqual(await typesOf({ ...DOCX, "word/media/orphan.png": PNG }), { "orphan.png": null });
});

test("an external relationship types nothing", async () => {
  assert.deepEqual(
    await typesOf({
      ...DOCX,
      "word/_rels/document.xml.rels": rels([`${OFFICE}/image`, "media/ext.png", "External"]),
      "word/media/ext.png": PNG,
    }),
    { "ext.png": null },
  );
});

test("a relationship of another kind types nothing", async () => {
  assert.deepEqual(
    await typesOf({ ...DOCX, "word/_rels/document.xml.rels": rels([`${OFFICE}/hyperlink`, "media/odd.png"]), "word/media/odd.png": PNG }),
    { "odd.png": null },
  );
});

test("a percent-encoded relationship target names the part it decodes to", async () => {
  assert.deepEqual(
    await typesOf({
      ...DOCX,
      "word/_rels/document.xml.rels": rels([`${OFFICE}/package`, "embeddings/My%20Sheet.xlsx"]),
      "word/embeddings/My Sheet.xlsx": BIN,
    }),
    { "My Sheet.xlsx": "ATTACHMENT" },
  );
});

test("a relationships file that is not XML types nothing and does not fail the document", async () => {
  assert.deepEqual(
    await typesOf({ ...DOCX, "word/_rels/document.xml.rels": "<Relationships><Relationship", "word/media/a.png": PNG }),
    { "a.png": null },
  );
});

test("a part reached by two relationships of different types takes the first relationships file by name", async () => {
  assert.deepEqual(
    await typesOf({
      ...DOCX,
      "word/_rels/document.xml.rels": rels([`${OFFICE}/image`, "media/both.png"]),
      "word/_rels/header1.xml.rels": rels([`${OFFICE}/package`, "media/both.png"]),
      "word/media/both.png": PNG,
    }),
    { "both.png": "INLINE" },
  );
});

test("a workbook's drawing types the picture it holds", async () => {
  assert.deepEqual(
    await typesOf({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook xmlns="x"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
      "xl/drawings/_rels/drawing1.xml.rels": rels([`${OFFICE}/image`, "../media/chart.png"]),
      "xl/media/chart.png": PNG,
    }),
    { "chart.png": "INLINE" },
  );
});
