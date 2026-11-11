import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  XHTMLContentHandler,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { parseComments } from "../src/ogg-comments.ts";
import { extractChannelInfo, extractComments, extractDuration, extractPictures } from "../src/ogg.ts";
import { commentBlock, concat, enc, u32be } from "./ogg-builder.ts";

/*
 * Ported from Tika 4.2.0's OggAudioParserTest and OggAudioParserDurationTest: how the comments of an Ogg file become
 * metadata, text and embedded pictures. Tika's tests feed VorbisComments built in code, these feed the same fields
 * through a comment header. Read from Tika's source; not run against a Tika.
 */

interface Run {
  readonly metadata: Metadata;
  readonly text: string;
  readonly pictures: Metadata[];
}

async function run(comments: readonly string[], options: { base?: readonly string[] } = {}): Promise<Run> {
  const base = options.base ?? ["title=Test Title", "artist=Test Artist", "album=Test Album"];
  const handler = createOutputHandler("body");
  const metadata = new Metadata();
  const ctx = new ParseContext();
  const embedded = new EmbeddedDocumentBytesHandler();
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, embedded);
  const xhtml = new XHTMLContentHandler(handler, metadata);
  await xhtml.startDocument();
  const parsed = parseComments(commentBlock("Test Vendor", [...base, ...comments]), 0);
  await extractPictures(await extractComments(metadata, xhtml, parsed), xhtml, metadata, ctx);
  await xhtml.endDocument();
  return { metadata, text: handler.toString(), pictures: embedded.resources.map((resource) => resource.metadata) };
}

test("the known comments become metadata, and the others are kept under vorbis:", async () => {
  const { metadata } = await run(["genre=Rock", "date=2004", "comment=First", "comment=Second", "encoder=x264", "Encoder=again"]);
  assert.equal(metadata.get("dc:title"), "Test Title");
  assert.equal(metadata.get("dc:creator"), "Test Artist");
  assert.equal(metadata.get("xmpDM:artist"), "Test Artist");
  assert.equal(metadata.get("xmpDM:album"), "Test Album");
  assert.equal(metadata.get("xmpDM:genre"), "Rock");
  assert.equal(metadata.get("xmpDM:releaseDate"), "2004", "a year alone is kept");
  assert.deepEqual(metadata.getAll("xmpDM:logComment"), ["First", "Second"]);
  assert.equal(metadata.get("xmp:CreatorTool"), "Test Vendor");
  assert.equal(metadata.get("vorbis:vendor"), "Test Vendor");
  assert.deepEqual(metadata.getAll("vorbis:encoder"), ["x264", "again"], "a field that repeats keeps every value");
  for (const done of ["title", "artist", "album", "genre", "date", "comment"]) {
    assert.equal(metadata.has(`vorbis:${done}`), false, done);
  }
});

test("field names are matched in lower case whatever the case in the file", async () => {
  const { metadata } = await run(["GENRE=Rock"], { base: ["TITLE=Upper Title", "ARTIST=Upper Artist"] });
  assert.equal(metadata.get("dc:title"), "Upper Title");
  assert.equal(metadata.get("xmpDM:artist"), "Upper Artist");
  assert.equal(metadata.get("xmpDM:genre"), "Rock");
});

test("the text is the title, artist, album, date, comments and genre, each in a paragraph", async () => {
  const { text } = await run(["date=2004-05", "comment=A comment", "genre=Rock", "tracknumber=3"]);
  assert.equal(text, "Test Title\nTest Artist\nTest Album, track 3\n2004-05\nA comment\nRock\n");
});

test("a track number with no album reads null, as Java concatenates a null", async () => {
  const { text } = await run(["tracknumber=7"], { base: ["title=T"] });
  assert.equal(text, "T\nnull, track 7\n");
});

test("a file with no title and no artist has no empty paragraphs", async () => {
  const { text } = await run([], { base: ["album=Only Album"] });
  assert.equal(text, "Only Album\n");
});

test("a copyright comment is xmpDM:copyright and stays under vorbis:", async () => {
  const { metadata } = await run(["copyright=Test Copyright"]);
  assert.equal(metadata.get("xmpDM:copyright"), "Test Copyright");
  assert.equal(metadata.get("vorbis:copyright"), "Test Copyright");
});

