import assert from "node:assert/strict";
import { test } from "node:test";
import { AttributesImpl, type Attributes } from "../src/attributes.ts";
import type { ContentHandler } from "../src/content-handler.ts";
import { WriteLimitReachedError } from "../src/errors.ts";
import { Metadata } from "../src/metadata.ts";
import { TextContentHandler, WriteOutContentHandler } from "../src/handlers/text.ts";
import { XHTMLContentHandler } from "../src/handlers/xhtml.ts";

class Recorder implements ContentHandler {
  readonly events: string[] = [];

  startDocument(): void {
    this.events.push("<doc>");
  }

  endDocument(): void {
    this.events.push("</doc>");
  }

  startPrefixMapping(prefix: string, uri: string): void {
    this.events.push(`<prefix ${prefix}=${uri}>`);
  }

  endPrefixMapping(prefix: string): void {
    this.events.push(`</prefix ${prefix}>`);
  }

  startElement(uri: string, localName: string, qName: string, atts: Attributes): void {
    const attrs = atts.names.map((attribute) => ` ${attribute.qName}="${attribute.value}"`).join("");
    this.events.push(`<${qName}${attrs}>`);
  }

  endElement(uri: string, localName: string, qName: string): void {
    this.events.push(`</${qName}>`);
  }

  characters(ch: string, start: number, length: number): void {
    this.events.push(ch.slice(start, start + length));
  }

  ignorableWhitespace(ch: string, start: number, length: number): void {
    this.events.push(ch.slice(start, start + length));
  }

  text(): string {
    return this.events.join("");
  }
}

test("TextContentHandler passes characters through raw", async () => {
  const handler = new TextContentHandler();
  handler.startDocument();
  await handler.startElement("", "p", "p");
  await handler.characters("hello", 0, 5);
  await handler.endElement("", "p", "p");
  assert.equal(handler.toString(), "hello");
});

test("TextContentHandler suppresses style and script content", async () => {
  const handler = new TextContentHandler();
  await handler.startElement("", "style", "style");
  await handler.characters("hidden", 0, 6);
  await handler.endElement("", "style", "style");
  await handler.startElement("", "script", "script");
  await handler.characters("also hidden", 0, 11);
  await handler.endElement("", "script", "script");
  await handler.characters("visible", 0, 7);
  assert.equal(handler.toString(), "visible");
});

test("WriteOutContentHandler forwards the prefix then throws", async () => {
  const target = new TextContentHandler();
  const handler = new WriteOutContentHandler(target, { writeLimit: 5 });
  await handler.characters("abcdef", 0, 6).catch((error: unknown) => {
    assert.ok(error instanceof WriteLimitReachedError);
  });
  assert.equal(target.toString(), "abcde");
});

test("WriteOutContentHandler truncate mode drops the remainder", async () => {
  const target = new TextContentHandler();
  const handler = new WriteOutContentHandler(target, {
    writeLimit: 5,
    onLimit: "truncate",
  });
  await handler.characters("abcdef", 0, 6);
  await handler.characters("ghi", 0, 3);
  assert.equal(target.toString(), "abcde");
  assert.equal(handler.isWriteLimitReached, true);
});

test("XHTMLContentHandler emits the upstream skeleton and metadata head", async () => {
  const recorder = new Recorder();
  const metadata = new Metadata();
  metadata.set("dc:title", "Doc");
  metadata.set("pdf:Producer", "Ripstream");
  const handler = new XHTMLContentHandler(recorder, metadata);

  await handler.startDocument();
  await handler.startElement("p");
  await handler.characters("hello");
  await handler.endElement("p");
  await handler.endDocument();

  const text = recorder.text();
  assert.match(text, /<prefix =http:\/\/www\.w3\.org\/1999\/xhtml>/);
  assert.match(text, /<html>/);
  assert.match(text, /<meta name="pdf:Producer" content="Ripstream">/);
  assert.match(text, /<title>Doc<\/title>/);
  assert.match(text, /<body>/);
  assert.match(text, /<p>hello<\/p>\n/);
  assert.match(text, /<\/body><\/html>/);
});

test("XHTMLContentHandler drops empty inline formatting and moves whitespace", async () => {
  const recorder = new Recorder();
  const handler = new XHTMLContentHandler(recorder, new Metadata());

  await handler.startDocument();
  await handler.startElement("b");
  await handler.characters("   ");
  await handler.endElement("b");
  await handler.startElement("b");
  await handler.characters(" x ");
  await handler.endElement("b");
  await handler.endDocument();

  const text = recorder.text();
  assert.doesNotMatch(text, /<b><\/b>/);
  assert.match(text, / <b>x<\/b> /);
});

test("XHTMLContentHandler indents list items and ends them with newline", async () => {
  const recorder = new Recorder();
  const handler = new XHTMLContentHandler(recorder, new Metadata());

  await handler.startDocument();
  await handler.startElement("ul");
  await handler.startElement("li");
  await handler.characters("item");
  await handler.endElement("li");
  await handler.endElement("ul");
  await handler.endDocument();

  assert.match(recorder.text(), /\t<li>item<\/li>\n/);
});

test("XHTMLContentHandler replaces invalid XML characters", async () => {
  const recorder = new Recorder();
  const handler = new XHTMLContentHandler(recorder, new Metadata());
  await handler.startDocument();
  await handler.startElement("p");
  await handler.characters("\u0001X");
  await handler.endElement("p");
  assert.match(recorder.text(), /�X/);
});
