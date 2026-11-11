import {
  AbortError,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseTimeoutError,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  WriteLimitReachedError,
  XHTMLContentHandler,
  tikaDateMetadataStringKeepPartial,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { formatDuration } from "./mp4.ts";
import { DEFAULT_MAX_FLAC_METADATA_BYTES, readNativeFlac } from "./flac.ts";
import { decodeMimeBase64, parseComments, parsePictureBlock, readFlacStreamInfo, type PictureBlock, type VorbisComments } from "./ogg-comments.ts";
import { readOgg } from "./ogg-demux.ts";

/*
 * Port of Tika 4.2.0's OggParser, OggAudioParser, VorbisParser, OpusParser, SpeexParser, FlacParser (the Ogg FLAC
 * half) and TheoraParser (tika-parser-audiovideo-module). Tika leans on the vorbis-java library for the Ogg framing
 * and the codec headers; that library is not in the Tika tree, so what it does here is from the codec specs and from
 * memory, and is marked as such. Read from the Tika source; not run against a Tika.
 */

// ---- the streams of a file -------------------------------------------------------------------------------------------

export type Kind = "audio" | "video" | "metadata" | "unknown";

export interface Signature {
  /** What the first packet of the stream starts with, and the shortest such packet that counts. */
  readonly bytes: string;
  readonly minLength: number;
  readonly mime: string;
  readonly kind: Kind;
}

/**
 * vorbis-java's OggStreamIdentifier. The same table as OGG_STREAM_SIGNATURES in packages/mime/src/containers/ogg.ts,
 * which this package cannot import (it depends on core alone, and the table would pull the mime package into its
 * bundle); packages/parser-media/test/ogg-signatures.test.ts fails when the two differ.
 */
export const OGG_SIGNATURES: readonly Signature[] = [
  { bytes: "\x01vorbis", minLength: 30, mime: "audio/vorbis", kind: "audio" },
  { bytes: "OpusHead", minLength: 19, mime: "audio/opus", kind: "audio" },
  { bytes: "Speex   ", minLength: 80, mime: "audio/speex", kind: "audio" },
  { bytes: "\x7fFLAC", minLength: 51, mime: "audio/x-oggflac", kind: "audio" },
  { bytes: "PCM     ", minLength: 28, mime: "audio/x-oggpcm", kind: "audio" },
  { bytes: "\x80theora", minLength: 30, mime: "video/theora", kind: "video" },
  { bytes: "\x80daala", minLength: 30, mime: "video/daala", kind: "video" },
  { bytes: "UVS ", minLength: 28, mime: "video/x-ogguvs", kind: "video" },
  { bytes: "\x01YUV", minLength: 28, mime: "video/x-oggyuv", kind: "video" },
  { bytes: "BBCD", minLength: 28, mime: "video/x-dirac", kind: "video" },
  { bytes: "\x01video", minLength: 28, mime: "video/x-ogm", kind: "video" },
  { bytes: "\x01RGB", minLength: 28, mime: "video/x-oggrgb", kind: "video" },
  { bytes: "\x80kate\0\0\0\0", minLength: 30, mime: "application/kate", kind: "metadata" },
  { bytes: "CMML\0\0\0\0", minLength: 30, mime: "text/x-cmml", kind: "metadata" },
  { bytes: "fishead\0", minLength: 30, mime: "application/ogg", kind: "metadata" },
];

const UNKNOWN: Signature = { bytes: "", minLength: 0, mime: "application/ogg", kind: "unknown" };

function matches(signature: Signature, packet: Uint8Array): boolean {
  if (packet.length < signature.minLength) return false;
  for (let index = 0; index < signature.bytes.length; index++) {
    if (packet[index] !== signature.bytes.charCodeAt(index)) return false;
  }
  return true;
}

function identify(packet: Uint8Array): Signature {
  return OGG_SIGNATURES.find((signature) => matches(signature, packet)) ?? UNKNOWN;
}

function signatureOf(mime: string): Signature {
  return OGG_SIGNATURES.find((signature) => signature.mime === mime)!;
}

const types = (...names: string[]): ReadonlySet<MediaType> => new Set(names.map((name) => MediaType.parseOrThrow(name)));

/** The general parser, for the Ogg files that no codec parser takes: it counts the streams. */
export class OggParser implements Parser {
  readonly name = "OggParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return types(
      "application/ogg",
      "audio/ogg",
      "video/ogg",
      "video/daala",
      "video/x-dirac",
      "video/x-ogm",
      "video/x-ogguvs",
      "video/x-oggyuv",
      "video/x-oggrgb",
      "audio/x-oggpcm",
      "application/kate",
    );
  }

  async parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, _ctx: ParseContext): Promise<void> {
    const byType = new Map<Signature, number>();
    const byKind = new Map<Kind, number>();
    let total = 0;
    // Only the first packet of each stream is needed, to identify it.
    await readOgg(stream, {
      keepPackets: 1,
      onPacket(packet) {
        if (!packet.beginningOfStream) return;
        total++;
        const type = identify(packet.data);
        byType.set(type, (byType.get(type) ?? 0) + 1);
        byKind.set(type.kind, (byKind.get(type.kind) ?? 0) + 1);
      },
    });

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    metadata.add("ogg:streams-total", total);
    for (const [type, count] of byType) {
      // The key is the mime subtype less an x- prefix; an unidentified stream is "unknown".
      const key = type === UNKNOWN ? "unknown" : type.mime.slice(type.mime.indexOf("/") + 1).replace(/^x-/, "");
      metadata.add(`ogg:streams-${key}`, count);
    }
    for (const [kind, count] of byKind) metadata.add(`ogg:streams-${kind}`, count);
    await xhtml.endDocument();
  }
}