test("more copyright comments: the first is xmpDM:copyright and vorbis: keeps all of them", async () => {
  const { metadata } = await run(["copyright=Test Copyright", "copyright=Second Copyright"]);
  assert.equal(metadata.get("xmpDM:copyright"), "Test Copyright");
  assert.deepEqual(metadata.getAll("vorbis:copyright"), ["Test Copyright", "Second Copyright"]);
});

test("track and disc numbers and totals", async () => {
  const { metadata } = await run(["tracknumber=3/12", "discnumber=1", "disctotal=2"]);
  assert.equal(metadata.get("xmpDM:trackNumber"), "3");
  assert.equal(metadata.get("audio:track-count"), "12");
  assert.equal(metadata.get("audio:raw-track-number"), "3/12");
  assert.equal(metadata.get("xmpDM:discNumber"), "1");
  assert.equal(metadata.get("audio:disc-count"), "2");
});

test("parts that are not numbers stay out of the typed keys but survive raw", async () => {
  const { metadata } = await run(["tracknumber=3/of twelve", "discnumber=/2"]);
  assert.equal(metadata.get("xmpDM:trackNumber"), "3");
  assert.equal(metadata.get("audio:track-count"), null);
  assert.equal(metadata.get("audio:raw-track-number"), "3/of twelve");
  assert.equal(metadata.get("xmpDM:discNumber"), null);
  assert.equal(metadata.get("audio:disc-count"), "2");
  assert.equal(metadata.get("audio:raw-disc-number"), "/2");
});

test("an explicit total wins over the combined form, the first positive one of tracktotal and totaltracks", async () => {
  assert.equal((await run(["tracknumber=3/12", "totaltracks=14"])).metadata.get("audio:track-count"), "14");
  const both = await run(["tracknumber=3/12", "tracktotal=0", "tracktotal= 9 ", "totaltracks=14", "discnumber=1/2", "totaldiscs=4"]);
  assert.equal(both.metadata.get("audio:track-count"), "9");
  assert.equal(both.metadata.get("audio:disc-count"), "4");
});

test("numbers are Java ints: a sign is read, a value past 2147483647 is not a number", async () => {
  const { metadata } = await run(["tracknumber=+5/2147483648"]);
  assert.equal(metadata.get("xmpDM:trackNumber"), "5");
  assert.equal(metadata.get("audio:track-count"), null);
});

function pictureComment(type: number, description: string, mime = "image/jpeg", data = Uint8Array.of(1, 2, 3, 4)): string {
  const mimeBytes = enc(mime);
  const descriptionBytes = enc(description);
  const block = concat(u32be(type), u32be(mimeBytes.length), mimeBytes, u32be(descriptionBytes.length), descriptionBytes, new Uint8Array(16), u32be(data.length), data);
  return `metadata_block_picture=${Buffer.from(block).toString("base64")}`;
}

test("a metadata_block_picture comment is an embedded document, and its raw block is not in the metadata", async () => {
  const { metadata, pictures } = await run([pictureComment(4, "Back cover")]);
  assert.equal(pictures.length, 1);
  const picture = pictures[0]!;
  assert.equal(picture.get("Content-Type"), "image/jpeg");
  assert.equal(picture.get("tk:embedded-resource-type"), "THUMBNAIL", "the only picture is the thumbnail, front cover or not");
  assert.equal(picture.get("dc:title"), "Back cover");
  assert.equal(picture.get("dc:description"), "Cover (back)");
  assert.equal(picture.get("Content-Length"), "4");
  assert.equal(metadata.has("vorbis:metadata_block_picture"), false);
});

test("the front cover is the thumbnail even when another picture comes first, and the others are inline", async () => {
  const { pictures } = await run([pictureComment(4, "Back cover"), pictureComment(3, "Front cover"), pictureComment(8, "Artist")]);
  assert.deepEqual(
    pictures.map((p) => [p.get("dc:title"), p.get("tk:embedded-resource-type")]),
    [["Back cover", "INLINE"], ["Front cover", "THUMBNAIL"], ["Artist", "INLINE"]],
  );
});

