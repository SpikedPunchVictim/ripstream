import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { FlacParser, OggParser, OpusParser, SpeexParser, TheoraParser, VorbisParser } from "../src/index.ts";
import {
  THEORA_COMMENT_PREFIX,
  commentBlock,
  concat,
  enc,
  flacTagsPacket,
  oggFlacFirst,
  oggPage,
  opusFile,
  opusHead,
  speexHeader,
  theoraIdent,
  u32le,
  vorbisFile,
  vorbisIdent,
} from "./ogg-builder.ts";

/*
 * The Ogg parsers over files built here. The values are what Tika 4.2.0's OggParser, VorbisParser, OpusParser,
 * SpeexParser, TheoraParser and FlacParser write, read from their source; not run against a Tika.
 */

interface Parsed {
  readonly metadata: Metadata;
  readonly text: string;
  readonly embedded: Metadata[];
}

async function parseWith(parser: Parser, bytes: Uint8Array, format: "body" | "xml" = "body"): Promise<Parsed> {
  const ctx = new ParseContext();
  const embedded = new EmbeddedDocumentBytesHandler();
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, embedded);
  const metadata = new Metadata();
  const handler = createOutputHandler(format);
  const stream = await RipstreamInputStream.from(bytes);
  try {
    await parser.parse(stream, handler, metadata, ctx);
  } finally {
    await stream.close();
  }
  return { metadata, text: handler.toString(), embedded: embedded.resources.map((r) => r.metadata) };
}

const COMMENTS = ["title=Test Title", "artist=Test Artist", "album=Test Album"];

test("vorbis: the identification header gives the rate, the layout, the codec version and the bitrate", async () => {
  const { metadata } = await parseWith(new VorbisParser(), vorbisFile({ ident: { channels: 2, rate: 44100, nominal: 80000 }, comments: COMMENTS }));
  assert.equal(metadata.get("Content-Type"), "audio/vorbis");
  assert.equal(metadata.get("xmpDM:audioCompressor"), "Vorbis");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(metadata.get("ogg:codec-version"), "Vorbis 0");
  assert.equal(metadata.get("audio:bitrate"), "80000");
  assert.equal(metadata.get("audio:is-variable-bitrate"), "true", "a nominal rate alone is variable");
  assert.equal(metadata.get("dc:title"), "Test Title");
});

test("vorbis bitrate: the cases of VorbisParserTest", async () => {
  const bitrate = async (upper: number, nominal: number, lower: number): Promise<[string | null, string | null]> => {
    const { metadata } = await parseWith(new VorbisParser(), vorbisFile({ ident: { upper, nominal, lower } }));
    return [metadata.get("audio:bitrate"), metadata.get("audio:is-variable-bitrate")];
  };
  assert.deepEqual(await bitrate(0, 192000, 0), ["192000", "true"], "nominal only");
  assert.deepEqual(await bitrate(192000, 192000, 192000), ["192000", "false"], "all three agree");
  assert.deepEqual(await bitrate(128000, 0, 128000), ["128000", "false"], "a zero-width bracket");
  assert.deepEqual(await bitrate(256000, 0, 96000), [null, "true"], "a real bracket");
  assert.deepEqual(await bitrate(0, 0, 0), [null, null], "no declared rate");
  // The rates are signed 32 bit numbers: a high bit is a negative rate, which declares nothing.
  assert.deepEqual(await bitrate(0xffffffff, 0, 0xffffffff), [null, null]);
});

test("vorbis: the duration is the last granule position over the rate, as xmpDM:duration and a paragraph", async () => {
  const { metadata, text } = await parseWith(new VorbisParser(), vorbisFile({ comments: COMMENTS, lastGranule: 44100n * 75n + 22050n }));
  assert.equal(metadata.get("xmpDM:duration"), "75.5");
  assert.equal(text, "Test Title\nTest Artist\nTest Album\n1:15\n");
  // 64 bit granule positions are read whole: 2^40 samples at 44100 Hz.
  const long = await parseWith(new VorbisParser(), vorbisFile({ lastGranule: 2n ** 40n }));
  assert.equal(long.metadata.get("xmpDM:duration"), "24932236.46"); // 1099511627776 / 44100
  // A granule of 0 (or -1) is no duration.
  assert.equal((await parseWith(new VorbisParser(), vorbisFile({ lastGranule: 0n }))).metadata.has("xmpDM:duration"), false);
  assert.equal((await parseWith(new VorbisParser(), vorbisFile({ lastGranule: -1n }))).metadata.has("xmpDM:duration"), false);
});

