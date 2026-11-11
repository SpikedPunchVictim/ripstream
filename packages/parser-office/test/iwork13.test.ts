import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  TIKA_KEYS,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { IWork13Parser } from "../src/index.ts";
import { array, ascii, binaryPlist, stringDictionaryPlist } from "./plist-builder.ts";
import { JPEG, Recorder, archive, runPackage, type Run, type RunOptions } from "./iwork-harness.ts";

/*
 * What Tika 4.2.0's IWork13PackageParser does with a 2013-layout iWork package, read from its source and its
 * IWork13ParserTest; none of it was run against a Tika. The Index/*.iwa files (Snappy-compressed protobuf) are not
 * decoded there, so no text comes from them: the package gives metadata from three Metadata/ entries, a thumbnail, and
 * every other entry as an embedded document.
 */

const HISTORY = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><string>Template: White (2015-09-16 11:52)</string><string>T2.6.1 (2180)</string></array></plist>`;
const DOCUMENT_ID = "0123456789abcdef0123456789abcdef0123";

const run = (data: Uint8Array, options: RunOptions = {}): Promise<Run> => runPackage(new IWork13Parser(), data, options);

const PROPERTIES = stringDictionaryPlist({ revision: "7", isMultiPage: "NO" });

const FULL: Record<string, string | Uint8Array> = {
  "Index/Document.iwa": "not read",
  "Index/Slide.iwa": "not read",
  "Metadata/Properties.plist": PROPERTIES,
  "Metadata/BuildVersionHistory.plist": HISTORY,
  "Metadata/DocumentIdentifier": DOCUMENT_ID,
  "preview.jpg": JPEG,
  "preview-micro.jpg": JPEG,
  "preview-web.jpg": JPEG,
  "Data/picture.png": new Uint8Array([1, 2, 3]),
};

test("claims the four 2013 types, under the name Tika's parser has", () => {
  const parser = new IWork13Parser();
  assert.equal(parser.name, "IWork13PackageParser");
  assert.deepEqual(
    [...parser.getSupportedTypes()].map((type) => type.toString()).sort(),
    [
      "application/vnd.apple.keynote.13",
      "application/vnd.apple.numbers.13",
      "application/vnd.apple.pages.13",
      "application/vnd.apple.unknown.13",
    ],
  );
});

test("Properties.plist keys become iwork: metadata, each value as dd-plist writes it", async () => {
  const { metadata } = await run(archive(FULL));
  assert.equal(metadata.get("iwork:revision"), "7");
  assert.equal(metadata.get("iwork:isMultiPage"), "NO");
});

test("BuildVersionHistory.plist adds each string of its array to iwork:build-version-history", async () => {
  const { metadata } = await run(archive(FULL));
  assert.deepEqual(metadata.getAll("iwork:build-version-history"), ["Template: White (2015-09-16 11:52)", "T2.6.1 (2180)"]);
});

test("a BuildVersionHistory.plist that is a dictionary and a Properties.plist that is an array add nothing", async () => {
  const { metadata } = await run(
    archive({
      "Metadata/BuildVersionHistory.plist": stringDictionaryPlist({ a: "b" }),
      "Metadata/Properties.plist": binaryPlist([array(1), ascii("x")]),
    }),
    { name: "x.pages" },
  );
  assert.deepEqual(metadata.getAll("iwork:build-version-history"), []);
  assert.deepEqual(metadata.names().filter((name) => name.startsWith("iwork:")), []);
});

test("DocumentIdentifier gives iwork:document-id from its first 36 bytes, and nothing when it has fewer", async () => {
  assert.equal((await run(archive(FULL))).metadata.get("iwork:document-id"), DOCUMENT_ID);
  const longer = await run(archive({ "Metadata/DocumentIdentifier": `${DOCUMENT_ID}-and more` }));
  assert.equal(longer.metadata.get("iwork:document-id"), DOCUMENT_ID);
  const shorter = await run(archive({ "Metadata/DocumentIdentifier": DOCUMENT_ID.slice(0, 35) }));
  assert.equal(shorter.metadata.get("iwork:document-id"), null);
});

test("DocumentIdentifier bytes are read as ISO-8859-1", async () => {
  const bytes = new Uint8Array(36).fill(0x41);
  bytes[0] = 0xe9;
  const { metadata } = await run(archive({ "Metadata/DocumentIdentifier": bytes }));
  assert.equal(metadata.get("iwork:document-id"), `é${"A".repeat(35)}`);
});

test("preview.jpg is emitted as the thumbnail; the micro and web previews and the .iwa parts are not emitted", async () => {
  const { recorder } = await run(archive(FULL));
  const preview = recorder.seen.find((item) => item.name === "preview.jpg");
  assert.equal(preview?.metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE), "THUMBNAIL");
  assert.deepEqual([...preview!.bytes], [...JPEG]);
  assert.deepEqual(recorder.seen.map((item) => item.name).sort(), ["Data/picture.png", "preview.jpg"]);
});

test("every other entry is emitted as an embedded document named by its path, with no resource type", async () => {
  const { recorder } = await run(archive(FULL));
  const picture = recorder.seen.find((item) => item.name === "Data/picture.png");
  assert.equal(picture?.metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE), null);
  assert.deepEqual([...picture!.bytes], [1, 2, 3]);
});

test("an embedded entry is written inside a package-entry div under an h1 of its name", async () => {
  const { xml } = await run(archive({ "preview.jpg": JPEG }));
  assert.match(xml, /<div class="package-entry"><h1>preview\.jpg<\/h1>\s*<\/div>/);
});

test("an entry the parser skips is not inflated, so a damaged one does not fail the package", async () => {
  const data = archive({ "Index/Document.iwa": "x".repeat(100), "preview-web.jpg": JPEG });
  // Corrupt the deflate stream of the .iwa entry: its local header is the first thing in the file.
  const damaged = data.slice();
  const at = 30 + "Index/Document.iwa".length;
  damaged.fill(0xff, at, at + 4);
  const { metadata } = await run(damaged);
  assert.equal(metadata.get("Content-Type"), "application/vnd.apple.unknown.13");
});

test("Slide and MasterSlide parts identify a Keynote package, whatever the file name says", async () => {
  for (const part of ["Index/Slide.iwa", "Index/Slide-7.iwa", "Index/MasterSlide.iwa", "Index/MasterSlide-3.iwa"]) {
    const { metadata } = await run(archive({ [part]: "x" }), { name: "deck.numbers" });
    assert.equal(metadata.get("Content-Type"), "application/vnd.apple.keynote.13", part);
  }
});

test("parts that only look like Slide parts do not identify Keynote", async () => {
  for (const part of ["Index/Slide-7.txt", "Index/Slides.iwa", "Other/Index/Slide.iwa", "Index/Document.iwa"]) {
    const { metadata } = await run(archive({ [part]: "x" }));
    assert.equal(metadata.get("Content-Type"), "application/vnd.apple.unknown.13", part);
  }
});

test("a package no entry identifies is typed by its file name's extension, in any case, else left unknown", async () => {
  const data = archive({ "Index/Document.iwa": "x" });
  const expected: [string | undefined, string][] = [
    ["Budget.numbers", "application/vnd.apple.numbers.13"],
    ["Letter.PAGES", "application/vnd.apple.pages.13"],
    ["Deck.Key", "application/vnd.apple.keynote.13"],
    ["notes.txt", "application/vnd.apple.unknown.13"],
    [undefined, "application/vnd.apple.unknown.13"],
  ];
  for (const [name, type] of expected) {
    assert.equal((await run(data, { name })).metadata.get("Content-Type"), type, String(name));
  }
});

test("an entry outside the Metadata and preview names that is not .iwa is embedded even if it sits under Index/", async () => {
  const { recorder } = await run(archive({ "Index/Tables/DataList.txt": "x", "Metadata/Other.plist": "x" }));
  assert.deepEqual(recorder.seen.map((item) => item.name).sort(), ["Index/Tables/DataList.txt", "Metadata/Other.plist"]);
});

test("a failure to read one embedded document is recorded on the package, and the rest are still emitted", async () => {
  const failures = new Map([["Data/bad.png", new Error("cannot read")]]);
  const { metadata, recorder } = await run(archive({ "Data/bad.png": "x", "preview.jpg": JPEG }), { failures });
  assert.equal(metadata.get(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION), "Error: cannot read");
  assert.deepEqual(recorder.seen.map((item) => item.name).sort(), ["Data/bad.png", "preview.jpg"]);
  assert.equal(metadata.get("Content-Type"), "application/vnd.apple.unknown.13");
});

test("a limit reached inside an embedded document ends the parse", async () => {
  const failures = new Map([["Data/bad.png", new LimitExceededError("too many")]]);
  await assert.rejects(run(archive({ "Data/bad.png": "x" }), { failures }), LimitExceededError);
});

test("a plist that cannot be read fails the package after the other entries are processed, with no Content-Type", async () => {
  const data = archive({
    "Metadata/Properties.plist": new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 1, 2, 3]),
    "Metadata/DocumentIdentifier": DOCUMENT_ID,
    "preview.jpg": JPEG,
  });
  const metadata = new Metadata();
  const context = new ParseContext();
  const recorder = new Recorder();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, recorder);
  const stream = await RipstreamInputStream.from(data);
  await assert.rejects(new IWork13Parser().parse(stream, createOutputHandler("xml"), metadata, context), MalformedDocumentError);
  await stream.close();
  assert.equal(metadata.get("iwork:document-id"), DOCUMENT_ID);
  assert.deepEqual(recorder.seen.map((item) => item.name), ["preview.jpg"]);
  assert.equal(metadata.get("Content-Type"), null);
});

test("an entry whose data cannot be inflated fails the package after the others are processed, with no Content-Type", async () => {
  const data = archive({ "Data/a.bin": "x".repeat(100), "preview.jpg": JPEG });
  const damaged = data.slice();
  const at = 30 + "Data/a.bin".length;
  damaged.fill(0xff, at, at + 4);
  const metadata = new Metadata();
  const context = new ParseContext();
  const recorder = new Recorder();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, recorder);
  const stream = await RipstreamInputStream.from(damaged);
  await assert.rejects(new IWork13Parser().parse(stream, createOutputHandler("xml"), metadata, context), MalformedDocumentError);
  await stream.close();
  assert.deepEqual(recorder.seen.map((item) => item.name), ["preview.jpg"]);
  assert.equal(metadata.get("Content-Type"), null);
});

test("a plist that fans out past the object cap is refused as a limit, not read around", async () => {
  const levels = Array.from({ length: 6 }, (_, i) => array(...Array<number>(14).fill(i + 1)));
  const hostile = binaryPlist([...levels, ascii("x")]);
  await assert.rejects(run(archive({ "Metadata/BuildVersionHistory.plist": hostile })), LimitExceededError);
});

test("data that is not a ZIP package is malformed", async () => {
  await assert.rejects(run(new Uint8Array(0)), MalformedDocumentError);
  await assert.rejects(run(new Uint8Array(512).fill(7)), MalformedDocumentError);
});

test("an entry that inflates past the embedded limit is refused as a limit", async () => {
  const data = archive({ "Data/big.bin": new Uint8Array(100_000) });
  const context = new ParseContext({ limits: { maxEmbeddedResourceBytes: 1000 } });
  await assert.rejects(run(data, { context }), LimitExceededError);
});

test("a document with more entries than the limit allows is refused as a limit", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`Data/${i}.bin`] = "x";
  const context = new ParseContext({ limits: { maxZipEntries: 3 } });
  await assert.rejects(run(archive(files), { context }), LimitExceededError);
});

test("every prefix of a valid package parses or is refused as malformed", async () => {
  const data = archive({
    "Index/Slide.iwa": "x",
    "Metadata/Properties.plist": PROPERTIES,
    "Metadata/BuildVersionHistory.plist": HISTORY,
    "Metadata/DocumentIdentifier": DOCUMENT_ID,
    "preview.jpg": JPEG,
  });
  for (let length = 0; length <= data.byteLength; length++) {
    try {
      await run(data.subarray(0, length));
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes threw ${String(error)}`);
    }
  }
  assert.equal((await run(data)).metadata.get("Content-Type"), "application/vnd.apple.keynote.13");
});

test("the number of properties and the Content-Type are what Tika's Keynote test counts", async () => {
  // IWork13ParserTest.testParseKeynote13 expects 9 metadata entries: six plist keys, the history, the identifier and
  // the type. Here two keys stand in for six.
  const { metadata } = await run(archive(FULL));
  assert.equal(metadata.size(), 5);
});
