import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { parsePlist, plistText, type PlistValue } from "../src/plist.ts";
import { array, ascii, binaryPlist, dict } from "./plist-builder.ts";

/*
 * The property-list reader behind the iWork package parsers. Tika reads these files with dd-plist's
 * PropertyListParser, which takes binary (bplist00) and XML lists; the layouts here are Apple's published ones, and the
 * binary lists are built by hand in plist-builder.ts. Nothing was run against a Tika.
 */

const enc = new TextEncoder();

function asDict(value: PlistValue): ReadonlyMap<string, PlistValue> {
  assert.equal(value.kind, "dict");
  return (value as Extract<PlistValue, { kind: "dict" }>).value;
}

test("a binary dictionary of strings is read with its keys", () => {
  const value = parsePlist(binaryPlist([dict(1, 2), ascii("name"), ascii("Ada")]));
  assert.deepEqual([...asDict(value)].map(([key, v]) => [key, plistText(v)]), [["name", "Ada"]]);
});

test("binary integers of every width, reals, booleans, a date, data, a UID and a UTF-16 string", () => {
  const value = parsePlist(
    binaryPlist([
      array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
      [0x10, 200],
      [0x11, 0x01, 0x00],
      [0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe],
      [0x23, ...new Uint8Array(new Float64Array([2.5]).buffer).reverse()],
      [0x09],
      [0x08],
      [0x33, ...new Uint8Array(new Float64Array([0]).buffer).reverse()],
      [0x42, 1, 2],
      [0x80, 7],
      [0x61, 0x00, 0x41],
      [0x60 | 0x2, 0x00, 0x42, 0x00, 0x43],
    ]),
  );
  assert.equal(value.kind, "array");
  const items = (value as Extract<PlistValue, { kind: "array" }>).value;
  assert.deepEqual(items.map(plistText), [
    "200",
    "256",
    "-2",
    "2.5",
    "true",
    "false",
    "Mon Jan 01 00:00:00 UTC 2001",
    "AQI=",
    "7",
    "A",
    "BC",
  ]);
});

test("a string longer than 14 characters carries its length as an integer object", () => {
  const text = "a fairly long string";
  const value = parsePlist(binaryPlist([[0x5f, 0x10, text.length, ...enc.encode(text)]]));
  assert.equal(plistText(value), text);
});

test("an XML array of strings, as BuildVersionHistory.plist is written", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<string>Template: White (2015-09-16 11:52)</string>
	<string>T2.6.1 (2180)</string>
</array>
</plist>`;
  const value = parsePlist(enc.encode(xml));
  assert.equal(value.kind, "array");
  assert.deepEqual((value as Extract<PlistValue, { kind: "array" }>).value.map(plistText), ["Template: White (2015-09-16 11:52)", "T2.6.1 (2180)"]);
});

test("an XML dictionary with every scalar kind", () => {
  const xml = `<plist version="1.0"><dict>
    <key>s</key><string>text &amp; more</string><key>i</key><integer>-12</integer><key>r</key><real>0.5</real>
    <key>t</key><true/><key>f</key><false/><key>d</key><date>2014-06-12T18:32:21Z</date><key>b</key><data>AQI=</data>
    <key>e</key><string/></dict></plist>`;
  const entries = [...asDict(parsePlist(enc.encode(xml)))].map(([key, v]) => [key, plistText(v)]);
  assert.deepEqual(entries, [
    ["s", "text & more"],
    ["i", "-12"],
    ["r", "0.5"],
    ["t", "true"],
    ["f", "false"],
    ["d", "Thu Jun 12 18:32:21 UTC 2014"],
    ["b", "AQI="],
    ["e", ""],
  ]);
});

test("values nest, and are written as Java writes a List and a Map", () => {
  const value = parsePlist(enc.encode("<plist><dict><key>k</key><array><string>a</string><integer>1</integer></array></dict></plist>"));
  assert.equal(plistText(value), "{k=[a, 1]}");
});

test("a real is written as Java's Double.toString writes it, an integer without a point", () => {
  assert.equal(plistText({ kind: "real", value: 5 }), "5.0");
  assert.equal(plistText({ kind: "integer", value: 5n }), "5");
});

test("a null object has no text, as Tika's toString on it would fail", () => {
  assert.throws(() => plistText(parsePlist(binaryPlist([[0x00]]))), MalformedDocumentError);
});

test("every prefix of a valid binary or XML list parses or is malformed", () => {
  const valid = [
    binaryPlist([dict(1, 2), ascii("name"), ascii("Ada")]),
    enc.encode("<plist><dict><key>k</key><string>v</string></dict></plist>"),
  ];
  for (const data of valid) {
    for (let length = 0; length <= data.byteLength; length++) {
      try {
        parsePlist(data.subarray(0, length));
      } catch (error) {
        assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes threw ${String(error)}`);
      }
    }
    parsePlist(data);
  }
});