test("a sample rate of 0 gives no duration rather than a division by zero", async () => {
  const { metadata } = await parseWith(new VorbisParser(), vorbisFile({ ident: { rate: 0 }, lastGranule: 1000n }));
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "0");
  assert.equal(metadata.has("xmpDM:duration"), false);
});

test("the metadata is complete in the head of the output: it is all set before the first paragraph", async () => {
  const { text: xml } = await parseWith(new VorbisParser(), vorbisFile({ comments: COMMENTS }), "xml");
  assert.match(xml, /<meta name="dc:title" content="Test Title"><\/meta>/);
  assert.match(xml, /<meta name="xmpDM:audioSampleRate" content="44100"><\/meta>/);
  assert.match(xml, /<body><h1>Test Title<\/h1>/);
});

test("opus: the input rate is the sample rate, and the duration is the granule position less the pre-skip over 48000", async () => {
  const { metadata, text } = await parseWith(
    new OpusParser(),
    opusFile({ head: { channels: 2, rate: 44100, preSkip: 312 }, comments: COMMENTS, lastGranule: 48312n }),
  );
  assert.equal(metadata.get("Content-Type"), "audio/opus");
  assert.equal(metadata.get("xmpDM:audioCompressor"), "Opus");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(metadata.get("ogg:codec-version"), "Opus 0.1");
  assert.equal(metadata.get("xmpDM:duration"), "1.0");
  assert.equal(text, "Test Title\nTest Artist\nTest Album\n0:01\n");
  assert.equal(metadata.get("xmp:CreatorTool"), "libopus");
});

test("opus: a granule position inside the pre-skip is no duration", async () => {
  const { metadata } = await parseWith(new OpusParser(), opusFile({ head: { preSkip: 312 }, lastGranule: 312n }));
  assert.equal(metadata.has("xmpDM:duration"), false);
});

test("speex: the version, the rate and the layout come from the header, the duration from the granule position", async () => {
  const header = speexHeader({ versionString: "1.2rc1", versionId: 1, rate: 16000, channels: 1 });
  const file = concat(
    oggPage({ sid: 3, bos: true, packets: [header], granule: 0n }),
    oggPage({ sid: 3, packets: [commentBlock("speex vendor", ["title=Spoken"])], granule: 0n }),
    oggPage({ sid: 3, eos: true, packets: [new Uint8Array(20)], granule: 24000n }),
  );
  const { metadata } = await parseWith(new SpeexParser(), file);
  assert.equal(metadata.get("Content-Type"), "audio/speex");
  assert.equal(metadata.get("xmpDM:audioCompressor"), "Speex");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "16000");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Mono");
  assert.equal(metadata.get("ogg:codec-version"), "Speex 1 - 1.2rc1");
  assert.equal(metadata.get("dc:title"), "Spoken");
  assert.equal(metadata.get("xmpDM:duration"), "1.5");
});

test("theora: the version is major.minor.revision, the compressor is the video one, and there is no duration", async () => {
  const file = concat(
    oggPage({ sid: 4, bos: true, packets: [theoraIdent({ major: 3, minor: 2, revision: 1 })], granule: 0n }),
    oggPage({ sid: 4, packets: [commentBlock("Xiph.Org libtheora", ["title=A Video", "artist=A Director"], THEORA_COMMENT_PREFIX)], granule: 0n }),
    oggPage({ sid: 4, eos: true, packets: [new Uint8Array(30)], granule: 1234n }),
  );
  const { metadata, text } = await parseWith(new TheoraParser(), file);
  assert.equal(metadata.get("Content-Type"), "video/theora");
  assert.equal(metadata.get("xmpDM:videoCompressor"), "Theora");
  assert.equal(metadata.get("ogg:codec-version"), "Theora 3.2.1");
  assert.equal(metadata.get("dc:title"), "A Video");
  assert.equal(metadata.has("xmpDM:duration"), false);
  assert.equal(text, "A Video\nA Director\n");
});

