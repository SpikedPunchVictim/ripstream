import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  CONTEXT_KEYS,
  LimitExceededError,
  MediaType,
  Metadata,
  Ripstream,
  RipstreamInputStream,
  handlerTypeName,
  parseHandlerType,
  rmetaObjects,
  type ContentHandler,
  type Detector,
  type Parser,
} from "../src/index.ts";
import type { EmbeddedDocumentExtractor } from "../src/embedded.ts";

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };
const none = new AttributesImpl([]);

async function write(handler: ContentHandler, title: string, heading: string, paragraph: string): Promise<void> {
  await handler.startElement?.("", "html", "html", none);
  await handler.startElement?.("", "head", "head", none);
  await handler.startElement?.("", "title", "title", none);
  await handler.characters?.(title, 0, title.length);
  await handler.endElement?.("", "title", "title");
  await handler.endElement?.("", "head", "head");
  await handler.startElement?.("", "body", "body", none);
  await handler.startElement?.("", "h1", "h1", none);
  await handler.characters?.(heading, 0, heading.length);
  await handler.endElement?.("", "h1", "h1");
  await handler.startElement?.("", "p", "p", none);
  await handler.characters?.(paragraph, 0, paragraph.length);
  await handler.endElement?.("", "p", "p");
  await handler.endElement?.("", "body", "body");
  await handler.endElement?.("", "html", "html");
}

/** A document that is a title, a heading and a paragraph, with one embedded document of the same shape. */
const parser: Parser = {
  name: "Page",
  getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
  async parse(_stream, handler, _metadata, ctx): Promise<void> {
    const embedded = (ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0) > 0;
    await write(handler, embedded ? "Inner title" : "Title", embedded ? "Inner" : "Heading", embedded ? "inner text" : "Some text");
    if (embedded) return;
    const extractor = ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined;
    if (extractor === undefined) return;
    const child = new Metadata();
    child.set("tk:resource-name", "inner.txt");
    await extractor.parseEmbedded(await RipstreamInputStream.from(new Uint8Array([1])), handler, child, ctx);
  },
};

const ripstream = new Ripstream({ detector, parser });
const bytes = new Uint8Array([9]);

test("parseHandlerType: Tika's spellings, in any case, and a name it does not know is refused with Tika's message", () => {
  assert.equal(parseHandlerType("TXT"), "text");
  assert.equal(parseHandlerType("text"), "text");
  assert.equal(parseHandlerType("Md"), "markdown");
  assert.equal(parseHandlerType("markdown"), "markdown");
  assert.equal(parseHandlerType("body"), "body");
  assert.equal(parseHandlerType("html"), "html");
  assert.equal(parseHandlerType("xml"), "xml");
  assert.equal(parseHandlerType("ignore"), "ignore");
  assert.equal(parseHandlerType(null, "html"), "html");
  assert.equal(parseHandlerType(undefined), "text");
  assert.throws(
    () => parseHandlerType("bogus"),
    new RangeError("Unrecognized handler type 'bogus'. Valid types: text, txt, html, xml, body, markdown, md, ignore"),
  );
});

test("handlerTypeName: the enum name Tika writes to tk:content-handler-type", () => {
  assert.deepEqual(
    (["text", "body", "html", "xml", "markdown", "ignore"] as const).map(handlerTypeName),
    ["TEXT", "BODY", "HTML", "XML", "MARKDOWN", "IGNORE"],
  );
});

test("parse: the default and 'text' are the text of the body", async () => {
  assert.equal((await ripstream.parse(bytes)).text, "HeadingSome text");
  assert.equal((await ripstream.parse(bytes, { handlerType: "text" })).text, "HeadingSome text");
  assert.equal((await ripstream.parse(bytes, { handlerType: "body" })).text, "HeadingSome text");
});

test("parse: html and xml are the serialized document, the xml without a declaration", async () => {
  const html = (await ripstream.parse(bytes, { handlerType: "html" })).text;
  assert.equal(html, "<html><head><title>Title</title></head><body><h1>Heading</h1><p>Some text</p></body></html>");
  const xml = (await ripstream.parse(bytes, { handlerType: "xml" })).text;
  assert.equal(xml, html);
});

