import assert from "node:assert/strict";
import { test } from "node:test";
import { AttributesImpl } from "../src/attributes.ts";
import { ToHTMLContentHandler, ToXMLContentHandler } from "../src/handlers/xml.ts";

test("XML serializer writes declaration, attributes, and escaping", () => {
  const handler = new ToXMLContentHandler();
  const attrs = new AttributesImpl();
  attrs.addAttribute("", "id", "id", "CDATA", 'a"b');
  handler.startDocument();
  handler.startElement("", "p", "p", attrs);
  handler.characters("a < b & c", 0, 9);
  handler.endElement("", "p", "p");
  assert.equal(
    handler.toString(),
    '<?xml version="1.0" encoding="UTF-8"?><p id="a&quot;b">a &lt; b &amp; c</p>',
  );
});

test("HTML serializer omits XML declaration and void end tags", () => {
  const handler = new ToHTMLContentHandler();
  handler.startDocument();
  handler.startElement("", "br", "br", new AttributesImpl());
  handler.endElement("", "br", "br");
  handler.startElement("", "p", "p", new AttributesImpl());
  handler.characters("x", 0, 1);
  handler.endElement("", "p", "p");
  assert.equal(handler.toString(), "<br><p>x</p>");
});
