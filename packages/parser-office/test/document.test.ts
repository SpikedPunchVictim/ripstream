import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { EpubParser, OpenDocumentParser } from "../src/index.ts";
import { MAX_ODF_META_DEPTH, applyOdfMetadata } from "../src/odf-meta.ts";
import { Recorder } from "./iwork-harness.ts";

async function run(
  parser: OpenDocumentParser | EpubParser,
  files: Record<string, string>,
): Promise<{ text: string; metadata: Metadata }> {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = strToU8(value);
  const stream = await RipstreamInputStream.from(zipSync(archive));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  // An EPUB hands its non-chapter items to the extractor, and a bare context has no parser to give the default one.
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, new Recorder());
  await parser.parse(stream, handler, metadata, context);
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts ODT text and metadata", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>Hello ODF</text:p><text:h>Heading</text:h></office:text></office:body></office:document-content>',
    "meta.xml":
      '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><dc:title>ODF Doc</dc:title><dc:creator>Ada</dc:creator><meta:generator>Writer</meta:generator></office:meta></office:document-meta>',
  });
  assert.match(result.text, /Hello ODF/);
  assert.match(result.text, /Heading/);
  assert.equal(result.metadata.get("dc:title"), "ODF Doc");
  assert.equal(result.metadata.get("dc:creator"), "Ada");
  assert.equal(result.metadata.get("generator"), "Writer");
});

test("extracts ODT tables, lists, notes and statistics", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>' +
      "<text:p>Intro</text:p>" +
      "<table:table><table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell></table:table-row></table:table>" +
      "<text:list><text:list-item><text:p>First item</text:p></text:list-item><text:list-item><text:p>Second item</text:p></text:list-item></text:list>" +
      "<text:p>Cite<text:note><text:note-body><text:p>Note body</text:p></text:note-body></text:note></text:p>" +
      "</office:text></office:body></office:document-content>",
    "meta.xml":
      '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator>Writer</meta:generator><meta:document-statistic meta:word-count="42" meta:page-count="3"/></office:meta></office:document-meta>',
  });
  assert.match(result.text, /A1/);
  assert.match(result.text, /B1/);
  assert.match(result.text, /First item/);
  assert.match(result.text, /Note body/);
  assert.equal(result.metadata.get("meta:word-count"), "42");
  assert.equal(result.metadata.get("meta:page-count"), "3");
});

test("extracts ODP slides and speaker notes", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.presentation",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t" xmlns:presentation="pr"><office:body><office:presentation>' +
      "<draw:page><draw:frame><draw:text-box><text:p>Slide body</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Speaker note</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>" +
      "</office:presentation></office:body></office:document-content>",
  });
  assert.match(result.text, /Slide body/);
  assert.match(result.text, /Speaker note/);
});

const OFFICE_NS = 'xmlns:office="o" xmlns:text="t" xmlns:table="tb" xmlns:chart="c"';

test("supports the ODF types Tika's OpenDocumentParser registers beyond the original eight (tikajs-68os.12)", () => {
  const supported = new Set([...new OpenDocumentParser().getSupportedTypes()].map((type) => type.toString()));
  for (const extra of [
    "application/vnd.sun.xml.writer",
    "application/vnd.oasis.opendocument.chart",
    "application/vnd.oasis.opendocument.chart-template",
    "application/vnd.oasis.opendocument.image",
    "application/vnd.oasis.opendocument.image-template",
    "application/vnd.oasis.opendocument.formula",
    "application/vnd.oasis.opendocument.formula-template",
    "application/vnd.oasis.opendocument.text-master",
    "application/vnd.oasis.opendocument.text-web",
  ]) {
    assert.ok(supported.has(extra), `${extra} is supported`);
  }
});

test("extracts an ODF chart's titles and its data table through the header and body row groups", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.chart",
    "content.xml":
      `<office:document-content ${OFFICE_NS}><office:body><office:chart><chart:chart>` +
      "<chart:title><text:p>Quarterly sales</text:p></chart:title>" +
      "<chart:subtitle><text:p>Fiscal 2024</text:p></chart:subtitle>" +
      "<chart:plot-area><chart:axis><chart:title><text:p>Revenue axis</text:p></chart:title></chart:axis>" +
      "<table:table>" +
      "<table:table-header-rows><table:table-row><table:table-cell><text:p>Region</text:p></table:table-cell><table:table-cell><text:p>Q1</text:p></table:table-cell></table:table-row></table:table-header-rows>" +
      "<table:table-rows><table:table-row><table:table-cell><text:p>North</text:p></table:table-cell><table:table-cell><text:p>42</text:p></table:table-cell></table:table-row></table:table-rows>" +
      "</table:table></chart:plot-area></chart:chart></office:chart></office:body></office:document-content>",
    "meta.xml":
      '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Sales chart</dc:title></office:meta></office:document-meta>',
  });
  for (const expected of ["Quarterly sales", "Fiscal 2024", "Revenue axis", "Region", "Q1", "North", "42"]) {
    assert.ok(result.text.includes(expected), `${expected} in ${JSON.stringify(result.text)}`);
  }
  assert.equal(result.metadata.get("dc:title"), "Sales chart");
});