test("ogg flac: the stream info gives the rate, the layout and the duration, the comment block the tags", async () => {
  const file = concat(
    oggPage({ sid: 5, bos: true, packets: [oggFlacFirst({ rate: 44100, channels: 2, samples: 88200 + 22050, major: 1, minor: 0 })], granule: 0n }),
    oggPage({ sid: 5, packets: [flacTagsPacket("reference libFLAC", COMMENTS)], granule: 0n }),
    oggPage({ sid: 5, eos: true, packets: [new Uint8Array(20)], granule: 110250n }),
  );
  const { metadata, text } = await parseWith(new FlacParser(), file);
  assert.equal(metadata.get("Content-Type"), "audio/x-oggflac");
  assert.equal(metadata.get("xmpDM:audioCompressor"), "FLAC");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(metadata.get("ogg:codec-version"), "Flac 1.0");
  assert.equal(metadata.get("dc:title"), "Test Title");
  assert.equal(metadata.get("xmpDM:duration"), "2.5");
  assert.equal(text, "Test Title\nTest Artist\nTest Album\n0:02\n");
});

test("ogg flac: the total samples are 36 bits, and a stream info with none gives no duration", async () => {
  const flac = (samples: number): Uint8Array =>
    concat(
      oggPage({ sid: 5, bos: true, packets: [oggFlacFirst({ rate: 48000, samples })], granule: 0n }),
      oggPage({ sid: 5, packets: [flacTagsPacket("v", COMMENTS)], granule: 0n }),
    );
  assert.equal((await parseWith(new FlacParser(), flac(2 ** 35))).metadata.get("xmpDM:duration"), "715827.88");
  assert.equal((await parseWith(new FlacParser(), flac(0))).metadata.has("xmpDM:duration"), false);
});

test("a codec parser takes the stream of its own codec out of a multiplexed file", async () => {
  const file = concat(
    oggPage({ sid: 10, bos: true, packets: [theoraIdent()], granule: 0n }),
    oggPage({ sid: 20, bos: true, packets: [vorbisIdent({ rate: 22050, nominal: 64000 })], granule: 0n }),
    oggPage({ sid: 10, packets: [commentBlock("t", ["title=Video Title"], THEORA_COMMENT_PREFIX)], granule: 0n }),
    oggPage({ sid: 20, packets: [concat(commentBlock("v", ["title=Audio Title"], Uint8Array.of(3, ...enc("vorbis"))), Uint8Array.of(1))], granule: 0n }),
    oggPage({ sid: 10, eos: true, packets: [new Uint8Array(10)], granule: 99999n }),
    oggPage({ sid: 20, eos: true, packets: [new Uint8Array(10)], granule: 44100n }),
  );
  const vorbis = await parseWith(new VorbisParser(), file);
  assert.equal(vorbis.metadata.get("dc:title"), "Audio Title");
  assert.equal(vorbis.metadata.get("xmpDM:duration"), "2.0", "the granule position of the Vorbis stream, not of the Theora one");
  assert.equal((await parseWith(new TheoraParser(), file)).metadata.get("dc:title"), "Video Title");
});

test("a file without a stream of the codec is refused as malformed", async () => {
  await assert.rejects(parseWith(new VorbisParser(), opusFile()), MalformedDocumentError);
  await assert.rejects(parseWith(new OpusParser(), vorbisFile()), MalformedDocumentError);
  await assert.rejects(parseWith(new TheoraParser(), vorbisFile()), MalformedDocumentError);
  await assert.rejects(parseWith(new VorbisParser(), enc("RIFF not an ogg file")), MalformedDocumentError);
  await assert.rejects(parseWith(new VorbisParser(), new Uint8Array(0)), MalformedDocumentError);
  // The identification packet is there but the comment packet is not.
  await assert.rejects(
    parseWith(new VorbisParser(), oggPage({ sid: 1, bos: true, packets: [vorbisIdent()], granule: 0n })),
    MalformedDocumentError,
  );
});

test("every prefix of a file of each codec parses, or is refused as malformed", async () => {
  const files: [Parser, Uint8Array][] = [
    [new VorbisParser(), vorbisFile({ comments: COMMENTS })],
    [new OpusParser(), opusFile({ comments: COMMENTS })],
    [
      new SpeexParser(),
      concat(
        oggPage({ sid: 3, bos: true, packets: [speexHeader()], granule: 0n }),
        oggPage({ sid: 3, packets: [commentBlock("v", COMMENTS)], granule: 0n }),
        oggPage({ sid: 3, eos: true, packets: [new Uint8Array(20)], granule: 100n }),
      ),
    ],
    [
      new TheoraParser(),
      concat(
        oggPage({ sid: 4, bos: true, packets: [theoraIdent()], granule: 0n }),
        oggPage({ sid: 4, packets: [commentBlock("v", COMMENTS, THEORA_COMMENT_PREFIX)], granule: 0n }),
      ),
    ],
    [
      new FlacParser(),
      concat(
        oggPage({ sid: 5, bos: true, packets: [oggFlacFirst({ samples: 1000 })], granule: 0n }),
        oggPage({ sid: 5, packets: [flacTagsPacket("v", COMMENTS)], granule: 0n }),
        oggPage({ sid: 5, eos: true, packets: [new Uint8Array(20)], granule: 1000n }),
      ),
    ],
    [new OggParser(), vorbisFile({ comments: COMMENTS })],
  ];
  for (const [parser, file] of files) {
    for (let length = 0; length <= file.length; length++) {
      try {
        await parseWith(parser, file.subarray(0, length));
      } catch (error) {
        assert.ok(error instanceof MalformedDocumentError, `${parser.name} prefix ${length}: ${String(error)}`);
      }
    }
  }
});