test("with no front cover the first picture of type Other or unknown is the thumbnail, else the first", async () => {
  const other = await run([pictureComment(4, "Back"), pictureComment(0, "Other"), pictureComment(5, "Leaflet")]);
  assert.deepEqual(other.pictures.map((p) => p.get("tk:embedded-resource-type")), ["INLINE", "THUMBNAIL", "INLINE"]);
  // A type past the ID3 table (21 entries) counts as unknown, and has no description.
  const unknown = await run([pictureComment(4, "Back"), pictureComment(99, "Odd")]);
  assert.deepEqual(unknown.pictures.map((p) => p.get("tk:embedded-resource-type")), ["INLINE", "THUMBNAIL"]);
  assert.equal(unknown.pictures[1]!.get("dc:description"), null);
  const first = await run([pictureComment(4, "Back"), pictureComment(5, "Leaflet")]);
  assert.deepEqual(first.pictures.map((p) => p.get("tk:embedded-resource-type")), ["THUMBNAIL", "INLINE"]);
});

test("a picture with no mime type or description has neither key, and a malformed one is skipped silently", async () => {
  const { pictures } = await run([
    pictureComment(3, "", ""),
    "metadata_block_picture=not base64 at all!",
    "metadata_block_picture=QUJD",
    pictureComment(3, "Second"),
  ]);
  assert.equal(pictures.length, 2);
  assert.equal(pictures[0]!.has("Content-Type"), false);
  assert.equal(pictures[0]!.has("dc:title"), false);
  assert.equal(pictures[1]!.get("dc:title"), "Second");
});

/** An extractor that fails every picture with `error`, counting the pictures it was offered. */
async function runWithFailingExtractor(error: Error): Promise<{ metadata: Metadata; offered: number }> {
  const metadata = new Metadata();
  const ctx = new ParseContext();
  let offered = 0;
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: () => true,
    parseEmbedded: async () => {
      offered++;
      throw error;
    },
  });
  const xhtml = new XHTMLContentHandler(createOutputHandler("body"), metadata);
  const parsed = parseComments(commentBlock("V", [pictureComment(3, "A"), pictureComment(4, "B")]), 0);
  await extractPictures(await extractComments(metadata, xhtml, parsed), xhtml, metadata, ctx);
  return { metadata, offered };
}

test("a picture that cannot be read is recorded on the file, and the next one is still offered", async () => {
  const { metadata, offered } = await runWithFailingExtractor(new MalformedDocumentError("not an image"));
  assert.equal(offered, 2);
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), [
    "MalformedDocumentError: not an image",
    "MalformedDocumentError: not an image",
  ]);
});

test("a limit ends the parse instead of being recorded", async () => {
  await assert.rejects(runWithFailingExtractor(new LimitExceededError("too many embedded documents")), LimitExceededError);
});

test("the channel count names the layout only for 1, 2, 5 and 7, as Tika does", () => {
  const layout = (channels: number): string | null => {
    const metadata = new Metadata();
    extractChannelInfo(metadata, channels);
    return metadata.get("xmpDM:audioChannelType");
  };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 0].map(layout), ["Mono", "Stereo", null, null, "5.1", null, "7.1", null]);
});

async function duration(seconds: number): Promise<{ metadata: Metadata; text: string }> {
  const handler = createOutputHandler("body");
  const metadata = new Metadata();
  const xhtml = new XHTMLContentHandler(handler, metadata);
  await xhtml.startDocument();
  await extractDuration(metadata, xhtml, seconds);
  await xhtml.endDocument();
  return { metadata, text: handler.toString() };
}

test("the duration is xmpDM:duration in the DecimalFormat pattern 0.0#, and a paragraph of minutes and seconds", async () => {
  // The durations of OggAudioParserDurationTest, with what Java's HALF_EVEN pattern gives for each double.
  const expected: [number, string][] = [
    [0.1, "0.1"],
    [1.005, "1.0"],
    [12.34, "12.34"],
    [59.995, "59.99"],
    [123.456, "123.46"],
    [3599.999, "3600.0"],
    [7200.05, "7200.05"],
    [86399.9, "86399.9"],
  ];
  for (const [seconds, text] of expected) assert.equal((await duration(seconds)).metadata.get("xmpDM:duration"), text, String(seconds));
  assert.equal((await duration(123.456)).text, "2:03\n");
  assert.equal((await duration(3600)).text, "1:00:00\n");
  assert.equal((await duration(86399.9)).text, "23:59:59\n");
  assert.equal((await duration(59.99)).text, "0:59\n");
});

test("no duration is recorded for zero, a negative or a number that is not one", async () => {
  for (const seconds of [0, -1, Number.NaN, -0.5]) {
    const { metadata, text } = await duration(seconds);
    assert.equal(metadata.has("xmpDM:duration"), false, String(seconds));
    assert.equal(text, "");
  }
});
