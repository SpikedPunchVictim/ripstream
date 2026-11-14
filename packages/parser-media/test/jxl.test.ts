import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { JxlParser } from "../src/index.ts";

function packet(body: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>${body}<?xpacket end="w"?>`,
  );
}

test("JXLParser maps the XMP title and document id, as Tika's JXLParser does", async () => {
  const bytes = packet(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Unknown Title</rdf:li></rdf:Alt></dc:title><xmpMM:DocumentID>adobe:docid:photoshop:162ca2dc</xmpMM:DocumentID></rdf:Description></rdf:RDF></x:xmpmeta>`,
  );
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  await new JxlParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("dc:title"), "Unknown Title");
  assert.equal(metadata.get("xmpMM:DocumentID"), "adobe:docid:photoshop:162ca2dc");
});

test("JXLParser yields no keys when the file has no XMP packet", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([0xff, 0x0a, 1, 2, 3]));
  const metadata = new Metadata();
  await new JxlParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.deepEqual([...metadata], []);
});
