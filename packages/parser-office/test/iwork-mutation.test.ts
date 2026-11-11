import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  CONTEXT_KEYS,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  TIKA_KEYS,
  createOutputHandler,
  type EmbeddedDocumentExtractor,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { IWork13Parser, IWork18Parser } from "../src/index.ts";
import { JPEG, archive, runPackage } from "./iwork-harness.ts";

/*
 * Pins found by mutation testing the iWork package parsers (tikajs-68os.18): what counts as a ZIP package, when an
 * extractor that declines an entry is asked nothing, which failure the 2013 parser reports, and that an aborted parse
 * stops. Tika 4.2.0's IWork13PackageParser and IWork18PackageParser are the reference.
 */

const parsers: [string, () => Parser][] = [
  ["IWork13Parser", () => new IWork13Parser()],
  ["IWork18Parser", () => new IWork18Parser()],
];

test("a ZIP archive with no entries is an empty package, not a refusal", async () => {
  for (const [name, make] of parsers) {
    const { recorder, metadata } = await runPackage(make(), archive({}));
    assert.deepEqual(recorder.seen, [], name);
    // the 2013 parser types an unidentified package; the 2018 parser leaves the type to the caller
    assert.equal(metadata.get("Content-Type"), name === "IWork13Parser" ? "application/vnd.apple.unknown.13" : null, name);
  }
});

test("data that opens with PK but is not a ZIP archive is malformed: only the end-of-archive record of an empty one is allowed", async () => {
  // Tika opens the package as a ZipFile, which refuses anything without a central directory ("Archive is not a ZIP archive").
  const junk = (head: number[]): Uint8Array => Uint8Array.from([...head, ...Array<number>(30).fill(0x41)]);
  const empty = archive({});
  assert.deepEqual([...empty.subarray(0, 4)], [0x50, 0x4b, 0x05, 0x06]);
  for (const [name, make] of parsers) {
    await assert.rejects(runPackage(make(), junk([0x50, 0x4b])), MalformedDocumentError, name);
    await assert.rejects(runPackage(make(), junk([0x50, 0x4b, 0x05])), MalformedDocumentError, name);
    for (let at = 0; at < 4; at++) {
      const changed = empty.slice();
      changed[at] = changed[at]! ^ 0x01;
      await assert.rejects(runPackage(make(), changed), MalformedDocumentError, `${name}, byte ${at} changed`);
    }
  }
});

/** An extractor that declines every entry, and counts the ones it was asked about. */
class Declining implements EmbeddedDocumentExtractor {
  asked = 0;
  parsed = 0;
  shouldParseEmbedded(): boolean {
    this.asked++;
    return false;
  }
  async parseEmbedded(): Promise<void> {
    this.parsed++;
  }
}

async function runDeclined(parser: Parser, data: Uint8Array): Promise<{ xml: string; declining: Declining }> {
  const context = new ParseContext();
  const declining = new Declining();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, declining);
  const stream = await RipstreamInputStream.from(data);
  const handler = createOutputHandler("xml");
  try {
    await parser.parse(stream, handler, new Metadata(), context);
  } finally {
    await stream.close();
  }
  return { xml: handler.toString(), declining };
}

test("an entry the extractor declines is not written at all: no wrapper, no heading, no parse", async () => {
  const files = { "Data/picture.png": new Uint8Array([1, 2, 3]), "preview.jpg": JPEG, "Deck.key/preview.jpg": JPEG };
  for (const [name, make] of parsers) {
    const { xml, declining } = await runDeclined(make(), archive(files));
    assert.ok(declining.asked > 0, `${name}: the extractor was asked`);
    assert.equal(declining.parsed, 0, name);
    assert.doesNotMatch(xml, /package-entry|<h1>/, name);
  }
});

test("an entry is wrapped for the extractor with the class Tika's outputHtml writes", async () => {
  const { xml } = await runPackage(new IWork13Parser(), archive({ "Data/picture.png": new Uint8Array([1]) }));
  assert.match(xml, /<div class="package-entry"><h1>Data\/picture\.png<\/h1>/);
});

test("two failing entries: the package error is the last one's, as Tika keeps the last exception", async () => {
  const data = archive({
    "Metadata/Properties.plist": new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 1, 2, 3]),
    "Metadata/BuildVersionHistory.plist": "<plist><integer>not a number</integer></plist>",
  });
  await assert.rejects(runPackage(new IWork13Parser(), data), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.equal(error.message, "Problem processing the iWork package");
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /not a number/);
    return true;
  });
});

