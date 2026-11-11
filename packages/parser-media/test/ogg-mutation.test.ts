import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParseTimeoutError,
  RipstreamInputStream,
  WriteLimitReachedError,
  XHTMLContentHandler,
  createOutputHandler,
  type EmbeddedDocumentExtractor,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { AudioParser } from "../src/audio.ts";
import { decodeMimeBase64, parseComments, parsePictureBlock } from "../src/ogg-comments.ts";
import { readOgg, type OggPacket } from "../src/ogg-demux.ts";
import { FlacParser, OggParser, OpusParser, SpeexParser, VorbisParser, extractComments, extractDuration, extractPictures } from "../src/ogg.ts";
import {
  chunked,
  commentBlock,
  concat,
  enc,
  flacTagsPacket,
  oggFlacFirst,
  oggPage,
  opusFile,
  speexHeader,
  theoraIdent,
  u32be,
  u32le,
  vorbisFile,
  vorbisIdent,
} from "./ogg-builder.ts";

/*
 * Mutation-testing additions (bead tikajs-68os.15): each test pins a bound, a key or a branch of the Ogg and AU code that
 * the other test files left open. Every file is built here; none of them reads a fixture.
 */

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

// ---- the demux ------------------------------------------------------------------------------------------------------

async function demux(file: Uint8Array, options: { keepPackets?: number; maxHeldBytes?: number; maxStreams?: number } = {}): Promise<OggPacket[]> {
  const packets: OggPacket[] = [];
  await readOgg(chunked(file, 64 * 1024), { keepPackets: options.keepPackets ?? 3, onPacket: (packet) => packets.push(packet), ...options });
  return packets;
}

/** One packet of `total` zero bytes on pages of 255 full segments, closed by a last page. `first` flags the first page. */
function longPacketPages(sid: number, total: number, first: { bos?: boolean } = {}): Uint8Array {
  const full = 255 * 255;
  const openPages = Math.floor(total / full);
  const rest = total - openPages * full;
  const openPage = oggPage({ sid, continued: true, packets: [new Uint8Array(full)], open: true });
  const pages: Uint8Array[] = [];
  for (let index = 0; index < openPages; index++) {
    pages.push(index === 0 ? oggPage({ sid, ...first, packets: [new Uint8Array(full)], open: true }) : openPage);
  }
  pages.push(oggPage({ sid, ...(openPages === 0 ? first : {}), continued: openPages > 0, packets: [new Uint8Array(rest)], granule: 1n }));
  return concat(...pages);
}

test("pages of a stream whose beginning was not seen are passed over", async () => {
  const file = concat(
    oggPage({ sid: 7, packets: [bytes(1)], granule: 5n }),
    oggPage({ sid: 8, bos: true, packets: [bytes(2)], granule: 0n }),
    oggPage({ sid: 7, packets: [bytes(3)], granule: 6n }),
  );
  assert.deepEqual((await demux(file)).map((packet) => [packet.sid, packet.data[0]]), [[8, 2]]);
});

test("a capture pattern that follows a stray O is still found", async () => {
  const file = concat(oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }), enc("O"), oggPage({ sid: 1, packets: [bytes(2)], granule: 1n }));
  assert.deepEqual((await demux(file)).map((packet) => packet.data[0]), [1, 2]);
});

test("a packet of exactly 255 bytes that goes on in the next page keeps those bytes", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [new Uint8Array(255).fill(9)], open: true }),
    oggPage({ sid: 1, continued: true, packets: [bytes(8, 8, 8)], granule: 1n }),
  );
  const [packet] = await demux(file);
  assert.equal(packet!.data.length, 258);
  assert.deepEqual([...packet!.data.subarray(254)], [9, 8, 8, 8]);
});

test("exactly as many streams as the cap are open without error, a second beginning of one serial number is not a second stream", async () => {
  const begun = (sid: number): Uint8Array => oggPage({ sid, bos: true, packets: [bytes(1)], granule: 0n });
  assert.equal((await demux(concat(...[1, 2, 3, 4, 5].map(begun)), { maxStreams: 5 })).length, 5);
  assert.equal((await demux(concat(begun(1), begun(1), begun(1)), { maxStreams: 1 })).length, 3);
});

