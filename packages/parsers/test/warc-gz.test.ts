import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

// Tika's WARCParserTest parses cc.warc.gz, testWARC_multiple.warc(.gz), testARC.arc and example.arc.gz through
// WARCParser, which claims application/warc, application/warc+gz, application/x-internet-archive and
// application/arc+gz. The fixtures here are built in the test; the structure follows those files.

const ripstream = createRipstream();
const encoder = new TextEncoder();

function warcRecord(type: string, uri: string, payload: string): string {
  return `WARC/1.0\r\nWARC-Type: ${type}\r\nWARC-Target-URI: ${uri}\r\nContent-Length: ${payload.length}\r\n\r\n${payload}\r\n\r\n`;
}

const WARC =
  warcRecord("warcinfo", "https://info.test", "software: test") +
  warcRecord("response", "https://one.test", "first page content") +
  warcRecord("response", "https://two.test", "second page content");

/** One gzip member per record, as crawlers write them. */
function gzipPerRecord(records: readonly string[]): Uint8Array {
  return Buffer.concat(records.map((record) => gzipSync(encoder.encode(record))));
}

function arcRecord(url: string, mediaType: string, body: string): string {
  return `${url} 127.0.0.1 20050614070151 ${mediaType} ${body.length}\n${body}\n`;
}

const ARC_VERSION_BLOCK = "1 1 InternetArchive\nURL IP-address Archive-date Content-type Archive-length\n";
const ARC =
  `filedesc://example.arc 0.0.0.0 20050614070144 text/plain ${ARC_VERSION_BLOCK.length}\n${ARC_VERSION_BLOCK}\n` +
  arcRecord("dns:www.example.test", "text/dns", "20050614070144\nwww.example.test.\t\t6858\tIN\tA\t152.91.15.12\n") +
  arcRecord(
    "http://www.example.test/robots.txt",
    "text/html",
    "HTTP/1.1 302 Found\nLocation: http://www.example.test/\n\n<HTML><BODY>The document has moved here.</BODY></HTML>\n",
  );

test("a .warc.gz is detected as application/warc+gz and its records are parsed", async () => {
  const result = await ripstream.parse(gzipSync(encoder.encode(WARC)), { filename: "archive.warc.gz" });
  assert.equal(result.metadata.get("Content-Type"), "application/warc+gz");
  assert.match(result.text, /first page content/);
  assert.match(result.text, /second page content/);
  assert.match(result.text, /https:\/\/two\.test/);
});

test("warc.gz parses to the same text as the plain warc", async () => {
  // Tika's testMultipleRecords compares testWARC_multiple.warc with testWARC_multiple.warc.gz.
  const plain = await ripstream.parse(encoder.encode(WARC), { filename: "archive.warc" });
  const zipped = await ripstream.parse(gzipSync(encoder.encode(WARC)), { filename: "archive.warc.gz" });
  assert.equal(zipped.text, plain.text);
});

test("a warc.gz written as one gzip member per record is read through every member", async () => {
  const records = [
    warcRecord("response", "https://one.test", "first page content"),
    warcRecord("response", "https://two.test", "second page content"),
  ];
  const result = await ripstream.parse(gzipPerRecord(records), { filename: "archive.warc.gz" });
  assert.match(result.text, /first page content/);
  assert.match(result.text, /second page content/);
});

test("an .arc is detected as application/x-internet-archive and its http response is parsed", async () => {
  const result = await ripstream.parse(encoder.encode(ARC), { filename: "example.arc" });
  assert.equal(result.metadata.get("Content-Type"), "application/x-internet-archive");
  assert.match(result.text, /The document has moved here/);
  assert.match(result.text, /http:\/\/www\.example\.test\/robots\.txt/);
});

test("an ARC record that is not an http response (version block, dns) is not parsed as a document", async () => {
  // Tika's testARC: three records, and only the http one becomes an embedded document.
  const result = await ripstream.parse(encoder.encode(ARC), { filename: "example.arc" });
  assert.doesNotMatch(result.text, /152\.91\.15\.12/);
  assert.doesNotMatch(result.text, /InternetArchive/);
  // Skipped means no record wrapper either: the url of a skipped record is not written.
  assert.doesNotMatch(result.text, /dns:www\.example\.test/);
  assert.doesNotMatch(result.text, /filedesc:/);
});

