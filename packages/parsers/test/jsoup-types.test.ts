import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, MediaType, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { HtmlDocumentParser, createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * Tika's JSoupParser claims text/html, application/xhtml+xml, application/vnd.wap.xhtml+xml, application/x-asp and
 * application/vnd.mozilla.xul+xml (JSoupParser.java). It rewrites Content-Type to the incoming type plus the detected charset for
 * text/html, XHTML, WAP XHTML and x-asp, and leaves any other type, XUL among them, as it was. Read from Tika source, not run
 * against a Tika.
 */

const encoder = new TextEncoder();
const ripstream = createRipstream();

async function typeAfter(incoming: string | null): Promise<string | null> {
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

test("the HTML parser claims the WAP XHTML, x-asp and XUL types as well", async () => {
  const claimed = [...(await new HtmlDocumentParser().getSupportedTypes())].map((type) => type.toString());
  for (const type of ["text/html", "application/xhtml+xml", "application/vnd.wap.xhtml+xml", "application/x-asp", "application/vnd.mozilla.xul+xml"]) {
    assert.ok(claimed.includes(type), type);
  }
});

test("WAP XHTML keeps its own type and gains the charset", async () => {
  assert.equal(await typeAfter("application/vnd.wap.xhtml+xml"), "application/vnd.wap.xhtml+xml; charset=windows-1252");
});

test("x-asp keeps its own type and gains the charset", async () => {
  assert.equal(await typeAfter("application/x-asp"), "application/x-asp; charset=windows-1252");
});

test("an incoming WAP XHTML or x-asp type loses its other parameters, as Tika builds the type from a constant", async () => {
  assert.equal(await typeAfter("application/x-asp; foo=bar"), "application/x-asp; charset=windows-1252");
  assert.equal(await typeAfter("application/vnd.wap.xhtml+xml; foo=bar"), "application/vnd.wap.xhtml+xml; charset=windows-1252");
});

test("XUL is left as it came: JSoupParser sets no Content-Type for it", async () => {
  assert.equal(await typeAfter("application/vnd.mozilla.xul+xml"), "application/vnd.mozilla.xul+xml");
});

test("the default registry sends WAP XHTML, x-asp and XUL to the HTML parser, ahead of the XML and text parsers", async () => {
  const composite = createDefaultParser();
  for (const type of ["application/vnd.wap.xhtml+xml", "application/x-asp", "application/vnd.mozilla.xul+xml"]) {
    const [first] = await composite.selectParsers(MediaType.parseOrThrow(type), new ParseContext());
    assert.equal(first?.parser.name, "HTMLParser", type);
    assert.equal(first?.kind, "exact", type);
  }
});

// AutoDetectParserTest.testXulWithExternalDtdEntities: XUL whose DTD entities cannot be loaded is still read, by JSoupParser.
test("XUL with an external DTD parameter entity is read as text, and keeps its type", async () => {
  const xul =
    '<?xml version="1.0"?>\n' +
    '<!DOCTYPE window [<!ENTITY % appDTD SYSTEM "chrome://app/locale/app.dtd"> %appDTD;]>\n' +
    '<window xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" xmlns:html="http://www.w3.org/1999/xhtml">' +
    "<html:p>&app.name; release notes</html:p></window>";
  const result = await ripstream.parse(encoder.encode(xul), { filename: "aboutDialog.xul" });
  assert.equal(result.metadata.get("Content-Type"), "application/vnd.mozilla.xul+xml");
  assert.match(result.text, /release notes/);
});

test("a document whose type is WAP XHTML is read as HTML text by the default parser", async () => {
  // The detector would call this text/html (its magic is the more specific, as in Tika's MimeTypes); a caller that
  // already knows the type reaches the parser by it.
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/vnd.wap.xhtml+xml");
  const handler = new BodyContentHandler();
  const stream = await RipstreamInputStream.from(encoder.encode("<html><head><title>WAP</title></head><body><p>wap body</p></body></html>"));
  try {
    await createDefaultParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.equal(metadata.get("Content-Type"), "application/vnd.wap.xhtml+xml; charset=windows-1252");
  assert.equal(metadata.get("dc:title"), "WAP");
  assert.match(handler.toString(), /wap body/);
});

test("deeply nested XUL is bounded by the HTML nesting cap", async () => {
  const xul = `<window xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">${"<box>".repeat(100_000)}x`;
  await assert.rejects(ripstream.parse(encoder.encode(xul), { filename: "deep.xul" }), (error: Error) => error.name === "LimitExceededError");
});