test("a hostile comment count or length is refused without reading the bytes it claims", async () => {
  const withComments = (block: Uint8Array): Uint8Array =>
    concat(
      oggPage({ sid: 1, bos: true, packets: [vorbisIdent()], granule: 0n }),
      oggPage({ sid: 1, packets: [concat(Uint8Array.of(3, ...enc("vorbis")), block, Uint8Array.of(1))], granule: 0n }),
    );
  const countOfFourBillion = concat(u32le(0), u32le(0xffffffff), u32le(0));
  const lengthOfFourBillion = concat(u32le(0), u32le(1), u32le(0xfffffffe), enc("title=x"));
  const vendorOfFourBillion = concat(u32le(0xffffffff), enc("v"));
  for (const block of [countOfFourBillion, lengthOfFourBillion, vendorOfFourBillion]) {
    await assert.rejects(parseWith(new VorbisParser(), withComments(block)), MalformedDocumentError);
  }
  // Ten thousand and one comments, each of them present: a limit, not a malformed file. (Empty comments, so that the
  // header fits the 65025 bytes of one page.)
  const many = commentBlock("v", Array.from({ length: 10_001 }, () => ""));
  await assert.rejects(parseWith(new VorbisParser(), withComments(many)), LimitExceededError);
});

test("the general parser counts the streams by type and by kind", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [theoraIdent()], granule: 0n }),
    oggPage({ sid: 2, bos: true, packets: [vorbisIdent()], granule: 0n }),
    oggPage({ sid: 3, bos: true, packets: [vorbisIdent()], granule: 0n }),
    oggPage({ sid: 4, bos: true, packets: [Uint8Array.of(1, 2, 3)], granule: 0n }),
    oggPage({ sid: 2, eos: true, packets: [new Uint8Array(4)], granule: 5n }),
  );
  const { metadata, text } = await parseWith(new OggParser(), file);
  assert.deepEqual(metadata.getAll("ogg:streams-total"), ["4"]);
  assert.deepEqual(metadata.getAll("ogg:streams-theora"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-vorbis"), ["2"]);
  assert.deepEqual(metadata.getAll("ogg:streams-video"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-audio"), ["2"]);
  // An unidentified stream is counted under its type and under its kind, both named unknown.
  assert.deepEqual(metadata.getAll("ogg:streams-unknown"), ["1", "1"]);
  assert.equal(text, "");
});

test("the general parser names a stream type after its mime type less the x- prefix", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [concat(enc("\u0001YUV"), new Uint8Array(30))], granule: 0n }),
    oggPage({ sid: 2, bos: true, packets: [concat(enc("\u007fFLAC"), new Uint8Array(60))], granule: 0n }),
    oggPage({ sid: 3, bos: true, packets: [concat(Uint8Array.of(0x80), enc("kate"), new Uint8Array(34))], granule: 0n }),
  );
  const { metadata } = await parseWith(new OggParser(), file);
  assert.deepEqual(metadata.getAll("ogg:streams-oggyuv"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-oggflac"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-kate"), ["1"]);
  assert.deepEqual(metadata.getAll("ogg:streams-metadata"), ["1"]);
});

test("the claims of each parser: the types Tika routes to it", () => {
  const claims = (parser: Parser): string[] => [...parser.getSupportedTypes()].map(String).sort();
  assert.deepEqual(claims(new VorbisParser()), ["audio/vorbis"]);
  // Tika also gives Opus and Speex the codec-parameter forms of audio/ogg, which the registry reads as audio/ogg.
  assert.deepEqual(claims(new OpusParser()), ["audio/ogg; codecs=opus", "audio/opus"]);
  assert.deepEqual(claims(new SpeexParser()), ["audio/ogg; codecs=speex", "audio/speex"]);
  assert.deepEqual(claims(new TheoraParser()), ["video/theora"]);
  assert.deepEqual(claims(new FlacParser()), ["audio/x-oggflac"]);
  assert.deepEqual(claims(new OggParser()), [
    "application/kate",
    "application/ogg",
    "audio/ogg",
    "audio/x-oggpcm",
    "video/daala",
    "video/ogg",
    "video/x-dirac",
    "video/x-ogguvs",
    "video/x-ogm",
    "video/x-oggrgb",
    "video/x-oggyuv",
  ].sort());
});