test("an array that declares more references than the file has bytes is malformed, and is not allocated by the count", () => {
  assert.throws(() => parsePlist(binaryPlist([[0xaf, 0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]])), MalformedDocumentError);
  assert.throws(() => parsePlist(binaryPlist([[0xaf, 0x10, 200]])), MalformedDocumentError);
});

test("a string whose declared length runs past the file is malformed", () => {
  assert.throws(() => parsePlist(binaryPlist([[0x5f, 0x10, 200, 0x41]])), MalformedDocumentError);
});

test("an array that holds itself is malformed, not a stack overflow", () => {
  assert.throws(() => parsePlist(binaryPlist([array(0)])), MalformedDocumentError);
});

test("references that fan out into more than the node cap are refused", () => {
  // Level n holds 14 references to level n+1: 14^6 expansions from a few hundred bytes.
  const levels = Array.from({ length: 6 }, (_, i) => array(...Array<number>(14).fill(i + 1)));
  assert.throws(() => parsePlist(binaryPlist([...levels, ascii("x")])), LimitExceededError);
});

test("a trailer that is out of range is malformed", () => {
  const good = binaryPlist([ascii("x")]);
  const withTrailer = (patch: (data: Uint8Array) => void): Uint8Array => {
    const data = good.slice();
    patch(data);
    return data;
  };
  const length = good.byteLength;
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 26] = 0))), MalformedDocumentError);
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 26] = 9))), MalformedDocumentError);
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 25] = 0))), MalformedDocumentError);
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 9] = 5))), MalformedDocumentError, "top object past the objects");
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 17] = 5))), MalformedDocumentError, "more objects than the table holds");
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 24] = 0xff))), MalformedDocumentError, "huge object count");
  assert.throws(() => parsePlist(withTrailer((d) => (d[length - 1] = 0xff))), MalformedDocumentError, "offset table past the file");
});

test("an object offset that points outside the objects is malformed", () => {
  const data = binaryPlist([ascii("x")]);
  data[data.byteLength - 32 - 1] = 0xf0;
  assert.throws(() => parsePlist(data), MalformedDocumentError);
});

test("an unknown binary version and an unknown marker are malformed", () => {
  const data = binaryPlist([ascii("x")]);
  data[6] = 0x34;
  assert.throws(() => parsePlist(data), MalformedDocumentError);
  assert.throws(() => parsePlist(binaryPlist([[0x70]])), MalformedDocumentError);
});

test("XML that nests past the depth cap is malformed", () => {
  const deep = "<array>".repeat(1000) + "</array>".repeat(1000);
  assert.throws(() => parsePlist(enc.encode(`<plist>${deep}</plist>`)), MalformedDocumentError);
});

test("XML that is not a property list, or is cut short, is malformed", () => {
  for (const xml of ["", "<plist/>", "<html/>", "<plist><dict><key>k</key></dict></plist>", "<plist><integer>abc</integer></plist>", "<plist><array>"]) {
    assert.throws(() => parsePlist(enc.encode(xml)), MalformedDocumentError, xml);
  }
});

test("an entity the document defines is not expanded", () => {
  const xml = `<!DOCTYPE plist [<!ENTITY a "AAAA">]><plist><string>&a;</string></plist>`;
  assert.throws(() => parsePlist(enc.encode(xml)), MalformedDocumentError);
});
