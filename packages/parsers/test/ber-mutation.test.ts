import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { Ber, TruncatedAsn1Error, decodeInteger, decodeOid, type Element } from "../src/ber.ts";

/*
 * Boundaries of the BER reader (tikajs-68os.21): each caps is tested one step below, at and one step above its value, and each
 * guard with an input that only it refuses. The encodings are those of X.690.
 */

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const kids = (ber: Ber, element: Element, limit: number): Element[] => [...ber.children(element, limit)];
const SEQUENCE_OPEN = [0x30, 0x80];
const END = [0x00, 0x00];

/** An OCTET STRING of definite length holding `inner`; lengths here stay below 128. */
const octetString = (...inner: number[]): number[] => [0x04, inner.length, ...inner];
const constructedString = (...inner: number[]): number[] => [0x24, inner.length, ...inner];

/** `levels` constructed OCTET STRINGs one inside the other, with one primitive segment "x" in the innermost. */
function nested(levels: number): Uint8Array {
  let inner = octetString(0x78);
  for (let level = 0; level < levels; level++) inner = constructedString(...inner);
  return Uint8Array.from(inner);
}

const readAll = (data: Uint8Array, maxBytes = 100): { text: string; error: MalformedDocumentError | null } => {
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, maxBytes);
  return { text: new TextDecoder().decode(result.bytes), error: result.error };
};

// ---- nesting of segments ----

test("constructed OCTET STRINGs nest eight deep and no deeper", () => {
  assert.deepEqual(readAll(nested(1)), { text: "x", error: null });
  assert.deepEqual(readAll(nested(8)), { text: "x", error: null });
  const nine = readAll(nested(9));
  assert.equal(nine.text, "");
  assert.ok(nine.error instanceof MalformedDocumentError && !(nine.error instanceof TruncatedAsn1Error));
  assert.match(nine.error.message, /nested too deeply/);
});

// ---- scanning past indefinite lengths ----

/** An indefinite-length SEQUENCE with `inside` more indefinite-length SEQUENCEs inside it, one in the next. */
function indefiniteNest(inside: number): Uint8Array {
  const opens = Array.from({ length: inside + 1 }, () => SEQUENCE_OPEN).flat();
  const closes = Array.from({ length: inside + 1 }, () => END).flat();
  return Uint8Array.from([...opens, ...closes]);
}

test("scanning follows indefinite lengths nested 64 deep and refuses 65", () => {
  for (const [inside, allowed] of [[62, true], [63, true], [64, false], [65, false]] as const) {
    const data = indefiniteNest(inside);
    const ber = new Ber(data);
    const root = ber.element(0, data.length);
    if (allowed) assert.equal(ber.end(root, data.length), data.length, `${inside} inside`);
    else assert.throws(() => ber.end(root, data.length), /nested too deeply/, `${inside} inside`);
  }
});

// ---- tags ----

test("a tag number of four octets is read and one of five is refused", () => {
  // [APPLICATION 0x1fffff] in four octets: 5f ff ff ff 7f is five, 5f ff ff 7f is three; a four octet one is 5f ff ff ff 7f minus one.
  const four = bytes(0x5f, 0x81, 0x80, 0x80, 0x00, 0x00);
  assert.equal(new Ber(four).element(0, four.length).tagNumber, 2097152);
  const five = bytes(0x5f, 0x81, 0x80, 0x80, 0x80, 0x00, 0x00);
  assert.throws(() => new Ber(five).element(0, five.length), (error: unknown) => error instanceof MalformedDocumentError && !(error instanceof TruncatedAsn1Error) && /tag is too long/.test(error.message));
});

test("a tag number of 30 is a low tag number, and 31 starts the long form", () => {
  const thirty = bytes(0x1e, 0x02, 0x00, 0x41);
  assert.equal(new Ber(thirty).element(0, thirty.length).tagNumber, 30);
  const thirtyOne = bytes(0x1f, 0x1f, 0x00);
  assert.equal(new Ber(thirtyOne).element(0, thirtyOne.length).tagNumber, 31);
});