// ---- what the codec parsers share: OggAudioParser --------------------------------------------------------------------

/** XMPDM's channel layouts; Tika names five channels "5.1" and seven "7.1", and leaves other counts unnamed. */
export function extractChannelInfo(metadata: Metadata, channels: number): void {
  const layout = { 1: "Mono", 2: "Stereo", 5: "5.1", 7: "7.1" }[channels];
  if (layout !== undefined) metadata.set("xmpDM:audioChannelType", layout);
}

/** ID3Tags.PICTURE_TYPES, indexed by the picture type of the FLAC picture block. */
const PICTURE_TYPES = [
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

const FIELDS_DONE = new Set(["title", "artist", "album", "genre", "date", "tracknumber", "vendor", "comment", "metadata_block_picture"]);

/** Java's String.trim: every character up to U+0020. */
const javaTrim = (text: string): string => text.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");

/** NumberAndTotal's number: a Java int above zero, or null. */
function positiveInteger(text: string): number | null {
  const trimmed = javaTrim(text);
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 && value <= 2_147_483_647 ? value : null;
}

/** NumberAndTotal.parse: "3" or "3/12", each part a positive integer or null; null when neither is. */
function numberAndTotal(text: string): { number: number | null; total: number | null } | null {
  const slash = text.indexOf("/");
  const number = positiveInteger(slash < 0 ? text : text.slice(0, slash));
  const total = slash < 0 ? null : positiveInteger(text.slice(slash + 1));
  return number === null && total === null ? null : { number, total };
}

/**
 * OggAudioParser.extractComments: the comments as metadata and text. Everything is set before the first paragraph, as
 * the head of the output is written then. Returns the pictures, which the caller emits.
 */
export async function extractComments(metadata: Metadata, xhtml: XHTMLContentHandler, comments: VorbisComments): Promise<PictureBlock[]> {
  const { fields } = comments;
  const first = (name: string): string | null => fields.get(name)?.[0] ?? null;
  const all = (name: string): readonly string[] => fields.get(name) ?? [];
  const title = first("title");
  const artist = first("artist");
  const album = first("album");
  const trackNumber = first("tracknumber");

  // A null removes the key, as Metadata.set(property, null) does.
  metadata.set("dc:title", title);
  metadata.set("dc:creator", artist);
  metadata.set("xmpDM:artist", artist);
  metadata.set("xmpDM:album", album);
  metadata.set("xmpDM:genre", first("genre"));
  const releaseDate = tikaDateMetadataStringKeepPartial(first("date"));
  if (releaseDate !== null) metadata.set("xmpDM:releaseDate", releaseDate);
  metadata.add("xmp:CreatorTool", comments.vendor);
  metadata.add("vorbis:vendor", comments.vendor);
  const copyright = first("copyright");
  if (copyright !== null) metadata.set("xmpDM:copyright", copyright);
  for (const comment of all("comment")) metadata.add("xmpDM:logComment", comment);
  // The rest, in case it helps. The pictures become embedded documents instead: their raw base64 helps nobody.
  for (const [name, values] of fields) {
    if (!FIELDS_DONE.has(name)) for (const value of values) metadata.add(`vorbis:${name}`, value);
  }

  await xhtml.element("h1", title);
  await xhtml.element("p", artist);
  if (trackNumber !== null) {
    // Java concatenates a missing album as "null".
    await xhtml.element("p", `${album}, track ${trackNumber}`);
    metadata.set("audio:raw-track-number", trackNumber);
    const track = numberAndTotal(trackNumber);
    if (track?.number != null) metadata.set("xmpDM:trackNumber", track.number);
    if (track?.total != null) metadata.set("audio:track-count", track.total);
  } else {
    await xhtml.element("p", album);
  }
  for (const value of all("discnumber")) {
    metadata.set("audio:raw-disc-number", value);
    const disc = numberAndTotal(value);
    if (disc?.number != null) metadata.set("xmpDM:discNumber", disc.number);
    if (disc?.total != null) metadata.set("audio:disc-count", disc.total);
  }
  // Explicit totals win over the combined form.
  const trackTotal = firstPositiveInteger(all("tracktotal"), all("totaltracks"));
  if (trackTotal !== null) metadata.set("audio:track-count", trackTotal);
  const discTotal = firstPositiveInteger(all("disctotal"), all("totaldiscs"));
  if (discTotal !== null) metadata.set("audio:disc-count", discTotal);

  await xhtml.element("p", first("date"));
  for (const comment of all("comment")) await xhtml.element("p", comment);
  await xhtml.element("p", first("genre"));

  // A block that is not Base64, or not a picture, is skipped without a word.
  const pictures: PictureBlock[] = [];
  for (const block of all("metadata_block_picture")) {
    const decoded = decodeMimeBase64(block);
    const picture = decoded === null ? null : parsePictureBlock(decoded);
    if (picture !== null) pictures.push(picture);
  }
  return pictures;
}

function firstPositiveInteger(...valueLists: (readonly string[])[]): number | null {
  for (const values of valueLists) {
    for (const value of values) {
      const parsed = positiveInteger(value);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

/**
 * CoverArt.extractPictures: every picture is an embedded document, the front cover (else the first of type Other or
 * unknown, else the first) the THUMBNAIL and the rest INLINE. Called once per file, with all its pictures.
 */
export async function extractPictures(
  pictures: readonly PictureBlock[],
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  if (pictures.length === 0) return;
  // A type past the ID3 table counts as unknown.
  const kinds = pictures.map((picture) => (picture.type >= PICTURE_TYPES.length ? -1 : picture.type));
  const front = kinds.indexOf(3);
  const thumbnail = front >= 0 ? front : Math.max(0, kinds.findIndex((kind) => kind <= 0));
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();

  for (const [index, picture] of pictures.entries()) {
    const embedded = new Metadata();
    embedded.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, index === thumbnail ? "THUMBNAIL" : "INLINE");
    if (picture.mimeType !== "") embedded.set("Content-Type", picture.mimeType);
    if (picture.description !== "") embedded.set("dc:title", picture.description);
    const kind = PICTURE_TYPES[picture.type];
    if (kind !== undefined) embedded.set("dc:description", kind);
    embedded.set("Content-Length", String(picture.data.length));
    if (!extractor.shouldParseEmbedded(embedded)) continue;

    const stream = await RipstreamInputStream.from(picture.data, { context: ctx });
    try {
      await extractor.parseEmbedded(stream, xhtml, embedded, ctx);
    } catch (error) {
      // A picture that cannot be read is recorded, and the others go on; a limit or an abort ends the parse.
      if (isFatal(error, ctx)) throw error;
      metadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    } finally {
      await stream.close();
    }
  }
}

function isFatal(error: unknown, ctx: ParseContext): boolean {
  return (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    error instanceof WriteLimitReachedError ||
    ctx.signal.aborted
  );
}

/** OggAudioParser.extractDuration: xmpDM:duration as DecimalFormat("0.0#") does it, and a paragraph of hours, minutes and seconds. */
export async function extractDuration(metadata: Metadata, xhtml: XHTMLContentHandler, seconds: number): Promise<void> {
  if (!(seconds > 0)) return;
  metadata.add("xmpDM:duration", formatDuration(seconds));
  const whole = Math.trunc(seconds);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const hours = Math.trunc(whole / 3600);
  const minutes = Math.trunc((whole % 3600) / 60);
  await xhtml.element("p", hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`);
}

// ---- one codec: Vorbis, Opus, Speex, Theora, Ogg FLAC ----------------------------------------------------------------

interface Codec {
  readonly name: string;
  readonly signature: Signature;
  readonly claims: readonly string[];
  readonly compressorKey: "xmpDM:audioCompressor" | "xmpDM:videoCompressor";
  readonly compressor: string;
  /** How many packets at the start of the stream are read. */
  readonly keepPackets: number;
  /** Writes what the first packet says, and returns the duration in seconds for the last granule position. */
  info(first: Uint8Array, metadata: Metadata): (lastGranule: bigint) => number;
  /** The comment packet among the packets read, and the bytes in it before the vendor; undefined if there is none. */
  comments(headers: readonly Uint8Array[]): { readonly packet: Uint8Array; readonly prefix: number } | undefined;
}

const view = (packet: Uint8Array): DataView => new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
/** vorbis-java reads these as ints; `| 0` is the cast to a Java int. */
const int32 = (packet: Uint8Array, offset: number): number => view(packet).getUint32(offset, true) | 0;

const secondsOver = (rate: number) => (granule: bigint): number => (rate > 0 ? Number(granule) / rate : 0);
const second = (headers: readonly Uint8Array[], prefix: number) => (headers[1] === undefined ? undefined : { packet: headers[1], prefix });

const VORBIS: Codec = {
  name: "VorbisParser",
  signature: signatureOf("audio/vorbis"),
  claims: ["audio/vorbis"],
  compressorKey: "xmpDM:audioCompressor",
  compressor: "Vorbis",
  keepPackets: 2,
  info(first, metadata) {
    const rate = int32(first, 12);
    metadata.set("xmpDM:audioSampleRate", rate);
    metadata.add("ogg:codec-version", `Vorbis ${int32(first, 7)}`);
    const [upper, nominal, lower] = [int32(first, 16), int32(first, 20), int32(first, 24)];
    if (nominal > 0 || upper > 0 || lower > 0) {
      if (nominal > 0) metadata.set("audio:bitrate", nominal);
      // A zero-width bracket declares an exact rate as well.
      else if (upper > 0 && upper === lower) metadata.set("audio:bitrate", upper);
      const fixed = (nominal > 0 && upper === nominal && lower === nominal) || (nominal <= 0 && upper > 0 && upper === lower);
      metadata.set("audio:is-variable-bitrate", !fixed);
    }
    extractChannelInfo(metadata, first[11]!);
    return secondsOver(rate);
  },
  comments: (headers) => second(headers, 7),
};

const OPUS: Codec = {
  name: "OpusParser",
  signature: signatureOf("audio/opus"),
  claims: ["audio/ogg; codecs=opus", "audio/opus"],
  compressorKey: "xmpDM:audioCompressor",
  compressor: "Opus",
  keepPackets: 2,
  info(first, metadata) {
    // The rate in the header is the rate of the input before encoding; Opus itself runs at 48000.
    metadata.set("xmpDM:audioSampleRate", int32(first, 12));
    metadata.add("ogg:codec-version", `Opus ${(first[8]! & 0xf0) >> 4}.${first[8]! & 0x0f}`);
    extractChannelInfo(metadata, first[9]!);
    const preSkip = view(first).getUint16(10, true);
    return (granule) => Number(granule - BigInt(preSkip)) / 48000;
  },
  comments: (headers) => second(headers, 8),
};

const SPEEX: Codec = {
  name: "SpeexParser",
  signature: signatureOf("audio/speex"),
  claims: ["audio/ogg; codecs=speex", "audio/speex"],
  compressorKey: "xmpDM:audioCompressor",
  compressor: "Speex",
  keepPackets: 2,
  info(first, metadata) {
    const rate = int32(first, 36);
    metadata.set("xmpDM:audioSampleRate", rate);
    // The version string is padded with zero bytes.
    const versionString = new TextDecoder().decode(first.subarray(8, 28)).split("\0")[0];
    metadata.add("ogg:codec-version", `Speex ${int32(first, 28)} - ${versionString}`);
    extractChannelInfo(metadata, int32(first, 48));
    return secondsOver(rate);
  },
  comments: (headers) => second(headers, 0),
};

const THEORA: Codec = {
  name: "TheoraParser",
  signature: signatureOf("video/theora"),
  claims: ["video/theora"],
  compressorKey: "xmpDM:videoCompressor",
  compressor: "Theora",
  keepPackets: 2,
  info(first, metadata) {
    metadata.add("ogg:codec-version", `Theora ${first[7]}.${first[8]}.${first[9]}`);
    return () => 0;
  },
  comments: (headers) => second(headers, 7),
};

/** How many packets of an Ogg FLAC stream are read to find the comment block; it follows the stream info at once. */
const FLAC_HEADER_PACKETS = 16;

const OGG_FLAC: Codec = {
  name: "FlacParser",
  signature: signatureOf("audio/x-oggflac"),
  claims: ["audio/x-oggflac"],
  compressorKey: "xmpDM:audioCompressor",
  compressor: "FLAC",
  keepPackets: FLAC_HEADER_PACKETS,
  info(first, metadata) {
    // The mapping header (13 bytes), then the STREAMINFO block: its 4 byte block header, then the block.
    const { sampleRate: rate, channels, totalSamples: samples } = readFlacStreamInfo(first, 17);
    metadata.set("xmpDM:audioSampleRate", rate);
    extractChannelInfo(metadata, channels);
    metadata.add("ogg:codec-version", `Flac ${first[5]}.${first[6]}`);
    // The duration comes from the stream info, not from the granule positions.
    return () => (samples > 0 && rate > 0 ? samples / rate : 0);
  },
  comments(headers) {
    // A metadata block per packet: a block header byte (type in the low 7 bits), 3 bytes of length, the block.
    const packet = headers.slice(1).find((candidate) => (candidate[0]! & 0x7f) === 4);
    return packet === undefined ? undefined : { packet, prefix: 4 };
  },
};

class OggCodecParser implements Parser {
  readonly capabilities = { metadataOnly: true } as const;
  private readonly codec: Codec;

  constructor(codec: Codec) {
    this.codec = codec;
  }

  get name(): string {
    return this.codec.name;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return types(...this.codec.claims);
  }

  async parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
    const { codec } = this;
    metadata.set("Content-Type", codec.signature.mime);
    metadata.set(codec.compressorKey, codec.compressor);

    const { headers, lastGranule } = await readCodecStream(stream, codec);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const durationOf = codec.info(headers[0]!, metadata);
    const comments = codec.comments(headers);
    if (comments === undefined) throw new MalformedDocumentError(`The ${codec.compressor} stream has no comment header`);
    const pictures = await extractComments(metadata, xhtml, parseComments(comments.packet, comments.prefix));
    await extractPictures(pictures, xhtml, metadata, ctx);
    await extractDuration(metadata, xhtml, durationOf(lastGranule));
    await xhtml.endDocument();
  }
}

/**
 * The first stream of the codec: its leading packets, and the granule position of the last page that ended a packet.
 * The codec's stream is told by the first packet of a beginning-of-stream page, as the detector does, so one in a file
 * that also holds video or other audio is found among them.
 */
async function readCodecStream(
  stream: RipstreamInputStream,
  codec: Codec,
): Promise<{ headers: Uint8Array[]; lastGranule: bigint }> {
  let sid: number | undefined;
  const headers: Uint8Array[] = [];
  let lastGranule = -1n;
  // Set when a packet of the serial number is out of order: the stream has ended and another one with the same number
  // has begun, which is not this one. Nothing more is taken from that number.
  let ended = false;
  await readOgg(stream, {
    keepPackets: codec.keepPackets,
    onPacket(packet) {
      if (sid === undefined && packet.beginningOfStream && matches(codec.signature, packet.data)) sid = packet.sid;
      if (packet.sid !== sid || ended) return;
      if (packet.index === headers.length) headers.push(packet.data);
      else ended = true;
    },
    onGranule(granuleSid, granule) {
      if (granuleSid === sid && !ended) lastGranule = granule;
    },
  });
  if (sid === undefined) throw new MalformedDocumentError(`The file has no ${codec.compressor} stream`);
  return { headers, lastGranule };
}

export class VorbisParser extends OggCodecParser {
  constructor() {
    super(VORBIS);
  }
}

export class OpusParser extends OggCodecParser {
  constructor() {
    super(OPUS);
  }
}

export class SpeexParser extends OggCodecParser {
  constructor() {
    super(SPEEX);
  }
}

export class TheoraParser extends OggCodecParser {
  constructor() {
    super(THEORA);
  }
}

export interface FlacParserOptions {
  /** What the walk over the metadata blocks of a native FLAC file may cover (default {@link DEFAULT_MAX_FLAC_METADATA_BYTES}). */
  readonly maxMetadataBytes?: number;
}

const FLAC_MAGIC = "fLaC";

/**
 * Tika's FlacParser: FLAC in an Ogg container (the Ogg codec parser of the file) and native FLAC (flac.ts), told by the
 * first four bytes as vorbis-java's FlacFile.open does. Written the same way for both: the layout and the rate from the
 * stream info, the comments, the pictures (those of the comments, then the PICTURE blocks), the duration.
 */
export class FlacParser implements Parser {
  readonly name = "FlacParser";
  readonly capabilities = { metadataOnly: true } as const;
  readonly #ogg = new OggCodecParser(OGG_FLAC);
  readonly #maxMetadataBytes: number;

  constructor(options: FlacParserOptions = {}) {
    const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_FLAC_METADATA_BYTES;
    if (!Number.isInteger(maxMetadataBytes) || maxMetadataBytes < 1) {
      throw new RangeError(`maxMetadataBytes must be a positive integer, got ${maxMetadataBytes}`);
    }
    this.#maxMetadataBytes = maxMetadataBytes;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    // audio/flac is the alias of audio/x-flac in Tika's registry.
    return types("audio/x-flac", "audio/flac", ...OGG_FLAC.claims);
  }

  async parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
    const magic = await stream.peek(FLAC_MAGIC.length);
    if (String.fromCharCode(...magic) !== FLAC_MAGIC) return this.#ogg.parse(stream, handler, metadata, ctx);

    metadata.set("xmpDM:audioCompressor", "FLAC");
    const { streamInfo, comments, pictures } = await readNativeFlac(stream, this.#maxMetadataBytes);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    metadata.set("xmpDM:audioSampleRate", streamInfo.sampleRate);
    extractChannelInfo(metadata, streamInfo.channels);
    metadata.set("Content-Type", "audio/x-flac");
    // A file with no comment block has no tags: it is written as one with an empty block, less the vendor it never named.
    const fromComments = await extractComments(metadata, xhtml, comments ?? { vendor: "", fields: new Map() });
    if (comments === null) {
      metadata.remove("xmp:CreatorTool");
      metadata.remove("vorbis:vendor");
    }
    await extractPictures([...fromComments, ...pictures], xhtml, metadata, ctx);
    if (streamInfo.totalSamples > 0 && streamInfo.sampleRate > 0) {
      await extractDuration(metadata, xhtml, streamInfo.totalSamples / streamInfo.sampleRate);
    }
    await xhtml.endDocument();
  }
}
