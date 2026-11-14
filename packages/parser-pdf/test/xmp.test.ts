import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser } from "../src/index.ts";
import { infoXmpPdf, xmpPacket } from "./fixtures.ts";

/*
 * Expected values below are what a running Apache Tika 4.2.0 server answered on /rmeta for the same bytes (tikajs-kqmz).
 * Each case lists the keys that come from the Info dictionary and the XMP packet; the keys every PDF gets (Content-Type,
 * pdf:chars-per-page, ...) are not repeated.
 */
async function run(info: string | undefined, xmp: string | undefined): Promise<Metadata> {
  const bytes = infoXmpPdf({ ...(info === undefined ? {} : { info }), ...(xmp === undefined ? {} : { xmp }) });
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  try {
    await new PdfParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

/** Every metadata key the document's own metadata wrote, as `key -> all values`. */
function written(metadata: Metadata, prefixes: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of metadata.names().sort()) {
    // dc:format is the PDF parser's own ("application/pdf; version=1.7"), not the packet's.
    if (name !== "dc:format" && prefixes.some((prefix) => name.startsWith(prefix))) out[name] = [...metadata.getAll(name)];
  }
  return out;
}

const KEYS = ["dc:", "dcterms:", "xmp:", "meta:", "pdf:docinfo", "pdf:producer", "pdf:trapped", "pdfa", "pdfaid", "tiff:", "exif:", "xmp-raw:"];
const alt = (value: string, lang = "x-default"): string => `<rdf:li xml:lang="${lang}">${value}</rdf:li>`;

test("an XMP packet written as a mixed-case table in pdf.js is read by its real names (Info absent)", async () => {
  const xmp = xmpPacket(
    `<dc:title><rdf:Alt>${alt("My Title")}</rdf:Alt></dc:title>` +
      `<dc:creator><rdf:Seq><rdf:li>Alice</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>` +
      `<dc:subject><rdf:Bag><rdf:li>k1</rdf:li><rdf:li>k2</rdf:li></rdf:Bag></dc:subject>` +
      `<dc:format>application/pdf</dc:format>` +
      `<xmp:CreateDate>2010-05-04T08:43:54+02:00</xmp:CreateDate><xmp:CreatorTool>MyTool 1.0</xmp:CreatorTool>` +
      `<pdf:Producer>XmpProducer</pdf:Producer><pdf:Keywords>kw1, kw2</pdf:Keywords><x1:Custom>customvalue</x1:Custom>`,
  );
  assert.deepEqual(written(await run(undefined, xmp), KEYS), {
    "dc:creator": ["Alice", "Bob"],
    "dc:subject": ["k1", "k2", "kw1, kw2"],
    "dc:title": ["My Title"],
    "dc:title:x-default": ["My Title"],
    "dcterms:created": ["2010-05-04T06:43:54Z"],
    "meta:keyword": ["kw1, kw2"],
    "pdf:producer": ["XmpProducer"],
    "xmp-raw:x1:Custom": ["customvalue"],
    "xmp:CreateDate": ["2010-05-04T06:43:54Z"],
    "xmp:CreatorTool": ["MyTool 1.0"],
    "xmp:dc:creator": ["Alice", "Bob"],
    "xmp:dc:format": ["application/pdf"],
    "xmp:dc:subject": ["k1", "k2"],
    "xmp:dc:title": ["My Title"],
    "xmp:dc:title:x-default": ["My Title"],
    "xmp:pdf:Keywords": ["kw1, kw2"],
    "xmp:pdf:Producer": ["XmpProducer"],
  });
});

test("a title that is in both the Info dictionary and the packet is not doubled (\"My Title | My Title\")", async () => {
  const metadata = await run("<< /Title (My Title) >>", xmpPacket(`<dc:title><rdf:Alt>${alt("My Title")}</rdf:Alt></dc:title>`));
  assert.deepEqual(written(metadata, KEYS), {
    "dc:title": ["My Title"],
    "dc:title:x-default": ["My Title"],
    "pdf:docinfo:title": ["My Title"],
    "xmp:dc:title": ["My Title"],
    "xmp:dc:title:x-default": ["My Title"],
  });
});

test("the packet wins over the Info dictionary for title, author and producer, the Info dictionary for the dates", async () => {
  const info = "<< /Title (Info Title) /Author (Info Author) /Producer (InfoProducer) /CreationDate (D:20100504084354+02'00') >>";
  const xmp = xmpPacket(
    `<dc:title><rdf:Alt>${alt("XMP Title")}</rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>XMP Author</rdf:li></rdf:Seq></dc:creator>` +
      `<pdf:Producer>XmpProducer</pdf:Producer><xmp:CreateDate>2015-01-02T03:04:05Z</xmp:CreateDate>`,
  );
  const out = written(await run(info, xmp), KEYS);
  assert.deepEqual(out["dc:title"], ["XMP Title"]);
  assert.deepEqual(out["dc:creator"], ["XMP Author"]);
  assert.deepEqual(out["pdf:producer"], ["XmpProducer"]);
  assert.deepEqual(out["dcterms:created"], ["2010-05-04T06:43:54Z"]);
  assert.deepEqual(out["xmp:CreateDate"], ["2015-01-02T03:04:05Z"]);
  assert.deepEqual(out["pdf:docinfo:producer"], ["InfoProducer"]);
  assert.deepEqual(out["pdf:docinfo:title"], ["Info Title"]);
});

test("the Info dictionary alone: pdf:docinfo keys, no dc:description, keywords and subject under dc:subject", async () => {
  const info =
    "<< /Title (Info Title) /Author (Info Author) /Subject (Info Subj) /Keywords (ik1, ik2) /Creator (InfoCreator) " +
    "/Producer (InfoProducer) /CreationDate (D:20100504084354+02'00') /ModDate (D:20110605094455Z) /Trapped /True /Custom#20One (cv) >>";
  assert.deepEqual(written(await run(info, undefined), KEYS), {
    "dc:creator": ["Info Author"],
    "dc:subject": ["ik1, ik2", "Info Subj"],
    "dc:title": ["Info Title"],
    "dcterms:created": ["2010-05-04T06:43:54Z"],
    "dcterms:modified": ["2011-06-05T09:44:55Z"],
    "pdf:docinfo:created": ["2010-05-04T06:43:54Z"],
    "pdf:docinfo:creator": ["Info Author"],
    "pdf:docinfo:creator-tool": ["InfoCreator"],
    "pdf:docinfo:custom:Custom One": ["cv"],
    "pdf:docinfo:keywords": ["ik1, ik2"],
    "pdf:docinfo:modified": ["2011-06-05T09:44:55Z"],
    "pdf:docinfo:producer": ["InfoProducer"],
    "pdf:docinfo:subject": ["Info Subj"],
    "pdf:docinfo:title": ["Info Title"],
    "pdf:docinfo:trapped": ["True"],
    "pdf:producer": ["InfoProducer"],
    "pdf:trapped": ["True"],
    "xmp:CreatorTool": ["InfoCreator"],
  });
});

test("an XMP element named Content-Type is a value under xmp-raw:, never a metadata key of its own", async () => {
  const xmp = xmpPacket(`<dc:Content-Type>text/evil</dc:Content-Type><x1:Content-Type>ct</x1:Content-Type><xmp:Foo>bar</xmp:Foo>`);
  const metadata = await run(undefined, xmp);
  // (The facade sets Content-Type; the parser run alone leaves it empty, and the packet must not fill it.)
  assert.deepEqual(metadata.getAll("Content-Type"), []);
  assert.deepEqual(written(metadata, ["xmp-raw:", "dc:"]), {
    "xmp-raw:dc:Content-Type": ["text/evil"],
    "xmp-raw:x1:Content-Type": ["ct"],
    "xmp-raw:xmp:Foo": ["bar"],
  });
});

test("language alternatives: the x-default first, one key per language, the single-valued copy keeps the default", async () => {
  const xmp = xmpPacket(
    `<dc:title><rdf:Alt>${alt("Fr", "fr")}${alt("Def")}${alt("De", "de")}</rdf:Alt></dc:title>` +
      `<dc:rights><rdf:Alt>${alt("OnlyDe", "de")}${alt("OnlyFr", "fr")}</rdf:Alt></dc:rights>`,
  );
  assert.deepEqual(written(await run(undefined, xmp), ["dc:", "xmp:dc:"]), {
    "dc:rights": ["OnlyDe", "OnlyFr"],
    "dc:rights:de": ["OnlyDe"],
    "dc:rights:fr": ["OnlyFr"],
    "dc:title": ["Def", "Fr", "De"],
    "dc:title:de": ["De"],
    "dc:title:fr": ["Fr"],
    "dc:title:x-default": ["Def"],
    "xmp:dc:rights": ["OnlyDe"],
    "xmp:dc:rights:de": ["OnlyDe"],
    "xmp:dc:rights:fr": ["OnlyFr"],
    "xmp:dc:title": ["Def"],
    "xmp:dc:title:de": ["De"],
    "xmp:dc:title:fr": ["Fr"],
    "xmp:dc:title:x-default": ["Def"],
  });
});

test("structs and attributes: xmp-raw paths, History field by field, PDF/A version, a fallback date from exif", async () => {
  const xmp = xmpPacket(
    `<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>saved</stEvt:action><stEvt:when>2020-01-01T00:00:00+01:00</stEvt:when></rdf:li>` +
      `<rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action></rdf:li></rdf:Seq></xmpMM:History>` +
      `<pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>` +
      `<x1:Struct rdf:parseType="Resource"><x1:inner>in</x1:inner></x1:Struct><x1:Link rdf:resource="http://link/"/>` +
      `<x1:Arr><rdf:Seq><rdf:li rdf:parseType="Resource"><x1:a>1</x1:a></rdf:li><rdf:li rdf:parseType="Resource"><x1:a>3</x1:a></rdf:li></rdf:Seq></x1:Arr>`,
    `xmp:CreatorTool="AttrTool" pdf:Producer="AttrProducer"`,
  );
  const out = written(await run(undefined, xmp), ["xmp-raw:", "xmpMM:", "pdfa", "xmp:CreatorTool", "pdf:producer"]);
  assert.deepEqual(out, {
    "pdf:producer": ["AttrProducer"],
    "pdfa:pdf-version": ["A-1b"],
    "pdfaid:conformance": ["B"],
    "pdfaid:part": ["1"],
    "xmp-raw:x1:Arr[1]/x1:a": ["1"],
    "xmp-raw:x1:Arr[2]/x1:a": ["3"],
    "xmp-raw:x1:Link": ["http://link/"],
    "xmp-raw:x1:Struct/x1:inner": ["in"],
    "xmp:CreatorTool": ["AttrTool"],
    "xmpMM:History:Action": ["saved", "created"],
    "xmpMM:History:When": ["2019-12-31T23:00:00Z", ""],
  });
});

test("a packet that is not well-formed XML is noted and contributes nothing, and the Info dictionary still reads", async () => {
  const metadata = await run("<< /Title (Info Title) >>", xmpPacket(`<dc:title>unclosed`));
  assert.equal(metadata.get("dc:title"), "Info Title");
  assert.equal(metadata.getAll("tk:exception:warn").length, 1);
  assert.deepEqual(written(metadata, ["xmp:dc", "xmp-raw:"]), {});
});

test("a date in the Info dictionary that does not exist writes no key, canonical or pdf:docinfo", async () => {
  const metadata = await run("<< /CreationDate (D:20100230120000Z) /ModDate (D:20101340250000Z) >>", undefined);
  assert.deepEqual(written(metadata, ["dcterms:", "pdf:docinfo"]), {});
});