test("extracts the rows of a table whose rows sit in header, body and group wrappers", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      `<office:document-content ${OFFICE_NS}><office:body><office:text><table:table>` +
      "<table:table-header-rows><table:table-row><table:table-cell><text:p>Head</text:p></table:table-cell></table:table-row></table:table-header-rows>" +
      "<table:table-row-group><table:table-row><table:table-cell><text:p>Grouped</text:p></table:table-cell></table:table-row></table:table-row-group>" +
      "<table:table-rows><table:table-row><table:table-cell><text:p>Body</text:p></table:table-cell></table:table-row></table:table-rows>" +
      "</table:table></office:text></office:body></office:document-content>",
  });
  for (const expected of ["Head", "Grouped", "Body"]) {
    assert.ok(result.text.includes(expected), `${expected} in ${JSON.stringify(result.text)}`);
  }
});

test("a formula document has no text, as Tika's does not (MathML is not rendered)", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.formula",
    "content.xml":
      '<math:math xmlns:math="http://www.w3.org/1998/Math/MathML"><math:semantics><math:mi>x</math:mi></math:semantics></math:math>',
    "meta.xml":
      '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Pangram</dc:title></office:meta></office:document-meta>',
  });
  assert.equal(result.text.trim(), "");
  assert.equal(result.metadata.get("dc:title"), "Pangram");
});

test("an ODF text master and a StarOffice 6 writer file (no mimetype entry) give their paragraphs", async () => {
  const master = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text-master",
    "content.xml":
      `<office:document-content ${OFFICE_NS}><office:body><office:text><text:section><text:p>Master text</text:p></text:section></office:text></office:body></office:document-content>`,
  });
  assert.match(master.text, /Master text/);
  const sxw = await run(new OpenDocumentParser(), {
    "content.xml":
      `<office:document-content ${OFFICE_NS}><office:body><text:p>Writer six</text:p></office:body></office:document-content>`,
    "meta.xml": '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Old writer</dc:title></office:meta></office:document-meta>',
  });
  assert.match(sxw.text, /Writer six/);
  assert.equal(sxw.metadata.get("dc:title"), "Old writer");
});

test("extracts EPUB spine text and OPF metadata", async () => {
  const result = await run(new EpubParser(), {
    "META-INF/container.xml":
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    "OEBPS/content.opf":
      '<package><metadata><dc:title>Book</dc:title><dc:creator>Grace</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="c1" href="chap1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    "OEBPS/chap1.xhtml":
      "<html><body><h1>Chapter</h1><p>Hello EPUB</p></body></html>",
  });
  assert.match(result.text, /Chapter/);
  assert.match(result.text, /Hello EPUB/);
  assert.equal(result.metadata.get("dc:title"), "Book");
  assert.equal(result.metadata.get("dc:creator"), "Grace");
});

test("names the package file when an EPUB package document is not well-formed (tikajs-ibvq)", async () => {
  await assert.rejects(
    run(new EpubParser(), {
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
      "c.opf": "<package><metadata></package>",
    }),
    (error: unknown) =>
      error instanceof MalformedDocumentError && /EPUB package document is not well-formed/.test(error.message),
  );
});

// Oracle (Tika 4.2.0 /rmeta, tikajs-ibvq): the chapter's failure is a TIKA-237 container exception, not a failed parse; the text before
// the error is written. The record names the chapter instead of surfacing the raw saxes error.
test("names the chapter in the recorded failure when an EPUB chapter is not well-formed (tikajs-ibvq)", async () => {
  const result = await run(new EpubParser(), {
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    "c.opf": '<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
    "a.xhtml": "<html><body><p><b>x</p></b></body></html>",
  });
  assert.match(result.metadata.get("tk:exception:container-exception") ?? "", /EPUB chapter a\.xhtml is not well-formed/);
  assert.match(result.text, /x/);
});

