import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { IDMLParser } from "../src/index.ts";

/*
 * Ported from the cases of Tika 4.2.0's IDMLParserTest, with archives built here instead of its fixture. The
 * expectations are what IDMLParser.java and ContentAndMetadataExtractor.java do when read; none of this was run
 * against a Tika. XmpExtractor is only ported for four xmp: properties (see idml.ts).
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const IDML_TYPE = "application/vnd.adobe.indesign-idml-package";

function archive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) files[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(files);
}

interface Result {
  readonly metadata: Metadata;
  readonly xml: string;
}

async function run(entries: Record<string, string | Uint8Array>, context = new ParseContext()): Promise<Result> {
  const stream = await RipstreamInputStream.from(archive(entries));
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new IDMLParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

function spread(pageCounts: readonly (string | null)[], content = ""): string {
  const spreads = pageCounts
    .map((count) => (count === null ? "<Spread/>" : `<Spread PageCount="${count}"/>`))
    .join("");
  return `${XML_HEAD}<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">${spreads}${content}</idPkg:Spread>`;
}

function masterSpread(pageCounts: readonly (string | null)[]): string {
  const spreads = pageCounts
    .map((count) => (count === null ? "<MasterSpread/>" : `<MasterSpread PageCount="${count}"/>`))
    .join("");
  return `${XML_HEAD}<idPkg:MasterSpread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">${spreads}</idPkg:MasterSpread>`;
}

function story(...texts: string[]): string {
  const runs = texts.map((text) => `<CharacterStyleRange><Content>${text}</Content><Br/></CharacterStyleRange>`).join("");
  return `${XML_HEAD}<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u1">${runs}</Story></idPkg:Story>`;
}

function xmp(properties: string, descriptionAttributes = ""): string {
  return `${XML_HEAD}<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c145">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" ${descriptionAttributes}>
      ${properties}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="r"?>`;
}

test("the page counts, the text and the type of a package", async () => {
  const result = await run({
    mimetype: IDML_TYPE,
    "MasterSpreads/MasterSpread_ua.xml": masterSpread(["2"]),
    "Spreads/Spread_ub.xml": spread(["1"]),
    "Stories/Story_uc.xml": story("Lorem ipsum dolor sit amet", "Second paragraph"),
  });
  assert.equal(result.metadata.get("meta:page-count"), "3");
  assert.equal(result.metadata.get("idml:master-spread-page-count"), "2");
  assert.equal(result.metadata.get("idml:spread-page-count"), "1");
  assert.equal(result.metadata.get("Content-Type"), IDML_TYPE);
  assert.match(result.xml, /<p>Lorem ipsum dolor sit amet<\/p>/);
  assert.match(result.xml, /<p>Second paragraph<\/p>/);
});

test("a PageCount is a Java int: a sign is allowed, a value past an int adds nothing, and the sum wraps", async () => {
  const pages = async (counts: readonly string[], masters: readonly string[] = []): Promise<Result> =>
    run({ "Spreads/Spread_u1.xml": spread(counts), "MasterSpreads/MasterSpread_u1.xml": masterSpread(masters) });
  assert.equal((await pages(["+3", " 4 "])).metadata.get("idml:spread-page-count"), "7");
  assert.equal((await pages(["-2", "5"])).metadata.get("idml:spread-page-count"), "3");
  assert.equal((await pages(["2147483647"])).metadata.get("idml:spread-page-count"), "2147483647");
  assert.equal((await pages(["-2147483648"])).metadata.get("idml:spread-page-count"), "-2147483648");
  assert.equal((await pages(["2147483648"])).metadata.get("idml:spread-page-count"), "0");
  assert.equal((await pages(["-2147483649"])).metadata.get("idml:spread-page-count"), "0");
  assert.equal((await pages(["2147483647", "1"])).metadata.get("idml:spread-page-count"), "-2147483648");
  assert.equal((await pages(["2147483647"], ["1"])).metadata.get("meta:page-count"), "-2147483648");
});

test("only Content elements are text, kept as written, and a Content is its own paragraph", async () => {
  const result = await run({
    "Stories/Story_u1.xml": `${XML_HEAD}<Story><Properties><Label>hidden</Label></Properties><Content> a  b </Content>between<Content>c</Content></Story>`,
  });
  assert.match(result.xml, /<p> a {2}b <\/p>/);
  assert.match(result.xml, /<p>c<\/p>/);
  assert.doesNotMatch(result.xml, /hidden|between/);
});

test("text follows the archive order, and an entry is matched by its name containing the folder", async () => {
  const result = await run({
    "Stories/Story_u1.xml": story("first"),
    "designmap.xml": `${XML_HEAD}<Document><Content>never read</Content></Document>`,
    "Resources/Styles.xml": `${XML_HEAD}<Styles><Content>never read either</Content></Styles>`,
    "Stories/Story_u2.xml": story("second"),
    "Archive/Spreads/Spread_u3.xml": spread(["4"], "<Content>in a spread</Content>"),
    "Archive/Stories/Story_u4.xml": story("third"),
  });
  assert.deepEqual([...result.xml.matchAll(/<p>([^<]*)<\/p>/g)].map((match) => match[1]), [
    "first",
    "second",
    "in a spread",
    "third",
  ]);
  assert.equal(result.metadata.get("idml:spread-page-count"), "4");
});

test("the counts add up across files and Spread elements, and a bad PageCount counts as nothing", async () => {
  const result = await run({
    "Spreads/Spread_u1.xml": spread(["2", "3"]),
    "Spreads/Spread_u2.xml": spread([" 4 ", "many", null]),
    "MasterSpreads/MasterSpread_u3.xml": masterSpread(["1"]),
    "MasterSpreads/MasterSpread_u4.xml": masterSpread(["5"]),
  });
  assert.equal(result.metadata.get("idml:spread-page-count"), "9");
  assert.equal(result.metadata.get("idml:master-spread-page-count"), "6");
  assert.equal(result.metadata.get("meta:page-count"), "15");
});

test("a package with no spreads reports zero pages", async () => {
  const result = await run({ "Stories/Story_u1.xml": story("text") });
  assert.equal(result.metadata.get("idml:spread-page-count"), "0");
  assert.equal(result.metadata.get("idml:master-spread-page-count"), "0");
  assert.equal(result.metadata.get("meta:page-count"), "0");
});

test("a spread file with no Spread or MasterSpread element fails the parse, as Integer.parseInt(null) does in Tika", async () => {
  await assert.rejects(run({ "Spreads/Spread_u1.xml": `${XML_HEAD}<Other/>` }), MalformedDocumentError);
  await assert.rejects(run({ "MasterSpreads/MasterSpread_u1.xml": `${XML_HEAD}<Other/>` }), MalformedDocumentError);
});

test("the idPkg:Spread wrapper of a spread file is a Spread by its local name, with no pages of its own", async () => {
  const result = await run({
    "Spreads/Spread_u1.xml": `${XML_HEAD}<idPkg:Spread xmlns:idPkg="urn:x"><Other/></idPkg:Spread>`,
  });
  assert.equal(result.metadata.get("idml:spread-page-count"), "0");
});

test("a story that is not well-formed fails the parse", async () => {
  await assert.rejects(run({ "Stories/Story_u1.xml": `${XML_HEAD}<Story><Content>cut off` }), MalformedDocumentError);
});

test("the counts are not carried from one parse to the next", async () => {
  const parser = new IDMLParser();
  for (let round = 0; round < 2; round++) {
    const stream = await RipstreamInputStream.from(archive({ "Spreads/Spread_u1.xml": spread(["1"]) }));
    const metadata = new Metadata();
    await parser.parse(stream, createOutputHandler("xml"), metadata, new ParseContext());
    await stream.close();
    assert.equal(metadata.get("meta:page-count"), "1");
  }
});

test("XMP: the creation and modification dates in UTC, the creator tool, and the canonical dates when absent", async () => {
  const result = await run({
    "META-INF/metadata.xml": xmp(`
      <xmp:CreateDate>2020-09-20T21:07:44+01:00</xmp:CreateDate>
      <xmp:MetadataDate>2019-11-20T21:37:24Z</xmp:MetadataDate>
      <xmp:ModifyDate>2020-09-21T08:00:00Z</xmp:ModifyDate>
      <xmp:CreatorTool>Adobe InDesign CC 14.0 (Windows)</xmp:CreatorTool>`),
    "Stories/Story_u1.xml": story("text"),
  });
  assert.equal(result.metadata.get("xmp:CreateDate"), "2020-09-20T20:07:44Z");
  assert.equal(result.metadata.get("xmp:ModifyDate"), "2020-09-21T08:00:00Z");
  assert.equal(result.metadata.get("xmp:MetadataDate"), "2019-11-20T21:37:24Z");
  assert.equal(result.metadata.get("xmp:CreatorTool"), "Adobe InDesign CC 14.0 (Windows)");
  assert.equal(result.metadata.get("dcterms:created"), "2020-09-20T20:07:44Z");
  assert.equal(result.metadata.get("dcterms:modified"), "2020-09-21T08:00:00Z");
  assert.match(result.xml, /<meta name="xmp:CreatorTool" content="Adobe InDesign CC 14.0 \(Windows\)"><\/meta>/);
});

test("XMP properties written as attributes of rdf:Description are read as well", async () => {
  const result = await run({
    "META-INF/metadata.xml": xmp("", 'xmp:CreatorTool="As an attribute" xmp:CreateDate="2021-01-02T03:04:05-02:00"'),
  });
  assert.equal(result.metadata.get("xmp:CreatorTool"), "As an attribute");
  assert.equal(result.metadata.get("xmp:CreateDate"), "2021-01-02T05:04:05Z");
});

test("XMP: a date that is not one is kept as written on the xmp key and not used for the canonical one", async () => {
  const result = await run({ "META-INF/metadata.xml": xmp("<xmp:CreateDate>last Tuesday</xmp:CreateDate>") });
  assert.equal(result.metadata.get("xmp:CreateDate"), "last Tuesday");
  assert.equal(result.metadata.get("dcterms:created"), null);
});

test("XMP: nested properties and other namespaces are not taken for the top-level xmp ones", async () => {
  const result = await run({
    "META-INF/metadata.xml": xmp(`
      <dc:creator><rdf:Bag><rdf:li>Someone</rdf:li></rdf:Bag></dc:creator>
      <xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmp:CreatorTool>nested</xmp:CreatorTool></rdf:li></rdf:Alt></xmp:Thumbnails>
      <other:CreatorTool xmlns:other="urn:other">elsewhere</other:CreatorTool>`),
  });
  assert.equal(result.metadata.get("xmp:CreatorTool"), null);
});

test("XMP: the prefix is whatever the packet declares for the namespace", async () => {
  const packet = `${XML_HEAD}<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:adobe="http://ns.adobe.com/xap/1.0/"><adobe:CreatorTool>Renamed prefix</adobe:CreatorTool></r:Description></r:RDF></x:xmpmeta>`;
  const result = await run({ "META-INF/metadata.xml": packet });
  assert.equal(result.metadata.get("xmp:CreatorTool"), "Renamed prefix");
});

test("malformed XMP is recorded as a warning and does not fail the package", async () => {
  const result = await run({
    "META-INF/metadata.xml": `${XML_HEAD}<x:xmpmeta xmlns:x="adobe:ns:meta/"><oops>`,
    "Spreads/Spread_u1.xml": spread(["2"]),
    "Stories/Story_u1.xml": story("still parsed"),
  });
  assert.match(result.metadata.get("tk:exception:warn") ?? "", /^MalformedDocumentError: /);
  assert.equal(result.metadata.get("meta:page-count"), "2");
  assert.match(result.xml, /<p>still parsed<\/p>/);
});

test("the XMP is read before the other entries whatever its place in the archive", async () => {
  const result = await run({
    "Stories/Story_u1.xml": story("text"),
    "META-INF/metadata.xml": xmp("<xmp:CreatorTool>First</xmp:CreatorTool>"),
  });
  assert.equal(result.metadata.get("xmp:CreatorTool"), "First");
  // The head of the output carries the metadata, so it is known before the body starts.
  assert.ok(result.xml.indexOf("xmp:CreatorTool") < result.xml.indexOf("<p>text</p>"));
});

test("supports the one IDML type", () => {
  assert.deepEqual([...new IDMLParser().getSupportedTypes()].map((type) => type.toString()), [IDML_TYPE]);
});

test("a hostile archive is refused, not expanded: an entry bomb, too many entries, and a bomb among the stories", async () => {
  const bomb = await RipstreamInputStream.from(
    archive({ "Stories/Story_u1.xml": new Uint8Array(5_000_000), "Stories/Story_u2.xml": new Uint8Array(5_000_000) }),
  );
  await assert.rejects(
    new IDMLParser().parse(bomb, createOutputHandler("xml"), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await bomb.close();

  const many: Record<string, string> = {};
  for (let index = 0; index < 20; index++) many[`Stories/Story_u${index}.xml`] = story("x");
  const crowded = await RipstreamInputStream.from(archive(many));
  await assert.rejects(
    new IDMLParser().parse(
      crowded,
      createOutputHandler("xml"),
      new Metadata(),
      new ParseContext({ limits: { maxZipEntries: 10 } }),
    ),
    LimitExceededError,
  );
  await crowded.close();

  const hostileXmp = await RipstreamInputStream.from(archive({ "META-INF/metadata.xml": new Uint8Array(5_000_000) }));
  await assert.rejects(
    new IDMLParser().parse(hostileXmp, createOutputHandler("xml"), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await hostileXmp.close();
});
