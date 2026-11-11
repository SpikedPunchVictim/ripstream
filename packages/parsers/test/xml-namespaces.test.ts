import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

const ripstream = createRipstream();
const encoder = new TextEncoder();
const DC = "http://purl.org/dc/elements/1.1/";

/** The declaration keeps the sniffer from reading a document with `<title>` in it as HTML. */
function parseXml(text: string) {
  return ripstream.parse(encoder.encode(`<?xml version="1.0"?>${text}`), { filename: "doc.xml", contentType: "application/xml" });
}

test("XML reads a Dublin Core element under the prefix, the default namespace and a prefix bound further in", async () => {
  const byPrefix = await parseXml(`<doc xmlns:dc="${DC}"><dc:title>by prefix</dc:title></doc>`);
  assert.equal(byPrefix.metadata.get("dc:title"), "by prefix");
  const byDefault = await parseXml(`<doc><title xmlns="${DC}">by default</title></doc>`);
  assert.equal(byDefault.metadata.get("dc:title"), "by default");
  const nested = await parseXml(`<doc><wrap xmlns:q="${DC}"><q:creator>nested</q:creator></wrap></doc>`);
  assert.equal(nested.metadata.get("dc:creator"), "nested");
});

test("XML does not read a Dublin Core name whose prefix is bound to something else in that scope", async () => {
  // dc is Dublin Core outside and a foreign namespace inside the wrapper, so the inner title is not dc:title.
  const result = await parseXml(
    `<doc xmlns:dc="${DC}"><wrap xmlns:dc="urn:other"><dc:title>inner</dc:title></wrap><dc:subject>outer</dc:subject></doc>`,
  );
  assert.equal(result.metadata.get("dc:title"), null);
  assert.equal(result.metadata.get("dc:subject"), "outer");
});

test("XML does not read a Dublin Core name once xmlns=\"\" or the end of its scope has unbound it", async () => {
  const unbound = await parseXml(`<doc xmlns="${DC}"><wrap xmlns=""><title>none</title></wrap><subject>some</subject></doc>`);
  assert.equal(unbound.metadata.get("dc:title"), null);
  assert.equal(unbound.metadata.get("dc:subject"), "some");
  const afterScope = await parseXml(`<doc><wrap xmlns:dc="${DC}"><dc:title>in</dc:title></wrap><title>out</title></doc>`);
  assert.equal(afterScope.metadata.get("dc:title"), "in");
});

test("XML with a prefix that is not bound is a malformed document", async () => {
  await assert.rejects(parseXml("<doc><dc:title>x</dc:title></doc>"), MalformedDocumentError);
  await assert.rejects(parseXml('<doc a:b="1"/>'), MalformedDocumentError);
});

test("XML with a prefix bound to nothing, a rebound xmlns prefix or a duplicate expanded attribute is malformed", async () => {
  await assert.rejects(parseXml('<doc xmlns:a=""/>'), MalformedDocumentError);
  await assert.rejects(parseXml('<doc xmlns:xmlns="urn:x"/>'), MalformedDocumentError);
  await assert.rejects(parseXml('<doc xmlns:a="urn:x" xmlns:b="urn:x" a:k="1" b:k="2"/>'), MalformedDocumentError);
});

test("XML nested 40,000 deep reads in linear time (saxes with xmlns:true took 8.4 to 12.3 s here)", async () => {
  // A wall-clock assertion, with a bound loose enough (4 s) to hold on a loaded machine: the document is 280 KB, a
  // linear read takes well under a second, and the quadratic one this guards against took 8.4 to 12.3 s when measured.
  const depth = 40_000;
  const text = `${"<a>".repeat(depth)}x${"</a>".repeat(depth)}`;
  const started = performance.now();
  const result = await parseXml(text);
  const elapsed = performance.now() - started;
  assert.match(result.text, /x/);
  assert.ok(elapsed < 4_000, `took ${Math.round(elapsed)} ms`);
});
