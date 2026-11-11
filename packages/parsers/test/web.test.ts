import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream, createOutputHandler } from "@spikedpunch/ripstream-core";
import { XliffParser, createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();

test("parses a WARC record payload", async () => {
  const payload = "hello warc";
  const warc = `WARC/1.0\r\nWARC-Type: response\r\nWARC-Target-URI: https://example.test\r\nContent-Length: ${payload.length}\r\n\r\n${payload}\r\n\r\n`;
  const result = await ripstream.parse(encoder.encode(warc), { filename: "archive.warc" });
  assert.match(result.text, /hello warc/);
  assert.match(result.text, /https:\/\/example\.test/);
});

test("parses XLIFF translation units", async () => {
  const xliff = `<xliff version="1.2"><file><body><trans-unit id="1"><source>Hello</source><target>Bonjour</target></trans-unit></body></file></xliff>`;
  const result = await ripstream.parse(encoder.encode(xliff), { filename: "strings.xlf" });
  assert.match(result.text, /Hello/);
  assert.match(result.text, /Bonjour/);
});

test("parses TMX segments", async () => {
  const tmx = `<tmx version="1.4"><body><tu><tuv><seg>Hello TMX</seg></tuv></tu></body></tmx>`;
  const result = await ripstream.parse(encoder.encode(tmx), { filename: "memory.tmx" });
  assert.match(result.text, /Hello TMX/);
});

test("parses every response record in a multi-record WARC", async () => {
  const record = (type: string, uri: string, payload: string): string =>
    `WARC/1.0\r\nWARC-Type: ${type}\r\nWARC-Target-URI: ${uri}\r\nContent-Length: ${payload.length}\r\n\r\n${payload}\r\n\r\n`;
  const warc =
    record("warcinfo", "https://info.test", "software: test") +
    record("response", "https://one.test", "first page content") +
    record("response", "https://two.test", "second page content");
  const result = await ripstream.parse(encoder.encode(warc), { filename: "archive.warc" });
  // Tika's WARCParser skips a warcinfo record and parses only response records (tikajs-68os.50).
  assert.doesNotMatch(result.text, /software: test/);
  assert.match(result.text, /first page content/);
  assert.match(result.text, /second page content/);
  assert.match(result.text, /https:\/\/two\.test/);
});

test("XLIFF honors the XML declaration encoding", async () => {
  const head = encoder.encode(
    `<?xml version="1.0" encoding="ISO-8859-1"?><xliff version="1.2"><file><body><trans-unit id="1"><source>caf`,
  );
  const tail = encoder.encode(`</source></trans-unit></body></file></xliff>`);
  const bytes = Uint8Array.from([...head, 0xe9, ...tail]);
  const result = await ripstream.parse(bytes, { filename: "strings.xlf" });
  assert.match(result.text, /café/);
  assert.doesNotMatch(result.text, /�/);
});

test("TMX honors the XML declaration encoding", async () => {
  const head = encoder.encode(
    `<?xml version="1.0" encoding="ISO-8859-1"?><tmx version="1.4"><body><tu><tuv><seg>caf`,
  );
  const tail = encoder.encode(`</seg></tuv></tu></body></tmx>`);
  const bytes = Uint8Array.from([...head, 0xe9, ...tail]);
  const result = await ripstream.parse(bytes, { filename: "memory.tmx" });
  assert.match(result.text, /café/);
});

test("XLIFF 1.2 is written as Tika's XLIFF12Parser does: a lang attribute on each source and target p", async () => {
  // Tika's XLIFF12ParserTest.testXLIFF12ToXMLHandler (read from Tika source/tests; not run against a Tika).
  const xliff = `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="a.txt" source-language="en" target-language="fr"><body><trans-unit id="4"><source xml:lang="en">Another trans-unit</source><target xml:lang="fr">Un autre trans-unit</target></trans-unit></body></file></xliff>`;
  const stream = await RipstreamInputStream.from(encoder.encode(xliff));
  const handler = createOutputHandler("xml");
  await new XliffParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /<p lang="en">Another trans-unit<\/p>/);
  assert.match(handler.toString(), /<p lang="fr">Un autre trans-unit<\/p>/);
});

// Pins found by mutating the WARC and XLIFF changes of web.ts (tikajs-68os.49, .50). Tika's WARCParser.processRecord and
// XLIFF12Parser were read from the source, not run.

const warcRecord = (headers: string, payload: string): string =>
  `WARC/1.0\r\n${headers}\r\nContent-Length: ${payload.length}\r\n\r\n${payload}\r\n\r\n`;

