import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { PdfSession } from "../src/pdf-session.ts";
import { classicPdf, onePageObjects, streamObject } from "./fixtures.ts";

/**
 * tikajs-5w1z: pdf.js's getStructTree walks the whole structure tree of page 1 (about 25 s of a 32 s parse of a cairo-tagged
 * file) and is asked only whether a root exists. When the objects say what the root holds, it is not asked.
 */

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));

interface PageProxy {
  getStructTree?: () => Promise<unknown>;
}

interface PdfjsModule {
  getDocument(options: { data: Uint8Array }): { promise: Promise<{ getPage(n: number): Promise<object>; destroy(): Promise<void> }> };
}

/** The class of pdf.js's page proxies, which the module does not export: taken from a page of a throwaway document. */
async function pageProxyPrototype(): Promise<PageProxy> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  const document = await pdfjs.getDocument({ data: bytesOf(classicPdf(onePageObjects("Hello"))) }).promise;
  try {
    return Object.getPrototypeOf(await document.getPage(1)) as PageProxy;
  } finally {
    await document.destroy();
  }
}

/** What `pdf:has-marked-content` comes from for `bytes`, and how many times pdf.js was asked for the tree. */
async function markedContent(bytes: Uint8Array): Promise<{ marked: boolean | string; walks: number }> {
  const proto = await pageProxyPrototype();
  const real = proto.getStructTree!;
  let walks = 0;
  proto.getStructTree = function (this: PageProxy) {
    walks++;
    return real.call(this);
  };
  const session = new PdfSession({ data: bytes });
  try {
    const ready = await session.open();
    return { marked: ready.type === "ready" ? ready.hasMarkedContent : ready.type, walks };
  } finally {
    proto.getStructTree = real;
    await session.dispose();
  }
}

const ELEMENT = "<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>";

function tagged(catalogEntry: string, extra: string[] = []): Uint8Array {
  const objects = onePageObjects("Hello");
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${catalogEntry} >>`;
  return bytesOf(classicPdf([...objects, ...extra]));
}

test("a root with kids is marked content without a walk of the tree", async () => {
  const pdf = tagged("/StructTreeRoot 6 0 R", ["<< /Type /StructTreeRoot /K 7 0 R >>", ELEMENT]);
  assert.deepEqual(await markedContent(pdf), { marked: true, walks: 0 });
});

test("a root with an empty /K is not marked content, and no walk either", async () => {
  const pdf = tagged("/StructTreeRoot 6 0 R", ["<< /Type /StructTreeRoot /K [] >>"]);
  assert.deepEqual(await markedContent(pdf), { marked: false, walks: 0 });
});

test("no root is not marked content; pdf.js is asked, and answers null at once", async () => {
  const pdf = bytesOf(classicPdf(onePageObjects("Hello")));
  assert.deepEqual(await markedContent(pdf), { marked: false, walks: 1 });
});

/** One page whose objects (all but the content stream) sit in one object stream: `fillers` members first, the catalog last. */
function objectStreamPdf(fillers: number, withKids: boolean): Uint8Array {
  const filler = `(${"x".repeat(150)})`;
  const members: [number, string][] = [];
  for (let index = 0; index < fillers; index++) members.push([100 + index, filler]);
  members.push(
    [1, "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [6, withKids ? "<< /Type /StructTreeRoot /K 7 0 R >>" : "<< /Type /StructTreeRoot /K [] >>"],
    [7, ELEMENT],
  );
  let header = "";
  let body = "";
  for (const [num, text] of members) {
    header += `${num} ${body.length} `;
    body += `${text} `;
  }
  const objectStream = deflateSync(Buffer.from(header + body, "latin1"));
  const content = streamObject("BT /F1 24 Tf 72 700 Td (Hello) Tj ET");
  const lastNum = 100 + fillers - 1;
  const head = "%PDF-1.5\n";
  const contentAt = head.length;
  const contentObject = `4 0 obj\n${content}\nendobj\n`;
  const streamAt = contentAt + contentObject.length;
  const streamObject10 = `10 0 obj\n<< /Type /ObjStm /N ${members.length} /First ${header.length} /Filter /FlateDecode /Length ${objectStream.length} >>\nstream\n`;
  const xrefAt = streamAt + streamObject10.length + objectStream.length + "\nendstream\nendobj\n".length;
  // Entries of 1 + 4 + 2 bytes for objects 0..lastNum: free, in the file (4, 10, the xref stream), or in object stream 10.
  const entries = Buffer.alloc((lastNum + 1) * 7);
  const put = (num: number, type: number, a: number, b: number): void => {
    entries.writeUInt8(type, num * 7);
    entries.writeUInt32BE(a, num * 7 + 1);
    entries.writeUInt16BE(b, num * 7 + 5);
  };
  members.forEach(([num], index) => put(num, 2, 10, index));
  put(4, 1, contentAt, 0);
  put(10, 1, streamAt, 0);
  put(11, 1, xrefAt, 0);
  const xrefData = deflateSync(entries);
  const file = Buffer.concat([
    Buffer.from(head + contentObject + streamObject10, "latin1"),
    objectStream,
    Buffer.from(
      `\nendstream\nendobj\n11 0 obj\n<< /Type /XRef /Size ${lastNum + 1} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${xrefData.length} >>\nstream\n`,
      "latin1",
    ),
    xrefData,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"),
  ]);
  return new Uint8Array(file);
}

test("an object stream too big for the first index still settles the root without a walk", async () => {
  assert.deepEqual(await markedContent(objectStreamPdf(60_000, true)), { marked: true, walks: 0 });
  assert.deepEqual(await markedContent(objectStreamPdf(60_000, false)), { marked: false, walks: 0 });
});

test("the same shape in a small object stream, for comparison", async () => {
  assert.deepEqual(await markedContent(objectStreamPdf(10, true)), { marked: true, walks: 0 });
});
