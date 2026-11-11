import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import { extractBasicXmp } from "../src/xmp-basic.ts";

/*
 * The narrow XMP reader of IDML, on its own: four xmp properties, read as Tika's XmpExtractor and XmpSaxFlattener do
 * when read; none of this was run against a Tika.
 */

const HEAD =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/">';
const TAIL = "</rdf:Description></rdf:RDF></x:xmpmeta>";

async function read(properties: string, metadata = new Metadata()): Promise<Metadata> {
  await extractBasicXmp(HEAD + properties + TAIL, metadata);
  return metadata;
}

test("the dates fill dcterms:created and dcterms:modified only when those are not set", async () => {
  const empty = await read(
    "<xmp:CreateDate>2020-01-02T03:04:05Z</xmp:CreateDate><xmp:ModifyDate>2021-01-02T03:04:05Z</xmp:ModifyDate>",
  );
  assert.equal(empty.get("dcterms:created"), "2020-01-02T03:04:05Z");
  assert.equal(empty.get("dcterms:modified"), "2021-01-02T03:04:05Z");

  const set = new Metadata();
  set.set("dcterms:created", "1999-12-31T23:59:59Z");
  await read("<xmp:CreateDate>2020-01-02T03:04:05Z</xmp:CreateDate>", set);
  assert.equal(set.get("dcterms:created"), "1999-12-31T23:59:59Z");
  assert.equal(set.get("xmp:CreateDate"), "2020-01-02T03:04:05Z");
});

test("a property with a language is an alternative, which is not read", async () => {
  const metadata = await read('<xmp:CreatorTool xml:lang="en">Localised</xmp:CreatorTool>');
  assert.equal(metadata.get("xmp:CreatorTool"), null);
  // An xml:lang of only blanks is none.
  assert.equal((await read('<xmp:CreatorTool xml:lang=" ">Plain</xmp:CreatorTool>')).get("xmp:CreatorTool"), "Plain");
});

test("a property that has properties of its own is a struct, not a value", async () => {
  const metadata = await read("<xmp:CreatorTool>Outer<xmp:Sub>inner</xmp:Sub></xmp:CreatorTool>");
  assert.equal(metadata.get("xmp:CreatorTool"), null);
});

test("a value is trimmed as Java's String.trim does, and one that is only blanks is no value", async () => {
  assert.equal((await read("<xmp:CreatorTool> \n\tTool\r </xmp:CreatorTool>")).get("xmp:CreatorTool"), "Tool");
  assert.equal((await read("<xmp:CreatorTool> \n </xmp:CreatorTool>")).get("xmp:CreatorTool"), null);
});

test("a value of a mebibyte is read, and one character more is dropped: the limit is on the trimmed value", async () => {
  const limit = 1 << 20;
  const tool = async (text: string): Promise<string | null> =>
    (await read(`<xmp:CreatorTool>${text}</xmp:CreatorTool>`)).get("xmp:CreatorTool");
  assert.equal((await tool("a".repeat(limit)))?.length, limit);
  assert.equal(await tool("a".repeat(limit + 1)), null);
  // XmpSaxFlattener trims before it counts, so the blanks around a value of exactly the limit do not count.
  assert.equal((await tool(` ${"a".repeat(limit)}\n`))?.length, limit);
});

test("elements too deep to look at do not disturb what comes after them, such as a prefix redeclared around them", async () => {
  // The outermost container rebinds xmp for the span of the container; the property after it has the binding of before.
  const deep = `<rdf:Bag xmlns:xmp="urn:other">${"<rdf:Bag>".repeat(12)}<xmp:Skipped>x</xmp:Skipped>${"</rdf:Bag>".repeat(12)}</rdf:Bag>`;
  const metadata = await read(`${deep}<xmp:CreatorTool>After</xmp:CreatorTool>`);
  assert.equal(metadata.get("xmp:CreatorTool"), "After");
});

test("elements nested more than sixteen deep are not looked at", async () => {
  // The property sits below xmpmeta, RDF, Description and the containers: at depth 16 it is read, at 17 it is not.
  const nested = (containers: number): string =>
    `${HEAD}${"<rdf:Bag>".repeat(containers)}<xmp:CreatorTool>Deep</xmp:CreatorTool>${"</rdf:Bag>".repeat(containers)}${TAIL}`;
  const read16 = new Metadata();
  await extractBasicXmp(nested(12), read16);
  assert.equal(read16.get("xmp:CreatorTool"), "Deep");
  const read17 = new Metadata();
  await extractBasicXmp(nested(13), read17);
  assert.equal(read17.get("xmp:CreatorTool"), null);
});