test("the default cap is 1000 open streams", async () => {
  const begun = (sid: number): Uint8Array => oggPage({ sid, bos: true, packets: [], granule: 0n });
  await demux(concat(...Array.from({ length: 1000 }, (_, sid) => begun(sid))));
  await assert.rejects(demux(concat(...Array.from({ length: 1001 }, (_, sid) => begun(sid)))), LimitExceededError);
});

test("the held bytes cap is reached by a packet of exactly that size, and bytes are released when a packet ends, a stream ends or a stream begins again", async () => {
  // 765 bytes open on one page and 235 closing the packet: 1000 in all.
  const packetOf = (size: number, sid = 1): Uint8Array =>
    concat(
      oggPage({ sid, bos: true, packets: [new Uint8Array(765)], open: true }),
      oggPage({ sid, continued: true, packets: [new Uint8Array(size - 765)], granule: 1n }),
    );
  assert.equal((await demux(packetOf(1000), { maxHeldBytes: 1000 }))[0]!.data.length, 1000);
  await assert.rejects(demux(packetOf(1001), { maxHeldBytes: 1000 }), LimitExceededError);

  // A packet that ends gives its bytes back: two of 1000 in a row, then the cap is not reached.
  const second = oggPage({ sid: 1, packets: [new Uint8Array(765)], open: true });
  const secondEnd = oggPage({ sid: 1, continued: true, packets: [new Uint8Array(235)], granule: 2n });
  assert.equal((await demux(concat(packetOf(1000), second, secondEnd), { maxHeldBytes: 1000 })).length, 2);

  // A stream that ends in the middle of a packet gives them back.
  const endsOpen = (sid: number): Uint8Array => oggPage({ sid, bos: true, eos: true, packets: [new Uint8Array(765)], open: true });
  assert.deepEqual(await demux(concat(endsOpen(1), endsOpen(2)), { maxHeldBytes: 1000 }), []);

  // So does a stream that begins again under the same serial number.
  const beginsOpen = oggPage({ sid: 1, bos: true, packets: [new Uint8Array(765)], open: true });
  assert.deepEqual(await demux(concat(beginsOpen, beginsOpen), { maxHeldBytes: 1000 }), []);
});

test("packets past the number asked for are not held, whatever their size", async () => {
  const file = concat(oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }), longPacketPages(1, 5000));
  const packets = await demux(file, { keepPackets: 1, maxHeldBytes: 1000 });
  assert.deepEqual(packets.map((packet) => packet.data.length), [1]);
});

test("the default cap on held bytes is 32 MiB: a packet of that size is read, one byte more is refused", async () => {
  const cap = 32 * 1024 * 1024;
  const read = (total: number): Promise<OggPacket[]> => demux(concat(oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }), longPacketPages(1, total)), { keepPackets: 2 });
  assert.deepEqual((await read(cap)).map((packet) => packet.data.length), [1, cap]);
  await assert.rejects(read(cap + 1), LimitExceededError);
});

test("a packet of 254 bytes ends a packet, only 255 goes on in the next segment", async () => {
  const file = oggPage({ sid: 1, bos: true, packets: [new Uint8Array(254).fill(1), bytes(2, 2)], granule: 3n });
  assert.deepEqual((await demux(file)).map((packet) => packet.data.length), [254, 2]);
});

test("a page that ends in the middle of a packet reports no granule position, whatever it holds", async () => {
  const granules: bigint[] = [];
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }),
    oggPage({ sid: 1, packets: [new Uint8Array(255)], open: true, granule: 9n }),
  );
  await readOgg(chunked(file, 1024), { keepPackets: 3, onPacket: () => undefined, onGranule: (_sid, granule) => granules.push(granule) });
  assert.deepEqual(granules, [0n]);
});

// ---- the comments ---------------------------------------------------------------------------------------------------

test("a byte order mark at the start of the vendor or of a comment is kept, as Java's decoder keeps it", () => {
  const bom = bytes(0xef, 0xbb, 0xbf);
  const block = concat(u32le(4), bom, enc("V"), u32le(1), u32le(6), bom, enc("a=b"));
  const comments = parseComments(block, 0);
  assert.equal(comments.vendor, "\uFEFFV");
  assert.deepEqual([...comments.fields], [["\uFEFFa", ["b"]]]);
});

test("a comment block with no comments, or only an empty one, is read to its last byte", () => {
  assert.equal(parseComments(commentBlock("v", []), 0).fields.size, 0);
  assert.deepEqual([...parseComments(commentBlock("v", [""]), 0).fields], []);
  assert.deepEqual([...parseComments(commentBlock("", ["a=b"]), 0).fields], [["a", ["b"]]]);
});

