import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { RdfParser } from "../src/index.ts";

const turtle = `@prefix dc: <http://purl.org/dc/elements/1.1/> .
<http://example.com/doc> dc:title "A title" ; dc:creator "Ada" .`;

test("parses Turtle triples", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(turtle));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", "text/turtle");
  await new RdfParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /A title/);
  assert.match(handler.toString(), /Ada/);
});

test("rejects malformed RDF", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("@prefix : <x> . :a :b"));
  await assert.rejects(
    new RdfParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
