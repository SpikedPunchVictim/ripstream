import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { EpubParser } from "../src/index.ts";
import { parseXmlTree } from "../src/xml-tree.ts";
import { JPEG, archive, runPackage, type Run } from "./iwork-harness.ts";

/*
 * What EpubParser hands to the embedded-document extractor: the manifest items that are not chapters, with the cover as the
 * thumbnail. Read from Tika 4.2.0's EpubParser (shouldHandleEmbedded, handleEmbedded, ContentOrderScraper), not run against a Tika.
 */

const CONTAINER =
  '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>';
const CHAPTER = "<html><body><p>Chapter text</p></body></html>";

function opf(metadata: string, manifest: string, spine: string): string {
  return `<package><metadata>${metadata}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
}

async function runEpub(
  content: string,
  entries: Record<string, string | Uint8Array> = {},
  failures?: ReadonlyMap<string, Error>,
): Promise<Run> {
  const data = archive({
    "META-INF/container.xml": CONTAINER,
    "OPS/content.opf": content,
    "OPS/c1.xhtml": CHAPTER,
    ...entries,
  });
  return runPackage(new EpubParser(), data, failures === undefined ? {} : { failures });
}

const C1 = '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>';
const SPINE = '<itemref idref="c1"/>';

function names(run: Run): string[] {
  return run.recorder.seen.map((seen) => seen.name);
}

test("the EPUB 2 cover meta names the item emitted as the thumbnail", async () => {
  const run = await runEpub(
    opf(
      '<meta name="cover" content="cov"/>',
      `${C1}<item id="cov" href="cover.jpg" media-type="image/jpeg"/><item id="pic" href="pic.jpg" media-type="image/jpeg"/>`,
      SPINE,
    ),
    { "OPS/cover.jpg": JPEG, "OPS/pic.jpg": JPEG },
  );
  const cover = run.recorder.seen.find((seen) => seen.name === "OPS/cover.jpg");
  const other = run.recorder.seen.find((seen) => seen.name === "OPS/pic.jpg");
  assert.equal(cover?.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(cover?.metadata.get("Content-Type"), "image/jpeg");
  assert.equal(other?.metadata.get("tk:embedded-resource-type"), null);
});

test("the EPUB 3 cover-image property marks the thumbnail, and wins over a cover meta", async () => {
  const run = await runEpub(
    opf(
      '<meta name="cover" content="pic"/>',
      `${C1}<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="x cover-image"/><item id="pic" href="pic.jpg" media-type="image/jpeg"/>`,
      SPINE,
    ),
    { "OPS/cover.jpg": JPEG, "OPS/pic.jpg": JPEG },
  );
  const thumbnails = run.recorder.seen.filter((seen) => seen.metadata.get("tk:embedded-resource-type") === "THUMBNAIL");
  assert.deepEqual(thumbnails.map((seen) => seen.name), ["OPS/cover.jpg"]);
});

test("stylesheets, SVG, XML, the NCX and iBooks items are not embedded; images, fonts and unknown types are", async () => {
  const run = await runEpub(
    opf(
      "",
      `${C1}` +
        '<item id="css" href="a.css" media-type="text/css"/>' +
        '<item id="svg" href="a.svg" media-type="image/svg+xml"/>' +
        '<item id="xml" href="a.xml" media-type="application/xml"/>' +
        '<item id="ncx" href="a.ncx" media-type="application/x-dtbncx+xml"/>' +
        '<item id="ibk" href="a.ibk" media-type="application/x-ibooks+zip"/>' +
        '<item id="img" href="a.jpg" media-type="image/jpeg"/>' +
        '<item id="fnt" href="a.otf" media-type="application/vnd.ms-opentype"/>' +
        '<item id="raw" href="a.bin"/>',
      SPINE,
    ),
    {
      ...Object.fromEntries(["a.css", "a.svg", "a.xml", "a.ibk", "a.jpg", "a.otf", "a.bin"].map((n) => [`OPS/${n}`, JPEG])),
      "OPS/a.ncx": "<ncx/>",
    },
  );
  assert.deepEqual(names(run).sort(), ["OPS/a.bin", "OPS/a.jpg", "OPS/a.otf"]);
});

test("a spine chapter is read as text, not embedded; a spine item that is not HTML is embedded", async () => {
  const run = await runEpub(
    opf("", `${C1}<item id="img" href="a.jpg" media-type="image/jpeg"/>`, `${SPINE}<itemref idref="img"/>`),
    { "OPS/a.jpg": JPEG },
  );
  assert.deepEqual(names(run), ["OPS/a.jpg"]);
  assert.match(run.xml, /Chapter text/);
});

test("an item without a media type is a chapter when it is in the spine and its name ends in html, and embedded otherwise", async () => {
  const run = await runEpub(
    opf("", '<item id="c1" href="c1.xhtml"/><item id="raw" href="a.bin"/>', SPINE),
    { "OPS/a.bin": JPEG },
  );
  assert.deepEqual(names(run), ["OPS/a.bin"]);
  assert.match(run.xml, /Chapter text/);
});

test("an embedded item is written in <div class=\"embedded\"> after the chapters, with the container's own metadata untouched", async () => {
  const run = await runEpub(opf("", `${C1}<item id="img" href="a.jpg" media-type="image/jpeg"/>`, SPINE), {
    "OPS/a.jpg": JPEG,
  });
  assert.match(run.xml, /Chapter text[\s\S]*<div class="embedded">[\s\S]*<\/div>/);
  assert.equal(run.metadata.get("tk:exception:embedded-stream-exception"), null);
});

test("an item named in the manifest but missing from the package is skipped", async () => {
  const run = await runEpub(opf("", `${C1}<item id="img" href="gone.jpg" media-type="image/jpeg"/>`, SPINE));
  assert.deepEqual(names(run), []);
});

test("manifest hrefs are percent-decoded, and a plus is a space, as java.net.URLDecoder does", async () => {
  const run = await runEpub(
    opf("", `${C1}<item id="a" href="a%20b.jpg" media-type="image/jpeg"/><item id="b" href="c+d.jpg" media-type="image/jpeg"/>`, SPINE),
    { "OPS/a b.jpg": JPEG, "OPS/c d.jpg": JPEG },
  );
  assert.deepEqual(names(run).sort(), ["OPS/a b.jpg", "OPS/c d.jpg"]);
});

test("a manifest href that is not valid percent-encoding is refused, as URLDecoder refuses it", async () => {
  await assert.rejects(
    runEpub(opf("", `${C1}<item id="a" href="100%.jpg" media-type="image/jpeg"/>`, SPINE)),
    /percent-encoding/,
  );
});

test("items are emitted in the order java.util.HashMap iterates their ids", async () => {
  const run = await runEpub(
    opf(
      "",
      `${C1}<item id="c" href="c.jpg" media-type="image/jpeg"/><item id="a" href="a.jpg" media-type="image/jpeg"/><item id="b" href="b.jpg" media-type="image/jpeg"/>`,
      SPINE,
    ),
    { "OPS/a.jpg": JPEG, "OPS/b.jpg": JPEG, "OPS/c.jpg": JPEG },
  );
  assert.deepEqual(names(run), ["OPS/a.jpg", "OPS/b.jpg", "OPS/c.jpg"]);
});

test("an embedded item that fails is recorded on the package and the others are still emitted", async () => {
  const run = await runEpub(
    opf("", `${C1}<item id="a" href="a.jpg" media-type="image/jpeg"/><item id="b" href="b.jpg" media-type="image/jpeg"/>`, SPINE),
    { "OPS/a.jpg": JPEG, "OPS/b.jpg": JPEG },
    new Map([["OPS/a.jpg", new Error("broken image")]]),
  );
  assert.deepEqual(names(run), ["OPS/a.jpg", "OPS/b.jpg"]);
  assert.deepEqual(run.metadata.getAll("tk:exception:embedded-stream-exception"), ["Error: broken image"]);
});

test("a limit reached by an embedded item ends the parse", async () => {
  await assert.rejects(
    runEpub(
      opf("", `${C1}<item id="a" href="a.jpg" media-type="image/jpeg"/>`, SPINE),
      { "OPS/a.jpg": JPEG },
      new Map([["OPS/a.jpg", new LimitExceededError("too many")]]),
    ),
    LimitExceededError,
  );
});

test("every Dublin Core element is a list of distinct values, and dc:contributor is among them", async () => {
  const run = await runEpub(
    opf(
      "<dc:title>One</dc:title><dc:title>Two</dc:title><dc:title>One</dc:title>" +
        "<dc:contributor>Ann</dc:contributor><dc:contributor>Bob</dc:contributor>" +
        "<dc:source>s1</dc:source><dc:type>book</dc:type>" +
        "<dc:rights>r1</dc:rights><dc:rights>r2</dc:rights>",
      C1,
      SPINE,
    ),
  );
  assert.deepEqual(run.metadata.getAll("dc:title"), ["One", "Two"]);
  assert.deepEqual(run.metadata.getAll("dc:contributor"), ["Ann", "Bob"]);
  assert.deepEqual(run.metadata.getAll("dc:source"), ["s1"]);
  assert.deepEqual(run.metadata.getAll("dc:type"), ["book"]);
  assert.deepEqual(run.metadata.getAll("dc:rights"), ["r1", "r2"]);
});

test("dc:date is dcterms:created, and dc:format is a single value", async () => {
  const run = await runEpub(
    opf("<dc:date>2009-10-07</dc:date><dc:format>a</dc:format><dc:format>b</dc:format>", C1, SPINE),
  );
  assert.equal(run.metadata.get("dcterms:created"), "2009-10-07");
  assert.equal(run.metadata.get("dc:date"), null);
  assert.deepEqual(run.metadata.getAll("dc:format"), ["b"]);
});

test("an XHTML chapter that uses an HTML entity under a DOCTYPE is read, the entity skipped", async () => {
  const run = await runEpub(opf("", C1, SPINE), {
    "OPS/c1.xhtml":
      '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">' +
      "<html><body><p>a&nbsp;b</p></body></html>",
  });
  assert.match(run.xml, /<p>ab<\/p>/);
});

test("an undefined entity in a chapter without a DOCTYPE is still a malformed document", async () => {
  await assert.rejects(
    runEpub(opf("", C1, SPINE), { "OPS/c1.xhtml": "<html><body><p>a&nbsp;b</p></body></html>" }),
    /undefined entity/,
  );
});

// ---- manifest, spine and cover details (mutation hardening) ----

const IMG = (id: string, href: string, extra = ""): string => `<item id="${id}" href="${href}" media-type="image/jpeg"${extra}/>`;

test("a manifest item without an id or without an href is ignored", async () => {
  const run = await runEpub(
    opf("", `${C1}<item id="noref" media-type="image/jpeg"/><item href="b.jpg" media-type="image/jpeg"/>${IMG("b", "b.jpg")}`, SPINE),
    { "OPS/b.jpg": JPEG },
  );
  assert.deepEqual(names(run), ["OPS/b.jpg"]);
});

test("an id put twice in the manifest keeps its first place and takes the last item", async () => {
  const run = await runEpub(opf("", `${C1}${IMG("a", "first.jpg")}${IMG("a", "second.jpg")}`, SPINE), {
    "OPS/first.jpg": JPEG,
    "OPS/second.jpg": JPEG,
  });
  assert.deepEqual(names(run), ["OPS/second.jpg"]);
});

test("with two cover-image items the first is the thumbnail", async () => {
  const run = await runEpub(opf("", `${C1}${IMG("a", "a.jpg", ' properties="cover-image"')}${IMG("b", "b.jpg", ' properties="cover-image"')}`, SPINE), {
    "OPS/a.jpg": JPEG,
    "OPS/b.jpg": JPEG,
  });
  const thumbnails = run.recorder.seen.filter((seen) => seen.metadata.get("tk:embedded-resource-type") === "THUMBNAIL");
  assert.deepEqual(thumbnails.map((seen) => seen.name), ["OPS/a.jpg"]);
});

test("cover-image is one word of the properties list: among others it counts, inside a longer word it does not", async () => {
  const run = await runEpub(
    opf("", `${C1}${IMG("a", "a.jpg", ' properties="not-cover-image-at-all"')}${IMG("b", "b.jpg", ' properties="  other   cover-image  "')}`, SPINE),
    { "OPS/a.jpg": JPEG, "OPS/b.jpg": JPEG },
  );
  const thumbnails = run.recorder.seen.filter((seen) => seen.metadata.get("tk:embedded-resource-type") === "THUMBNAIL");
  assert.deepEqual(thumbnails.map((seen) => seen.name), ["OPS/b.jpg"]);
});

test("with two cover metas the first names the cover; an empty one names nothing", async () => {
  const entries = { "OPS/a.jpg": JPEG, "OPS/b.jpg": JPEG };
  const manifest = `${C1}${IMG("a", "a.jpg")}${IMG("b", "b.jpg")}`;
  const first = await runEpub(opf('<meta name="cover" content="a"/><meta name="cover" content="b"/>', manifest, SPINE), entries);
  const thumbnail = (run: Run): string[] =>
    run.recorder.seen.filter((seen) => seen.metadata.get("tk:embedded-resource-type") === "THUMBNAIL").map((seen) => seen.name);
  assert.deepEqual(thumbnail(first), ["OPS/a.jpg"]);
  const afterEmpty = await runEpub(opf('<meta name="cover" content=""/><meta name="cover" content="b"/>', manifest, SPINE), entries);
  assert.deepEqual(thumbnail(afterEmpty), ["OPS/b.jpg"]);
});

test("the id of a cover meta is read without the blanks around it", async () => {
  const run = await runEpub(opf('<meta name="cover" content="  a  "/>', `${C1}${IMG("a", "a.jpg")}`, SPINE), { "OPS/a.jpg": JPEG });
  assert.equal(run.recorder.seen[0]?.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
});

test("an itemref outside the spine is not a spine item", async () => {
  const second = '<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>';
  const run = await runEpub(
    opf("", `${C1}${second}`, SPINE).replace("</package>", '<guide><itemref idref="c2"/></guide></package>'),
    { "OPS/c2.xhtml": "<html><body><p>Second text</p></body></html>" },
  );
  assert.doesNotMatch(run.xml, /Second text/);
  assert.deepEqual(names(run), ["OPS/c2.xhtml"]);
});

test("an itemref after the spine has closed is not a spine item", async () => {
  const second = '<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>';
  const run = await runEpub(
    opf("", `${C1}${second}`, SPINE).replace("</spine>", '</spine><itemref idref="c2"/>'),
    { "OPS/c2.xhtml": "<html><body><p>Second text</p></body></html>" },
  );
  assert.doesNotMatch(run.xml, /Second text/);
  assert.deepEqual(names(run), ["OPS/c2.xhtml"]);
});

test("a fragment on a manifest href is cut, and . and .. and empty parts are folded", async () => {
  const run = await runEpub(
    opf("", `${C1}${IMG("a", "a.jpg#frag")}${IMG("b", "./b.jpg")}${IMG("c", "../img/c.jpg")}${IMG("d", "sub//d.jpg")}`, SPINE),
    { "OPS/a.jpg": JPEG, "OPS/b.jpg": JPEG, "img/c.jpg": JPEG, "OPS/sub/d.jpg": JPEG },
  );
  assert.deepEqual(names(run).sort(), ["OPS/a.jpg", "OPS/b.jpg", "OPS/sub/d.jpg", "img/c.jpg"]);
});

test("an href that is not valid percent-encoding is a MalformedDocumentError with the decoder's failure as its cause", async () => {
  await assert.rejects(
    runEpub(opf("", `${C1}${IMG("a", "100%.jpg")}`, SPINE)),
    (error: unknown) => error instanceof MalformedDocumentError && error.cause instanceof Error,
  );
});

test("a spine item is a chapter by its media type, whatever its case, when the type has html in it", async () => {
  const entries = { "OPS/t.html": "<html><body><p>Plain html</p></body></html>", "OPS/u.html": "<html><body><p>Upper case type</p></body></html>" };
  const run = await runEpub(
    opf(
      "",
      `${C1}<item id="t" href="t.html" media-type="text/html"/><item id="u" href="u.html" media-type="Application/XHTML+XML"/>`,
      `${SPINE}<itemref idref="t"/><itemref idref="u"/>`,
    ),
    entries,
  );
  assert.match(run.xml, /Plain html/);
  assert.match(run.xml, /Upper case type/);
  assert.deepEqual(names(run), []);
});

test("a spine item without a media type is a chapter by the end of its name, in any case, for htm, html and .xml", async () => {
  const page = (text: string): string => `<html><body><p>${text}</p></body></html>`;
  const run = await runEpub(
    opf(
      "",
      '<item id="c1" href="c1.xhtml"/><item id="a" href="A.HTM"/><item id="b" href="b.xml"/><item id="c" href="cxml"/><item id="d" href="d.bxml"/>',
      '<itemref idref="c1"/><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/><itemref idref="d"/>',
    ),
    { "OPS/A.HTM": page("upper htm"), "OPS/b.xml": page("dot xml"), "OPS/cxml": JPEG, "OPS/d.bxml": JPEG },
  );
  assert.match(run.xml, /upper htm/);
  assert.match(run.xml, /dot xml/);
  assert.deepEqual(names(run).sort(), ["OPS/cxml", "OPS/d.bxml"]);
});

test("the media types that are not embedded are matched in any case, and an +xml type that is not /xml is embedded", async () => {
  const run = await runEpub(
    opf(
      "",
      `${C1}<item id="s" href="s.css" media-type="Text/CSS"/><item id="v" href="v.svg" media-type="IMAGE/SVG+XML"/>` +
        '<item id="i" href="i.bin" media-type="X-IBOOKS/thing"/><item id="n" href="n.ncx" media-type="Application/X-DTBNCX+XML"/>' +
        '<item id="x" href="x.xml" media-type="Application/XML"/><item id="a" href="a.atom" media-type="application/atom+xml"/>',
      SPINE,
    ),
    Object.fromEntries(["s.css", "v.svg", "i.bin", "n.ncx", "x.xml", "a.atom"].map((name) => [`OPS/${name}`, JPEG])),
  );
  assert.deepEqual(names(run), ["OPS/a.atom"]);
});

test("an item with an empty media type is embedded with no Content-Type of its own", async () => {
  const run = await runEpub(opf("", `${C1}<item id="a" href="a.bin" media-type=""/>`, SPINE), { "OPS/a.bin": JPEG });
  assert.deepEqual(names(run), ["OPS/a.bin"]);
  assert.equal(run.recorder.seen[0]?.metadata.get("Content-Type"), null);
});

/** An extractor that counts what it is asked, and what it is handed. */
class Counting implements EmbeddedDocumentExtractor {
  asked = 0;
  parsed = 0;
  allow = true;
  onParse: () => void = () => undefined;

  shouldParseEmbedded(): boolean {
    this.asked++;
    return this.allow;
  }

  async parseEmbedded(): Promise<void> {
    this.parsed++;
    this.onParse();
  }
}

async function runWith(extractor: EmbeddedDocumentExtractor, data: Uint8Array, context = new ParseContext()): Promise<{ metadata: Metadata; xml: string }> {
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(data);
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new EpubParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

const bookWith = (manifest: string, entries: Record<string, string | Uint8Array> = {}): Uint8Array =>
  archive({ "META-INF/container.xml": CONTAINER, "OPS/content.opf": opf("", `${C1}${manifest}`, SPINE), "OPS/c1.xhtml": CHAPTER, ...entries });

test("an item missing from the package is not offered to the extractor", async () => {
  const extractor = new Counting();
  await runWith(extractor, bookWith(IMG("a", "gone.jpg")));
  assert.equal(extractor.asked, 0);
});

test("an extractor that declines an item gets nothing and nothing is written for it", async () => {
  const extractor = new Counting();
  extractor.allow = false;
  const { xml } = await runWith(extractor, bookWith(IMG("a", "a.jpg"), { "OPS/a.jpg": JPEG }));
  assert.equal(extractor.asked, 1);
  assert.equal(extractor.parsed, 0);
  assert.doesNotMatch(xml, /embedded/);
});

function corrupt(data: Uint8Array, entry: string): Uint8Array {
  const copy = Uint8Array.from(data);
  const name = new TextEncoder().encode(entry);
  const at = copy.findIndex((_, index) => name.every((byte, offset) => copy[index + offset] === byte));
  const extra = copy[at - 2]! | (copy[at - 1]! << 8);
  copy[at + name.length + extra] = 0x07; // a final block of the reserved type
  return copy;
}

test("an entry that cannot be inflated is recorded on the package, skipped, and the parse goes on", async () => {
  const data = corrupt(
    archive({
      "META-INF/container.xml": CONTAINER,
      "OPS/content.opf": opf("", `${C1}${IMG("a", "a.jpg")}${IMG("b", "b.jpg")}`, SPINE),
      "OPS/c1.xhtml": CHAPTER,
      "OPS/a.jpg": new Uint8Array(2000).fill(7),
      "OPS/b.jpg": JPEG,
    }),
    "OPS/a.jpg",
  );
  const run = await runPackage(new EpubParser(), data);
  assert.deepEqual(names(run), ["OPS/b.jpg"]);
  const recorded = run.metadata.getAll("tk:exception:embedded-stream-exception");
  assert.equal(recorded.length, 1);
  assert.match(recorded[0]!, /Invalid ZIP entry OPS\/a\.jpg/);
  assert.equal(run.xml.match(/<div class="embedded">/g)?.length, 1);
  assert.match(run.xml, /Chapter text/);
});

test("an entry that exceeds the decompression limits ends the parse", async () => {
  const data = archive({
    "META-INF/container.xml": CONTAINER,
    "OPS/content.opf": opf("", `${C1}${IMG("a", "a.jpg")}`, SPINE),
    "OPS/c1.xhtml": CHAPTER,
    "OPS/a.jpg": new Uint8Array(5_000_000),
  });
  await assert.rejects(runPackage(new EpubParser(), data), LimitExceededError);
});

test("a failure that is recorded is the name and the message, and an empty message still has its colon", async () => {
  const run = await runEpub(
    opf("", `${C1}${IMG("a", "a.jpg")}`, SPINE),
    { "OPS/a.jpg": JPEG },
    new Map([["OPS/a.jpg", new TypeError("")]]),
  );
  assert.deepEqual(run.metadata.getAll("tk:exception:embedded-stream-exception"), ["TypeError: "]);
});

test("a failure of an embedded item ends the parse when the parse has been aborted", async () => {
  const controller = new AbortController();
  const extractor = new Counting();
  extractor.onParse = () => {
    controller.abort();
    throw new Error("boom");
  };
  await assert.rejects(
    runWith(extractor, bookWith(IMG("a", "a.jpg") + IMG("b", "b.jpg"), { "OPS/a.jpg": JPEG, "OPS/b.jpg": JPEG }), new ParseContext({ signal: controller.signal })),
  );
  assert.equal(extractor.parsed, 1);
});

// ---- the Dublin Core elements and the entity rule ----

test("the remaining Dublin Core bags are lists of distinct values", async () => {
  const run = await runEpub(
    opf(
      "<dc:subject>s1</dc:subject><dc:subject>s2</dc:subject><dc:subject>s1</dc:subject>" +
        "<dc:description>d1</dc:description><dc:description>d2</dc:description>" +
        "<dc:publisher>p1</dc:publisher><dc:publisher>p2</dc:publisher>" +
        "<dc:identifier>i1</dc:identifier><dc:identifier>i2</dc:identifier>" +
        "<dc:language>en</dc:language><dc:language>fr</dc:language><dc:creator>c1</dc:creator><dc:creator>c2</dc:creator>",
      C1,
      SPINE,
    ),
  );
  assert.deepEqual(run.metadata.getAll("dc:subject"), ["s1", "s2"]);
  assert.deepEqual(run.metadata.getAll("dc:description"), ["d1", "d2"]);
  assert.deepEqual(run.metadata.getAll("dc:publisher"), ["p1", "p2"]);
  assert.deepEqual(run.metadata.getAll("dc:identifier"), ["i1", "i2"]);
  assert.deepEqual(run.metadata.getAll("dc:language"), ["en", "fr"]);
  assert.deepEqual(run.metadata.getAll("dc:creator"), ["c1", "c2"]);
});

test("a Dublin Core value is trimmed, and an empty one is not a value", async () => {
  const run = await runEpub(opf("<dc:title>\n  Padded \n</dc:title><dc:title>   </dc:title><dc:publisher></dc:publisher>", C1, SPINE));
  assert.deepEqual(run.metadata.getAll("dc:title"), ["Padded"]);
  assert.equal(run.metadata.get("dc:publisher"), null);
});

test("dc:date keeps the last value it is given, as dcterms:created", async () => {
  const run = await runEpub(opf("<dc:date>2001</dc:date><dc:date>2002</dc:date>", C1, SPINE));
  assert.deepEqual(run.metadata.getAll("dcterms:created"), ["2002"]);
});

test("an EPUB 3 dcterms:modified meta is one value, the last", async () => {
  const run = await runEpub(
    opf('<meta property="dcterms:modified">2020-01-01T00:00:00Z</meta><meta property="dcterms:modified">2021-01-01T00:00:00Z</meta>', C1, SPINE),
  );
  assert.deepEqual(run.metadata.getAll("dcterms:modified"), ["2021-01-01T00:00:00Z"]);
});

const EXTERNAL = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

test("parseXmlTree refuses an undefined entity under an external DOCTYPE unless it is told to skip it", () => {
  const xml = `${EXTERNAL}<html><p>a&nbsp;b</p></html>`;
  assert.throws(() => parseXmlTree(xml), /undefined entity/);
  assert.equal(parseXmlTree(xml, { skipEntitiesOfExternalDtd: true }).children[0]!.children[0]!.text, "ab");
});

test("a SYSTEM DOCTYPE is an external DTD too", () => {
  const xml = '<!DOCTYPE html SYSTEM "x.dtd"><html><p>a&nbsp;b</p></html>';
  assert.equal(parseXmlTree(xml, { skipEntitiesOfExternalDtd: true }).children[0]!.children[0]!.text, "ab");
});

test("a DOCTYPE with no external DTD does not make an undefined entity skippable", () => {
  assert.throws(() => parseXmlTree("<!DOCTYPE html><html><p>a&nbsp;b</p></html>", { skipEntitiesOfExternalDtd: true }), /undefined entity/);
});

test("the predefined entities are still resolved under an external DOCTYPE that is skipped over", () => {
  const xml = `${EXTERNAL}<html><p>a&amp;b&lt;c</p></html>`;
  assert.equal(parseXmlTree(xml, { skipEntitiesOfExternalDtd: true }).children[0]!.children[0]!.text, "a&b<c");
});

test("element names of the package document are read in any case", async () => {
  // The port lowercases element names (epub-package.ts); whether Tika's scraper does is not checked here.
  const upper =
    '<package><METADATA><META name="cover" content="a"/></METADATA><MANIFEST><ITEM id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>' +
    '<ITEM id="a" href="a.jpg" media-type="image/jpeg"/></MANIFEST><SPINE><ITEMREF idref="c1"/></SPINE></package>';
  const run = await runEpub(upper, { "OPS/a.jpg": JPEG });
  assert.match(run.xml, /Chapter text/);
  assert.equal(run.recorder.seen[0]?.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
});

test("the stream handed to the extractor is closed after it, also when the extractor fails", async () => {
  for (const failure of [undefined, new Error("embedded failure")]) {
    let closed = 0;
    const extractor: EmbeddedDocumentExtractor = {
      shouldParseEmbedded: () => true,
      async parseEmbedded(stream: RipstreamInputStream): Promise<void> {
        const close = stream.close.bind(stream);
        stream.close = async () => {
          closed++;
          await close();
        };
        if (failure !== undefined) throw failure;
      },
    };
    await runWith(extractor, bookWith(IMG("a", "a.jpg"), { "OPS/a.jpg": JPEG }));
    assert.equal(closed, 1);
  }
});
