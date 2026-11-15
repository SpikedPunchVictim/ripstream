import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, CONTEXT_KEYS, Metadata, ParseContext, RipstreamInputStream, XHTMLContentHandler, type Parser } from "@spikedpunch/ripstream-core";
import { Iso9660Parser } from "../src/index.ts";

function record(name: string, extent: number, size: number, directory: boolean): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  const length = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0);
  const bytes = new Uint8Array(length);
  bytes[0] = length;
  const view = new DataView(bytes.buffer);
  view.setUint32(2, extent, true);
  view.setUint32(10, size, true);
  bytes[25] = directory ? 2 : 0;
  bytes[32] = nameBytes.length;
  bytes.set(nameBytes, 33);
  return [...bytes];
}

function sampleIso(): Uint8Array {
  const data = new Uint8Array(20 * 2048);
  const pvd = 16 * 2048;
  data[pvd] = 1;
  data.set([0x43, 0x44, 0x30, 0x30, 0x31], pvd + 1);
  const root = record("\0", 17, 2048, true);
  data.set(root, pvd + 156);
  const file = record("HELLO.TXT;1", 18, 5, false);
  data.set(file, 17 * 2048);
  data.set([...new TextEncoder().encode("hello")], 18 * 2048);
  return data;
}

const plainText: Parser = {
  getSupportedTypes: () => new Set(),
  async parse(stream, handler) {
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    await xhtml.element("p", text);
    await xhtml.endDocument();
  },
};

test("walks ISO 9660 directories and parses files", async () => {
  const stream = await RipstreamInputStream.from(sampleIso());
  const handler = new BodyContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, plainText);
  await new Iso9660Parser().parse(stream, handler, new Metadata(), context);
  await stream.close();
  assert.match(handler.toString(), /HELLO\.TXT/);
  assert.match(handler.toString(), /hello/);
});

test("rejects excessively deep directory chains with LimitExceededError", async () => {
  const depth = 150;
  const data = new Uint8Array((18 + depth) * 2048);
  const pvd = 16 * 2048;
  data.set([0x43, 0x44, 0x30, 0x30, 0x31], pvd + 1);
  data.set(record("\0", 17, 2048, true), pvd + 156);
  for (let level = 0; level < depth; level++) {
    data.set(record("D", 18 + level, 2048, true), (17 + level) * 2048);
  }
  const stream = await RipstreamInputStream.from(data);
  await assert.rejects(
    new Iso9660Parser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    (error: Error) => error.name === "LimitExceededError",
  );
  await stream.close();
});

/** The entry limit of an ISO image is the context's maxZipEntries, and past it the image throws or is flagged (tikajs-6ghz, F3). */
function isoWithFiles(count: number): Uint8Array {
  const data = new Uint8Array(20 * 2048);
  const pvd = 16 * 2048;
  data[pvd] = 1;
  data.set([0x43, 0x44, 0x30, 0x30, 0x31], pvd + 1);
  data.set(record("\0", 17, 2048, true), pvd + 156);
  let position = 17 * 2048;
  for (let index = 1; index <= count; index++) {
    const entry = record(`F${index}.TXT;1`, 18, 5, false);
    data.set(entry, position);
    position += entry.length;
  }
  data.set([...new TextEncoder().encode("hello")], 18 * 2048);
  return data;
}

async function parseIso(bytes: Uint8Array, maxZipEntries: number, truncate: boolean): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  const ctx = new ParseContext({ limits: { maxZipEntries } });
  ctx.set(CONTEXT_KEYS.PARSER, plainText);
  if (truncate) ctx.set(CONTEXT_KEYS.TRUNCATE_EMBEDDED_LIMIT, true);
  try {
    await new Iso9660Parser().parse(stream, handler, metadata, ctx);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("ISO: more files than maxZipEntries throws LimitExceededError", async () => {
  await assert.rejects(parseIso(isoWithFiles(5), 3, false), (error: Error) => error.name === "LimitExceededError");
});

test("ISO: under onEmbeddedLimit truncate the first files are read and the cut is flagged", async () => {
  const { text, metadata } = await parseIso(isoWithFiles(5), 3, true);
  assert.match(text, /F3\.TXT/);
  assert.doesNotMatch(text, /F4\.TXT/);
  assert.equal(metadata.get("tk:exception:embedded-resource-limit-reached"), "true");
  assert.equal(metadata.get("tk:exception:embedded-resource-limit-seen"), "5");
  assert.equal(metadata.get("tk:exception:embedded-resource-limit-read"), "3");
});

test("ISO: exactly maxZipEntries files is neither an error nor a flag, and the limit is no longer a fixed 10,000", async () => {
  const { text, metadata } = await parseIso(isoWithFiles(3), 3, false);
  assert.match(text, /F3\.TXT/);
  assert.equal(metadata.get("tk:exception:embedded-resource-limit-reached"), null);
});
