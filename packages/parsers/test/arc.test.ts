import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { arcHttpBody, isArc, readArcRecords } from "../src/arc.ts";

// The ARC reader follows the published format (Tika hands ARC to jwarc, whose source is not in the Tika tree). These
// tests pin each rule of it: header fields, lengths, separators, the size cap and the HTTP body split.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const read = (text: string) => [...readArcRecords(bytes(text))].map((r) => ({ ...r, body: decoder.decode(r.body) }));

test("each record gives its url, its content type (the fourth field) and exactly its declared body", () => {
  const records = read("http://a.test/ 1.2.3.4 20050614070151 text/html 5\nhello\nhttp://b.test/ 5.6.7.8 20050614070152 image/png 3\nabc\n");
  assert.deepEqual(records, [
    { url: "http://a.test/", contentType: "text/html", body: "hello" },
    { url: "http://b.test/", contentType: "image/png", body: "abc" },
  ]);
});

test("a version 2 header with extra fields is read: the length is the last field and the type the fourth", () => {
  const records = read("http://a.test/ 1.2.3.4 20050614070151 text/html 200 abc123 4096 a.arc 5\nhello\n");
  assert.deepEqual(records, [{ url: "http://a.test/", contentType: "text/html", body: "hello" }]);
});

test("records may be separated by CRLF or blank lines", () => {
  const records = read("http://a.test/ 1 2 t/a 1\nx\r\n\r\n\nhttp://b.test/ 1 2 t/b 1\ny\r\n");
  assert.deepEqual(
    records.map((r) => r.body),
    ["x", "y"],
  );
});

test("a header line that ends in CRLF is read", () => {
  assert.deepEqual(read("http://a.test/ 1 2 t/a 2\r\nhi\n").map((r) => r.body), ["hi"]);
});

test("a body that runs past the data is clamped to the bytes present", () => {
  assert.deepEqual(read("http://a.test/ 1 2 t/a 100\nshort").map((r) => r.body), ["short"]);
});

test("a header with fewer than five fields is refused", () => {
  assert.throws(() => read("http://a.test/ 1 2 5\nhello\n"), /Invalid ARC record header/);
});

test("a length that is not all digits is refused as a bad header", () => {
  for (const length of ["12abc", "1e3", "-5", "0x10"]) {
    assert.throws(() => read(`http://a.test/ 1 2 t/a ${length}\nhello\n`), /Invalid ARC record header/, length);
  }
});

test("a length beyond the safe integers is refused as a bad length", () => {
  assert.throws(() => read("http://a.test/ 1 2 t/a 99999999999999999999\nhello\n"), /Invalid ARC record length/);
});

test("a header line is read up to the 64 KiB cap and no further", () => {
  const tail = " 1 2 t/a 2";
  const header = (lineLength: number): string => `${"u".repeat(lineLength - tail.length)}${tail}\nhi\n`;
  assert.deepEqual(read(header(65_535)).map((r) => r.body), ["hi"]);
  assert.throws(() => read(header(65_536)), MalformedDocumentError);
});

test("a header with no end of line is refused", () => {
  assert.throws(() => read("http://a.test/ 1 2 t/a 5"), MalformedDocumentError);
});

test("isArc is true only when the data opens with filedesc://", () => {
  assert.equal(isArc(bytes("filedesc://x.arc 0.0.0.0 1 text/plain 0\n")), true);
  assert.equal(isArc(bytes("filedesc://")), true);
  assert.equal(isArc(bytes("filedesc:/")), false);
  assert.equal(isArc(bytes("fXXXXXXXXXX")), false);
  assert.equal(isArc(bytes("XXXXXXXXXXX")), false);
  assert.equal(isArc(bytes("")), false);
  assert.equal(isArc(bytes("WARC/1.0\r\n")), false);
});

test("the HTTP body starts after a blank line, which is a bare newline or a CRLF", () => {
  const body = (text: string): string => decoder.decode(arcHttpBody(bytes(text)));
  assert.equal(body("HTTP/1.1 200 OK\nContent-Type: text/html\n\nBODY"), "BODY");
  assert.equal(body("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nBODY"), "BODY");
});

test("an HTTP response with no blank line, or nothing after it, has no body", () => {
  const body = (text: string): string => decoder.decode(arcHttpBody(bytes(text)));
  assert.equal(body("HTTP/1.1 200 OK\nContent-Type: text/html\n"), "");
  assert.equal(body("HTTP/1.1 200 OK\n\n"), "");
  assert.equal(body("HTTP/1.1 200 OK\r\n\r\n"), "");
  assert.equal(body(""), "");
});
