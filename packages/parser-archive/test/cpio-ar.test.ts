import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, CONTEXT_KEYS, LimitExceededError, Metadata, ParseContext, RipstreamInputStream, XHTMLContentHandler, type Parser } from "@spikedpunch/ripstream-core";
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

test("a CPIO size field with a minus sign cannot walk back to the same header (tikajs-2mo9)", async () => {
  const name = new TextEncoder().encode("a.txt\0");
  const fields = ["00000001", "000081a4", "0", "0", "00000001", "0", "-0000074", "0", "0", "0", "0", "00000006", "0"];
  const header = "070701" + fields.map((field) => field.padStart(8, "0").replace(/^0+-/, "-")).join("");
  // -0x74 is minus the 116 bytes from the header to the data, so the next entry would start at offset 0 again.
  assert.equal(header.length, 110);
  const bytes = new Uint8Array([...new TextEncoder().encode(header), ...name, 0, 0, ...new TextEncoder().encode("x".repeat(200))]);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const ctx = new ParseContext({ limits: { maxZipEntries: 50 } });
  ctx.set(CONTEXT_KEYS.PARSER, plainText);
  await new CpioParser().parse(stream, handler, new Metadata(), ctx);
  await stream.close();
  assert.equal(handler.toString().split("a.txt").length - 1, 0);
});

/** Entry-count limit and damaged headers (tikajs-6ghz, F3): nothing past the limit is dropped without saying so. */

function cpioEntry(name: string, content: string): number[] {
  const nameBytes = [...new TextEncoder().encode(`${name}\0`)];
  const body = [...new TextEncoder().encode(content)];
  const fields = [1, 0o100644, 0, 0, 1, 0, body.length, 0, 0, 0, 0, nameBytes.length, 0];
  const header = [...new TextEncoder().encode("070701" + fields.map((field) => field.toString(16).padStart(8, "0")).join(""))];
  const pad = (length: number): number[] => new Array<number>((4 - (length % 4)) % 4).fill(0);
  return [...header, ...nameBytes, ...pad(110 + nameBytes.length), ...body, ...pad(body.length)];
}

function cpio(names: readonly string[], trailer = true): Uint8Array {
  return new Uint8Array([...names.flatMap((name) => cpioEntry(name, `body of ${name}`)), ...(trailer ? cpioEntry("TRAILER!!!", "") : [])]);
}

function arEntry(name: string, content: string): number[] {
  const header = `${`${name}/`.padEnd(16)}0           0     0     100644  ${String(content.length).padEnd(10)}\`\n`;
  return [...new TextEncoder().encode(header), ...new TextEncoder().encode(content), ...(content.length % 2 === 1 ? [0x0a] : [])];
}

function ar(names: readonly string[]): Uint8Array {
  return new Uint8Array([...new TextEncoder().encode("!<arch>\n"), ...arEntry("", "symbols"), ...names.flatMap((name) => arEntry(name, `body of ${name}`))]);
}

async function parseWith(parser: Parser, bytes: Uint8Array, maxZipEntries: number, truncate: boolean): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  const ctx = new ParseContext({ limits: { maxZipEntries } });
  ctx.set(CONTEXT_KEYS.PARSER, plainText);
  if (truncate) ctx.set(CONTEXT_KEYS.TRUNCATE_EMBEDDED_LIMIT, true);
  try {
    await parser.parse(stream, handler, metadata, ctx);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

for (const [label, parser, build] of [
  ["cpio", new CpioParser(), cpio],
  ["ar", new ArParser(), ar],
] as const) {
  const names = ["f1", "f2", "f3", "f4", "f5"];
  test(`${label}: an archive with more entries than maxZipEntries throws LimitExceededError`, async () => {
    await assert.rejects(parseWith(parser, build(names), 3, false), LimitExceededError);
  });

  test(`${label}: under onEmbeddedLimit truncate the first entries are read and the cut is flagged`, async () => {
    const { text, metadata } = await parseWith(parser, build(names), 3, true);
    assert.match(text, /body of f3/);
    assert.doesNotMatch(text, /body of f4/);
    assert.equal(metadata.get("tk:exception:embedded-resource-limit-reached"), "true");
    assert.equal(metadata.get("tk:exception:embedded-resource-limit"), "maxZipEntries");
    assert.equal(metadata.get("tk:exception:embedded-resource-limit-max"), "3");
    assert.equal(metadata.get("tk:exception:embedded-resource-limit-seen"), "5");
    assert.equal(metadata.get("tk:exception:embedded-resource-limit-read"), "3");
  });

  test(`${label}: exactly maxZipEntries entries is neither an error nor a flag`, async () => {
    const { text, metadata } = await parseWith(parser, build(names.slice(0, 3)), 3, false);
    assert.match(text, /body of f3/);
    assert.equal(metadata.get("tk:exception:embedded-resource-limit-reached"), null);
  });

  test(`${label}: a limit of 0 with entries in the archive throws`, async () => {
    await assert.rejects(parseWith(parser, build(["f1"]), 0, false), LimitExceededError);
  });
}

test("cpio: a header that fails after a good entry is recorded on the archive, not a silent end", async () => {
  const good = cpioEntry("f1", "body of f1");
  const damaged = [...good, ...new TextEncoder().encode("070701" + "zz".repeat(52))];
  const { text, metadata } = await parseWith(new CpioParser(), new Uint8Array(damaged), 100, false);
  assert.match(text, /body of f1/);
  assert.match(metadata.get("tk:exception:embedded-stream-exception") ?? "", /cpio header at offset \d+/i);
});

test("cpio: the TRAILER and bytes after it are not an error", async () => {
  const { metadata } = await parseWith(new CpioParser(), new Uint8Array([...cpio(["f1"]), ...new Array<number>(512).fill(0)]), 100, false);
  assert.equal(metadata.get("tk:exception:embedded-stream-exception"), null);
});

test("ar: a header that fails after a good entry is recorded on the archive", async () => {
  const damaged = new Uint8Array([...ar(["f1"]), ...new TextEncoder().encode("garbage header that is sixty bytes long, with no valid size field.")]);
  const { text, metadata } = await parseWith(new ArParser(), damaged, 100, false);
  assert.match(text, /body of f1/);
  assert.match(metadata.get("tk:exception:embedded-stream-exception") ?? "", /ar header at offset \d+/i);
});
