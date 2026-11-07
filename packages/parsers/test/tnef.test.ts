import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { TnefParser } from "../src/index.ts";

const encoder = new TextEncoder();

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}
function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** MS-OXTNEF attribute: level, 32-bit tag (type<<16 | id), length, data, 2-byte checksum. */
function attr(tag: number, data: number[]): number[] {
  const checksum = data.reduce((sum, byte) => (sum + byte) & 0xffff, 0);
  return [1, ...u32(tag), ...u32(data.length), ...data, ...u16(checksum)];
}
function str(value: string): number[] {
  return [...encoder.encode(value), 0];
}

const ATT_SUBJECT = 0x00018004;
const ATT_BODY = 0x0002800c;
const ATT_MESSAGE_CLASS = 0x00078008;
const ATT_PRIORITY = 0x0004800d; // NOT an HTML body
const ATT_MSG_PROPS = 0x00069003;

/** One PT_STRING8 / PT_BINARY MAPI property as stored in attMsgProps. */
function mapiProperty(type: number, id: number, value: Uint8Array | number[]): number[] {
  const bytes = [...value];
  const pad = (4 - (bytes.length % 4)) % 4;
  return [...u16(type), ...u16(id), ...u32(1), ...u32(bytes.length), ...bytes, ...new Array<number>(pad).fill(0)];
}
function msgProps(...properties: number[][]): number[] {
  return [...u32(properties.length), ...properties.flat()];
}

function tnef(...attributes: number[][]): Uint8Array {
  return new Uint8Array([...u32(0x223e9f78), 0x78, 0x9f, ...attributes.flat()]);
}

async function parse(bytes: Uint8Array): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new TnefParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts TNEF subject and body from spec-format attributes", async () => {
  const { text, metadata } = await parse(
    tnef(
      attr(ATT_MESSAGE_CLASS, str("IPM.Note")),
      attr(ATT_SUBJECT, str("TNEF subject")),
      attr(ATT_BODY, str("Body line")),
    ),
  );
  assert.equal(metadata.get("dc:title"), "TNEF subject");
  assert.equal(metadata.get("tnef:message-class"), "IPM.Note");
  assert.match(text, /Body line/);
});

test("skips the 2-byte checksum so later attributes stay aligned", async () => {
  const { metadata, text } = await parse(
    tnef(attr(ATT_PRIORITY, u16(2)), attr(ATT_SUBJECT, str("After priority")), attr(ATT_BODY, str("Aligned body"))),
  );
  assert.equal(metadata.get("dc:title"), "After priority");
  assert.match(text, /Aligned body/);
});

test("0x800d is attPriority, not an HTML body", async () => {
  const { text } = await parse(tnef(attr(ATT_PRIORITY, str("<p>not a body</p>"))));
  assert.doesNotMatch(text, /not a body/);
});

test("reads subject and HTML body from MAPI properties in attMsgProps", async () => {
  const props = msgProps(
    mapiProperty(0x001e, 0x0037, str("MAPI subject")),
    mapiProperty(0x0102, 0x1013, encoder.encode("<html><body><p>MAPI html body</p></body></html>")),
  );
  const { text, metadata } = await parse(tnef(attr(ATT_MSG_PROPS, props)));
  assert.equal(metadata.get("dc:title"), "MAPI subject");
  assert.match(text, /MAPI html body/);
});

test("rejects data without the TNEF signature", async () => {
  await assert.rejects(parse(new Uint8Array(16)));
});
