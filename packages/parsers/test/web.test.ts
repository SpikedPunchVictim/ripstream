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
