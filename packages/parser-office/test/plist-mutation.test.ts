import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { parsePlist, plistText, type PlistValue } from "../src/plist.ts";
import { array, ascii, bigEndian, binaryPlist, dict } from "./plist-builder.ts";

/*
 * Pins found by mutation testing the property-list reader (tikajs-68os.18): every width and marker of the binary format,
 * the exact bounds of each check (object offsets, the offset table, the trailer, the depth and node caps), the XML scalar
 * forms, and the date text. The binary layout is Apple's, as in plist.test.ts; dd-plist's toString is the reference for text.
 */

const enc = new TextEncoder();

interface Raw {
  readonly objects: readonly number[];
  readonly offsets: readonly number[];
  readonly offsetSize?: number;
  readonly refSize?: number;
  readonly count?: number;
  readonly top?: number;
  /** Where the trailer says the offset table is, where that is not just after the objects. */
  readonly tableOffset?: number;
  /** The table's bytes where they are not the offsets in `offsetSize` bytes each. */
  readonly table?: readonly number[];
  /** The five trailer bytes nothing is meant to read. */
  readonly unused?: readonly number[];
}

/** A "bplist00" file laid out byte by byte, so a test can put a field exactly where a bound is. */
function raw(spec: Raw): Uint8Array {
  const offsetSize = spec.offsetSize ?? 1;
  const header = [...enc.encode("bplist00")];
  const tableOffset = header.length + spec.objects.length;
  const table = spec.table ?? spec.offsets.flatMap((offset) => bigEndian(offset, offsetSize));
  const trailer = [
    ...(spec.unused ?? [0, 0, 0, 0, 0]),
    0,
    offsetSize,
    spec.refSize ?? 1,
    ...bigEndian(spec.count ?? spec.offsets.length, 8),
    ...bigEndian(spec.top ?? 0, 8),
    ...bigEndian(spec.tableOffset ?? tableOffset, 8),
  ];
  return Uint8Array.from([...header, ...spec.objects, ...table, ...trailer]);
}

const items = (value: PlistValue): readonly PlistValue[] => {
  assert.equal(value.kind, "array");
  return (value as Extract<PlistValue, { kind: "array" }>).value;
};

function float64(value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return [...bytes];
}

test("an integer of four bytes is unsigned; one of eight is signed; one of sixteen is refused", () => {
  const value = parsePlist(binaryPlist([array(1, 2), [0x12, 0xff, 0xff, 0xff, 0xff], [0x13, 0, 0, 0, 0, 0, 0, 0, 1]]));
  assert.deepEqual(items(value).map(plistText), ["4294967295", "1"]);
  assert.throws(() => parsePlist(binaryPlist([[0x14, ...Array<number>(16).fill(0)]])), MalformedDocumentError);
});

test("a real of four bytes is a float, of eight a double; any other width is refused", () => {
  assert.equal(plistText(parsePlist(binaryPlist([[0x22, 0x40, 0x20, 0x00, 0x00]]))), "2.5");
  assert.equal(plistText(parsePlist(binaryPlist([[0x23, ...float64(0.1)]]))), "0.1");
  assert.throws(() => parsePlist(binaryPlist([[0x21, 0x00, 0x00]])), MalformedDocumentError);
  assert.throws(() => parsePlist(binaryPlist([[0x24, ...Array<number>(16).fill(0)]])), MalformedDocumentError);
});

test("a date counts seconds from 2001-01-01, and its marker is 0x33 only", () => {
  assert.equal(plistText(parsePlist(binaryPlist([[0x33, ...float64(3)]]))), "Mon Jan 01 00:00:03 UTC 2001");
  assert.equal(plistText(parsePlist(binaryPlist([[0x33, ...float64(86400.5)]]))), "Tue Jan 02 00:00:00 UTC 2001");
  for (const marker of [0x30, 0x31, 0x32, 0x34]) {
    assert.throws(() => parsePlist(binaryPlist([[marker, ...float64(0)]])), MalformedDocumentError, marker.toString(16));
  }
});

