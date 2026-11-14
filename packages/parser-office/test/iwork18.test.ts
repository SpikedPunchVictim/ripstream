import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError, ParseContext, TIKA_KEYS } from "@spikedpunch/ripstream-core";
import { IWork18Parser } from "../src/index.ts";
import { JPEG, archive, runPackage, type Run, type RunOptions } from "./iwork-harness.ts";

/*
 * What Tika 4.2.0's IWork18PackageParser does with a 2018-layout iWork package (a ZIP holding one directory, such as
 * Presentation.key/), read from its source and its IWork18ParserTest; none of it was run against a Tika. It types the
 * package from the name of its Metadata/BuildVersionHistory.plist entry and emits the preview image as a thumbnail; the
 * content is not parsed there.
 */

const run = (data: Uint8Array, options: RunOptions = {}): Promise<Run> => runPackage(new IWork18Parser(), data, options);

const KEYNOTE_PACKAGE: Record<string, string | Uint8Array> = {
  "Presentation.key/Metadata/BuildVersionHistory.plist": "<plist><array/></plist>",
  "Presentation.key/Metadata/Properties.plist": "not read",
  "Presentation.key/Index/Document.iwa": "not read",
  "Presentation.key/preview.jpg": JPEG,
  "Presentation.key/Data/picture.png": new Uint8Array([1, 2, 3]),
};

test("claims the three 2018 types, under the name Tika's parser has", () => {
  const parser = new IWork18Parser();
  assert.equal(parser.name, "IWork18PackageParser");
  assert.deepEqual(
    [...parser.getSupportedTypes()].map((type) => type.toString()).sort(),
    ["application/vnd.apple.keynote.18", "application/vnd.apple.numbers.18", "application/vnd.apple.pages.18"],
  );
});

test("the extension of the package directory that holds BuildVersionHistory.plist gives the type", async () => {
  const expected: [string, string][] = [
    ["Budget.numbers", "application/vnd.apple.numbers.18"],
    ["Letter.pages", "application/vnd.apple.pages.18"],
    ["Presentation.key", "application/vnd.apple.keynote.18"],
  ];
  for (const [directory, type] of expected) {
    const { metadata } = await run(archive({ [`${directory}/Metadata/BuildVersionHistory.plist`]: "x" }));
    assert.equal(metadata.get("Content-Type"), type, directory);
  }
});

test("without a BuildVersionHistory.plist under a .key, .pages or .numbers directory no Content-Type is set", async () => {
  for (const name of [
    "Metadata/BuildVersionHistory.plist",
    "Deck.keynote/Metadata/BuildVersionHistory.plist",
    "Deck.key/Metadata/Properties.plist",
    "Deck.key/Index/Document.iwa",
  ]) {
    const { metadata } = await run(archive({ [name]: "x" }));
    assert.equal(metadata.get("Content-Type"), null, name);
  }
});

test("the first entry that identifies the package decides its type", async () => {
  const { metadata } = await run(
    archive({
      "A.pages/Metadata/BuildVersionHistory.plist": "x",
      "B.numbers/Metadata/BuildVersionHistory.plist": "x",
    }),
  );
  assert.equal(metadata.get("Content-Type"), "application/vnd.apple.pages.18");
});

test("the preview is emitted as a thumbnail typed image/jpeg, named by its path in the package", async () => {
  const { recorder } = await run(archive(KEYNOTE_PACKAGE));
  assert.equal(recorder.seen.length, 1);
  const [preview] = recorder.seen;
  assert.equal(preview!.name, "Presentation.key/preview.jpg");
  assert.equal(preview!.metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE), "THUMBNAIL");
  assert.equal(preview!.metadata.get("Content-Type"), "image/jpeg");
  assert.deepEqual([...preview!.bytes], [...JPEG]);
});

