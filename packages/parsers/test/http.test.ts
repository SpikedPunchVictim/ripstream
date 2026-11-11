import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, CONTEXT_KEYS, MediaType, Metadata, ParseContext, RipstreamInputStream, type EmbeddedDocumentExtractor } from "@spikedpunch/ripstream-core";
import { HttpParser, createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * Tika's HttpParser (tika-parser-webarchive-module). It reads an HTTP response with jwarc's lenient parser, ignores every header
 * but Content-Length (updateMetadata is an empty TODO), and when Content-Length is above 0 parses that many bytes after the
 * headers as an embedded document with a fresh Metadata. HttpParserTest reads the http-response fixture (LF line ends,
 * "Content-Length: 136", an HTML body) and expects two documents, the container's Content-Type to be exactly
 * application/x-httpresponse, and "this is some content" in the second. The responses below have the shape of that file.
 * Read from Tika source, not run against a Tika; jwarc's own source is not in the Tika tree.
 */

const encoder = new TextEncoder();
const ripstream = createRipstream();

const BODY =
  '<html>\n <head>\n <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>\n </head>\n <body>this is some content</body>\n</html>';

/** A response with the given headers (Content-Length of the body by default), its status line and line ending. */
function response(
  body: string,
  options: { headers?: readonly string[]; eol?: string; status?: string } = {},
): string {
  const eol = options.eol ?? "\n";
  const headers = options.headers ?? ["Content-Type: text/html; charset=UTF-8", `Content-Length: ${encoder.encode(body).length}`];
  return [options.status ?? "HTTP/1.1 200 OK", ...headers, "", body].join(eol);
}

async function parseDirect(text: string, parser: HttpParser = new HttpParser()): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(encoder.encode(text));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

function malformed(error: Error): boolean {
  return error.name === "MalformedDocumentError";
}

test("the HTTP parser claims application/x-httpresponse, and the default registry sends it there, not to the text parser", async () => {
  assert.deepEqual([...(await new HttpParser().getSupportedTypes())].map(String), ["application/x-httpresponse"]);
  const [first] = await createDefaultParser().selectParsers(MediaType.parseOrThrow("application/x-httpresponse"), new ParseContext());
  assert.equal(first?.parser.name, "HttpParser");
  assert.equal(first?.kind, "exact");
});

test("a response is two documents, the container keeps its bare type and the body's text is read, as HttpParserTest expects", async () => {
  const records = await ripstream.parseRecursive(encoder.encode(response(BODY)), { filename: "http-response" });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.metadata.get("Content-Type"), "application/x-httpresponse");
  assert.match(records[1]?.content ?? "", /this is some content/);
});

test("a response through the whole library is written as one text, with no header in it and no charset on the type", async () => {
  const result = await ripstream.parse(encoder.encode(response(BODY)), { filename: "http-response" });
  assert.equal(result.metadata.get("Content-Type"), "application/x-httpresponse");
  assert.match(result.text, /this is some content/);
  assert.doesNotMatch(result.text, /Content-Length|HTTP\/1\.1|Cache-Control/);
});

test("the headers set no metadata: not the Content-Type of the response, nor its length", async () => {
  const { metadata } = await parseDirect(response("", { headers: ["Content-Type: text/html", "X-Powered-By: ASP.NET", "Content-Length: 0"] }));
  assert.deepEqual(metadata.names(), []);
});

test("the container's text is empty: only the payload is written", async () => {
  const { text } = await parseDirect(response("", { headers: ["Server: nginx"] }));
  assert.equal(text.trim(), "");
});

test("CRLF, LF and mixed line ends all end the headers", async () => {
  for (const eol of ["\r\n", "\n"]) {
    const records = await ripstream.parseRecursive(encoder.encode(response(BODY, { eol })), { filename: "x" });
    assert.match(records[1]?.content ?? "", /this is some content/, JSON.stringify(eol));
  }
  const body = "plain words in the body";
  const mixed = `HTTP/1.1 200 OK\r\nServer: x\nContent-Length: ${body.length}\r\n\n${body}`;
  const records = await ripstream.parseRecursive(encoder.encode(mixed), { filename: "x" });
  assert.match(records[1]?.content ?? "", /plain words in the body/);
});

