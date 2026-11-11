import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PlistParser } from "../src/index.ts";

/*
 * Tika's PListParser writes an NSData value as its base64 text (handleData: value.getBase64EncodedData()). Read from the
 * Tika 4.2.0 source, not run against a Tika.
 */

/** A binary plist whose only object is a data value (marker 0x4F, a 2-byte length int, the bytes). */
function bplistWithData(payload: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode("bplist00");
  const object = Uint8Array.from([0x4f, 0x11, payload.length >> 8, payload.length & 0xff, ...payload]);
  const trailer = new Uint8Array(32);
  trailer[6] = 2; // offset size
  trailer[7] = 1; // object reference size
  new DataView(trailer.buffer).setBigUint64(8, 1n); // object count
  new DataView(trailer.buffer).setBigUint64(24, BigInt(header.length + object.length)); // offset table position
  return Uint8Array.from([...header, ...object, 0, header.length, ...trailer]);
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await new PlistParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
  return handler.toString();
}

test("a data value is written as base64 text", async () => {
  const text = await textOf(bplistWithData(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])));
  assert.equal(text.trim(), JSON.stringify("3q2+7w=="));
});

test("a large data value stays within the default output limit instead of growing four-fold", async () => {
  // 30000 bytes written as a JSON array of numbers is about 120000 characters, over the 100000 default limit of a parse;
  // as base64 it is 40000.
  const payload = new Uint8Array(30000).fill(0xab);
  const text = await textOf(bplistWithData(payload));
  assert.equal(text.trim().length, 40000 + 2);
});