test("an ARC record is an http response only when its body opens with HTTP/n.n", async () => {
  const arc =
    `filedesc://x.arc 0.0.0.0 20050614070144 text/plain 0\n\n` +
    arcRecord("http://not-http.test/", "text/plain", "xx HTTP/1.1 200 OK\n\nhidden words") +
    arcRecord("http://is-http.test/", "text/plain", "HTTP/1.1 200 OK\n\nshown words");
  const result = await ripstream.parse(encoder.encode(arc), { filename: "x.arc" });
  assert.match(result.text, /is-http\.test/);
  assert.doesNotMatch(result.text, /not-http\.test/);
});

test("an ARC http response with no body is still listed by its url", async () => {
  const arc =
    `filedesc://x.arc 0.0.0.0 20050614070144 text/plain 0\n\n` +
    arcRecord("http://empty.test/", "text/html", "HTTP/1.1 204 No Content\n\n");
  const result = await ripstream.parse(encoder.encode(arc), { filename: "x.arc" });
  assert.match(result.text, /empty\.test/);
});

test("data is gunzipped only when both gzip magic bytes are there", async () => {
  // 0x1f 0x00 and 0x00 0x8b are each one magic byte short: they are read as a plain WARC, not inflated.
  for (const head of [[0x1f, 0x00], [0x00, 0x8b]]) {
    const outcome = await ripstream
      .parse(Uint8Array.from([...head, ...encoder.encode(WARC)]), { filename: "x.warc", contentType: "application/warc" })
      .then(() => "", (error: unknown) => String(error));
    assert.doesNotMatch(outcome, /gzip/i, head.join(","));
  }
});

test("an .arc.gz is detected as application/arc+gz and its http response is parsed", async () => {
  const result = await ripstream.parse(gzipSync(encoder.encode(ARC)), { filename: "example.arc.gz" });
  assert.equal(result.metadata.get("Content-Type"), "application/arc+gz");
  assert.match(result.text, /The document has moved here/);
});

test("every prefix of an arc.gz parses or is refused as malformed", { timeout: 60_000 }, async () => {
  const valid = gzipSync(encoder.encode(ARC));
  for (let length = 0; length <= valid.byteLength; length++) {
    try {
      await ripstream.parse(valid.subarray(0, length), { filename: "example.arc.gz", contentType: "application/arc+gz" });
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
    }
  }
});

test("every prefix of a plain ARC parses or is refused as malformed", { timeout: 60_000 }, async () => {
  const valid = encoder.encode(ARC);
  for (let length = 0; length <= valid.byteLength; length++) {
    try {
      await ripstream.parse(valid.subarray(0, length), { filename: "example.arc", contentType: "application/x-internet-archive" });
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes: ${String(error)}`);
    }
  }
});

test("an ARC record header without a length is refused as malformed", async () => {
  const bad = "filedesc://x.arc 0.0.0.0 20050614070144 text/plain notanumber\nbody\n";
  await assert.rejects(
    ripstream.parse(encoder.encode(bad), { filename: "x.arc", contentType: "application/x-internet-archive" }),
    MalformedDocumentError,
  );
});

test("a gzip bomb inside a warc.gz fails with LimitExceededError at the output cap", async () => {
  const bomb = gzipSync(new Uint8Array(1_000_000));
  await assert.rejects(
    ripstream.parse(bomb, {
      filename: "bomb.warc.gz",
      contentType: "application/warc+gz",
      limits: { maxEmbeddedResourceBytes: 100_000, maxDecompressionRatio: 1e9 },
    }),
    // The inflate itself must trip; "No parser available" is also a LimitExceededError and would hide a missing claim.
    (error: unknown) => error instanceof LimitExceededError && /gzip data exceeds/.test(error.message),
  );
});

test("a gzip bomb inside an arc.gz fails with LimitExceededError at the output cap", async () => {
  const bomb = gzipSync(Buffer.concat([encoder.encode("filedesc://b.arc 0.0.0.0 20050614070144 text/plain 4\nabcd\n"), new Uint8Array(1_000_000)]));
  await assert.rejects(
    ripstream.parse(bomb, {
      filename: "bomb.arc.gz",
      contentType: "application/arc+gz",
      limits: { maxEmbeddedResourceBytes: 100_000, maxDecompressionRatio: 1e9 },
    }),
    // The inflate itself must trip; "No parser available" is also a LimitExceededError and would hide a missing claim.
    (error: unknown) => error instanceof LimitExceededError && /gzip data exceeds/.test(error.message),
  );
});

test("a record header that never ends is refused rather than scanned without bound", { timeout: 10_000 }, async () => {
  const hostile = encoder.encode(`filedesc://${"a".repeat(2_000_000)}`);
  await assert.rejects(
    ripstream.parse(hostile, { filename: "x.arc", contentType: "application/x-internet-archive" }),
    MalformedDocumentError,
  );
});
