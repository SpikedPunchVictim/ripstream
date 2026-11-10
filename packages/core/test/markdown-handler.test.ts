import assert from "node:assert/strict";
import { test } from "node:test";
import { AttributesImpl, MarkdownContentHandler } from "../src/index.ts";

/*
 * The Markdown handler reads the XHTML the parsers write. Tika's own handler builds a document model and drops the
 * whitespace between blocks; this one streams, so the tests pin the shapes the two share: a blank line between
 * blocks, the title as the first line, lists one item a line.
 */

type Event = string | [name: string, attributes?: Record<string, string>] | { end: string };

async function render(events: readonly Event[]): Promise<string> {
  const handler = new MarkdownContentHandler();
  for (const event of events) {
    if (typeof event === "string") {
      await handler.characters(event, 0, event.length);
    } else if ("end" in event) {
      await handler.endElement("", event.end, event.end);
    } else {
      const [name, attributes = {}] = event;
      const pairs = Object.entries(attributes).map(([key, value]) => ({ uri: "", localName: key, qName: key, type: "CDATA", value }));
      await handler.startElement("", name, name, new AttributesImpl(pairs));
    }
  }
  return handler.toString();
}

const end = (name: string): Event => ({ end: name });

test("adjacent paragraphs are separate paragraphs, a blank line apart", async () => {
  const out = await render([["body"], ["p"], "one", end("p"), ["p"], "two", end("p"), end("body")]);
  assert.equal(out, "one\n\ntwo\n");
});

test("a heading is its own block", async () => {
  const out = await render([["body"], ["h2"], "Head", end("h2"), ["p"], "text", end("p"), end("body")]);
  assert.equal(out, "## Head\n\ntext\n");
});

test("the title leads the document as a line of its own; an empty title writes nothing", async () => {
  const head = (title: string): Event[] => [["head"], ["title"], title, end("title"), end("head"), ["body"], ["p"], "text", end("p"), end("body")];
  assert.equal(await render(head("A title")), "A title  \n\ntext\n");
  assert.equal(await render(head("")), "text\n");
});

test("what the head holds, other than the title, is not content", async () => {
  const out = await render([["head"], ["meta", { name: "a", content: "b" }], "\n", end("head"), ["body"], ["p"], "text", end("p")]);
  assert.equal(out, "text\n");
});

test("whitespace between blocks is layout and is dropped; inside a run of text it stays", async () => {
  const out = await render([["html"], "\n", ["body"], "\n", ["p"], "a b", end("p"), "\n", ["p"], "c", end("p"), "\n", end("body"), "\n"]);
  assert.equal(out, "a b\n\nc\n");
});

test("list items are one a line, numbered for an ordered list", async () => {
  const unordered = await render([["ul"], ["li"], "a", end("li"), ["li"], "b", end("li"), end("ul")]);
  assert.equal(unordered, "- a\n- b\n\n");
  const ordered = await render([["ol"], ["li"], "a", end("li"), ["li"], "b", end("li"), end("ol")]);
  assert.equal(ordered, "1. a\n2. b\n\n");
});

test("emphasis, links and preformatted text", async () => {
  const out = await render([
    ["p"], ["b"], "bold", end("b"), " and ", ["i"], "soft", end("i"), " ", ["a", { href: "https://example.com" }], "site", end("a"), end("p"),
    ["pre"], "x  =  1", end("pre"),
  ]);
  assert.equal(out, "**bold** and *soft* [site](https://example.com)\n\n```\nx  =  1\n```\n");
});