test("extracts EPUB3 nav, cover and multiple creators", async () => {
  const result = await run(new EpubParser(), {
    "META-INF/container.xml":
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    "OEBPS/content.opf":
      '<package><metadata><dc:title>Nav Book</dc:title><dc:creator>Ada</dc:creator><dc:creator>Grace</dc:creator><meta property="dcterms:modified">2024-01-01T00:00:00Z</meta></metadata>' +
      '<manifest><item id="nav" href="nav.xhtml" properties="nav"/><item id="cover" href="cover.jpg" properties="cover-image"/><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>',
    "OEBPS/nav.xhtml":
      '<html><body><nav epub:type="toc"><ol><li><a href="chap1.xhtml">Chapter One</a></li></ol></nav></body></html>',
    "OEBPS/chap1.xhtml": "<html><body><p>Body</p></body></html>",
  });
  assert.match(result.text, /Body/);
  assert.deepEqual(result.metadata.getAll("dc:creator"), ["Ada", "Grace"]);
  assert.equal(result.metadata.get("epub:cover"), "OEBPS/cover.jpg");
  assert.deepEqual(result.metadata.getAll("epub:toc"), ["Chapter One"]);
  assert.equal(
    result.metadata.get("dcterms:modified"),
    "2024-01-01T00:00:00Z",
  );
});

test("clamps ODF text:s counts", async () => {
  const content = (c: string): string =>
    `<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>a<text:s text:c="${c}"/>b</text:p></office:text></office:body></office:document-content>`;
  for (const c of ["400000000", "-5", "abc"]) {
    const result = await run(new OpenDocumentParser(), {
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml": content(c),
    });
    assert.ok(result.text.length < 20_000, `c=${c}`);
  }
});

test("ODF and EPUB reject zip entries that exceed the decompression limits", async () => {
  const bomb = zipSync({
    "content.xml": new Uint8Array(5_000_000),
    "META-INF/container.xml": new Uint8Array(5_000_000),
  });
  for (const parser of [new OpenDocumentParser(), new EpubParser()]) {
    const stream = await RipstreamInputStream.from(bomb);
    await assert.rejects(
      parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
      LimitExceededError,
    );
    await stream.close();
  }
});

// meta.xml handling follows Tika 4.2.0's OpenDocumentMetaParser and the handlers it composes, read from the source and
// ODFParserTest; not run against a Tika (tikajs-68os.48).
const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';

async function odfMetadata(metaXml: string): Promise<Metadata> {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>x</text:p></office:text></office:body></office:document-content>',
    "meta.xml": metaXml,
  });
  return result.metadata;
}

test("ODF keywords are joined into meta:keyword and come first in dc:subject, ahead of the subject", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><meta:keyword>Pangram</meta:keyword><meta:keyword>fox</meta:keyword><dc:subject>Gym class</dc:subject></office:meta></office:document-meta>`,
  );
  assert.deepEqual(metadata.getAll("meta:keyword"), ["Pangram, fox"]);
  assert.deepEqual(metadata.getAll("dc:subject"), ["Pangram, fox", "Gym class"]);
});

test("an ODF subject is copied to an empty dc:description, and does not replace one that is there", async () => {
  const copied = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><dc:subject>Only subject</dc:subject></office:meta></office:document-meta>`,
  );
  assert.equal(copied.get("dc:description"), "Only subject");
  const kept = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><dc:description>Described</dc:description><dc:subject>Subject</dc:subject></office:meta></office:document-meta>`,
  );
  assert.deepEqual(kept.getAll("dc:description"), ["Described"]);
});

test("ODF initial-creator and dc:creator share dc:creator in document order, without a repeat", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><meta:initial-creator>Ada</meta:initial-creator><dc:creator>Grace</dc:creator><dc:creator>Ada</dc:creator></office:meta></office:document-meta>`,
  );
  assert.deepEqual(metadata.getAll("dc:creator"), ["Ada", "Grace"]);
});

