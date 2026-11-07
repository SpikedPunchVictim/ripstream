import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { EpubParser, OpenDocumentParser } from "../src/index.ts";

async function run(
  parser: OpenDocumentParser | EpubParser,
  files: Record<string, string>,
): Promise<{ text: string; metadata: Metadata }> {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = strToU8(value);
  const stream = await RipstreamInputStream.from(zipSync(archive));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await parser.parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("extracts ODT text and metadata", async () => {
  const result = await run(new OpenDocumentParser(), {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>Hello ODF</text:p><text:h>Heading</text:h></office:text></office:body></office:document-content>',
    "meta.xml":
      '<office:document-meta xmlns:office="o" xmlns:dc="d" xmlns:meta="m"><office:meta><dc:title>ODF Doc</dc:title><dc:creator>Ada</dc:creator><meta:generator>Writer</meta:generator></office:meta></office:document-meta>',
  });
  assert.match(result.text, /Hello ODF/);
  assert.match(result.text, /Heading/);
  assert.equal(result.metadata.get("dc:title"), "ODF Doc");
  assert.equal(result.metadata.get("dc:creator"), "Ada");
  assert.equal(result.metadata.get("meta:generator"), "Writer");
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
      '<office:document-meta xmlns:office="o" xmlns:meta="m"><office:meta><meta:generator>Writer</meta:generator><meta:document-statistic meta:word-count="42" meta:page-count="3"/></office:meta></office:document-meta>',
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
