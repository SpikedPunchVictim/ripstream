import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { RtfParser } from "../src/index.ts";

const rtf = String.raw`{\rtf1\ansi\ansicpg1252
{\fonttbl{\f0 Arial;}{\f1 Courier New;}}
{\colortbl;\red0\green0\blue0;}
{\info{\title Sample Doc}{\author Ada}{\subject Testing}{\keywords one; two}{\company ACME}{\creatim\yr2024\mo1\dy2\hr3\min4}}
\f0\pard Hello \b bold\b0  world\par
Unicode: \uc1\u233? and tab\tab end\par
{\header Header text\par}
}`;

async function parse(value: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(value));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new RtfParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts RTF text, groups and headers", async () => {
  const result = await parse(rtf);
  assert.match(result.text, /Hello/);
  assert.match(result.text, /bold/);
  assert.match(result.text, /world/);
  assert.match(result.text, /Unicode: é/);
  assert.match(result.text, /Header text/);
  assert.doesNotMatch(result.text, /Arial/);
  assert.doesNotMatch(result.text, /Courier/);
});

test("maps RTF info metadata", async () => {
  const result = await parse(rtf);
  assert.equal(result.metadata.get("dc:title"), "Sample Doc");
  assert.equal(result.metadata.get("dc:creator"), "Ada");
  assert.equal(result.metadata.get("dc:description"), "Testing");
  assert.equal(result.metadata.get("extended-properties:Company"), "ACME");
  assert.match(result.metadata.get("dcterms:created") ?? "", /^2024-01-02T03:04/);
});

test("rejects non-RTF input", async () => {
  await assert.rejects(parse("plain text"), MalformedDocumentError);
});

test("rejects excessively nested RTF groups", async () => {
  await assert.rejects(parse("{\\rtf1 " + "{".repeat(5000)), MalformedDocumentError);
});

test("negative \\bin does not hang", async () => {
  const result = await parse("{\\rtf1 \\bin-7 x}");
  assert.match(result.text, /x/);
});

test("decodes double-byte code page escapes as a run (cp932)", async () => {
  const result = await parse(String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0\'82\'a2}`);
  assert.match(result.text, /あい/);
});

test("decodes cp936 and cp949 multibyte escapes", async () => {
  const gbk = await parse(String.raw`{\rtf1\ansi\ansicpg936 \'c4\'e3\'ba\'c3}`);
  assert.match(gbk.text, /你好/);
  const kr = await parse(String.raw`{\rtf1\ansi\ansicpg949 \'b0\'a1}`);
  assert.match(kr.text, /가/);
});

test("single-byte cp1252 escapes still decode", async () => {
  const result = await parse(String.raw`{\rtf1\ansi\ansicpg1252 caf\'e9 \'e9\'e8}`);
  assert.match(result.text, /café éè/);
});

test("multibyte run interleaved with text and a \\u fallback", async () => {
  const result = await parse(String.raw`{\rtf1\ansi\ansicpg932 a\'82\'a0b \uc1\u233\'e9c}`);
  assert.match(result.text, /aあb é/);
  assert.match(result.text, /éc/);
});