test("a status line without the version is accepted, as in the LWP-style capture of Tika's EMLXDetectionTest", async () => {
  const body = "the capture body";
  const capture = response(body, { status: "200 OK", headers: ["Date: Thu, 08 Aug 2002 10:44:35 GMT", `Content-Length: ${body.length}`] });
  const records = await ripstream.parseRecursive(encoder.encode(capture), { filename: "capture" });
  assert.match(records[1]?.content ?? "", /the capture body/);
});

test("the payload is exactly Content-Length bytes: what follows is not read, and a short body is read as far as it goes", async () => {
  const cut = response("0123456789 and then more words", { headers: ["Content-Length: 10"] });
  const long = await ripstream.parseRecursive(encoder.encode(cut), { filename: "x" });
  assert.match(long[1]?.content ?? "", /0123456789/);
  assert.doesNotMatch(long[1]?.content ?? "", /more words/);
  const short = await ripstream.parseRecursive(encoder.encode(response("only these words", { headers: ["Content-Length: 5000"] })), { filename: "x" });
  assert.match(short[1]?.content ?? "", /only these words/);
});

test("the headers end at the first empty line: an extra blank line after it belongs to the payload", async () => {
  // The Tika fixture has "Content-Length: 136" and then two empty lines before the HTML. The body after the first one is 137
  // bytes, so a reader that ends the headers there reads 136 of them. Whether jwarc does is not known.
  const body = "\nhello after a blank line";
  const records = await ripstream.parseRecursive(encoder.encode(response(body, { headers: [`Content-Length: ${body.length}`] })), { filename: "x" });
  assert.match(records[1]?.content ?? "", /hello after a blank line/);
});

test("Content-Length is found whatever the case of its name, with spaces around the value", async () => {
  const body = "found by a lower case name";
  const records = await ripstream.parseRecursive(
    // The detector needs a header it knows (Content-Type) to call this an HTTP response; Content-Length alone is not enough.
    encoder.encode(response(body, { headers: ["Content-Type: text/plain", `content-length:   ${body.length}  `] })),
    { filename: "x" },
  );
  assert.match(records[1]?.content ?? "", /found by a lower case name/);
});

test("a response with no Content-Length, or one that is 0 or negative, has no payload: Tika has no way to read a body of no known length", async () => {
  for (const headers of [["Server: x"], ["Content-Length: 0"], ["Content-Length: -5"]]) {
    const records = await ripstream.parseRecursive(encoder.encode(response("this body is not read", { headers })), { filename: "x" });
    assert.equal(records.length, 1, headers.join());
    assert.doesNotMatch(records[0]?.content ?? "", /not read/, headers.join());
  }
});

test("Java's Long.parseLong takes a plus sign and leading zeros", async () => {
  const body = "a plus sign";
  const records = await ripstream.parseRecursive(
    encoder.encode(response(body, { headers: [`Content-Length: +00${body.length}`] })),
    { filename: "x" },
  );
  assert.match(records[1]?.content ?? "", /a plus sign/);
});

test("a Content-Length that Long.parseLong rejects is a MalformedDocumentError, as the NumberFormatException ends Tika's parse", async () => {
  for (const value of ["abc", "", "12abc", "0x10", "1.5", "9223372036854775808", "-9223372036854775809"]) {
    await assert.rejects(parseDirect(response("x", { headers: [`Content-Length: ${value}`] })), malformed, JSON.stringify(value));
  }
});

test("two Content-Length headers are a MalformedDocumentError: jwarc's sole() is taken to refuse a repeated header", async () => {
  // Not verified against jwarc's source: sole() is believed to throw when the header occurs twice.
  await assert.rejects(parseDirect(response("x", { headers: ["Content-Length: 1", "Content-Length: 1"] })), malformed);
});

test("an empty input is a MalformedDocumentError, as the first read's EOFException ends Tika's parse", async () => {
  await assert.rejects(parseDirect(""), malformed);
});

test("headers with no empty line after them are a MalformedDocumentError", async () => {
  await assert.rejects(parseDirect("HTTP/1.1 200 OK\nServer: x\nContent-Length: 4"), malformed);
});

test("a first line that is no status line is a MalformedDocumentError", async () => {
  for (const first of ["hello world", "HTTP/1.1", "HTTP/ 200 OK", "20 OK", "2000 OK", "HTTP/1.1200 OK", ""]) {
    await assert.rejects(parseDirect(`${first}\nServer: x\n\n`), malformed, JSON.stringify(first));
  }
});