test("a count that the rest of the header cannot hold is malformed even when it is also past the limit", () => {
  // 10001 comments would take 40004 bytes; 35000 are there.
  const block = concat(u32le(0), u32le(10_001), new Uint8Array(35_000));
  assert.throws(() => parseComments(block, 0), MalformedDocumentError);
});

test("a comment that starts with an equals sign has an empty name", () => {
  assert.deepEqual([...parseComments(commentBlock("v", ["=value"]), 0).fields], [["", ["value"]]]);
});

function pictureBlockOf(mime: Uint8Array, description: Uint8Array): Uint8Array {
  return concat(u32be(3), u32be(mime.length), mime, u32be(description.length), description, new Uint8Array(16), u32be(2), bytes(7, 7));
}

test("the mime type of a picture block is ISO-8859-1, the description UTF-8", () => {
  const picture = parsePictureBlock(pictureBlockOf(bytes(0xe9, 0x80, 0x41), enc("é")))!;
  assert.equal(picture.mimeType, "é\u0080A");
  assert.equal(picture.description, "é");
});

test("a picture block with an empty mime type or description is a picture", () => {
  const picture = parsePictureBlock(pictureBlockOf(new Uint8Array(0), new Uint8Array(0)))!;
  assert.deepEqual([picture.mimeType, picture.description, [...picture.data]], ["", "", [7, 7]]);
});

test("a picture block with data of exactly the bytes left is a picture, one byte short of it is not", () => {
  const whole = pictureBlockOf(enc("image/png"), enc("d"));
  assert.notEqual(parsePictureBlock(whole), null);
  assert.equal(parsePictureBlock(whole.subarray(0, whole.length - 1)), null, "one data byte short");
  assert.equal(parsePictureBlock(whole.subarray(0, whole.length - 2)), null, "no data at all");
  assert.equal(parsePictureBlock(whole.subarray(0, whole.length - 6)), null, "no data length");
});

test("MIME Base64 gives what a standard encoder gives, for every length and every sextet", () => {
  for (let length = 0; length < 12; length++) {
    const data = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
    assert.deepEqual([...decodeMimeBase64(Buffer.from(data).toString("base64"))!], [...data], `length ${length}`);
  }
  // Every one of the 64 characters of the alphabet, in every position of a unit.
  const all = Uint8Array.from({ length: 192 }, (_, index) => index);
  assert.deepEqual([...decodeMimeBase64(Buffer.from(all).toString("base64"))!], [...all]);
  assert.deepEqual([...decodeMimeBase64("+/+/")!], [0xfb, 0xff, 0xbf]);
  assert.deepEqual([...decodeMimeBase64("QUJD".repeat(3))!], [...enc("ABC".repeat(3))]);
});

test("MIME Base64 skips U+0080 and refuses what the JDK refuses at the end", () => {
  assert.deepEqual([...decodeMimeBase64("QU\u0080JD")!], [...enc("ABC")]);
  assert.equal(decodeMimeBase64("QQ==A"), null, "the letter A is sextet 0 and still data after the padding");
  assert.equal(decodeMimeBase64("QQ=x"), null, "after one = the next character must be the second");
  assert.equal(decodeMimeBase64("QQ=\n="), null, "a skipped character is not allowed between the two");
  assert.equal(decodeMimeBase64("Q="), null, "a dangling sextet before the padding");
  assert.deepEqual([...decodeMimeBase64("QQ==\u0080é")!], [0x41]);
});

// ---- the comments as metadata ---------------------------------------------------------------------------------------

async function runComments(comments: readonly string[], base: readonly string[] = ["title=T"]): Promise<{ metadata: Metadata; text: string }> {
  const handler = createOutputHandler("body");
  const metadata = new Metadata();
  const xhtml = new XHTMLContentHandler(handler, metadata);
  await xhtml.startDocument();
  await extractComments(metadata, xhtml, parseComments(commentBlock("Vendor", [...base, ...comments]), 0));
  await xhtml.endDocument();
  return { metadata, text: handler.toString() };
}