test("a UID of two bytes, and a set, are read", () => {
  assert.equal(plistText(parsePlist(binaryPlist([[0x81, 0x01, 0x00]]))), "256");
  const set = parsePlist(binaryPlist([[0xc1, 1], ascii("a")]));
  assert.deepEqual(items(set).map(plistText), ["a"]);
});

test("the simple objects: 0x00 and 0x0F are null, 0x08 false, 0x09 true; the others are refused", () => {
  assert.equal(parsePlist(binaryPlist([[0x00]])).kind, "null");
  assert.equal(parsePlist(binaryPlist([[0x0f]])).kind, "null");
  assert.equal(plistText(parsePlist(binaryPlist([[0x08]]))), "false");
  assert.equal(plistText(parsePlist(binaryPlist([[0x09]]))), "true");
  for (const low of [0x01, 0x02, 0x07, 0x0a, 0x0e]) {
    assert.throws(() => parsePlist(binaryPlist([[low]])), MalformedDocumentError, low.toString(16));
  }
});

test("a dictionary key that is not a string is refused", () => {
  assert.throws(() => parsePlist(binaryPlist([dict(1, 2), [0x10, 1], ascii("v")])), MalformedDocumentError);
});

test("an ASCII string byte above 0x7F is U+FFFD, including 0x80 to 0x9F (which windows-1252 would turn into letters)", () => {
  const value = parsePlist(binaryPlist([[0x55, 0x41, 0x80, 0x9f, 0xe9, 0xff]]));
  assert.equal(plistText(value), "A����");
});

test("a length given as an integer object must be an integer object, of at most eight bytes", () => {
  assert.throws(() => parsePlist(binaryPlist([[0x5f, 0x20, 1, 0x41]])), MalformedDocumentError);
  assert.throws(() => parsePlist(binaryPlist([[0x5f, 0x14, ...Array<number>(16).fill(0), 0x41]])), MalformedDocumentError);
  assert.equal(plistText(parsePlist(binaryPlist([[0x5f, 0x11, 0, 3, 0x41, 0x42, 0x43]]))), "ABC");
});

test("a data object's bytes are returned as they are", () => {
  const value = parsePlist(binaryPlist([[0x4f, 0x10, 16, ...Array.from({ length: 16 }, (_, i) => i)]]));
  assert.equal(value.kind, "data");
  assert.deepEqual([...(value as Extract<PlistValue, { kind: "data" }>).value], Array.from({ length: 16 }, (_, i) => i));
});

test("sizes of eight bytes for offsets and references, and different sizes for each, are read", () => {
  assert.equal(plistText(parsePlist(binaryPlist([ascii("x")], { offsetSize: 8 }))), "x");
  // refSize 8
  const eight = raw({ objects: [0xa1, 0, 0, 0, 0, 0, 0, 0, 1, ...ascii("x")], offsets: [8, 17], refSize: 8 });
  assert.deepEqual(items(parsePlist(eight)).map(plistText), ["x"]);
  // offsets of two bytes and references of one, then the other way round: a reader that swaps them reads the wrong field
  const offsetsTwo = raw({ objects: [0xa1, 1, ...ascii("x")], offsets: [8, 10], offsetSize: 2, refSize: 1 });
  assert.deepEqual(items(parsePlist(offsetsTwo)).map(plistText), ["x"]);
  const refsTwo = raw({ objects: [0xa1, 0, 1, ...ascii("x")], offsets: [8, 11], offsetSize: 1, refSize: 2 });
  assert.deepEqual(items(parsePlist(refsTwo)).map(plistText), ["x"]);
});

test("a size of nought for offsets or references is refused, as is one of nine", () => {
  for (const [offsetSize, refSize] of [[0, 1], [1, 0], [9, 1], [1, 9]] as const) {
    const data = raw({ objects: ascii("x"), offsets: [8] });
    data[data.byteLength - 26] = offsetSize;
    data[data.byteLength - 25] = refSize;
    assert.throws(() => parsePlist(data), MalformedDocumentError, `${offsetSize}, ${refSize}`);
  }
});

test("the trailer's three counts are read from where Apple puts them", () => {
  // two objects, the top one the second: a reader that mixed up the object count and the top object would read the wrong one
  const data = raw({ objects: [...ascii("a"), ...ascii("b")], offsets: [8, 10], top: 1 });
  assert.equal(plistText(parsePlist(data)), "b");
});