test("ODF dc:title, dc:contributor and the other Dublin Core bags keep each distinct value", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><dc:title>One</dc:title><dc:title>Two</dc:title><dc:title>One</dc:title><dc:language>en-US</dc:language><dc:publisher>P</dc:publisher></office:meta></office:document-meta>`,
  );
  assert.deepEqual(metadata.getAll("dc:title"), ["One", "Two"]);
  assert.equal(metadata.get("dc:language"), "en-US");
  assert.equal(metadata.get("dc:publisher"), "P");
});

test("ODF writes generator, editing-cycles and editing-duration under Tika's keys, and the statistics twice for the page count", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS} office:version="1.2"><office:meta><meta:generator>Writer</meta:generator><meta:editing-cycles>3</meta:editing-cycles><meta:editing-duration>PT1M7S</meta:editing-duration><meta:document-statistic meta:page-count=" 4 " meta:character-count="9"/></office:meta></office:document-meta>`,
  );
  assert.equal(metadata.get("generator"), "Writer");
  assert.equal(metadata.get("editing-cycles"), "3");
  assert.equal(metadata.get("extended-properties:TotalTime"), "PT1M7S");
  assert.equal(metadata.get("odf:version"), "1.2");
  assert.equal(metadata.get("meta:page-count"), "4");
  assert.equal(metadata.get("xmpTPg:NPages"), "4");
  assert.equal(metadata.get("meta:character-count"), "9");
});

test("ODF writes only Tika's keys, not the four pre-parity ones", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><meta:generator>Writer</meta:generator><meta:editing-cycles>3</meta:editing-cycles><meta:initial-creator>Ada</meta:initial-creator><meta:keyword>k</meta:keyword></office:meta></office:document-meta>`,
  );
  assert.equal(metadata.get("generator"), "Writer");
  assert.equal(metadata.get("editing-cycles"), "3");
  assert.equal(metadata.get("dc:creator"), "Ada");
  assert.equal(metadata.get("pdf:Keywords"), null);
  assert.equal(metadata.get("meta:editing-cycles"), null);
  assert.equal(metadata.get("meta:initial-creator"), null);
});

test("ODF user-defined properties become custom:<name>; one without text adds nothing", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><meta:user-defined meta:name="Info 1">Text 1</meta:user-defined><meta:user-defined meta:name="Info 2"/><meta:user-defined meta:name="Info 1">Text 2</meta:user-defined></office:meta></office:document-meta>`,
  );
  assert.deepEqual(metadata.getAll("custom:Info 1"), ["Text 1", "Text 2"]);
  assert.equal(metadata.get("custom:Info 2"), null);
});