test("a comment named vendor or tracknumber is not repeated under vorbis:, and others that Tika leaves there are", async () => {
  const { metadata } = await runComments(["vendor=other", "tracknumber=4", "discnumber=1/2", "tracktotal=9", "copyright=C", "metadata_block_picture=x"]);
  assert.deepEqual(metadata.getAll("vorbis:vendor"), ["Vendor"]);
  assert.equal(metadata.has("vorbis:tracknumber"), false);
  assert.equal(metadata.has("vorbis:metadata_block_picture"), false);
  assert.equal(metadata.get("vorbis:discnumber"), "1/2");
  assert.equal(metadata.get("vorbis:tracktotal"), "9");
  assert.equal(metadata.get("vorbis:copyright"), "C");
});

test("a track or disc number that is not a number sets no typed key", async () => {
  const { metadata } = await runComments(["tracknumber=abc", "discnumber=xyz"]);
  assert.equal(metadata.has("xmpDM:trackNumber"), false);
  assert.equal(metadata.has("audio:track-count"), false);
  assert.equal(metadata.has("xmpDM:discNumber"), false);
  assert.equal(metadata.has("audio:disc-count"), false);
  assert.equal(metadata.get("audio:raw-track-number"), "abc");
  assert.equal(metadata.get("audio:raw-disc-number"), "xyz");
});

test("with more disc numbers the last one is the raw value, and each sets its own parts", async () => {
  const { metadata } = await runComments(["discnumber=1/2", "discnumber=3"]);
  assert.deepEqual(metadata.getAll("audio:raw-disc-number"), ["3"]);
  assert.equal(metadata.get("xmpDM:discNumber"), "3");
  assert.equal(metadata.get("audio:disc-count"), "2");
});

test("the totals under their own names: tracktotal over totaltracks, disctotal over totaldiscs, each alone too", async () => {
  assert.equal((await runComments(["disctotal=5", "totaldiscs=6"])).metadata.get("audio:disc-count"), "5");
  assert.equal((await runComments(["totaldiscs=6"])).metadata.get("audio:disc-count"), "6");
  assert.equal((await runComments(["totaltracks=8"])).metadata.get("audio:track-count"), "8");
  assert.equal((await runComments(["tracktotal=7", "totaltracks=8"])).metadata.get("audio:track-count"), "7");
});

test("a number is trimmed as Java's String.trim does, and may be as large as an int", async () => {
  assert.equal((await runComments(["tracktotal=\t7\n"])).metadata.get("audio:track-count"), "7");
  assert.equal((await runComments(["tracktotal=\u0001 8"])).metadata.get("audio:track-count"), "8");
  assert.equal((await runComments(["tracktotal=2147483647"])).metadata.get("audio:track-count"), "2147483647");
  assert.equal((await runComments(["tracktotal=0", "totaltracks=-3"])).metadata.has("audio:track-count"), false);
});

// ---- the pictures ---------------------------------------------------------------------------------------------------

function pictureComment(type: number, description: string, data = bytes(1, 2, 3)): string {
  const mime = enc("image/png");
  const text = enc(description);
  const block = concat(u32be(type), u32be(mime.length), mime, u32be(text.length), text, new Uint8Array(16), u32be(data.length), data);
  return `metadata_block_picture=${Buffer.from(block).toString("base64")}`;
}

async function embeddedFrom(comments: readonly string[]): Promise<Metadata[]> {
  const metadata = new Metadata();
  const ctx = new ParseContext();
  const embedded = new EmbeddedDocumentBytesHandler();
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, embedded);
  const xhtml = new XHTMLContentHandler(createOutputHandler("body"), metadata);
  const parsed = parseComments(commentBlock("V", comments), 0);
  await extractPictures(await extractComments(metadata, xhtml, parsed), xhtml, metadata, ctx);
  return embedded.resources.map((resource) => resource.metadata);
}

test("every picture type has the description of Tika's ID3 table, and types past it have none", async () => {
  const table = [
    "Other",
    "32x32 pixels 'file icon' (PNG only)",
    "Other file icon",
    "Cover (front)",
    "Cover (back)",
    "Leaflet page",
    "Media (e.g. label side of CD)",
    "Lead artist/lead performer/soloist",
    "Artist/performer",
    "Conductor",
    "Band/Orchestra",
    "Composer",
    "Lyricist/text writer",
    "Recording Location",
    "During recording",
    "During performance",
    "Movie/video screen capture",
    "A bright coloured fish",
    "Illustration",
    "Band/artist logotype",
    "Publisher/Studio logotype",
  ];
  const types = [...table.keys(), 21, 0xffffffff];
  const embedded = await embeddedFrom(types.map((type) => pictureComment(type, `t${type}`)));
  assert.deepEqual(
    embedded.map((picture) => picture.get("dc:description")),
    [...table, null, null],
  );
});