test("a status line may have no reason phrase, and a header line with no colon is skipped", async () => {
  const { text } = await parseDirect("HTTP/1.1 204\njunk with no colon\nServer: x\n\n");
  assert.equal(text.trim(), "");
});

test("hostile: a header block that never ends is a LimitExceededError at the cap, not a buffer of the whole input", async () => {
  await assert.rejects(
    parseDirect(`HTTP/1.1 200 OK\nX-Long: ${"a".repeat(2_000_000)}`),
    (error: Error) => error.name === "LimitExceededError",
  );
  await assert.rejects(
    parseDirect(`HTTP/1.1 200 OK\n${"X: y\n".repeat(1_000)}\n`, new HttpParser({ maxHeaderBytes: 1_000 })),
    (error: Error) => error.name === "LimitExceededError",
  );
});

test("hostile: a header block of many lines under the cap is read in time and in memory", async () => {
  const started = performance.now();
  const { text } = await parseDirect(`HTTP/1.1 200 OK\n${"X: y\n".repeat(150_000)}\n`);
  assert.equal(text.trim(), "");
  assert.ok(performance.now() - started < 10_000, "the parse took too long");
});

test("hostile: a Content-Length of 2^63-1 over a small body reads the body and allocates nothing for the rest", async () => {
  const records = await ripstream.parseRecursive(
    encoder.encode(response("a small body", { headers: ["Content-Length: 9223372036854775807"] })),
    { filename: "x" },
  );
  assert.match(records[1]?.content ?? "", /a small body/);
});

test("hostile: a payload over the embedded size limit is a LimitExceededError, not a read of all of it", async () => {
  const body = "word ".repeat(40_000);
  await assert.rejects(
    ripstream.parse(encoder.encode(response(body)), { filename: "big", limits: { maxEmbeddedResourceBytes: 10_000 } }),
    (error: Error) => error.name === "LimitExceededError",
  );
});

test("hostile: responses inside responses are bounded by the embedded depth limit", async () => {
  let body = "the innermost words";
  for (let level = 0; level < 300; level++) {
    body = response(body, { headers: ["Content-Type: text/plain", `Content-Length: ${encoder.encode(body).length}`] });
  }
  await assert.rejects(
    ripstream.parse(encoder.encode(body), { filename: "nested" }),
    (error: Error) => error.name === "LimitExceededError",
  );
});

test("hostile: text of a payload is bounded by the output limit", async () => {
  const body = "x".repeat(5_000_000);
  await assert.rejects(
    ripstream.parse(encoder.encode(response(body)), { filename: "big", limits: { maxOutputChars: 10_000 } }),
    (error: Error) => error.name === "LimitExceededError" || error.name === "WriteLimitReachedError",
  );
});

test("the header cap is inclusive: headers of exactly maxHeaderBytes are read, one byte more is a limit", async () => {
  const headers = "HTTP/1.1 200 OK\nContent-Length: 0\n\n";
  await parseDirect(headers, new HttpParser({ maxHeaderBytes: headers.length }));
  await assert.rejects(
    parseDirect(headers, new HttpParser({ maxHeaderBytes: headers.length - 1 })),
    (error: Error) => error.name === "LimitExceededError",
  );
});

test("a tab around the Content-Length value is trimmed like a space", async () => {
  const body = "found by a tab padded length";
  for (const padded of [`\t${body.length}`, `${body.length}\t`, `\t${body.length}\t`]) {
    const records = await ripstream.parseRecursive(
      encoder.encode(response(body, { headers: ["Content-Type: text/plain", `Content-Length:${padded}`] })),
      { filename: "x" },
    );
    assert.match(records[1]?.content ?? "", /found by a tab padded length/, JSON.stringify(padded));
  }
});

test("the payload is offered to the extractor with a fresh Metadata, and an extractor that refuses it parses nothing", async () => {
  const offered: string[][] = [];
  let parsed = 0;
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: (metadata) => {
      offered.push(metadata.names());
      return false;
    },
    parseEmbedded: async () => {
      parsed++;
    },
  };
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(encoder.encode(response(BODY)));
  try {
    await new HttpParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  } finally {
    await stream.close();
  }
  assert.deepEqual(offered, [[]]);
  assert.equal(parsed, 0);
});
