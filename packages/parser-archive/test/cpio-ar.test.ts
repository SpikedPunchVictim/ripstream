import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, CONTEXT_KEYS, Metadata, ParseContext, RipstreamInputStream, XHTMLContentHandler, type Parser } from "@spikedpunch/ripstream-core";
import { ArParser, CpioParser } from "../src/index.ts";

const plainText: Parser = {
  getSupportedTypes: () => new Set(),
  async parse(stream, handler) {
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    await xhtml.element("p", text);
    await xhtml.endDocument();
  },
};

async function run(parser: Parser, bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, plainText);
  await parser.parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  return handler.toString();
}

test("parses newc CPIO archives", async () => {
  const content = new TextEncoder().encode("cpio hello");
  const name = new TextEncoder().encode("a.txt\0");
  const header = (size: number, nameSize: number): string => {
    const fields = [1, 0o100644, 0, 0, 1, 0, size, 0, 0, 0, 0, nameSize, 0];
    return "070701" + fields.map((field) => field.toString(16).padStart(8, "0")).join("");
  };
  const bytes = [
    ...new TextEncoder().encode(header(content.length, name.length)),
    ...name,
    ...new Uint8Array((4 - ((110 + name.length) % 4)) % 4),
    ...content,
    ...new Uint8Array((4 - (content.length % 4)) % 4),
    ...new TextEncoder().encode(header(0, 11)),
    ...new TextEncoder().encode("TRAILER!!!\0"),
  ];
  const text = await run(new CpioParser(), new Uint8Array(bytes));
  assert.match(text, /a\.txt/);
  assert.match(text, /cpio hello/);
});

test("parses ar archives", async () => {
  const content = new TextEncoder().encode("ar hello");
  const name = "b.txt/".padEnd(16);
  const header = `${name}0           0     0     100644  ${String(content.length).padEnd(10)}\`\n`;
  const bytes = new Uint8Array([
    ...new TextEncoder().encode("!<arch>\n"),
    ...new TextEncoder().encode(header),
    ...content,
    ...(content.length % 2 === 1 ? [0x0a] : []),
  ]);
  const text = await run(new ArParser(), bytes);
  assert.match(text, /b\.txt/);
  assert.match(text, /ar hello/);
});
