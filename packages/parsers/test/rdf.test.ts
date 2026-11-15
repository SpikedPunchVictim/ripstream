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

async function parseTurtle(text: string): Promise<string> {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(text));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", "text/turtle");
  await new RdfParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  return handler.toString();
}

// tikajs-dasw: n3 numbers blank nodes with module-level counters (one per parse for labelled nodes, one per anonymous
// node), so the same document printed different labels depending on how many RDF documents the process had parsed
// before, and the labels told a later document how many anonymous nodes earlier documents had. Each parse now numbers
// its own blank nodes from zero.
const BLANK_NODES = `@prefix ex: <http://example.org/> .
_:x ex:knows [ ex:name "anon" ] .
ex:a ex:list ( "one" "two" ) .`;

test("blank-node labels depend on the document alone, not on earlier parses", async () => {
  const first = await parseTurtle(BLANK_NODES);
  await parseTurtle(`@prefix ex: <http://example.org/> . _:y ex:p [ ex:q [ ex:r "s" ] ] .`);
  assert.equal(await parseTurtle(BLANK_NODES), first);
  assert.match(first, /b0_x/);
  assert.match(first, /n3-0/);
});