test("parse: markdown is the document as Markdown, and ignore is nothing", async () => {
  const markdown = (await ripstream.parse(bytes, { handlerType: "markdown" })).text;
  assert.equal(markdown, "Title  \n\n# Heading\n\nSome text\n");
  const ignored = await ripstream.parse(bytes, { handlerType: "ignore" });
  assert.equal(ignored.text, "");
});

test("parse: ignore has no output limit, as Tika's ignore handler has none; the other types do", async () => {
  const limits = { maxOutputChars: 3 };
  assert.equal((await ripstream.parse(bytes, { handlerType: "ignore", limits })).text, "");
  for (const handlerType of ["text", "body", "html", "xml", "markdown"] as const) {
    await assert.rejects(ripstream.parse(bytes, { handlerType, limits }), LimitExceededError, handlerType);
  }
});

test("parse: html counts every character the parsers write, the title included; text counts the body's only", async () => {
  // The body is "Heading" + "Some text" = 16 characters; with the title (5) it is 21.
  const fits = { maxOutputChars: 16 };
  assert.equal((await ripstream.parse(bytes, { handlerType: "text", limits: fits })).text, "HeadingSome text");
  await assert.rejects(ripstream.parse(bytes, { handlerType: "html", limits: fits }), LimitExceededError);
  assert.match((await ripstream.parse(bytes, { handlerType: "html", limits: { maxOutputChars: 21 } })).text, /^<html>/);
});

test("parse: a truncated html answer is the markup up to the limit, flagged", async () => {
  const result = await ripstream.parse(bytes, { handlerType: "html", limits: { maxOutputChars: 8 }, onOutputLimit: "truncate" });
  assert.equal(result.metadata.get("tk:exception:write-limit-reached"), "true");
  assert.equal(result.text, "<html><head><title>Title</title></head><body><h1>Hea");
});

test("parseRecursive: each record's content is in the requested shape and says so in tk:content-handler-type", async () => {
  const records = await ripstream.parseRecursive(bytes, { handlerType: "html" });
  assert.equal(records.length, 2);
  assert.match(records[0]!.content, /^<html><head><title>Title<\/title>/);
  assert.match(records[1]!.content, /^<html><head><title>Inner title<\/title>/);
  const objects = rmetaObjects(records);
  assert.deepEqual(objects.map((object) => object["tk:content-handler-type"]), ["HTML", "HTML"]);
});

test("parseRecursive: the default is text, a container's every character and an embedded document's body", async () => {
  const records = await ripstream.parseRecursive(bytes);
  assert.equal(records[0]!.content, "TitleHeadingSome text");
  assert.equal(records[1]!.content, "Innerinner text");
  assert.deepEqual(rmetaObjects(records).map((object) => object["tk:content-handler-type"]), ["TEXT", "TEXT"]);
});

test("parseRecursive: body is the body's characters for the container too", async () => {
  const records = await ripstream.parseRecursive(bytes, { handlerType: "body" });
  assert.deepEqual(records.map((record) => record.content), ["HeadingSome text", "Innerinner text"]);
  assert.deepEqual(rmetaObjects(records).map((object) => object["tk:content-handler-type"]), ["BODY", "BODY"]);
});

test("parseRecursive: ignore keeps no content, writes neither tk:content nor a handler type, and has no output limit", async () => {
  const records = await ripstream.parseRecursive(bytes, { handlerType: "ignore", limits: { maxOutputChars: 1 } });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.content), ["", ""]);
  for (const object of rmetaObjects(records)) {
    assert.equal(object["tk:content"], undefined);
    assert.equal(object["tk:content-handler-type"], undefined);
  }
});

test("parseRecursive: a limit on html counts the markup's characters across the container and what it embeds", async () => {
  // The container writes Title + Heading + Some text = 21 characters, the embedded document 26 more.
  const over = await ripstream.parseRecursive(bytes, { handlerType: "html", limits: { maxOutputChars: 30 } });
  assert.match(over[1]!.metadata.get("tk:exception:embedded-exception") ?? "", /^LimitExceededError: Recursive output exceeds 30/);
  const fits = await ripstream.parseRecursive(bytes, { handlerType: "html", limits: { maxOutputChars: 47 } });
  assert.equal(fits[1]!.metadata.get("tk:exception:embedded-exception"), null);
});