test("only a file named preview.jpg, at the root or in any directory, is a preview", async () => {
  const { recorder } = await run(
    archive({
      "preview.jpg": JPEG,
      "A/B/preview.jpg": JPEG,
      "mypreview.jpg": JPEG,
      "preview.jpg.bak": JPEG,
      "preview-web.jpg": JPEG,
      "Deck.key/Data/preview.png": JPEG,
    }),
  );
  assert.deepEqual(recorder.seen.map((item) => item.name), ["preview.jpg", "A/B/preview.jpg"]);
});

test("nothing but the previews is emitted, and the plists add no metadata", async () => {
  const { metadata, recorder } = await run(archive(KEYNOTE_PACKAGE));
  assert.deepEqual(recorder.seen.map((item) => item.name), ["Presentation.key/preview.jpg"]);
  assert.deepEqual(metadata.names().sort(), ["Content-Type"]);
});

test("a preview is written inside a package-entry div under an h1 of its name", async () => {
  const { xml } = await run(archive(KEYNOTE_PACKAGE));
  assert.match(xml, /<div class="package-entry"><h1>Presentation\.key\/preview\.jpg<\/h1>\s*<\/div>/);
});

test("a failure of the embedded preview is recorded on the package, which keeps its type", async () => {
  const failures = new Map([["Presentation.key/preview.jpg", new Error("cannot read")]]);
  const { metadata } = await run(archive(KEYNOTE_PACKAGE), { failures });
  assert.equal(metadata.get(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION), "Error: cannot read");
  assert.equal(metadata.get("Content-Type"), "application/vnd.apple.keynote.18");
});

test("a limit reached inside the embedded preview ends the parse", async () => {
  const failures = new Map([["Presentation.key/preview.jpg", new LimitExceededError("too many")]]);
  await assert.rejects(run(archive(KEYNOTE_PACKAGE), { failures }), LimitExceededError);
});

test("an entry that is not a preview is not inflated, so a damaged one does not fail the package", async () => {
  const data = archive({
    "Deck.key/Index/Document.iwa": "x".repeat(100),
    "Deck.key/Metadata/BuildVersionHistory.plist": "x",
  });
  const damaged = data.slice();
  const at = 30 + "Deck.key/Index/Document.iwa".length;
  damaged.fill(0xff, at, at + 4);
  assert.equal((await run(damaged)).metadata.get("Content-Type"), "application/vnd.apple.keynote.18");
});

test("a preview whose data cannot be inflated is skipped, as Tika skips an unreadable entry", async () => {
  const data = archive({ "Deck.key/preview.jpg": "x".repeat(100) });
  const damaged = data.slice();
  const at = 30 + "Deck.key/preview.jpg".length;
  damaged.fill(0xff, at, at + 4);
  await assert.doesNotReject(run(damaged));
});

test("a preview that inflates past the embedded limit is refused as a limit", async () => {
  const data = archive({ "Deck.key/preview.jpg": new Uint8Array(100_000) });
  const context = new ParseContext({ limits: { maxEmbeddedResourceBytes: 1000 } });
  await assert.rejects(run(data, { context }), LimitExceededError);
});

test("a package with more entries than the limit allows is refused as a limit", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`Deck.key/Data/${i}.bin`] = "x";
  const context = new ParseContext({ limits: { maxZipEntries: 3 } });
  await assert.rejects(run(archive(files), { context }), LimitExceededError);
});

test("data that is not a ZIP package is malformed", async () => {
  await assert.rejects(run(new Uint8Array(0)), MalformedDocumentError);
  await assert.rejects(run(new Uint8Array(512).fill(7)), MalformedDocumentError);
});

test("every prefix of a valid package parses or is refused as malformed", async () => {
  const data = archive(KEYNOTE_PACKAGE);
  for (let length = 0; length <= data.byteLength; length++) {
    try {
      await run(data.subarray(0, length));
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes threw ${String(error)}`);
    }
  }
  assert.equal((await run(data)).metadata.get("Content-Type"), "application/vnd.apple.keynote.18");
});
