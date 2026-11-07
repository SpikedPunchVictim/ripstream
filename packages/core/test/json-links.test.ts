import assert from "node:assert/strict";
import { test } from "node:test";
import { AttributesImpl } from "../src/attributes.ts";
import { JsonContentHandler, LinkExtractor } from "../src/handlers/json-links.ts";
import { Metadata } from "../src/metadata.ts";

test("JSON handler merges metadata and content", () => {
  const metadata = new Metadata();
  metadata.set("Content-Type", "text/plain");
  const handler = new JsonContentHandler(metadata);
  handler.startDocument();
  handler.characters("hello", 0, 5);
  assert.deepEqual(JSON.parse(handler.toString()), {
    "Content-Type": "text/plain",
    "X-TIKA:content": "hello",
  });
});

test("link extractor collects href and src", async () => {
  const extractor = new LinkExtractor();
  const attrs = new AttributesImpl();
  attrs.addAttribute("", "href", "href", "CDATA", "https://a.test");
  await extractor.startElement("", "a", "a", attrs);
  const img = new AttributesImpl();
  img.addAttribute("", "src", "src", "CDATA", "embedded:x.png");
  await extractor.startElement("", "img", "img", img);
  assert.deepEqual(extractor.links, ["https://a.test", "embedded:x.png"]);
});
