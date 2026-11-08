import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PlistParser } from "../src/index.ts";

test("extracts XML plist keys and values", async () => {
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>Name</key><string>Ada</string><key>Age</key><integer>36</integer></dict></plist>`;
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(plist));
  const handler = new BodyContentHandler();
  await new PlistParser().parse(
    stream,
    handler,
    new Metadata(),
    new ParseContext(),
  );
  await stream.close();
  assert.match(handler.toString(), /Name/);
  assert.match(handler.toString(), /Ada/);
  assert.match(handler.toString(), /36/);
});

/**
 * Assemble a binary plist ("bplist00") from raw object encodings.
 * Layout: 8-byte header | objects | offset table (1-byte entries) | 32-byte trailer.
 * Trailer: 6 unused bytes, offsetSize(1), objectRefSize(1), numObjects(u64 BE),
 * topObject(u64 BE), offsetTableOffset(u64 BE). Objects are addressed by index;
 * offsets and refs are 1 byte each, so fixtures must stay under 256 bytes / objects.
 */
function buildBplist(objects: number[][]): Uint8Array {
  const header = [...new TextEncoder().encode("bplist00")];
  const body: number[] = [];
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(header.length + body.length);
    body.push(...object);
  }
  const tableOffset = header.length + body.length;
  const trailer = new Uint8Array(32);
  const view = new DataView(trailer.buffer);
  trailer[6] = 1;
  trailer[7] = 1;
  view.setBigUint64(8, BigInt(objects.length));
  view.setBigUint64(16, 0n);
  view.setBigUint64(24, BigInt(tableOffset));
  return Uint8Array.from([...header, ...body, ...offsets, ...trailer]);
}

async function parsePlist(bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await new PlistParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
  return handler.toString();
}

test("binary plist: a normal small plist still parses and emits its content", async () => {
  const ascii = (s: string) => [...new TextEncoder().encode(s)];
  const bytes = buildBplist([
    [0xd2, 1, 2, 3, 4], // 0: dict, 2 entries: keys -> 1,2; values -> 3,4
    [0x54, ...ascii("name")], // 1: "name"
    [0x53, ...ascii("age")], // 2: "age"
    [0x53, ...ascii("Ada")], // 3: "Ada"
    [0x10, 36], // 4: int 36
  ]);
  assert.match(await parsePlist(bytes), /\{"name":"Ada","age":36\}/);
});

test("binary plist: DAG expansion bomb is rejected with LimitExceededError (#11)", async () => {
  // 31 objects. Object k (0..29) is a 2-element array whose both refs point to
  // object k+1: [0xA2, k+1, k+1]. Object 30 is the int 0 ([0x10, 0x00]).
  // Encoded size is ~100 bytes but fully expanding the top array yields 2^30
  // leaves, which exhausts memory in a naive materializing parser.
  const levels = 30;
  const objects: number[][] = [];
  for (let k = 0; k < levels; k++) objects.push([0xa2, k + 1, k + 1]);
  objects.push([0x10, 0x00]);
  const started = Date.now();
  await assert.rejects(parsePlist(buildBplist(objects)), LimitExceededError);
  assert.ok(Date.now() - started < 5000, "bomb must be rejected promptly");
});

test("binary plist: a reference cycle is rejected rather than recursing forever", async () => {
  // Object 0 is an array holding a reference to itself.
  await assert.rejects(parsePlist(buildBplist([[0xa1, 0]])), LimitExceededError);
});

test("binary plist: a trailer declaring more objects than bytes is malformed", async () => {
  const bytes = buildBplist([[0x10, 0x00]]);
  new DataView(bytes.buffer).setBigUint64(bytes.length - 24, 1n << 40n);
  await assert.rejects(parsePlist(bytes), MalformedDocumentError);
});
