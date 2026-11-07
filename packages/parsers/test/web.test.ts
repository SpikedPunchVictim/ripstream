import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "../src/index.ts";

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

test("parses every record in a multi-record WARC", async () => {
  const record = (type: string, uri: string, payload: string): string =>
    `WARC/1.0\r\nWARC-Type: ${type}\r\nWARC-Target-URI: ${uri}\r\nContent-Length: ${payload.length}\r\n\r\n${payload}\r\n\r\n`;
  const warc =
    record("warcinfo", "https://info.test", "software: test") +
    record("resource", "https://one.test", "first page content") +
    record("resource", "https://two.test", "second page content");
  const result = await ripstream.parse(encoder.encode(warc), { filename: "archive.warc" });
  assert.match(result.text, /software: test/);
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