test("ODF dates are Tika date strings, and a value that is not a date is dropped", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS}><office:meta><meta:creation-date>2009-10-05T19:04:01</meta:creation-date><dc:date>not a date</dc:date></office:meta></office:document-meta>`,
  );
  assert.equal(metadata.get("dcterms:created"), "2009-10-05T19:04:01");
  assert.equal(metadata.get("dcterms:modified"), null);
});

test("ODF reads OpenOffice 1.x element namespaces as the OpenDocument ones", async () => {
  const metadata = await odfMetadata(
    '<office:document-meta xmlns:office="http://openoffice.org/2000/office" xmlns:meta="http://openoffice.org/2000/meta" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><meta:generator>OpenOffice.org 1.1</meta:generator><dc:title>Old</dc:title></office:meta></office:document-meta>',
  );
  assert.equal(metadata.get("generator"), "OpenOffice.org 1.1");
  assert.equal(metadata.get("dc:title"), "Old");
});

test("ODF metadata in elements of another namespace is not read", async () => {
  const metadata = await odfMetadata(
    '<office:document-meta xmlns:office="o" xmlns:meta="m" xmlns:dc="d"><office:meta><dc:title>Nope</dc:title><meta:generator>Nope</meta:generator></office:meta></office:document-meta>',
  );
  assert.equal(metadata.get("dc:title"), null);
  assert.equal(metadata.get("generator"), null);
});

test("a meta.xml that is not well-formed is a MalformedDocumentError", async () => {
  await assert.rejects(odfMetadata(`<office:document-meta ${NS}><office:meta><dc:title>cut`), MalformedDocumentError);
});

test("ODF meta.xml nested to the depth limit is read, one level more is a LimitExceededError (tikajs-68os.27)", async () => {
  const nested = (levels: number): string =>
    `<office:document-meta ${NS}>${"<x:a xmlns:x='urn:x'>".repeat(levels - 1)}${"</x:a>".repeat(levels - 1)}</office:document-meta>`;
  await odfMetadata(nested(MAX_ODF_META_DEPTH));
  await assert.rejects(odfMetadata(nested(MAX_ODF_META_DEPTH + 1)), LimitExceededError);
});

// Pins found by mutating odf-meta.ts (tikajs-68os.48): each behaviour below was read from the Tika handlers, not run.
const NS_X = `${NS} xmlns:x="urn:example:other"`;

function metaDoc(body: string, root = ""): string {
  return `<office:document-meta ${NS_X}${root}><office:meta>${body}</office:meta></office:document-meta>`;
}

test("ODF dc:modified comes from dc:date, and a second creation-date replaces the first", async () => {
  const metadata = await odfMetadata(
    metaDoc(
      "<meta:creation-date>2009-10-05T19:04:01</meta:creation-date><meta:creation-date>2010-01-02T03:04:05</meta:creation-date><dc:date>2011-02-03T04:05:06</dc:date>",
    ),
  );
  assert.deepEqual(metadata.getAll("dcterms:created"), ["2010-01-02T03:04:05"]);
  assert.deepEqual(metadata.getAll("dcterms:modified"), ["2011-02-03T04:05:06"]);
});

test("an ODF date element is ended by an element of its own namespace and name only", async () => {
  const metadata = await odfMetadata(
    metaDoc("<meta:creation-date>2009-10-05<x:creation-date/>T19:04:01</meta:creation-date>"),
  );
  assert.equal(metadata.get("dcterms:created"), "2009-10-05T19:04:01");
});

test("ODF writes every Dublin Core text property under its dc: key", async () => {
  const metadata = await odfMetadata(
    metaDoc(
      "<dc:title>T</dc:title><dc:description>D</dc:description><dc:publisher>P</dc:publisher><dc:contributor>C</dc:contributor><dc:type>Ty</dc:type><dc:format>F</dc:format><dc:identifier>I</dc:identifier><dc:language>L</dc:language><dc:rights>R</dc:rights>",
    ),
  );
  for (const [key, value] of [
    ["dc:title", "T"],
    ["dc:description", "D"],
    ["dc:publisher", "P"],
    ["dc:contributor", "C"],
    ["dc:type", "Ty"],
    ["dc:format", "F"],
    ["dc:identifier", "I"],
    ["dc:language", "L"],
    ["dc:rights", "R"],
  ] as const) {
    assert.deepEqual(metadata.getAll(key), [value], key);
  }
});

test("ODF dc:format holds one value, the last, where the other Dublin Core text properties keep each distinct one", async () => {
  const metadata = await odfMetadata(
    metaDoc("<dc:format>one</dc:format><dc:format>two</dc:format><dc:rights>a</dc:rights><dc:rights>b</dc:rights>"),
  );
  assert.deepEqual(metadata.getAll("dc:format"), ["two"]);
  assert.deepEqual(metadata.getAll("dc:rights"), ["a", "b"]);
});

test("a single-valued ODF property adds to several values already there, once, and replaces a single one", () => {
  const several = new Metadata();
  several.add("dc:format", "a");
  several.add("dc:format", "b");
  applyOdfMetadata(several, metaDoc("<dc:format>c</dc:format>"));
  assert.deepEqual(several.getAll("dc:format"), ["a", "b", "c"]);
  const again = new Metadata();
  again.add("dc:format", "a");
  again.add("dc:format", "b");
  applyOdfMetadata(again, metaDoc("<dc:format>b</dc:format>"));
  assert.deepEqual(again.getAll("dc:format"), ["a", "b"]);
  const one = new Metadata();
  one.add("dc:format", "a");
  applyOdfMetadata(one, metaDoc("<dc:format>c</dc:format>"));
  assert.deepEqual(one.getAll("dc:format"), ["c"]);
});

test("ODF element text is trimmed, a blank element adds nothing, and text with Bag in it is not taken", async () => {
  const metadata = await odfMetadata(
    metaDoc("<dc:title>  Padded  </dc:title><dc:publisher>   </dc:publisher><dc:contributor>Bag of tricks</dc:contributor>"),
  );
  assert.deepEqual(metadata.getAll("dc:title"), ["Padded"]);
  assert.equal(metadata.get("dc:publisher"), null);
  assert.equal(metadata.get("dc:contributor"), null);
});

test("ODF element text with the same element nested in it is one value, ended by the outer one", async () => {
  const metadata = await odfMetadata(metaDoc("<dc:title>A<dc:title>B</dc:title>C</dc:title>"));
  assert.deepEqual(metadata.getAll("dc:title"), ["ABC"]);
});

test("ODF text in a CDATA section is read as text", async () => {
  const metadata = await odfMetadata(metaDoc("<dc:title><![CDATA[a <b> title]]></dc:title>"));
  assert.equal(metadata.get("dc:title"), "a <b> title");
});

test("ODF meta: elements in another namespace are not read, and an empty keyword adds nothing", async () => {
  const metadata = await odfMetadata(
    metaDoc(
      "<x:keyword>foreign</x:keyword><x:generator>foreign</x:generator><x:creation-date>2009-10-05T19:04:01</x:creation-date><meta:keyword/><meta:generator></meta:generator>",
    ),
  );
  assert.equal(metadata.get("meta:keyword"), null);
  assert.equal(metadata.get("pdf:Keywords"), null);
  assert.equal(metadata.get("generator"), null);
  assert.equal(metadata.get("dcterms:created"), null);
});

test("ODF joined text is ended by an element of its own namespace and name only", async () => {
  const metadata = await odfMetadata(metaDoc("<meta:keyword>a<x:keyword/>b</meta:keyword>"));
  assert.deepEqual(metadata.getAll("meta:keyword"), ["ab"]);
});

test("ODF joined text is kept as written under Tika's key; the legacy keys are gone", async () => {
  const metadata = await odfMetadata(metaDoc("<meta:generator> Writer </meta:generator><meta:keyword> </meta:keyword>"));
  assert.equal(metadata.get("generator"), " Writer ");
  assert.equal(metadata.get("meta:keyword"), " ");
  assert.equal(metadata.get("meta:generator"), null);
  assert.equal(metadata.get("pdf:Keywords"), null);
});

test("a single ODF keyword and no subject is the whole of dc:subject", async () => {
  const metadata = await odfMetadata(metaDoc("<meta:keyword>alone</meta:keyword>"));
  assert.deepEqual(metadata.getAll("dc:subject"), ["alone"]);
});

test("ODF version is the root's office:version, trimmed; an empty one, another namespace's, or a nested element's is not it", async () => {
  assert.equal((await odfMetadata(metaDoc("", ' office:version=" 1.3 "'))).get("odf:version"), "1.3");
  assert.equal((await odfMetadata(metaDoc("", ' office:version=""'))).get("odf:version"), null);
  assert.equal((await odfMetadata(metaDoc("", ' x:version="9"'))).get("odf:version"), null);
  const nested = await odfMetadata(
    `<office:document-meta ${NS_X}><office:document-meta office:version="9"/></office:document-meta>`,
  );
  assert.equal(nested.get("odf:version"), null);
  const foreignRoot = await odfMetadata(`<x:document-meta ${NS_X} office:version="9"/>`);
  assert.equal(foreignRoot.get("odf:version"), null);
});

test("ODF writes each document statistic under its meta: key, trimmed, and reads only the meta namespace's", async () => {
  const metadata = await odfMetadata(
    metaDoc(
      '<meta:document-statistic meta:object-count="1" meta:image-count=" 2 " meta:page-count="3" meta:table-count="4" meta:paragraph-count="5" meta:word-count="6" meta:character-count="7" x:word-count="8"/>',

    ),
  );
  assert.equal(metadata.get("meta:object-count"), "1");
  assert.equal(metadata.get("meta:image-count"), "2");
  assert.equal(metadata.get("meta:page-count"), "3");
  assert.equal(metadata.get("xmpTPg:NPages"), "3");
  assert.equal(metadata.get("meta:table-count"), "4");
  assert.equal(metadata.get("meta:paragraph-count"), "5");
  assert.equal(metadata.get("meta:word-count"), "6");
  assert.equal(metadata.get("meta:character-count"), "7");
});

test("ODF statistics of another namespace, an attribute of another namespace, and a blank value are not written", async () => {
  const foreign = await odfMetadata(metaDoc('<x:document-statistic meta:word-count="6"/>'));
  assert.equal(foreign.get("meta:word-count"), null);
  const attribute = await odfMetadata(metaDoc('<meta:document-statistic x:word-count="6" meta:page-count="  "/>'));
  assert.equal(attribute.get("meta:word-count"), null);
  assert.equal(attribute.get("meta:page-count"), null);
  assert.equal(attribute.get("xmpTPg:NPages"), null);
});

test("ODF user-defined: only an element with meta:name is read, as the name that is spelled meta:name, and only inside its own text", async () => {
  const metadata = await odfMetadata(
    metaDoc(
      '<meta:user-defined meta:name="A">1</meta:user-defined><meta:user-defined x:name="B">2</meta:user-defined><meta:user-defined>3</meta:user-defined><dc:title>T</dc:title><meta:user-defined meta:name="C">4</meta:user-defined>',
    ),
  );
  assert.deepEqual(metadata.getAll("custom:A"), ["1"]);
  assert.equal(metadata.get("custom:B"), null);
  // the text of the two unnamed elements is still collected, as Tika's handler collects it, and goes to the next named one
  assert.deepEqual(metadata.getAll("custom:C"), ["234"]);
});

test("ODF user-defined name read through another prefix for the meta namespace is not a meta:name", async () => {
  const metadata = await odfMetadata(
    `<office:document-meta ${NS} xmlns:m="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><m:user-defined m:name="P">v</m:user-defined></office:meta></office:document-meta>`,
  );
  assert.equal(metadata.get("custom:P"), null);
});