test("the thumbnail: a type past the table counts as unknown, so does a negative one, and the first front cover wins", async () => {
  const thumbnails = async (types: readonly number[]): Promise<number[]> =>
    (await embeddedFrom(types.map((type, index) => pictureComment(type, `p${index}`))))
      .map((picture, index) => (picture.get("tk:embedded-resource-type") === "THUMBNAIL" ? index : -1))
      .filter((index) => index >= 0);
  assert.deepEqual(await thumbnails([4, 21]), [1]);
  assert.deepEqual(await thumbnails([4, 20]), [0], "type 20 is in the table and is not unknown");
  assert.deepEqual(await thumbnails([4, 0xffffffff]), [1]);
  assert.deepEqual(await thumbnails([3, 3, 0]), [0]);
});

async function extractWith(extractor: EmbeddedDocumentExtractor, ctx = new ParseContext()): Promise<Metadata> {
  const metadata = new Metadata();
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const xhtml = new XHTMLContentHandler(createOutputHandler("body"), metadata);
  const parsed = parseComments(commentBlock("V", [pictureComment(3, "A"), pictureComment(4, "B")]), 0);
  await extractPictures(await extractComments(metadata, xhtml, parsed), xhtml, metadata, ctx);
  return metadata;
}

test("a picture that the extractor does not want is not offered to it", async () => {
  let parsed = 0;
  await extractWith({ shouldParseEmbedded: () => false, parseEmbedded: async () => void parsed++ });
  assert.equal(parsed, 0);
});

test("with no extractor in the context the default one is used, and it needs a parser", async () => {
  const metadata = new Metadata();
  const ctx = new ParseContext();
  const xhtml = new XHTMLContentHandler(createOutputHandler("body"), metadata);
  const pictures = await extractComments(metadata, xhtml, parseComments(commentBlock("V", [pictureComment(3, "A")]), 0));
  await assert.rejects(extractPictures(pictures, xhtml, metadata, ctx), LimitExceededError);
});

test("a timeout, an abort or a write limit ends the parse like a limit does", async () => {
  for (const error of [new ParseTimeoutError("late"), new AbortError("stop"), new WriteLimitReachedError(10)]) {
    await assert.rejects(extractWith({ shouldParseEmbedded: () => true, parseEmbedded: async () => Promise.reject(error) }), (thrown) => thrown === error);
  }
});

test("an error that is not fatal ends the parse when the signal has been aborted meanwhile", async () => {
  const controller = new AbortController();
  let offered = 0;
  const failure = new MalformedDocumentError("late news");
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    parseEmbedded: async () => {
      offered++;
      controller.abort();
      throw failure;
    },
  };
  await assert.rejects(extractWith(extractor, new ParseContext({ signal: controller.signal })), (thrown) => thrown === failure);
  assert.equal(offered, 1);
});

test("an error that is not an Error is recorded as its text", async () => {
  const metadata = await extractWith({ shouldParseEmbedded: () => true, parseEmbedded: async () => Promise.reject("plain text") });
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), ["plain text", "plain text"]);
});

test("the duration paragraph counts whole minutes of 60 seconds", async () => {
  const text = async (seconds: number): Promise<string> => {
    const handler = createOutputHandler("body");
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    await extractDuration(new Metadata(), xhtml, seconds);
    await xhtml.endDocument();
    return handler.toString();
  };
  assert.equal(await text(180), "3:00\n");
  assert.equal(await text(3540), "59:00\n");
  assert.equal(await text(7380), "2:03:00\n");
});

// ---- the stream types -----------------------------------------------------------------------------------------------

