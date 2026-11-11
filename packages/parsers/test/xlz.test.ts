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
import { XLZParser } from "../src/index.ts";

/*
 * Ported from the case of Tika 4.2.0's XLZParserTest and XLIFF12ParserTest, with archives built here instead of its
 * fixture. The expectations are what XLZParser.java, XLIFF12Parser.java and XLIFF12ContentHandler.java do when read;
 * none of this was run against a Tika.
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

function xliff(files: string): string {
  return `${XML_HEAD}<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">${files}</xliff>`;
}

function file(original: string, source: string, target: string | undefined, units: string): string {
  const targetAttribute = target === undefined ? "" : ` target-language="${target}"`;
  return `<file original="${original}" source-language="${source}"${targetAttribute} datatype="plaintext"><header/><body>${units}</body></file>`;
}

function unit(id: string, source: string, target?: string): string {
  const targetElement = target === undefined ? "" : `<target xml:lang="fr">${target}</target>`;
  return `<trans-unit id="${id}"><source xml:lang="en">${source}</source>${targetElement}</trans-unit>`;
}

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
    await new XLZParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

const TWO_FILES = xliff(
  file("one.txt", "en", "fr", unit("1", "Hooray", "Hourra") + unit("2", "Another trans-unit", "Un autre trans-unit")) +
    file("two.txt", "en", "fr", unit("3", "Third") + unit("4", "Fourth")),
);

test("the text, the counts and the languages of an XLIFF 1.2 file in an archive", async () => {
  const result = await run({ "testXLIFF12.xlf": TWO_FILES });
  assert.match(result.xml, /Hooray/);
  assert.equal(result.metadata.get("file-count"), "2");
  assert.equal(result.metadata.get("tu-count"), "4");
  assert.equal(result.metadata.get("source-language"), "en");
  assert.equal(result.metadata.get("target-language"), "fr");
});

test("each file is a div with its original name as a heading, each unit a div, each source and target a paragraph", async () => {
  const result = await run({ "a.xlf": TWO_FILES });
  assert.match(result.xml, /<div>\s*<h1>one\.txt<\/h1>/);
  assert.match(result.xml, /<div id="1"><p lang="en">Hooray<\/p>\s*<p lang="fr">Hourra<\/p>\s*<\/div>/);
  assert.match(result.xml, /<p lang="en">Another trans-unit<\/p>/);
  assert.match(result.xml, /<p lang="fr">Un autre trans-unit<\/p>/);
});

test("the type becomes the XLIFF one, as XLIFF12Parser sets it on the metadata it is given", async () => {
  const result = await run({ "a.xlf": TWO_FILES });
  assert.equal(result.metadata.get("Content-Type"), "application/x-xliff+xml");
});

test("the source language is added under original as well (Tika adds the wrong attribute)", async () => {
  const result = await run({ "a.xlf": TWO_FILES });
  assert.deepEqual(result.metadata.getAll("original"), ["en", "en"]);
  assert.deepEqual(result.metadata.getAll("source-language"), ["en", "en"]);
});

test("a file with no target language adds none, and one without a source language adds nothing", async () => {
  const result = await run({
    "a.xlf": xliff(file("a", "de", undefined, unit("1", "x")) + '<file original="b"><body/></file>'),
  });
  assert.deepEqual(result.metadata.getAll("source-language"), ["de"]);
  assert.deepEqual(result.metadata.getAll("target-language"), []);
  assert.equal(result.metadata.get("file-count"), "2");
});

test("only text inside a trans-unit is written, and all of it, tags aside", async () => {
  const result = await run({
    "a.xlf": xliff(
      '<file original="f" source-language="en"><header><note>header note</note></header><body>' +
        '<group><trans-unit id="1"><source>one <g id="g">two</g> <x id="x"/>three<![CDATA[ <four> ]]></source>' +
        "<note>a note</note></trans-unit></group>" +
        "</body></file>",
    ),
  });
  assert.doesNotMatch(result.xml, /header note/);
  assert.match(result.xml, /<p>one two three &lt;four&gt; <\/p>/);
  assert.match(result.xml, /a note/);
});

test("a trans-unit keeps its attributes, but not namespace declarations", async () => {
  const result = await run({
    "a.xlf": xliff(
      '<file original="f" source-language="en"><body><trans-unit id="7" approved="yes" xml:lang="en" xmlns:x="urn:x"><source>s</source></trans-unit></body></file>',
    ),
  });
  assert.match(result.xml, /<div id="7" approved="yes" xml:lang="en">/);
  assert.doesNotMatch(result.xml, /xmlns:x/);
});

test("a file with no original attribute gets an empty heading", async () => {
  const result = await run({ "a.xlf": xliff('<file source-language="en"><body><trans-unit id="1"><source>s</source></trans-unit></body></file>') });
  assert.match(result.xml, /<h1><\/h1>/);
  assert.equal(result.metadata.get("file-count"), "1");
});

test("every entry whose name contains .xlf is read, in archive order, and the counts are those of the last", async () => {
  const result = await run({
    "first.xlf": xliff(file("f1", "en", "fr", unit("1", "From the first"))),
    "readme.txt": "not xliff",
    "nested/second.xlf.bak": xliff(file("f2", "en", "de", unit("2", "From the second") + unit("3", "More"))),
  });
  assert.ok(result.xml.indexOf("From the first") < result.xml.indexOf("From the second"));
  assert.doesNotMatch(result.xml, /not xliff/);
  assert.equal(result.metadata.get("file-count"), "1");
  assert.equal(result.metadata.get("tu-count"), "2");
  assert.deepEqual(result.metadata.getAll("target-language"), ["fr", "de"]);
});

test("an archive with no XLIFF file gives an empty document", async () => {
  const result = await run({ "readme.txt": "nothing here" });
  assert.equal(result.metadata.get("file-count"), null);
  assert.doesNotMatch(result.xml, /nothing here/);
  // No document was started, so none is ended: Tika ends the outer document only when an inner one has ended.
  assert.equal(result.xml, "");
});

test("the encoding is the one the XML declares", async () => {
  const latin1 = new Uint8Array([
    ...strToU8('<?xml version="1.0" encoding="ISO-8859-1"?><xliff><file original="f" source-language="en"><body><trans-unit id="1"><source>caf'),
    0xe9,
    ...strToU8("</source></trans-unit></body></file></xliff>"),
  ]);
  const result = await run({ "a.xlf": latin1 });
  assert.match(result.xml, /<p>café<\/p>/);
});

test("an XLIFF file that is not well-formed fails the parse", async () => {
  await assert.rejects(
    run({ "a.xlf": `${XML_HEAD}<xliff><file original="f" source-language="en"><body><trans-unit id="1"><source>cut off` }),
    MalformedDocumentError,
  );
});

test("supports the one XLZ type", () => {
  assert.deepEqual([...new XLZParser().getSupportedTypes()].map((type) => type.toString()), ["application/x-xliff+zip"]);
});

test("a hostile archive is refused, not expanded: an entry bomb, too many entries and a bomb behind a name that is not XLIFF", async () => {
  const bomb = await RipstreamInputStream.from(archive({ "a.xlf": new Uint8Array(5_000_000), "b.xlf": new Uint8Array(5_000_000) }));
  await assert.rejects(
    new XLZParser().parse(bomb, createOutputHandler("xml"), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await bomb.close();

  const many: Record<string, string> = { "a.xlf": TWO_FILES };
  for (let index = 0; index < 20; index++) many[`extra/${index}.txt`] = "x";
  const crowded = await RipstreamInputStream.from(archive(many));
  await assert.rejects(
    new XLZParser().parse(
      crowded,
      createOutputHandler("xml"),
      new Metadata(),
      new ParseContext({ limits: { maxZipEntries: 10 } }),
    ),
    LimitExceededError,
  );
  await crowded.close();

  // A name that is not XLIFF is never inflated, so its size is no concern of this parser.
  const ignored = await run({ "a.xlf": TWO_FILES, "big.bin": new Uint8Array(5_000_000) });
  assert.equal(ignored.metadata.get("tu-count"), "4");
});
