import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser, type PdfParserOptions } from "../src/index.ts";
import { classicPdf, encryptedPdf, onePageObjects, streamObject } from "./fixtures.ts";

/** The Tika 4.2.0 metadata keys of tikajs-p1qx. The expected values were read from a running Tika server for the same shapes. */

async function parse(bytes: Uint8Array | string, options: PdfParserOptions = {}): Promise<Metadata> {
  const data = typeof bytes === "string" ? new Uint8Array(Buffer.from(bytes, "latin1")) : bytes;
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  try {
    await new PdfParser(options).parse(stream, new BodyContentHandler(), metadata, new ParseContext());
    return metadata;
  } finally {
    await stream.close();
  }
}

const PERMISSIONS = [
  "can-print",
  "can-print-faithful",
  "can-modify",
  "extract-content",
  "extract-for-accessibility",
  "fill-in-form",
  "modify-annotations",
  "assemble-document",
] as const;

function permissions(metadata: Metadata): string {
  return PERMISSIONS.map((name) => (metadata.get(`access-permission:${name}`) === "true" ? "T" : "F")).join("");
}

test("a file that is not encrypted grants every permission", async () => {
  assert.equal(permissions(await parse(classicPdf(onePageObjects("Hello")))), "TTTTTTTT");
});

test("each /P bit clears its own permission", async () => {
  const cases: Array<[number, string]> = [
    [-4 & ~0x4, "FTTTTTTT"], // print
    [-4 & ~0x800, "TFTTTTTT"], // print faithful
    [-4 & ~0x8, "TTFTTTTT"], // modify contents
    [-4 & ~0x10, "TTTFTTTT"], // extract content
    [-4 & ~0x200, "TTTTFTTT"], // extract for accessibility
    [-4 & ~0x100, "TTTTTFTT"], // fill in form
    [-4 & ~0x20, "TTTTTTFT"], // modify annotations
    [-4 & ~0x400, "TTTTTTTF"], // assemble
    [-3904, "FFFFFFFF"],
  ];
  for (const [bits, expected] of cases) {
    assert.equal(permissions(await parse(encryptedPdf("", bits))), expected, `P=${bits}`);
  }
});

test("the owner password grants every permission whatever /P says, the empty one included", async () => {
  assert.equal(permissions(await parse(encryptedPdf("", -3904))), "FFFFFFFF");
  assert.equal(permissions(await parse(encryptedPdf("", -3904), { password: "owner-secret" })), "TTTTTTTT");
  assert.equal(permissions(await parse(encryptedPdf("", -3904, ""))), "TTTTTTTT");
});

const withCatalog = (catalog: string, extra: string[] = []): string => {
  const objects = onePageObjects("Hello");
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`;
  return classicPdf([...objects, ...extra]);
};
const ELEMENT = "<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>";

test("pdf:has-marked-content is a structure tree root with something in /K", async () => {
  const marked = async (pdf: string): Promise<string | null> => (await parse(pdf)).get("pdf:has-marked-content");
  assert.equal(await marked(classicPdf(onePageObjects("Hello"))), "false");
  assert.equal(await marked(withCatalog("/MarkInfo << /Marked true >>")), "false");
  assert.equal(await marked(withCatalog("/StructTreeRoot 6 0 R", ["<< /Type /StructTreeRoot /K 7 0 R >>", ELEMENT])), "true");
  assert.equal(await marked(withCatalog("/StructTreeRoot 6 0 R", ["<< /K [7 0 R] >>", ELEMENT])), "true");
  assert.equal(await marked(withCatalog("/StructTreeRoot << /Type /StructTreeRoot /K [6 0 R] >>", [ELEMENT])), "true");
  assert.equal(await marked(withCatalog("/StructTreeRoot 6 0 R", ["<< /Type /StructTreeRoot /K [] >>"])), "false");
  assert.equal(await marked(withCatalog("/StructTreeRoot 6 0 R", ["<< /Type /StructTreeRoot >>"])), "false");
  assert.equal(await marked(withCatalog("/StructTreeRoot << /Type /StructTreeRoot >>")), "false");
});

test("pdf:eof-offsets lists each revision and the update count is one fewer", async () => {
  const base = classicPdf(onePageObjects("Base"));
  const update = `${base}6 0 obj\n<< /Note (update) >>\nendobj\nxref\n6 1\n0000000000 00000 n \ntrailer\n<< /Size 7 /Root 1 0 R /Prev ${/startxref\n(\d+)/.exec(base)![1]} >>\nstartxref\n${base.length + 40}\n%%EOF\n`;
  const single = await parse(base);
  assert.deepEqual(single.getAll("pdf:eof-offsets"), [String(base.length)]);
  assert.equal(single.get("pdf:incremental-update-count"), "0");
  const updated = await parse(update);
  assert.deepEqual(updated.getAll("pdf:eof-offsets"), [String(base.length), String(update.length)]);
  assert.equal(updated.get("pdf:incremental-update-count"), "1");
});

test("a file with no startxref has no eof offsets and no updates", async () => {
  const noXref = classicPdf(onePageObjects("Base")).replace(/startxref\n\d+\n/, "");
  const metadata = await parse(noXref);
  assert.deepEqual(metadata.getAll("pdf:eof-offsets"), []);
  assert.equal(metadata.get("pdf:incremental-update-count"), "0");
});

test("pdf:num-3d-annotations counts the 3D annotations", async () => {
  const page =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R 7 0 R 8 0 R] >>";
  const objects = onePageObjects("Annot");
  objects[2] = page;
  objects.push(
    "<< /Type /Annot /Subtype /3D /Rect [0 0 100 100] >>",
    "<< /Type /Annot /Subtype /3D /Rect [0 0 100 100] >>",
    "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (http://example.com/) >> >>",
  );
  assert.equal((await parse(classicPdf(objects))).get("pdf:num-3d-annotations"), "2");
  assert.equal((await parse(classicPdf([...onePageObjects("Hello").slice(0, 3), streamObject("BT ET"), onePageObjects("x")[4]!]))).get("pdf:num-3d-annotations"), "0");
});