async function parseWith(parser: Parser, file: Uint8Array): Promise<Metadata> {
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(file);
  try {
    await parser.parse(stream, createOutputHandler("body"), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

test("each stream signature is told from its first bytes at its shortest length, and not one byte under it", async () => {
  // [first bytes, shortest packet, the stream type's name, its kind]
  const table: [string, number, string, string][] = [
    ["\x01vorbis", 30, "vorbis", "audio"],
    ["OpusHead", 19, "opus", "audio"],
    ["Speex   ", 80, "speex", "audio"],
    ["\x7fFLAC", 51, "oggflac", "audio"],
    ["PCM     ", 28, "oggpcm", "audio"],
    ["\x80theora", 30, "theora", "video"],
    ["\x80daala", 30, "daala", "video"],
    ["UVS ", 28, "ogguvs", "video"],
    ["\x01YUV", 28, "oggyuv", "video"],
    ["BBCD", 28, "dirac", "video"],
    ["\x80kate\0\0\0\0", 30, "kate", "metadata"],
    ["CMML\0\0\0\0", 30, "cmml", "metadata"],
    ["fishead\0", 30, "ogg", "metadata"],
  ];
  const packetOf = (prefix: string, length: number): Uint8Array => {
    const out = new Uint8Array(length);
    out.set(Uint8Array.from(prefix, (char) => char.charCodeAt(0)));
    return out;
  };
  for (const [prefix, length, key, kind] of table) {
    const known = await parseWith(new OggParser(), oggPage({ sid: 1, bos: true, packets: [packetOf(prefix, length)], granule: 0n }));
    assert.deepEqual(known.getAll(`ogg:streams-${key}`), ["1"], `${key} at ${length}`);
    assert.deepEqual(known.getAll(`ogg:streams-${kind}`), ["1"], `${key} kind`);
    assert.equal(known.has("ogg:streams-unknown"), false, key);

    const short = await parseWith(new OggParser(), oggPage({ sid: 1, bos: true, packets: [packetOf(prefix, length - 1)], granule: 0n }));
    assert.deepEqual(short.getAll("ogg:streams-unknown"), ["1", "1"], `${key} at ${length - 1}`);
    assert.equal(short.has(`ogg:streams-${key}`), false, `${key} short`);

    // Every byte of the signature counts, the first as much as the last.
    for (const at of [0, prefix.length - 1]) {
      const wrong = packetOf(prefix, length);
      wrong[at] = (wrong[at]! ^ 0x20) & 0xff;
      assert.deepEqual((await parseWith(new OggParser(), oggPage({ sid: 1, bos: true, packets: [wrong], granule: 0n }))).getAll("ogg:streams-unknown"), ["1", "1"], `${key} byte ${at}`);
    }
  }
});

test("a packet that only looks like a codec's first packet, later in a stream, does not make the stream that codec's", async () => {
  const file = concat(
    oggPage({ sid: 5, bos: true, packets: [bytes(1, 2, 3)], granule: 0n }),
    oggPage({ sid: 5, packets: [vorbisIdent(), commentBlock("v", ["title=T"], bytes(3, ...enc("vorbis")))], granule: 0n }),
  );
  await assert.rejects(parseWith(new VorbisParser(), file), MalformedDocumentError);
});

test("a stream of the same serial number that follows the end of the codec's own stream is not read as part of it", async () => {
  // The first stream ends after its identification packet. A chained one with the same number has all of its packets.
  const file = concat(oggPage({ sid: 1, bos: true, eos: true, packets: [vorbisIdent()], granule: 0n }), vorbisFile({ sid: 1, comments: ["title=Second"] }));
  await assert.rejects(parseWith(new VorbisParser(), file), MalformedDocumentError);
  // Nothing is lost when the first stream is whole.
  const whole = concat(vorbisFile({ sid: 1, comments: ["title=First"] }), vorbisFile({ sid: 1, comments: ["title=Second"], lastGranule: 88200n }));
  const parsed = await parseWith(new VorbisParser(), whole);
  assert.equal(parsed.get("dc:title"), "First");
  assert.equal(parsed.get("xmpDM:duration"), "1.0", "the granule position of the first stream, not of the chained one");
});

test("the general parser reads only the first packet of each stream, whatever the size of the others", async () => {
  const file = concat(oggPage({ sid: 1, bos: true, packets: [vorbisIdent()], granule: 0n }), longPacketPages(1, 32 * 1024 * 1024 + 1));
  assert.deepEqual((await parseWith(new OggParser(), file)).getAll("ogg:streams-vorbis"), ["1"]);
});

test("the duration is from the codec's own stream when another stream's last page comes after it", async () => {
  const file = concat(
    oggPage({ sid: 10, bos: true, packets: [theoraIdent()], granule: 0n }),
    oggPage({ sid: 20, bos: true, packets: [vorbisIdent({ rate: 22050 })], granule: 0n }),
    oggPage({ sid: 20, packets: [concat(commentBlock("v", [], bytes(3, ...enc("vorbis"))), bytes(1))], granule: 0n }),
    oggPage({ sid: 20, eos: true, packets: [new Uint8Array(10)], granule: 44100n }),
    oggPage({ sid: 10, eos: true, packets: [new Uint8Array(10)], granule: 99999n }),
  );
  assert.equal((await parseWith(new VorbisParser(), file)).get("xmpDM:duration"), "2.0");
});

// ---- the codec headers ----------------------------------------------------------------------------------------------

test("vorbis: the version is read from byte 7", async () => {
  const ident = vorbisIdent();
  ident[7] = 2;
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [ident], granule: 0n }),
    oggPage({ sid: 1, packets: [concat(commentBlock("v", [], bytes(3, ...enc("vorbis"))), bytes(1))], granule: 0n }),
  );
  assert.equal((await parseWith(new VorbisParser(), file)).get("ogg:codec-version"), "Vorbis 2");
});