test("ODF user-defined text outside a user-defined element is not part of it", async () => {
  const metadata = await odfMetadata(
    metaDoc('<dc:title>before</dc:title><meta:user-defined meta:name="A">1</meta:user-defined>'),
  );
  assert.deepEqual(metadata.getAll("custom:A"), ["1"]);
});

test("ODF user-defined elements of another namespace are not read", async () => {
  const metadata = await odfMetadata(metaDoc('<x:user-defined meta:name="A">1</x:user-defined>'));
  assert.equal(metadata.get("custom:A"), null);
});

test("ODF keyword and subject, whichever comes first in the file, are keywords first in dc:subject", async () => {
  const metadata = await odfMetadata(metaDoc("<dc:subject>S</dc:subject><meta:keyword>K</meta:keyword>"));
  assert.deepEqual(metadata.getAll("dc:subject"), ["K", "S"]);
});

test("ODF OpenOffice 1.x element namespaces are mapped below the root too; its attribute namespaces are not mapped", async () => {
  const old =
    'xmlns:office="http://openoffice.org/2000/office" xmlns:meta="http://openoffice.org/2000/meta" xmlns:m2="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';
  const mapped = await odfMetadata(
    `<office:document-meta ${old}><office:meta><meta:document-statistic m2:word-count="5"/></office:meta></office:document-meta>`,
  );
  assert.equal(mapped.get("meta:word-count"), "5");
  const attributes = await odfMetadata(
    `<office:document-meta ${old} office:version="1.0"><office:meta><meta:document-statistic meta:word-count="5"/></office:meta></office:document-meta>`,
  );
  assert.equal(attributes.get("meta:word-count"), null);
  assert.equal(attributes.get("odf:version"), null);
});

