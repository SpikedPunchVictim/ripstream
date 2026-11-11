import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRipstream } from "../src/index.ts";

/*
 * Tika 4.2.0's EpubParserTest, over its own EPUB files (fixtures/epub): the metadata of the Dublin Core elements, and the
 * embedded documents with the cover as the thumbnail (tikajs-68os.51). Read from the Tika source, not run against a Tika.
 */

const ripstream = createRipstream();

// The multi-metadata book is a whole novel: more text than the default output limit.
const WHOLE_BOOK = { limits: { maxOutputChars: 2_000_000 } };

function sample(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/epub/${name}`, import.meta.url)));
}

test("testEPUB.epub: the EPUB 2 cover meta names the cover image, emitted as the thumbnail", async () => {
  const records = await ripstream.parseRecursive(sample("testEPUB.epub"), { filename: "testEPUB.epub" });
  assert.equal(records.length, 2);
  assert.equal(records[1]?.metadata.get("Content-Type"), "image/jpeg");
  assert.equal(records[1]?.metadata.get("tk:resource-name"), "OPS/CoverDesign.jpg");
  assert.equal(records[1]?.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
});

test("testEPUB.epub: the Dublin Core elements, dc:contributor among them", async () => {
  const records = await ripstream.parseRecursive(sample("testEPUB.epub"), { filename: "testEPUB.epub" });
  const metadata = records[0]!.metadata;
  assert.deepEqual(metadata.getAll("dc:contributor"), ["no-one"]);
  assert.deepEqual(metadata.getAll("dc:language"), ["en"]);
  assert.deepEqual(metadata.getAll("dc:publisher"), ["Apache"]);
  assert.deepEqual(metadata.getAll("dc:description"), ["This is an ePub test publication for Tika."]);
});

test("testEPUB.epub: the table of contents comes before the chapters", async () => {
  const records = await ripstream.parseRecursive(sample("testEPUB.epub"), { filename: "testEPUB.epub" });
  const text = records[0]!.content;
  const toc = text.indexOf("Table of Contents");
  const one = text.indexOf("Chapter 1");
  const two = text.indexOf("Chapter 2");
  assert.ok(toc > -1 && one > toc && two > one, `toc=${toc} one=${one} two=${two}`);
});

test("testEPUB_xml_ext.epub: one document, with its text", async () => {
  const records = await ripstream.parseRecursive(sample("testEPUB_xml_ext.epub"), { filename: "testEPUB_xml_ext.epub" });
  assert.equal(records.length, 1);
  assert.match(records[0]!.content, /It was a bright cold day in April/);
});

test("testEPUB_multi-metadata-vals.epub: every value of each Dublin Core element (TIKA-4466)", async () => {
  const records = await ripstream.parseRecursive(sample("testEPUB_multi-metadata-vals.epub"), {
    filename: "testEPUB_multi-metadata-vals.epub",
    ...WHOLE_BOOK,
  });
  const metadata = records[0]!.metadata;
  const set = (key: string): Set<string> => new Set(metadata.getAll(key));
  assert.deepEqual(set("dc:publisher"), new Set(["Standard Ebooks", "Guternberg"]));
  assert.deepEqual(
    set("dc:title"),
    new Set(["The Inheritors", "An Extravagant Story", "The Inheritors: An Extravagant Story"]),
  );
  assert.deepEqual(
    set("dc:contributor"),
    new Set([
      "The League of Moveable Type",
      "zikasak",
      "William Holyoake",
      "Clare Boothby",
      "Graeme Mackreth",
      "Distributed Proofreaders",
      "Szymon Szott",
      "David Reimer",
    ]),
  );
  assert.deepEqual(set("dc:creator"), new Set(["Joseph Conrad", "Ford Madox Ford"]));
  assert.deepEqual(set("dc:language"), new Set(["en-GB", "en-US"]));
  assert.deepEqual(
    set("dc:description"),
    new Set([
      "A young writer dabbling in journalism meets a strange, otherworldly woman with long-term political goals.",
      "additional description",
    ]),
  );
  assert.deepEqual(
    set("dc:source"),
    new Set(["https://www.gutenberg.org/ebooks/14888", "https://archive.org/details/inheritorsanext01fordgoog/"]),
  );
  assert.deepEqual(
    set("dc:identifier"),
    new Set(["https://standardebooks.org/ebooks/joseph-conrad_ford-madox-ford/the-inheritors", "isbn:0571225470"]),
  );
  assert.deepEqual(set("dc:subject"), new Set(["Science fiction"]));
  assert.equal(metadata.getAll("dc:rights").length, 2);
  assert.match(metadata.getAll("dc:rights")[0]!, /^The source text and artwork/);
  assert.equal(metadata.getAll("dc:rights")[1], "test rights");
});

test("testEPUB_multi-metadata-vals.epub: only the EPUB 3 cover-image item is the thumbnail", async () => {
  const records = await ripstream.parseRecursive(sample("testEPUB_multi-metadata-vals.epub"), {
    filename: "testEPUB_multi-metadata-vals.epub",
    ...WHOLE_BOOK,
  });
  const thumbnails = records.filter((r) => r.metadata.get("tk:embedded-resource-type") === "THUMBNAIL");
  assert.deepEqual(
    thumbnails.map((r) => r.metadata.get("tk:resource-name")),
    ["epub/images/cover.jpg"],
  );
});