test("vorbis bitrate: every one of the three rates counts, and the fixed rate needs all three to agree", async () => {
  const bitrate = async (upper: number, nominal: number, lower: number): Promise<[string | null, string | null]> => {
    const metadata = await parseWith(new VorbisParser(), vorbisFile({ ident: { upper, nominal, lower } }));
    return [metadata.get("audio:bitrate"), metadata.get("audio:is-variable-bitrate")];
  };
  assert.deepEqual(await bitrate(0, 0, 96000), [null, "true"], "a lower bound alone");
  assert.deepEqual(await bitrate(256000, 0, 0), [null, "true"], "an upper bound alone");
  assert.deepEqual(await bitrate(192000, 192000, 96000), ["192000", "true"], "the lower bound differs");
  assert.deepEqual(await bitrate(256000, 192000, 192000), ["192000", "true"], "the upper bound differs");
  assert.deepEqual(await bitrate(128000, 192000, 128000), ["192000", "true"], "a zero-width bracket does not make a nominal rate fixed");
  assert.deepEqual(await bitrate(0, -1, 0), [null, null], "a negative rate declares nothing");
});

test("opus: the version is the two nibbles of byte 8, the channels are byte 9", async () => {
  const metadata = await parseWith(new OpusParser(), opusFile({ head: { version: 0x2f, channels: 1 } }));
  assert.equal(metadata.get("ogg:codec-version"), "Opus 2.15");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Mono");
});

test("speex: the version string is read in all of its 20 bytes and the version number is at byte 28", async () => {
  const header = speexHeader({ versionString: "1.2.3-0123456789abc", versionId: 7 });
  const file = concat(
    oggPage({ sid: 3, bos: true, packets: [header], granule: 0n }),
    oggPage({ sid: 3, packets: [commentBlock("v", [])], granule: 0n }),
  );
  assert.equal((await parseWith(new SpeexParser(), file)).get("ogg:codec-version"), "Speex 7 - 1.2.3-0123456789abc");
});

test("ogg flac: the version, a rate of 0, and how far the comment block may be", async () => {
  const filler = Uint8Array.of(1, 0, 0, 2, 0, 0); // a padding block
  const withFillers = (count: number): Uint8Array =>
    concat(
      oggPage({ sid: 5, bos: true, packets: [oggFlacFirst({ rate: 48000, samples: 48000, major: 1, minor: 3 })], granule: 0n }),
      oggPage({ sid: 5, packets: [...Array.from({ length: count }, () => filler), flacTagsPacket("v", ["title=T"])], granule: 0n }),
    );
  const metadata = await parseWith(new FlacParser(), withFillers(1));
  assert.equal(metadata.get("ogg:codec-version"), "Flac 1.3");
  assert.equal(metadata.get("xmpDM:duration"), "1.0");
  // Sixteen packets are read: the comment block as the sixteenth is found, as the seventeenth it is not.
  assert.equal((await parseWith(new FlacParser(), withFillers(14))).get("dc:title"), "T");
  await assert.rejects(parseWith(new FlacParser(), withFillers(15)), MalformedDocumentError);

  const zeroRate = concat(
    oggPage({ sid: 5, bos: true, packets: [oggFlacFirst({ rate: 0, samples: 1000 })], granule: 0n }),
    oggPage({ sid: 5, packets: [flacTagsPacket("v", [])], granule: 0n }),
  );
  assert.equal((await parseWith(new FlacParser(), zeroRate)).has("xmpDM:duration"), false);
});

// ---- AU -------------------------------------------------------------------------------------------------------------