test("EPUB reads the mimetype override, the package version and a pre-paginated rendition", async () => {
  const result = await run(new EpubParser(), {
    mimetype: "application/x-ibooks+zip\n",
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
    "content.opf":
      '<package version="3.0"><metadata><dc:title>Layout</dc:title><meta property="rendition:layout">pre-paginated</meta></metadata>' +
      '<manifest><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1" properties="rendition:layout-pre-paginated"/></spine></package>',
    "chap1.xhtml": "<html><body><p>fixed</p></body></html>",
  });
  assert.equal(result.metadata.get("Content-Type"), "application/x-ibooks+zip");
  assert.equal(result.metadata.get("epub:version"), "3.0");
  assert.equal(result.metadata.get("epub:rendition:layout"), "pre-paginated");
});

test("EPUB finds the OPF by extension when container.xml is absent, as Tika's getRoot fallback", async () => {
  const result = await run(new EpubParser(), {
    "OEBPS/book.opf":
      '<package><metadata><dc:title>Fallback</dc:title></metadata><manifest><item id="c1" href="chap1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    "OEBPS/chap1.xhtml": "<html><body><p>found</p></body></html>",
  });
  assert.equal(result.metadata.get("dc:title"), "Fallback");
  assert.match(result.text, /found/);
});

test("EPUB with encrypted items is an EncryptedDocumentError", async () => {
  await assert.rejects(
    run(new EpubParser(), {
      "META-INF/encryption.xml": '<encryption><EncryptedData><CipherData><CipherReference URI="chap1.xhtml"/></CipherData></EncryptedData></encryption>',
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      "content.opf": '<package><manifest><item id="c1" href="chap1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      "chap1.xhtml": "<html><body><p>secret</p></body></html>",
    }),
    EncryptedDocumentError,
  );
});

test("EPUB without any OPF writes the HTML entries and reports the missing package document", async () => {
  await assert.rejects(
    run(new EpubParser(), {
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="missing.opf"/></rootfiles></container>',
      "one.xhtml": "<html><body><p>recovered one</p></body></html>",
      "two.html": "<html><body><p>recovered two</p></body></html>",
    }),
    (error: unknown) => error instanceof MalformedDocumentError && /recovered 3 HTML entries/.test(error.message),
  );
});