test("a high tag number that the limit cuts is truncated, not too long", () => {
  // The data goes on with continuation octets past the limit; the limit is what ends the element.
  const data = bytes(0x5f, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81);
  assert.throws(() => new Ber(data).element(0, 4), TruncatedAsn1Error);
});

test("a header that ends at the limit before its length octet is truncated, also when clipping", () => {
  const data = bytes(0x5f, 0x01, 0x00);
  const ber = new Ber(data);
  assert.throws(() => ber.element(0, 2), TruncatedAsn1Error);
  assert.throws(() => ber.element(0, 2, true), TruncatedAsn1Error);
  assert.equal(ber.element(0, 3).contentEnd, 3);
});

test("two octets are the least an element has", () => {
  const data = bytes(0x04, 0x00, 0x04);
  const ber = new Ber(data);
  assert.equal(ber.element(0, 2).contentEnd, 2);
  assert.throws(() => ber.element(0, 1), TruncatedAsn1Error);
  assert.throws(() => ber.element(2, 3), TruncatedAsn1Error);
});

// ---- lengths ----

test("a long-form length of four octets is read and of five is refused", () => {
  const four = bytes(0x04, 0x84, 0x00, 0x00, 0x00, 0x01, 0x61);
  const element = new Ber(four).element(0, four.length);
  assert.equal(element.contentEnd, four.length);
  const five = bytes(0x04, 0x85, 0x00, 0x00, 0x00, 0x00, 0x01, 0x61);
  assert.throws(() => new Ber(five).element(0, five.length), (error: unknown) => error instanceof MalformedDocumentError && !(error instanceof TruncatedAsn1Error) && /length is not valid/.test(error.message));
});

test("a length given in octets that fit exactly in the limit is read", () => {
  const data = bytes(0x04, 0x81, 0x00);
  assert.equal(new Ber(data).element(0, 3).contentEnd, 3);
  assert.throws(() => new Ber(data).element(0, 2), TruncatedAsn1Error);
});

test("an element whose content ends exactly at the limit is whole, and one octet more is truncated", () => {
  const data = bytes(0x04, 0x02, 0x61, 0x62, 0x63);
  const ber = new Ber(data);
  const whole = ber.element(0, 4);
  assert.equal(whole.contentEnd, 4);
  assert.equal(whole.truncated, undefined);
  assert.throws(() => ber.element(0, 3), TruncatedAsn1Error);
  const clipped = ber.element(0, 3, true);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.contentEnd, 3);
});

test("a length octet of 0x80 is the indefinite form, not a short length", () => {
  const data = bytes(0x30, 0x80, 0x00, 0x00);
  assert.equal(new Ber(data).element(0, data.length).contentEnd, null);
  const empty = bytes(0x30, 0x00);
  assert.equal(new Ber(empty).element(0, 2).contentEnd, 2);
});

test("a long-form length is its octets in order, base 256", () => {
  const data = new Uint8Array(4 + 0x0302);
  data.set([0x04, 0x82, 0x03, 0x02]);
  const element = new Ber(data).element(0, data.length);
  assert.equal(element.contentEnd! - element.contentStart, 0x0302);
});

// ---- children and end ----

test("the children of a primitive element are refused", () => {
  const data = bytes(0x04, 0x02, 0x05, 0x00);
  const ber = new Ber(data);
  assert.throws(() => kids(ber, ber.element(0, data.length), data.length), /has no children/);
});

test("a child of a definite-length element that looks like end-of-contents is a child", () => {
  const data = bytes(0x30, 0x05, 0x00, 0x00, 0x02, 0x01, 0x05);
  const ber = new Ber(data);
  const parts = kids(ber, ber.element(0, data.length), data.length);
  assert.deepEqual(parts.map((part) => part.tagNumber), [0, 2]);
});