function auHeader(encoding: number, rate: number, channels: number, headerSize = 24): Uint8Array {
  return concat(bytes(0x2e, 0x73, 0x6e, 0x64), u32be(headerSize), u32be(0xffffffff), u32be(encoding), u32be(rate), u32be(channels));
}

async function parseAu(head: Uint8Array, contentType = "audio/basic", format: "body" | "xml" = "body"): Promise<{ metadata: Metadata; text: string }> {
  const metadata = new Metadata();
  metadata.set("Content-Type", contentType);
  const handler = createOutputHandler(format);
  const stream = await RipstreamInputStream.from(head);
  try {
    await new AudioParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { metadata, text: handler.toString() };
}

test("au: a rate or a channel count of -1 is not specified and is left out, 0 is written", async () => {
  const unspecified = (await parseAu(auHeader(3, 0xffffffff, 0xffffffff))).metadata;
  assert.equal(unspecified.has("audio:channels"), false);
  assert.equal(unspecified.has("xmpDM:audioSampleRate"), false);
  assert.equal(unspecified.get("audio:encoding"), "PCM_SIGNED");
  const zero = (await parseAu(auHeader(3, 0, 0))).metadata;
  assert.equal(zero.get("audio:channels"), "0");
  assert.equal(zero.get("xmpDM:audioSampleRate"), "0");
});

test("au: the rate and the channel count are signed ints, and the rate is a float to javax.sound", async () => {
  const { metadata } = await parseAu(auHeader(3, 0x80000000, 0x80000001));
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "-2147483648");
  assert.equal(metadata.get("audio:channels"), "-2147483647");
  // A float has 24 bits of mantissa: 16777217 is 16777216 once it is a float, as Tika's (int) cast of it gives.
  assert.equal((await parseAu(auHeader(3, 16777217, 1))).metadata.get("xmpDM:audioSampleRate"), "16777216");
  // And the cast saturates: 2147483647 as a float is 2^31.
  assert.equal((await parseAu(auHeader(3, 2147483647, 1))).metadata.get("xmpDM:audioSampleRate"), "2147483647");
});

test("au: a header size of 23 is too short, one of 24 or more is read", async () => {
  assert.equal((await parseAu(auHeader(3, 8000, 1, 23))).metadata.has("audio:encoding"), false);
  assert.equal((await parseAu(auHeader(3, 8000, 1, 24))).metadata.get("audio:encoding"), "PCM_SIGNED");
  assert.equal((await parseAu(auHeader(3, 8000, 1, 1000))).metadata.get("audio:encoding"), "PCM_SIGNED");
});

test("au: the content type is found whatever its case, its parameters or its spaces, and is written back plain", async () => {
  for (const contentType of ["AUDIO/BASIC", "audio/basic; charset=x", " audio/basic ; q=1", "Audio/Basic"]) {
    const { metadata } = await parseAu(auHeader(3, 8000, 1), contentType);
    assert.equal(metadata.get("audio:encoding"), "PCM_SIGNED", contentType);
    assert.equal(metadata.get("Content-Type"), "audio/basic", contentType);
  }
});

test("au: the warning is Tika's text word for word", async () => {
  const { metadata } = await parseAu(new Uint8Array(30));
  assert.deepEqual(metadata.getAll("tk:exception:warn"), [
    "An UnsupportedAudioFileException was thrown.  This could mean that the underlying parser hit an EndOfFileException or that the file is unsupported. ¯\\_(ツ)_/¯",
  ]);
});

test("au: an empty document is written, with the metadata in its head, as Tika's AudioParser does", async () => {
  const known = (await parseAu(auHeader(3, 8000, 1), "audio/basic", "xml")).text;
  assert.match(known, /<meta name="audio:encoding" content="PCM_SIGNED"><\/meta>/);
  assert.match(known, /<body><\/body>|<body\/>/);
  const refused = (await parseAu(new Uint8Array(30), "audio/basic", "xml")).text;
  assert.match(refused, /<meta name="tk:exception:warn" content="An UnsupportedAudioFileException/);
});

test("au: a file that the AudioParser reads without a content type goes to the general reader and is refused there", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array(40));
  try {
    await assert.rejects(
      new AudioParser().parse(stream, createOutputHandler("body"), new Metadata(), new ParseContext()),
      (error) => !(error instanceof TypeError),
    );
  } finally {
    await stream.close();
  }
});