// tikajs-ybtt: every keyword re-flattened a value that was already at the cap, so thousands of keywords cost seconds.
test("ODF meta with tens of thousands of keywords is read in bounded time", () => {
  const keywords = "<meta:keyword>kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk</meta:keyword>".repeat(80_000);
  const metadata = new Metadata();
  metadata.setMaxValueChars(1_000_000);
  const started = performance.now();
  applyOdfMetadata(metadata, `<office:document-meta ${NS}><office:meta>${keywords}</office:meta></office:document-meta>`);
  assert.ok(performance.now() - started < 3000, "keyword joining is not bounded");
  assert.ok(metadata.get("meta:keyword")!.length <= 1_000_000);
});

// tikajs-r77m: content.xml lists automatic styles (number:text) before office:body, and they used to be taken as the body.
test("ODF body is found under office:body, not in a number:text style element", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:number="n"><office:automatic-styles><number:date-style><number:text>-</number:text></number:date-style></office:automatic-styles>' +
      "<office:body><office:text><text:p>Real body</text:p></office:text></office:body></office:document-content>",
  });
  assert.match(result.text, /Real body/);
});

// tikajs-v517: text after an inline element belongs after that element's text.
test("ODF mixed content keeps document order", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>Alpha <text:span>bold</text:span> omega</text:p></office:text></office:body></office:document-content>',
  });
  assert.match(result.text, /Alpha bold omega/);
});

test("EPUB mixed content keeps document order and CDATA text is kept", async () => {
  const result = await run(new EpubParser(), {
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    "c.opf":
      '<package><manifest><item id="c1" href="chap1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    "chap1.xhtml":
      "<html><body><p>The <b>quick</b> brown <i>fox</i> jumps</p><p><![CDATA[Cdata <kept>]]></p></body></html>",
  });
  assert.match(result.text, /The quick brown fox jumps/);
  assert.match(result.text, /Cdata <kept>/);
});

// tikajs-r77m: many spine items re-read the archive per item; each lookup must stay cheap and the walk must be abortable.
test("EPUB with thousands of spine items is read without rescanning the archive per item", async () => {
  const count = 3000;
  const files: Record<string, string> = {
    "META-INF/container.xml": '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    "c.opf": `<package><manifest>${Array.from({ length: count }, (_, i) => `<item id="i${i}" href="c${i}.xhtml"/>`).join("")}</manifest><spine>${Array.from({ length: count }, (_, i) => `<itemref idref="i${i}"/>`).join("")}</spine></package>`,
  };
  for (let i = 0; i < count; i++) files[`c${i}.xhtml`] = `<html><body><p>chapter ${i}</p></body></html>`;
  const started = performance.now();
  const result = await run(new EpubParser(), files);
  assert.match(result.text, /chapter 2999/);
  assert.ok(performance.now() - started < 5000, "spine walk is not linear");
});

// Oracle (Tika 4.2.0 /tika, tikajs-u03v): an office:annotation is written as a block of its own. Its paragraphs end in a space and one
// that follows another starts with one; the first block starts with the literal "&#32;" (Tika's quirk). The creator, the date and
// text directly in it are not written, and the text after it in the host paragraph is a paragraph again.
const ODF_ANNOTATION_NS = 'xmlns:office="o" xmlns:text="t" xmlns:dc="d"';
async function odtBody(body: string): Promise<string> {
  return (
    await run(new OpenDocumentParser(), {
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml": `<office:document-content ${ODF_ANNOTATION_NS}><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
    })
  ).text;
}

test("an ODT comment is written between the text before it and the text after it", async () => {
  const text = await odtBody(
    "<text:p>Before<office:annotation><dc:creator>Al</dc:creator><text:p>First.</text:p><text:p>Second.</text:p></office:annotation>After</text:p>",
  );
  assert.equal(text.replace(/\n+/g, "\n"), "Before\n&#32;First.  Second. \nAfter\n");
});

test("text directly in an ODT comment is not written", async () => {
  const text = await odtBody("<text:p>X<office:annotation>Direct</office:annotation>Y</text:p>");
  assert.equal(text.replace(/\n+/g, "\n"), "X\nY\n");
});

// tikajs-z36j: Tika 4.2.0 writes a heading's text with no line break after it, and an empty paragraph as a newline.
test("an ODT heading has no line break after it, and an empty paragraph has one", async () => {
  const text = await odtBody(
    '<text:h text:outline-level="1">T</text:h><text:p>B</text:p><text:h text:outline-level="2">U</text:h><text:p></text:p><text:p>C</text:p>',
  );
  assert.equal(text, "TB\nU\nC\n");
});

test("a trailing ODT heading has no final line break", async () => {
  assert.equal(await odtBody('<text:h text:outline-level="1">T</text:h>'), "T");
});
