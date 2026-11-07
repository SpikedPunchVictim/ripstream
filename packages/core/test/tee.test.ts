import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  BodyContentHandler,
  TeeContentHandler,
  XHTMLContentHandler,
  Metadata,
} from "../src/index.ts";

test("tee forwards to every handler", async () => {
  const first = new BodyContentHandler();
  const second = new BodyContentHandler();
  const metadata = new Metadata();
  const tee = new TeeContentHandler([
    new XHTMLContentHandler(first, metadata),
    new XHTMLContentHandler(second, metadata),
  ]);
  tee.startDocument();
  await tee.startElement("", "p", "p", new AttributesImpl([]));
  await tee.characters("shared", 0, 6);
  await tee.endElement("", "p", "p");
  tee.endDocument();
  assert.match(first.toString(), /shared/);
  assert.match(second.toString(), /shared/);
});
