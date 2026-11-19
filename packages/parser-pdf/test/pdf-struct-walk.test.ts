import assert from "node:assert/strict";
import { test } from "node:test";
import { PdfSession } from "../src/pdf-session.ts";
import { classicPdf, objectStreamPdf, onePageObjects, STRUCT_ELEMENT as ELEMENT } from "./fixtures.ts";

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

test("an object stream too big for the first index still settles the root without a walk", async () => {
  assert.deepEqual(await markedContent(objectStreamPdf(60_000, true)), { marked: true, walks: 0 });
  assert.deepEqual(await markedContent(objectStreamPdf(60_000, false)), { marked: false, walks: 0 });
});

test("the same shape in a small object stream, for comparison", async () => {
  assert.deepEqual(await markedContent(objectStreamPdf(10, true)), { marked: true, walks: 0 });
});