test("a reference to the object after the last is refused even when the bytes after the table look like an offset", () => {
  // obj0 is an array of one reference, to object 2; there are two objects, so 2 is the first byte of the trailer, which
  // is here the offset of object 1
  const data = raw({ objects: [0xa1, 2, ...ascii("x")], offsets: [8, 10], unused: [10, 0, 0, 0, 0] });
  assert.throws(() => parsePlist(data), MalformedDocumentError);
});

test("an object offset that points at the first byte of the offset table is refused, not read as an object", () => {
  // the table is [8, 10]; offset 10 is the table's own first byte, 0x08, which would read as `false`
  const data = raw({ objects: [0xa1, 1], offsets: [8, 10] });
  assert.throws(() => parsePlist(data), MalformedDocumentError);
});

test("an offset below the first object is refused", () => {
  const data = raw({ objects: [0xa1, 1, ...ascii("x")], offsets: [8, 7] });
  assert.throws(() => parsePlist(data), MalformedDocumentError);
});

test("an object that declares one byte more than the objects hold is refused, not read from the offset table", () => {
  // the last object claims two characters and holds one; the next byte is the table's first, 0x08
  const data = raw({ objects: [0xa1, 1, 0x52, 0x41], offsets: [8, 10] });
  assert.throws(() => parsePlist(data), MalformedDocumentError);
  // and the same object with its two characters is read
  const whole = raw({ objects: [0xa1, 1, 0x52, 0x41, 0x42], offsets: [8, 10] });
  assert.deepEqual(items(parsePlist(whole)).map(plistText), ["AB"]);
});

test("an offset table that reaches one byte into the trailer is refused", () => {
  // two one-byte offsets starting one byte before the trailer: the second would be the trailer's first byte, here 10
  const data = raw({ objects: [0xa1, 1, ...ascii("x")], offsets: [8], table: [8], count: 2, unused: [10, 0, 0, 0, 0] });
  assert.throws(() => parsePlist(data), MalformedDocumentError);
});

test("an offset table whose entries are wider than one byte is measured in bytes, not entries", () => {
  // one two-byte offset starting one byte before the trailer: its second byte would be the trailer's first, here 8
  const data = raw({ objects: ascii("x"), offsets: [], table: [0], count: 1, offsetSize: 2, unused: [8, 0, 0, 0, 0] });
  assert.throws(() => parsePlist(data), MalformedDocumentError);
});

test("an array or dictionary whose references are not all there is refused before any of them is followed", () => {
  // Six levels that fan out 14-fold, a leaf, and then a last object whose count is two but which holds one reference
  // (the second would lie in the offset table). Following the first reference would be a limit error; the shape comes first.
  const levels = Array.from({ length: 6 }, (_, i) => array(...Array<number>(14).fill(i + 1)));
  const objects = [...levels, ascii("x")];
  assert.throws(() => parsePlist(binaryPlist([...objects, [0xa2, 0]], { top: 7 })), MalformedDocumentError);
  assert.throws(() => parsePlist(binaryPlist([...objects, [0xd1, 0]], { top: 7 })), MalformedDocumentError);
});

test("nesting is allowed to the depth cap and refused one level past it", () => {
  const chain = (arrays: number): Uint8Array => {
    // object i is an array of one reference (two bytes) to object i + 1, the last a string
    const objects: number[] = [];
    const offsets: number[] = [];
    for (let index = 0; index < arrays; index++) {
      offsets.push(8 + objects.length);
      objects.push(0xa1, ...bigEndian(index + 1, 2));
    }
    offsets.push(8 + objects.length);
    objects.push(...ascii("x"));
    return raw({ objects, offsets, offsetSize: 2, refSize: 2 });
  };
  // the leaf of 256 arrays is at depth 256
  let value: PlistValue = parsePlist(chain(256));
  for (let level = 0; level < 256; level++) value = items(value)[0]!;
  assert.equal(plistText(value), "x");
  assert.throws(() => parsePlist(chain(257)), MalformedDocumentError);
});

test("a dictionary that holds itself is malformed, not a stack overflow", () => {
  assert.throws(() => parsePlist(binaryPlist([dict(1, 0), ascii("k")])), MalformedDocumentError);
});

