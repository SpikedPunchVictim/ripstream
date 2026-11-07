import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { Asn1Parser } from "../src/index.ts";

test("dumps OIDs and strings from DER", async () => {
  // SEQUENCE { OID 1.2.3, UTF8String "hello" }
  const der = Uint8Array.from([
    0x30, 0x0b,
    0x06, 0x02, 0x2a, 0x03,
    0x0c, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
  ]);
  const stream = await RipstreamInputStream.from(der);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new Asn1Parser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /OID 1\.2\.3/);
  assert.match(handler.toString(), /String hello/);
  assert.deepEqual(metadata.getAll("asn1:oid"), ["1.2.3"]);
});