test("a WARC-Type of any case is a response record, and is written as it was spelled", async () => {
  const warc = warcRecord("WARC-Type: Response\r\nWARC-Target-URI: https://case.test", "mixed case body");
  const result = await ripstream.parse(encoder.encode(warc), { filename: "case.warc" });
  assert.match(result.text, /mixed case body/);
  assert.match(result.text, /https:\/\/case\.test/);
  assert.match(result.text, /Response/);
});

test("a WARC record with no WARC-Type is left out, and the records after it are still found", async () => {
  const warc =
    warcRecord("WARC-Target-URI: https://untyped.test", "untyped body") +
    warcRecord("WARC-Type: response\r\nWARC-Target-URI: https://typed.test", "typed body");
  const result = await ripstream.parse(encoder.encode(warc), { filename: "untyped.warc" });
  assert.doesNotMatch(result.text, /untyped/);
  assert.match(result.text, /typed body/);
  assert.match(result.text, /https:\/\/typed\.test/);
});

test("a WARC record that is not a response is left out whole, with its target and type, and the next one is read", async () => {
  const warc =
    warcRecord("WARC-Type: request\r\nWARC-Target-URI: https://request.test", "GET / HTTP/1.1") +
    warcRecord("WARC-Type: metadata\r\nWARC-Target-URI: https://metadata.test", "fetchTimeMs: 5") +
    warcRecord("WARC-Type: response\r\nWARC-Target-URI: https://response.test", "response body");
  const result = await ripstream.parse(encoder.encode(warc), { filename: "types.warc" });
  assert.doesNotMatch(result.text, /request|metadata|GET|fetchTimeMs/);
  assert.match(result.text, /https:\/\/response\.test/);
  assert.match(result.text, /response body/);
});

// XLIFF 2.x is told from 1.2 by the root's version attribute, read from the first 4 KiB.
const xliffBody = `<file original="a.txt" source-language="en"><body><trans-unit id="1"><source>Hello</source><target>Bonjour</target></trans-unit></body></file>`;

async function xliffFileCount(xml: string): Promise<string | null> {
  const stream = await RipstreamInputStream.from(encoder.encode(xml));
  const metadata = new Metadata();
  await new XliffParser().parse(stream, createOutputHandler("xml"), metadata, new ParseContext());
  await stream.close();
  return metadata.get("file-count");
}

test("an XLIFF root version of 2.x, in either quote and with spaces around the =, is read as XLIFF 2", async () => {
  assert.equal(await xliffFileCount(`<xliff version='2.1'>${xliffBody}</xliff>`), null);
  assert.equal(await xliffFileCount(`<xliff   version = "2.0">${xliffBody}</xliff>`), null);
  assert.equal(await xliffFileCount(`<xliff xmlns="urn:x" version="2.0">${xliffBody}</xliff>`), null);
});

test("an XLIFF root that is not version 2.x is read as XLIFF 1.2, whatever else says 2 in its attributes or the document", async () => {
  assert.equal(await xliffFileCount(`<xliff version="1.2">${xliffBody}</xliff>`), "1");
  assert.equal(await xliffFileCount(`<xliff version="1.2" x-version="2.0">${xliffBody}</xliff>`), "1");
  assert.equal(await xliffFileCount(`<xliff version="2">${xliffBody}</xliff>`), "1");
  assert.equal(await xliffFileCount(`<xliff version="1.2"><note version="2.0"/>${xliffBody}</xliff>`), "1");
  assert.equal(await xliffFileCount(`<xliffs version="2.0">${xliffBody}</xliffs>`), "1");
});

test("an XLIFF root version is looked for in the first 4,096 bytes and no further", async () => {
  const tag = '<xliff version="2.0">';
  // a comment before the root puts the "." that ends the version's match at byte `dotIndex`
  const pad = (dotIndex: number): string => {
    const padding = `<!--${"x".repeat(dotIndex - tag.indexOf(".") - "<!---->".length)}-->`;
    assert.equal((padding + tag).indexOf("."), dotIndex);
    return padding;
  };
  assert.equal(await xliffFileCount(`${pad(3000)}${tag}${xliffBody}</xliff>`), null);
  assert.equal(await xliffFileCount(`${pad(4095)}${tag}${xliffBody}</xliff>`), null);
  assert.equal(await xliffFileCount(`${pad(4096)}${tag}${xliffBody}</xliff>`), "1");
});
