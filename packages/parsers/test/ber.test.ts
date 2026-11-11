import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { Ber, TruncatedAsn1Error, decodeInteger, decodeOid, is, type Element } from "../src/ber.ts";

/*
 * The BER reader behind the TSD parser (tikajs-68os.21). The encodings are those of X.690.
 */

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const children = (ber: Ber, element: Element, limit: number): Element[] => [...ber.children(element, limit)];

test("a definite-length SEQUENCE gives its children in order", () => {
  const data = bytes(0x30, 0x06, 0x02, 0x01, 0x05, 0x04, 0x01, 0x41);
  const ber = new Ber(data);
  const root = ber.element(0, data.length);
  const parts = children(ber, root, data.length);
  assert.deepEqual(parts.map((part) => part.tagNumber), [2, 4]);
  assert.deepEqual([...ber.content(parts[1]!)], [0x41]);
});

test("an indefinite-length SEQUENCE ends at its end-of-contents octets and its end is found by scanning", () => {
  // 30 80 { 02 01 05 } 00 00, then a byte that is not part of it.
  const data = bytes(0x30, 0x80, 0x02, 0x01, 0x05, 0x00, 0x00, 0xff);
  const ber = new Ber(data);
  const root = ber.element(0, data.length);
  assert.equal(root.contentEnd, null);
  assert.equal(children(ber, root, data.length).length, 1);
  assert.equal(ber.end(root, data.length), 7);
});

test("indefinite lengths nested inside indefinite lengths are matched pair by pair", () => {
  const data = bytes(0x30, 0x80, 0x30, 0x80, 0x00, 0x00, 0x02, 0x01, 0x01, 0x00, 0x00);
  const ber = new Ber(data);
  assert.equal(ber.end(ber.element(0, data.length), data.length), data.length);
});

test("a primitive element cannot have an indefinite length", () => {
  assert.throws(() => new Ber(bytes(0x04, 0x80, 0x00, 0x00)).element(0, 4), MalformedDocumentError);
});

test("a long-form length and a high tag number are read", () => {
  // [APPLICATION 300] primitive, length 0x0101 (two octets), content of 257 bytes.
  const content = new Uint8Array(257);
  const data = Uint8Array.from([0x5f, 0x82, 0x2c, 0x82, 0x01, 0x01, ...content]);
  const element = new Ber(data).element(0, data.length);
  assert.equal(element.tagClass, 1);
  assert.equal(element.tagNumber, 300);
  assert.equal(element.contentEnd! - element.contentStart, 257);
});

test("a length past the data is a truncated element, and is kept when asked for as one", () => {
  const data = bytes(0x04, 0x84, 0xff, 0xff, 0xff, 0xff, 1, 2, 3);
  const ber = new Ber(data);
  assert.throws(() => ber.element(0, data.length), TruncatedAsn1Error);
  const clipped = ber.element(0, data.length, true);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.contentEnd, data.length);
});

test("a length of more than four octets is refused", () => {
  assert.throws(() => new Ber(bytes(0x04, 0x85, 1, 0, 0, 0, 0)).element(0, 7), MalformedDocumentError);
});

test("an indefinite-length element that is never closed is truncated", () => {
  const data = bytes(0x30, 0x80, 0x02, 0x01, 0x05);
  const ber = new Ber(data);
  assert.throws(() => ber.end(ber.element(0, data.length), data.length), TruncatedAsn1Error);
  assert.throws(() => children(ber, ber.element(0, data.length), data.length), TruncatedAsn1Error);
});

test("scanning past deeply nested indefinite lengths is refused, not recursed into", () => {
  const depth = 100_000;
  const data = new Uint8Array(depth * 2);
  for (let index = 0; index < depth; index++) {
    data[index * 2] = 0x30;
    data[index * 2 + 1] = 0x80;
  }
  const ber = new Ber(data);
  assert.throws(() => ber.end(ber.element(0, data.length), data.length), MalformedDocumentError);
});

test("a constructed OCTET STRING is read segment by segment, nested once more too", () => {
  // 24 80 { 04 02 'a' 'b'  24 80 { 04 01 'c' } 00 00  04 00 } 00 00
  const data = bytes(0x24, 0x80, 0x04, 0x02, 0x61, 0x62, 0x24, 0x80, 0x04, 0x01, 0x63, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.equal(new TextDecoder().decode(result.bytes), "abc");
  assert.equal(result.error, null);
});

test("an OCTET STRING cut short gives the bytes before the cut and the reason", () => {
  // The second segment says 5 bytes and has 2.
  const data = bytes(0x24, 0x80, 0x04, 0x01, 0x61, 0x04, 0x05, 0x62, 0x63);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.equal(new TextDecoder().decode(result.bytes), "abc");
  assert.ok(result.error instanceof TruncatedAsn1Error);
});

test("a segment that is not an OCTET STRING stops the string with an error", () => {
  const data = bytes(0x24, 0x80, 0x04, 0x01, 0x61, 0x02, 0x01, 0x05, 0x00, 0x00);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.equal(new TextDecoder().decode(result.bytes), "a");
  assert.ok(result.error instanceof MalformedDocumentError);
});

test("more content than the caller allowed is refused rather than returned in part", () => {
  const data = bytes(0x04, 0x03, 1, 2, 3);
  const ber = new Ber(data);
  assert.throws(() => ber.readOctets(ber.element(0, data.length), data.length, 2), MalformedDocumentError);
});

test("half a million empty segments are read in one pass", () => {
  const count = 500_000;
  const data = new Uint8Array(2 + count * 2 + 2);
  data[0] = 0x24;
  data[1] = 0x80;
  for (let index = 0; index < count; index++) data[2 + index * 2] = 0x04;
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.equal(result.bytes.length, 0);
  assert.equal(result.error, null);
});

test("is() compares class, number and, when given, constructed", () => {
  const element = new Ber(bytes(0xa0, 0x00)).element(0, 2);
  assert.ok(is(element, 2, 0, true));
  assert.ok(!is(element, 2, 0, false));
  assert.ok(!is(element, 0, 0));
});

test("object identifiers are dotted, including arcs under 2 above 39 and arcs of several octets", () => {
  assert.equal(decodeOid(bytes(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x1f)), "1.2.840.113549.1.9.16.1.31");
  assert.equal(decodeOid(bytes(0x88, 0x37, 0x01)), "2.999.1");
});

test("an object identifier cut short or too long is refused", () => {
  assert.throws(() => decodeOid(bytes(0x2a, 0x86)), MalformedDocumentError);
  assert.throws(() => decodeOid(new Uint8Array(2000).fill(0x2a)), MalformedDocumentError);
});

test("integers are two's complement and unbounded in size up to the cap", () => {
  assert.equal(decodeInteger(bytes(0x00, 0xff)), 255n);
  assert.equal(decodeInteger(bytes(0xff)), -1n);
  assert.equal(decodeInteger(bytes(0x80, 0x00)), -32768n);
  assert.throws(() => decodeInteger(new Uint8Array(5000)), MalformedDocumentError);
});
