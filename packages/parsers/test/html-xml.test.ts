import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, MalformedDocumentError, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { HtmlDocumentParser, createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();

test("parses HTML text, title, and strips script/style", async () => {
  const result = await ripstream.parse(
    encoder.encode(
      '<html><head><title>Title</title><style>x{}</style></head><body><p>Hello <b>world</b></p><script>bad()</script></body></html>',
    ),
    { filename: "page.html" },
  );
  // Tika's JSoupParser: `text/html; charset=<detected>`, and Mojibuster detects pure ASCII as windows-1252.
  assert.equal(result.metadata.get("Content-Type"), "text/html; charset=windows-1252");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
  assert.equal(result.metadata.get("dc:title"), "Title");
  assert.match(result.text, /Hello world/);
  assert.doesNotMatch(result.text, /bad\(\)|x\{\}/);
});

test("HTML that declares its charset reports that charset", async () => {
  const result = await ripstream.parse(encoder.encode('<html><head><meta charset="ISO-8859-2"></head><body>x</body></html>'), {
    filename: "page.html",
  });
  assert.equal(result.metadata.get("Content-Type"), "text/html; charset=ISO-8859-2");
});

/** The Content-Type the HTML parser leaves when it is handed `incoming` (none when null). */
async function htmlTypeAfter(incoming: string | null): Promise<string | null> {
  const metadata = new Metadata();
  if (incoming !== null) metadata.set("Content-Type", incoming);
  const stream = await RipstreamInputStream.from(encoder.encode("<p>x</p>"));
  try {
    await new HtmlDocumentParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata.get("Content-Type");
}

test("HTML given no Content-Type is text/html with its charset, as Tika's JSoupParser makes it", async () => {
  assert.equal(await htmlTypeAfter(null), "text/html; charset=windows-1252");
});

test("HTML drops the other parameters of an incoming text/html, as Tika builds the type from a constant", async () => {
  assert.equal(await htmlTypeAfter("text/html; foo=bar"), "text/html; charset=windows-1252");
});

test("HTML leaves a Content-Type that is neither text/html nor XHTML as it was", async () => {
  assert.equal(await htmlTypeAfter("application/x-other"), "application/x-other");
});

test("XHTML keeps its own type and gains the charset", async () => {
  const result = await ripstream.parse(
    encoder.encode('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>x</body></html>'),
    { filename: "page.xhtml" },
  );
  assert.equal(result.metadata.get("Content-Type"), "application/xhtml+xml; charset=windows-1252");
});

test("parses XML text and Dublin Core metadata", async () => {
  const result = await ripstream.parse(
    encoder.encode(
      '<doc xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Doc</dc:title><p>Hello</p></doc>',
    ),
    { filename: "doc.xml" },
  );
  assert.equal(result.metadata.get("Content-Type"), "application/xml");
  assert.equal(result.metadata.get("dc:title"), "Doc");
  assert.match(result.text, /Hello/);
});

test("XML DTD is rejected", async () => {
  await assert.rejects(
    ripstream.parse(
      encoder.encode('<!DOCTYPE foo [<!ENTITY x "y">]><foo>&x;</foo>'),
      { filename: "doc.xml" },
    ),
    MalformedDocumentError,
  );
});

test("XML never expands custom entities, even with a DOCTYPE hidden past the sniffed prefix", async () => {
  // maxXmlEntityExpansions is moot: saxes expands only the 5 predefined
  // entities, so a billion-laughs payload cannot amplify; it is a parse error.
  const padding = `<!--${" ".repeat(70 * 1024)}-->`;
  const payload = `${padding}<!DOCTYPE foo [<!ENTITY x "yyyyyyyy">]><foo>&x;&x;</foo>`;
  const outcome = await ripstream
    .parse(encoder.encode(payload), { filename: "doc.xml" })
    .then((result) => result.text, (error: unknown) => error);
  assert.ok(
    outcome instanceof MalformedDocumentError || !String(outcome).includes("yyyyyyyy"),
    `entity must not expand: ${String(outcome)}`,
  );
});

test("honours the XML declaration encoding", async () => {
  const latin1 = Uint8Array.from([
    ...new TextEncoder().encode(
      '<?xml version="1.0" encoding="ISO-8859-1"?><doc>',
    ),
    0x63,
    0x61,
    0x66,
    0xe9,
    ...new TextEncoder().encode("</doc>"),
  ]);
  const result = await ripstream.parse(latin1, { filename: "doc.xml" });
  assert.match(result.text, /café/);
  // Tika's XMLParser never writes Content-Encoding (nor a charset in Content-Type); only its text, HTML and Markdown parsers do.
  assert.equal(result.metadata.get("Content-Encoding"), null);
});

test("XML and SVG carry no Content-Encoding, as Tika's XML parser writes none", async () => {
  const xml = await ripstream.parse(encoder.encode("<doc><p>Hello</p></doc>"), { filename: "doc.xml" });
  assert.equal(xml.metadata.get("Content-Encoding"), null);
  assert.equal(xml.metadata.get("Content-Type"), "application/xml");
  const svg = await ripstream.parse(encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>'), { filename: "i.svg" });
  assert.equal(svg.metadata.get("Content-Encoding"), null);
});

test("parses SVG as XML text", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>Icon</title><desc>A circle</desc><text>Hello SVG</text></svg>';
  const result = await ripstream.parse(new TextEncoder().encode(svg), {
    filename: "icon.svg",
  });
  assert.match(result.text, /Icon/);
  assert.match(result.text, /Hello SVG/);
});

test("parses flat ODF XML", async () => {
  const flat =
    '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:h>Heading</text:h><text:p>Flat body</text:p></office:text></office:body></office:document-content>';
  const result = await ripstream.parse(new TextEncoder().encode(flat), {
    filename: "doc.fodt",
  });
  assert.match(result.text, /Heading/);
  assert.match(result.text, /Flat body/);
});

test("parses legacy Microsoft XML and FictionBook", async () => {
  const wordml =
    '<?xml version="1.0"?><w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"><w:body><w:p><w:r><w:t>WordML text</w:t></w:r></w:p></w:body></w:wordDocument>';
  const word = await ripstream.parse(new TextEncoder().encode(wordml), {
    filename: "doc.xml",
  });
  assert.match(word.text, /WordML text/);

  const fb2 =
    '<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body><section><title><p>Book Title</p></title><p>Fiction body</p></section></body></FictionBook>';
  const book = await ripstream.parse(new TextEncoder().encode(fb2), {
    filename: "book.fb2",
  });
  assert.match(book.text, /Book Title/);
  assert.match(book.text, /Fiction body/);
});

test("parses ISO 19115 XML", async () => {
  const xml =
    '<gmd:MD_Metadata xmlns:gmd="http://www.isotc211.org/2005/gmd"><gmd:fileIdentifier>id-1</gmd:fileIdentifier><gmd:language>eng</gmd:language></gmd:MD_Metadata>';
  const result = await ripstream.parse(new TextEncoder().encode(xml), {
    filename: "metadata.xml",
  });
  assert.match(result.text, /id-1/);
});

test("HTML parser honors an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const html = "<p>x</p>".repeat(3000);
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(html));
  await assert.rejects(
    new HtmlDocumentParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext({ signal: controller.signal })),
  );
  await stream.close();
});

test("HTML depth cap is configurable and defaults to 2000", async () => {
  const run = async (parser: HtmlDocumentParser, depth: number) => {
    const stream = await RipstreamInputStream.from(new TextEncoder().encode("<div>".repeat(depth)));
    try {
      await parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext());
    } finally {
      await stream.close();
    }
  };
  await assert.rejects(run(new HtmlDocumentParser({ maxDepth: 5 }), 6), /exceeds 5 open/);
  await run(new HtmlDocumentParser({ maxDepth: 5 }), 5);
  await run(new HtmlDocumentParser(), 2000);
  await assert.rejects(run(new HtmlDocumentParser(), 2001), /exceeds 2000 open/);
  assert.throws(() => new HtmlDocumentParser({ maxDepth: 0 }), RangeError);
});
