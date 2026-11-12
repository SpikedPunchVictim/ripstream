import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  OutputLimitContentHandler,
  ParseContext,
  RipstreamInputStream,
  type ContentHandler,
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

// tikajs-68os.73: the text is tokenized lazily and written as it is produced, so the output cap and the first writes
// do not wait for the whole input to be tokenized. The XHTML head still holds every \info value, wherever \info is.

interface Recorded {
  /** One entry per element or text event, in the order the handler saw them: `<name>`, `</name>`, `text:...`. */
  readonly events: string[];
  readonly paragraphs: string[];
  /** `name=content` for each <meta> in the head, and `title:...` for the <title>. */
  readonly head: string[];
}

function recorder(): { handler: ContentHandler; recorded: Recorded } {
  const recorded: Recorded = { events: [], paragraphs: [], head: [] };
  let open: string | null = null;
  const handler: ContentHandler = {
    startDocument: () => undefined,
    endDocument: () => undefined,
    startElement: (_uri, local, _qName, attributes) => {
      recorded.events.push(`<${local}>`);
      open = local;
      if (local === "meta") {
        recorded.head.push(`${attributes.getValueByQName("name")}=${attributes.getValueByQName("content")}`);
      }
    },
    endElement: (_uri, local) => {
      recorded.events.push(`</${local}>`);
      open = null;
    },
    characters: (ch, start, length) => {
      const value = ch.substring(start, start + length);
      recorded.events.push(`text:${value}`);
      if (open === "p") recorded.paragraphs.push(value);
      if (open === "title" && value.length > 0) recorded.head.push(`title:${value}`);
    },
  };
  return { handler, recorded };
}

async function record(
  value: string,
  options: { outputLimit?: number } = {},
): Promise<Recorded> {
  const { handler, recorded } = recorder();
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(value));
  try {
    const target =
      options.outputLimit === undefined ? handler : new OutputLimitContentHandler(handler, options.outputLimit);
    await new RtfParser().parse(stream, target, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
  return recorded;
}

test("an output cap fires before a depth error that comes later in the input", async () => {
  const doc = "{\\rtf1 " + "word\\par ".repeat(5000) + "{".repeat(2000) + "}";
  await assert.rejects(record(doc, { outputLimit: 100 }), LimitExceededError);
});

test("paragraphs reach the handler before a depth error that comes later in the input", async () => {
  const doc = "{\\rtf1 " + "word\\par ".repeat(5000) + "{".repeat(2000) + "}";
  const { handler, recorded } = recorder();
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(doc));
  await assert.rejects(
    new RtfParser().parse(stream, handler, new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
  assert.ok(recorded.paragraphs.length > 1000, `${recorded.paragraphs.length} paragraphs written`);
});

test("a depth error still ends a parse that nests deeply after the first output piece", async () => {
  await assert.rejects(record("{\\rtf1 " + "x".repeat(20000) + "{".repeat(1001)), MalformedDocumentError);
});

test("an \\info group after the body still fills the head", async () => {
  const late = await record(String.raw`{\rtf1 Body\par {\info{\title Late}{\author Ann}{\creatim\yr2024\mo5\dy6}}}`);
  const early = await record(String.raw`{\rtf1 {\info{\title Late}{\author Ann}{\creatim\yr2024\mo5\dy6}}Body\par }`);
  assert.ok(late.head.includes("dc:title=Late"), late.head.join("|"));
  assert.ok(late.head.includes("dc:creator=Ann"), late.head.join("|"));
  assert.ok(late.head.includes("title:Late"), late.head.join("|"));
  assert.ok(late.head.some((entry) => entry.startsWith("dcterms:created=2024-05-06T")), late.head.join("|"));
  assert.deepEqual(late.events, early.events);
});

// The tokenizer appends a run of plain characters at once, so the output pieces are counted in appends, not characters.
// A control word between characters ends the run: `x\\b0 ` is one append of "x" and the control word emits none.
function spread(value: string): string {
  return [...value].map((character) => `${character}\\b0 `).join("");
}

test("an \\info group after more than one output piece still fills the head", async () => {
  const result = await record("{\\rtf1 " + spread("x".repeat(30000)) + String.raw`\par {\info{\title Far}}}`);
  assert.ok(result.head.includes("dc:title=Far"), result.head.join("|"));
  assert.deepEqual(result.paragraphs, ["x".repeat(30000)]);
});

test("paragraphs are intact wherever an output piece ends", async () => {
  // Over the offsets a piece boundary lands in, just before and just after a \par.
  for (let offset = 0; offset < 40; offset++) {
    const expected: string[] = [];
    let doc = "{\\rtf1 " + spread("q".repeat(offset)) + "\\par ";
    expected.push("q".repeat(offset));
    for (let index = 0; index < 500; index++) {
      const value = String.fromCharCode(97 + (index % 26)).repeat(1 + ((index * 37) % 90));
      doc += `${spread(value)}\\par `;
      expected.push(value);
    }
    const result = await record(doc + "}");
    assert.deepEqual(result.paragraphs, expected.filter((value) => value.length > 0), `offset ${offset}`);
  }
});

test("blank paragraphs are dropped and trailing space is trimmed from the rest", async () => {
  const result = await record(String.raw`{\rtf1 a  \par \par  \par b \par c\line d}`);
  assert.deepEqual(result.paragraphs, ["a", "b", "c", "d"]);
});

test("the last paragraph is written when the document has no closing \\par", async () => {
  const result = await record("{\\rtf1 first\\par " + spread("z".repeat(25000)) + "}");
  assert.deepEqual(result.paragraphs, ["first", "z".repeat(25000)]);
});

test("a source line break inside a run of text is not a paragraph break", async () => {
  const result = await record("{\\rtf1 Hel\r\nlo\nwo\\par next}");
  assert.deepEqual(result.paragraphs, ["Hellowo", "next"]);
});

test("a \\u fallback is dropped from a run of plain text and the rest of the run is kept", async () => {
  const result = await record(String.raw`{\rtf1\uc1\u233?abc\uc3\u8364 xyzabc}`);
  assert.deepEqual(result.paragraphs, ["éabc€abc"]);
});

test("text in a skipped group and in \\info is not written to the body", async () => {
  const result = await record(String.raw`{\rtf1 {\fonttbl Arial;}{\*\generator Word;}{\info{\title T}Stray}shown}`);
  assert.deepEqual(result.paragraphs, ["shown"]);
});