test("an entry failure on the package is added to the stream-exception key, one value for each failure", async () => {
  const failures = new Map([
    ["Data/a.png", new Error("first")],
    ["Data/b.png", new Error("second")],
  ]);
  const { metadata } = await runPackage(new IWork13Parser(), archive({ "Data/a.png": "x", "Data/b.png": "y" }), { failures });
  assert.deepEqual(metadata.getAll(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION), ["Error: first", "Error: second"]);
});

test("an entry whose name merely ends in iwa, without the dot, is embedded", async () => {
  const { recorder } = await runPackage(new IWork13Parser(), archive({ "Data/aiwa": "x", "Data/b.iwa": "y" }));
  assert.deepEqual(recorder.seen.map((item) => item.name), ["Data/aiwa"]);
});

test("a package whose history is an array of non-strings writes each item as dd-plist's toString does", async () => {
  const history = "<plist><array><integer>5</integer><true/><real>1.5</real></array></plist>";
  const { metadata } = await runPackage(new IWork13Parser(), archive({ "Metadata/BuildVersionHistory.plist": history }));
  assert.deepEqual(metadata.getAll("iwork:build-version-history"), ["5", "true", "1.5"]);
});

test("DocumentIdentifier bytes 0x80 to 0x9F are the C1 controls ISO-8859-1 gives, not windows-1252 characters", async () => {
  // Tika: new String(bytes, StandardCharsets.ISO_8859_1) (IWork13PackageParser.extractDocumentIdentifier)
  const bytes = new Uint8Array(36).fill(0x41);
  bytes[0] = 0x80;
  bytes[1] = 0x9f;
  bytes[2] = 0xe9;
  const { metadata } = await runPackage(new IWork13Parser(), archive({ "Metadata/DocumentIdentifier": bytes }));
  assert.equal(metadata.get("iwork:document-id"), `\u0080\u009fé${"A".repeat(33)}`);
});

test("an aborted parse stops before it reads an entry, in both parsers", async () => {
  const controller = new AbortController();
  controller.abort();
  const files = { "Metadata/DocumentIdentifier": "x".repeat(40), "Deck.key/Metadata/BuildVersionHistory.plist": "x" };
  for (const [name, make] of parsers) {
    const context = new ParseContext({ signal: controller.signal });
    await assert.rejects(runPackage(make(), archive(files), { context }), AbortError, name);
  }
});

test("the 2018 parser takes the type of the first identifying entry even when a preview comes first", async () => {
  const { metadata, recorder } = await runPackage(
    new IWork18Parser(),
    archive({ "Deck.numbers/preview.jpg": JPEG, "Deck.numbers/Metadata/BuildVersionHistory.plist": "x", "Other.pages/Metadata/BuildVersionHistory.plist": "x" }),
  );
  assert.equal(metadata.get("Content-Type"), "application/vnd.apple.numbers.18");
  assert.deepEqual(recorder.seen.map((item) => item.name), ["Deck.numbers/preview.jpg"]);
});

test("the 2018 type needs the dot before the extension and the exact history path", async () => {
  for (const name of ["Deckkey/Metadata/BuildVersionHistory.plist", "Deckpages/Metadata/BuildVersionHistory.plist", "Decknumbers/Metadata/BuildVersionHistory.plist", "Deck.key/Metadata/BuildVersionHistory.plist2"]) {
    const { metadata } = await runPackage(new IWork18Parser(), archive({ [name]: "x" }));
    assert.equal(metadata.get("Content-Type"), null, name);
  }
});

test("a history that is not an array, and properties that are not a dictionary, add nothing", async () => {
  // Tika tests `rootObj instanceof NSArray` and `instanceof NSDictionary` and does nothing for any other root
  const { metadata } = await runPackage(
    new IWork13Parser(),
    archive({
      "Metadata/BuildVersionHistory.plist": "<plist><dict><key>a</key><string>b</string></dict></plist>",
      "Metadata/Properties.plist": "<plist><array><string>x</string></array></plist>",
    }),
  );
  assert.deepEqual(metadata.names().filter((name) => name.startsWith("iwork:")), []);
});

test("a history whose root is a number or a boolean is ignored, not a failure of the package", async () => {
  // Tika does nothing for a root that is not an NSArray; a loop over the value would throw on a bigint or a boolean
  for (const root of ["<integer>5</integer>", "<true/>", "<real>1.5</real>"]) {
    const { metadata } = await runPackage(new IWork13Parser(), archive({ "Metadata/BuildVersionHistory.plist": `<plist>${root}</plist>` }));
    assert.deepEqual(metadata.getAll("iwork:build-version-history"), [], root);
  }
});