test("an array of a million objects is read and one more is a limit, counting the array itself", () => {
  const wide = (refs: number): Uint8Array => {
    const top = new Uint8Array(10 + refs).fill(1);
    top.set([0xaf, 0x13, ...bigEndian(refs, 8)]);
    const leaf = ascii("x");
    const objects = new Uint8Array(top.length + leaf.length);
    objects.set(top);
    objects.set(leaf, top.length);
    const header = enc.encode("bplist00");
    const table = [...bigEndian(8, 4), ...bigEndian(8 + top.length, 4)];
    const trailer = [0, 0, 0, 0, 0, 0, 4, 1, ...bigEndian(2, 8), ...bigEndian(0, 8), ...bigEndian(8 + objects.length, 8)];
    return Uint8Array.from([...header, ...objects, ...table, ...trailer]);
  };
  assert.equal(items(parsePlist(wide(999_999))).length, 999_999);
  assert.throws(() => parsePlist(wide(1_000_000)), LimitExceededError);
});

test("data that opens like a binary list but has another version is refused as one", () => {
  const data = binaryPlist([ascii("x")]);
  data[7] = 0x31;
  assert.throws(() => parsePlist(data), /binary property list version/);
  assert.throws(() => parsePlist(enc.encode("bplist")), /binary property list version/);
});

test("an XML integer may carry a plus sign and spaces, and must be only digits", () => {
  assert.equal(plistText(parsePlist(enc.encode("<plist><integer> +7 </integer></plist>"))), "7");
  assert.equal(plistText(parsePlist(enc.encode("<plist><integer>-0012</integer></plist>"))), "-12");
  for (const bad of ["12x", "x12", "1 2", "", "1.5", "--1"]) {
    assert.throws(() => parsePlist(enc.encode(`<plist><integer>${bad}</integer></plist>`)), MalformedDocumentError, bad);
  }
});

test("an XML real: NaN and the infinities in any case, exponents, a leading or trailing point; nothing else", () => {
  const real = (text: string): string => plistText(parsePlist(enc.encode(`<plist><real>${text}</real></plist>`)));
  assert.equal(real("nan"), "NaN");
  assert.equal(real("NaN"), "NaN");
  assert.equal(real("inf"), "Infinity");
  assert.equal(real("Infinity"), "Infinity");
  assert.equal(real("+INF"), "Infinity");
  assert.equal(real("-inf"), "-Infinity");
  assert.equal(real("-Infinity"), "-Infinity");
  assert.equal(real("1e5"), "100000.0");
  assert.equal(real("-1.5E-3"), "-0.0015");
  assert.equal(real(".5"), "0.5");
  assert.equal(real("5."), "5.0");
  assert.equal(real(" 2.5 "), "2.5");
  for (const bad of ["1.5abc", "abc", "", "1e", "e5", "1.2.3", "infin", "nanx", "--1"]) {
    assert.throws(() => parsePlist(enc.encode(`<plist><real>${bad}</real></plist>`)), MalformedDocumentError, bad);
  }
});

test("an XML date must be a date", () => {
  assert.throws(() => parsePlist(enc.encode("<plist><date>last tuesday</date></plist>")), MalformedDocumentError);
  assert.equal(plistText(parsePlist(enc.encode("<plist><date> 2014-06-12T18:32:21Z </date></plist>"))), "Thu Jun 12 18:32:21 UTC 2014");
});

test("an XML data element ignores the white space inside its base64", () => {
  assert.equal(plistText(parsePlist(enc.encode("<plist><data>\n  AQ\n\tI=\n</data></plist>"))), "AQI=");
});

test("an XML dictionary whose entries are not key and value pairs is refused; an unknown element is refused", () => {
  assert.throws(() => parsePlist(enc.encode("<plist><dict><string>a</string><string>b</string></dict></plist>")), MalformedDocumentError);
  assert.throws(() => parsePlist(enc.encode("<plist><dict><key>a</key><key>b</key></dict></plist>")), MalformedDocumentError);
  assert.throws(() => parsePlist(enc.encode("<plist><foo/></plist>")), MalformedDocumentError);
});