test("an end-of-contents is two zero octets, not any octet followed by zero or zero followed by any", () => {
  // 30 80 { 04 00 } 00 00: the child 04 00 ends in a zero octet, which is not end-of-contents.
  const withZeroSecond = bytes(0x30, 0x80, 0x04, 0x00, 0x00, 0x00);
  const first = new Ber(withZeroSecond);
  assert.equal(kids(first, first.element(0, 6), 6).length, 1);
  // 30 80 { 00 01 41 } 00 00: a child whose tag octet is zero, followed by a length that is not.
  const withZeroFirst = bytes(0x30, 0x80, 0x00, 0x01, 0x41, 0x00, 0x00);
  const second = new Ber(withZeroFirst);
  assert.equal(kids(second, second.element(0, 7), 7).length, 1);
  assert.equal(second.end(second.element(0, 7), 7), 7);
});

test("an end-of-contents needs both its octets inside the limit", () => {
  const data = bytes(0x30, 0x80, 0x00, 0x00);
  const ber = new Ber(data);
  const root = ber.element(0, data.length);
  assert.equal(ber.end(root, 4), 4);
  assert.throws(() => ber.end(root, 3), TruncatedAsn1Error);
});

test("the children of an indefinite-length element stop at its end-of-contents and need no more data", () => {
  const data = bytes(0x30, 0x80, 0x02, 0x01, 0x05, 0x00, 0x00);
  const ber = new Ber(data);
  assert.equal(kids(ber, ber.element(0, data.length), data.length).length, 1);
});

test("the end of a definite-length element is where its content ends", () => {
  const data = bytes(0x04, 0x02, 0x61, 0x62, 0x63);
  const ber = new Ber(data);
  assert.equal(ber.end(ber.element(0, 5), 5), 4);
});

test("content is refused for an indefinite length", () => {
  const data = bytes(0x30, 0x80, 0x00, 0x00);
  const ber = new Ber(data);
  assert.throws(() => ber.content(ber.element(0, data.length)), /indefinite length/);
});

// ---- OCTET STRING reading ----

test("a content of exactly the allowed size is read, one more is refused", () => {
  const data = bytes(0x04, 0x03, 1, 2, 3);
  const ber = new Ber(data);
  assert.deepEqual([...ber.readOctets(ber.element(0, 5), 5, 3).bytes], [1, 2, 3]);
  assert.throws(() => ber.readOctets(ber.element(0, 5), 5, 2), MalformedDocumentError);
});

test("the cap holds over the segments together, and a refusal is not a partial result", () => {
  const data = Uint8Array.from(constructedString(...octetString(1, 2), ...octetString(3, 4)));
  const ber = new Ber(data);
  assert.deepEqual([...ber.readOctets(ber.element(0, data.length), data.length, 4).bytes], [1, 2, 3, 4]);
  assert.throws(() => ber.readOctets(ber.element(0, data.length), data.length, 3), /too large/);
});

test("segments are joined in order and the result holds only their bytes, however they grow the buffer", () => {
  const segments = [[1], [2, 3], [4, 5, 6, 7], [], [8]];
  const data = Uint8Array.from(constructedString(...segments.flatMap((segment) => octetString(...segment))));
  const result = readAll(data);
  assert.deepEqual(result.error, null);
  const ber = new Ber(data);
  assert.deepEqual([...ber.readOctets(ber.element(0, data.length), data.length, 100).bytes], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("an indefinite-length OCTET STRING with no end-of-contents is truncated, with what it held", () => {
  const data = bytes(0x24, 0x80, 0x04, 0x01, 0x61);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.deepEqual([...result.bytes], [0x61]);
  assert.ok(result.error instanceof TruncatedAsn1Error);
  assert.match(result.error.message, /not closed/);
});

test("a constructed OCTET STRING whose length runs past the data is truncated, with what it held", () => {
  const data = bytes(0x24, 0x20, 0x04, 0x01, 0x61);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length, true), data.length, 100);
  assert.deepEqual([...result.bytes], [0x61]);
  assert.ok(result.error instanceof TruncatedAsn1Error);
  assert.match(result.error.message, /not closed/);
});

test("a primitive OCTET STRING whose length runs past the data gives what is there, as truncated", () => {
  const data = bytes(0x04, 0x20, 0x61, 0x62);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length, true), data.length, 100);
  assert.deepEqual([...result.bytes], [0x61, 0x62]);
  assert.ok(result.error instanceof TruncatedAsn1Error);
  assert.match(result.error.message, /cut short/);
});

