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