test("an XML list is its plist element's first child, and true and false are told apart", () => {
  assert.equal(plistText(parsePlist(enc.encode("<plist><string>first</string><string>second</string></plist>"))), "first");
  assert.equal(plistText(parsePlist(enc.encode("<plist><true/></plist>"))), "true");
  assert.equal(plistText(parsePlist(enc.encode("<plist><false/></plist>"))), "false");
});

test("a list of several entries is written with a comma and a space between them, a dictionary as key=value", () => {
  const xml = "<plist><dict><key>a</key><integer>1</integer><key>b</key><array><integer>2</integer><integer>3</integer></array></dict></plist>";
  assert.equal(plistText(parsePlist(enc.encode(xml))), "{a=1, b=[2, 3]}");
  assert.equal(plistText({ kind: "uid", value: 9n }), "9");
  assert.equal(plistText({ kind: "data", value: Uint8Array.of(0xfb, 0xff) }), "+/8=");
});

test("an XML list of a million objects is read and one more is a limit", () => {
  const wide = (children: number): Uint8Array => enc.encode(`<plist><array>${"<true/>".repeat(children)}</array></plist>`);
  assert.equal(items(parsePlist(wide(999_999))).length, 999_999);
  assert.throws(() => parsePlist(wide(1_000_000)), LimitExceededError);
});

test("a date is written as Java's Date.toString writes it, in UTC: every weekday and month, padded fields", () => {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
  const two = (value: number): string => String(value).padStart(2, "0");
  for (let day = 0; day < 366; day++) {
    const date = new Date(Date.UTC(2024, 0, 1 + day, day % 24, (day * 7) % 60, (day * 13) % 60));
    const expected = `${weekday.format(date)} ${month.format(date)} ${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC ${date.getUTCFullYear()}`;
    assert.equal(plistText({ kind: "date", value: date }), expected);
  }
  assert.equal(plistText({ kind: "date", value: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)) }), "Tue Jan 02 03:04:05 UTC 2024");
});

test("a date that is not a time is written as NaN rather than as invalid text", () => {
  assert.equal(plistText({ kind: "date", value: new Date(Number.NaN) }), "NaN");
});

test("an Apple time of one millisecond before 2001-01-01 is the last second of 2000", () => {
  // the epoch is exactly 978307200000 ms: a millisecond either way moves this date across a second
  assert.equal(plistText(parsePlist(binaryPlist([[0x33, ...float64(-0.001)]]))), "Sun Dec 31 23:59:59 UTC 2000");
});

/** The message of the MalformedDocumentError a parse throws: each refusal of the binary format says what is wrong. */
function refusal(data: Uint8Array): string {
  try {
    parsePlist(data);
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError, String(error));
    return error.message;
  }
  return assert.fail("the property list was read");
}

test("each bound of the binary header is refused for its own reason, and only at its exact value", () => {
  // the file is 8 + 1 + 1 + 32 = 42 bytes: a trailer field above that is refused as such, not by what it would do next
  assert.match(refusal(Uint8Array.from([...enc.encode("bplist00"), ...Array<number>(32).fill(0)])), /shorter than its trailer/);
  assert.match(refusal(raw({ objects: [0x08], offsets: [8], offsetSize: 0 })), /offset size/);
  assert.match(refusal(raw({ objects: [0x08], offsets: [8], count: 43 })), /trailer field/);
  assert.match(refusal(raw({ objects: [0x08], offsets: [8], top: 43 })), /trailer field/);
  assert.match(refusal(raw({ objects: [0x08], offsets: [8], tableOffset: 43 })), /trailer field/);
  // a top object just past the last one, and an offset table that starts inside the header
  assert.match(refusal(raw({ objects: [0x08], offsets: [8], top: 1 })), /count or top object/);
  assert.match(refusal(raw({ objects: [0x08], offsets: [8], tableOffset: 7 })), /offset table is outside/);
  // an object that starts on the header's last byte
  assert.match(refusal(raw({ objects: [0x08], offsets: [7] })), /object offset is outside/);
  // a length of 50 in a file of 44 bytes
  assert.match(refusal(raw({ objects: [0xaf, 0x10, 50], offsets: [8] })), /larger than the file/);
});