test("a segment is read to its own end, not to the end of its parent", () => {
  // The segment is two bytes of a longer buffer: the bytes after the end-of-contents are not its own.
  const data = bytes(0x24, 0x80, 0x04, 0x02, 0x61, 0x62, 0x00, 0x00, 0x63, 0x64);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.deepEqual([...result.bytes], [0x61, 0x62]);
  assert.equal(result.error, null);
});

test("end-of-contents octets inside a definite-length constructed string are not a segment", () => {
  const data = bytes(0x24, 0x05, 0x04, 0x01, 0x61, 0x00, 0x00);
  const ber = new Ber(data);
  const result = ber.readOctets(ber.element(0, data.length), data.length, 100);
  assert.deepEqual([...result.bytes], [0x61]);
  assert.ok(result.error instanceof MalformedDocumentError && !(result.error instanceof TruncatedAsn1Error));
  assert.match(result.error.message, /not an OCTET STRING/);
});

test("an indefinite-length segment inside a constructed string is skipped by its own end", () => {
  // 24 80 { 24 80 { 04 01 a } 00 00  04 01 b } 00 00
  const data = bytes(0x24, 0x80, 0x24, 0x80, 0x04, 0x01, 0x61, 0x00, 0x00, 0x04, 0x01, 0x62, 0x00, 0x00);
  const result = readAll(data);
  assert.deepEqual(result, { text: "ab", error: null });
});

test("an error that is not about the data is not turned into a partial result", () => {
  class Failing extends Uint8Array {
    override subarray(): never {
      throw new RangeError("the buffer failed");
    }
  }
  const data = Failing.from([0x04, 0x01, 0x61]);
  const ber = new Ber(data);
  const element = ber.element(0, 3);
  assert.throws(() => ber.readOctets(element, 3, 10), RangeError);
});

// ---- object identifiers and integers ----

test("an empty object identifier and an empty integer are refused", () => {
  assert.throws(() => decodeOid(new Uint8Array(0)), /Empty ASN\.1 object identifier/);
  assert.throws(() => decodeInteger(new Uint8Array(0)), /Empty ASN\.1 integer/);
});

test("an object identifier or an integer of 1024 octets is read and of 1025 is refused", () => {
  assert.doesNotThrow(() => decodeOid(new Uint8Array(1024).fill(0x2a)));
  assert.throws(() => decodeOid(new Uint8Array(1025).fill(0x2a)), /too long/);
  assert.equal(decodeInteger(new Uint8Array(1024)), 0n);
  assert.equal(decodeInteger(Uint8Array.of(0x7f, ...new Uint8Array(1023))), 0x7fn << 8184n);
  assert.throws(() => decodeInteger(new Uint8Array(1025)), /too long/);
});

test("the first two arcs of an object identifier are split at 40 and 80", () => {
  assert.equal(decodeOid(bytes(0x00)), "0.0");
  assert.equal(decodeOid(bytes(0x27)), "0.39");
  assert.equal(decodeOid(bytes(0x28)), "1.0");
  assert.equal(decodeOid(bytes(0x4f)), "1.39");
  assert.equal(decodeOid(bytes(0x50)), "2.0");
  assert.equal(decodeOid(bytes(0x51)), "2.1");
});

test("integers of one octet and two are two's complement at their own width", () => {
  assert.equal(decodeInteger(bytes(0x7f)), 127n);
  assert.equal(decodeInteger(bytes(0x80)), -128n);
  assert.equal(decodeInteger(bytes(0xff, 0x7f)), -129n);
  assert.equal(decodeInteger(bytes(0x01, 0x00)), 256n);
  assert.equal(decodeInteger(bytes(0x00, 0x80)), 128n);
});