test("the parsers declare they read metadata only and nothing unsafe", () => {
  for (const parser of [new OggParser(), new VorbisParser(), new OpusParser(), new SpeexParser(), new TheoraParser(), new FlacParser()]) {
    assert.deepEqual(parser.capabilities, { metadataOnly: true }, parser.name);
  }
});

test("input with no Ogg page in it is read once, to its end, and refused", async () => {
  // 20000 chunks of zeros, 20 MB.
  async function* zeros(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < 20_000; index++) yield new Uint8Array(1024);
  }
  const stream = await RipstreamInputStream.from(zeros());
  await assert.rejects(
    new VorbisParser().parse(stream, createOutputHandler("body"), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});

const MEDIA = new URL("../../parsers/test/fixtures/media/", import.meta.url);
const real = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, MEDIA)));

test("testVORBIS.ogg of Tika: the bitrate, the rate, and the tags of AutoDetectParserTest", async () => {
  const { metadata, text } = await parseWith(new VorbisParser(), real("testVORBIS.ogg"));
  assert.equal(metadata.get("audio:bitrate"), "80000");
  assert.equal(metadata.get("audio:is-variable-bitrate"), "true");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(metadata.get("dc:title"), "Test Title");
  assert.equal(metadata.get("dc:creator"), "Test Artist");
  assert.equal(metadata.get("xmpDM:artist"), "Test Artist");
  assert.equal(metadata.get("xmpDM:album"), "Test Album");
  assert.ok(text.includes("Test Title") && text.includes("Test Artist"));
});

test("testVORBIS_coverArt.ogg of Tika: one embedded picture, the thumbnail, and no raw block in the metadata", async () => {
  const { metadata, embedded } = await parseWith(new VorbisParser(), real("testVORBIS_coverArt.ogg"));
  assert.equal(metadata.get("Content-Type"), "audio/vorbis");
  assert.equal(metadata.has("vorbis:metadata_block_picture"), false);
  assert.equal(embedded.length, 1);
  assert.equal(embedded[0]!.get("Content-Type"), "image/png");
  assert.equal(embedded[0]!.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(embedded[0]!.get("dc:title"), "Test Cover");
  assert.equal(embedded[0]!.get("dc:description"), "Cover (front)");
});

test("testVORBIS_twoCovers.ogg of Tika: a picture for each comment, in file order, the front cover the thumbnail", async () => {
  const { metadata, embedded } = await parseWith(new VorbisParser(), real("testVORBIS_twoCovers.ogg"));
  assert.equal(metadata.has("vorbis:metadata_block_picture"), false);
  assert.equal(embedded.length, 2);
  const [front, back] = embedded as [Metadata, Metadata];
  assert.deepEqual(
    [front.get("Content-Type"), front.get("dc:title"), front.get("dc:description"), front.get("tk:embedded-resource-type")],
    ["image/png", "Front Cover", "Cover (front)", "THUMBNAIL"],
  );
  assert.deepEqual(
    [back.get("Content-Type"), back.get("dc:title"), back.get("dc:description"), back.get("tk:embedded-resource-type")],
    ["image/png", "Back Cover", "Cover (back)", "INLINE"],
  );
});

test("testOPUS.opus and testFLAC.oga of Tika: the tags, the layout and the rate of AutoDetectParserTest", async () => {
  const opus = (await parseWith(new OpusParser(), real("testOPUS.opus"))).metadata;
  assert.equal(opus.get("dc:title"), "Test Title");
  assert.equal(opus.get("xmpDM:artist"), "Test Artist");
  assert.equal(opus.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(opus.get("xmpDM:audioSampleRate"), "44100");
  const flac = (await parseWith(new FlacParser(), real("testFLAC.oga"))).metadata;
  assert.equal(flac.get("Content-Type"), "audio/x-oggflac");
  assert.equal(flac.get("dc:title"), "Test Title");
  assert.equal(flac.get("xmpDM:album"), "Test Album");
  assert.equal(flac.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(flac.get("xmpDM:audioSampleRate"), "44100");
});
