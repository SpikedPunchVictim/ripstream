import {
  MalformedDocumentError,
  MediaType,
  javaDoubleString,
  javaFloatString,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** Seconds from the QuickTime epoch (1904-01-01) to the Unix epoch. */
const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800;

/** SampleEntry fields before a VisualSampleEntry's own fields: 6 reserved bytes and the data reference index. */
const SAMPLE_ENTRY_FIELDS = 8;

/** A VisualSampleEntry's fields after the SampleEntry ones, up to where its child boxes begin. */
const VISUAL_ENTRY_SIZE = 78;

/** Real files nest 'wave' at most one level; this only bounds a crafted chain of them. */
const MAX_BOX_DEPTH = 10;

/** Sample entry formats that wrap a protected stream, whose original codec is in a child 'sinf'/'frma'. */
const PROTECTED_FORMATS = new Set(["drms", "drmi", "enca", "encv"]);

/**
 * MP4/MOV/3GP metadata from ISO base media file format boxes, under the keys Tika's MP4Parser writes. It reads the
 * movie header (duration and times), every track's media header and sample description (codecs, frame rate, compressor,
 * audio channel and size parameters, average bitrates) and the video size. It reads no other box.
 */
export class Mp4Parser implements Parser {
  readonly name = "MP4Parser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "video/mp4",
        "audio/mp4",
        "application/mp4",
        "video/quicktime",
        "video/3gpp",
        "video/3gpp2",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const movie = findBox(data, view, 0, data.byteLength, "moov");
    if (movie === null) throw new MalformedDocumentError("Missing MP4 moov box");
    const movieHeader = findBox(
      data,
      view,
      movie.start,
      movie.start + movie.size,
      "mvhd",
    );
    let movieTimescale = 0;
    if (movieHeader !== null) {
      const start = movieHeader.start;
      const version = data[start]!;
      if (movieHeader.size < (version === 1 ? 32 : 20)) {
        throw new MalformedDocumentError("Truncated MP4 mvhd box");
      }
      const timescaleOffset = version === 1 ? start + 20 : start + 12;
      const durationOffset = version === 1 ? start + 24 : start + 16;
      const timescale = readU32(view, timescaleOffset);
      movieTimescale = timescale;
      const duration =
        version === 1
          ? Number(view.getBigUint64(durationOffset))
          : readU32(view, durationOffset);
      const created = version === 1 ? Number(view.getBigUint64(start + 4)) : readU32(view, start + 4);
      const modified = version === 1 ? Number(view.getBigUint64(start + 12)) : readU32(view, start + 8);
      setQuickTimeDate(metadata, "dcterms:created", created);
      setQuickTimeDate(metadata, "dcterms:modified", modified);
      if (timescale > 0) metadata.set("xmpDM:duration", formatDuration(duration / timescale));
      // Tika writes the movie time scale under the audio sample rate key, before any track overrides it.
      metadata.set("xmpDM:audioSampleRate", String(timescale));
    }
    for (const track of boxes(data, view, movie.start, movie.start + movie.size)) {
      if (track.type === "trak") parseTrack(data, view, track, movieTimescale, metadata);
    }
    scanQuickTimeMetadata(data, view, movie.start, movie.start + movie.size, metadata);
  }
}

/** Walks the containers that hold QuickTime metadata boxes (`udta`/`meta`, nested in the movie and its tracks). */
function scanQuickTimeMetadata(
  data: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  metadata: Metadata,
): void {
  for (const box of boxes(data, view, start, end)) {
    if (box.type === "udta" || box.type === "meta") {
      processQuickTimeMeta(data, view, box, metadata);
    } else if (box.type === "trak" || box.type === "mdia" || box.type === "minf" || box.type === "stbl") {
      scanQuickTimeMetadata(data, view, box.start, box.start + box.size, metadata);
    }
  }
}

/**
 * A `udta` box holds a `meta` box directly; a `meta` box is a FullBox whose children start after four bytes of
 * version and flags. Both the legacy `mdir` handler (iTunes tags) and the QuickTime `mdta` handler (`keys`/`ilst`)
 * are read, under the keys Tika writes.
 */
function processQuickTimeMeta(data: Uint8Array, view: DataView, box: Box, metadata: Metadata): void {
  let meta = box;
  if (box.type === "udta") {
    // QuickTime stores a location as a `©xyz` atom directly in `udta`: u16 length, u16 language, then ISO 6709.
    for (const child of boxes(data, view, box.start, box.start + box.size)) {
      if (child.type !== "©xyz" || child.size < 4) continue;
      const length = view.getUint16(child.start);
      const end = child.start + child.size;
      if (child.start + 4 + length <= end) {
        addLocation(metadata, new TextDecoder().decode(data.subarray(child.start + 4, child.start + 4 + length)));
      }
    }
    const found = findBox(data, view, box.start, box.start + box.size, "meta");
    if (found === null) return;
    meta = found;
  }
  const start = metaChildrenStart(data, view, meta);
  const end = meta.start + meta.size;
  if (start >= end) return;
  const handler = findBox(data, view, start, end, "hdlr");
  if (handler === null || handler.size < 12) return;
  const subtype = fourCC(data, handler.start + 8);
  const list = findBox(data, view, start, end, "ilst");
  if (list === null) return;
  if (subtype === "mdta") {
    const keys = findBox(data, view, start, end, "keys");
    if (keys !== null) readQuickTimeItemList(data, view, keys, list, metadata);
  } else if (subtype === "mdir") {
    readUserDataItemList(data, view, list, metadata);
  }
}

/** ISO `meta` is a FullBox (four bytes of version and flags first); Apple's QuickTime `meta` is not. */
function metaChildrenStart(data: Uint8Array, view: DataView, meta: Box): number {
  const end = meta.start + meta.size;
  if (meta.start + 8 <= end) {
    const size = readU32(view, meta.start);
    const type = fourCC(data, meta.start + 4);
    if (size >= 8 && meta.start + size <= end && (type === "hdlr" || type === "keys" || type === "ilst")) {
      return meta.start;
    }
  }
  return meta.start + 4;
}

/** The QuickTime `keys` box maps 1-based indices to key names; the `ilst` entries then carry their values. */
function readQuickTimeItemList(
  data: Uint8Array,
  view: DataView,
  keys: Box,
  list: Box,
  metadata: Metadata,
): void {
  const names: string[] = [];
  if (keys.size >= 8) {
    const count = readU32(view, keys.start + 4);
    const end = keys.start + keys.size;
    let offset = keys.start + 8;
    for (let i = 0; i < count && offset + 8 <= end; i++) {
      const size = readU32(view, offset);
      if (size < 8 || offset + size > end) break;
      names.push(new TextDecoder().decode(data.subarray(offset + 8, offset + size)));
      offset += size;
    }
  }
  for (const entry of boxes(data, view, list.start, list.start + list.size)) {
    const index = readU32(view, entry.start - 4);
    if (index < 1 || index > names.length) continue;
    const dataBox = findBox(data, view, entry.start, entry.start + entry.size, "data");
    if (dataBox === null || dataBox.size < 8) continue;
    const valueType = readU32(view, dataBox.start);
    const value = decodeQuickTimeValue(data, view, dataBox.start + 8, dataBox.size - 8, valueType);
    if (value === null) continue;
    const key = names[index - 1]!;
    metadata.add(`mp4:${key}`, value);
    if (key === "com.apple.quicktime.location.ISO6709") addLocation(metadata, value);
  }
}

/** Decodes a QuickTime metadata item value of one of the "well-known" types, or null for anything else. */
function decodeQuickTimeValue(
  data: Uint8Array,
  view: DataView,
  start: number,
  length: number,
  valueType: number,
): string | null {
  switch (valueType) {
    case 1:
      return new TextDecoder().decode(data.subarray(start, start + length));
    case 21:
    case 22:
      if (length < 1 || length > 8) return null;
      return bigEndianInteger(data, start, length, valueType === 21);
    case 23:
      return length === 4 ? javaFloatString(view.getFloat32(start)) : null;
    case 24:
      return length === 8 ? String(view.getFloat64(start)) : null;
    default:
      return null;
  }
}

function bigEndianInteger(data: Uint8Array, start: number, length: number, signed: boolean): string {
  let value = 0n;
  for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(data[start + i]!);
  if (signed && (data[start]! & 0x80) !== 0) value -= 1n << BigInt(8 * length);
  return value.toString();
}

/** The legacy `mdir` item list (iTunes tags), whose entries name their field with an atom type such as `©nam`. */
function readUserDataItemList(data: Uint8Array, view: DataView, list: Box, metadata: Metadata): void {
  for (const entry of boxes(data, view, list.start, list.start + list.size)) {
    const dataBox = findBox(data, view, entry.start, entry.start + entry.size, "data");
    if (dataBox === null || dataBox.size < 8) continue;
    const length = dataBox.size - 8;
    const start = dataBox.start + 8;
    if (length <= 0) continue;
    const fieldName = entry.type;
    if (fieldName === "covr") continue;
    if (fieldName === "trkn" && length >= 8) {
      metadata.set("xmpDM:trackNumber", String(readU32(view, start)));
      const total = readU32(view, start + 4) >>> 16;
      if (total > 0) metadata.set("audio:track-count", String(total));
    } else if (fieldName === "disk" && length >= 6) {
      metadata.set("xmpDM:discNumber", String(readU32(view, start)));
      const total = view.getUint16(start + 4);
      if (total > 0) metadata.set("audio:disc-count", String(total));
    } else if (fieldName === "cpil") {
      metadata.set("xmpDM:compilation", String(data[start]!));
    } else {
      const value = new TextDecoder().decode(data.subarray(start, start + length));
      mapUserDataField(metadata, fieldName, value);
    }
  }
}

function mapUserDataField(metadata: Metadata, field: string, value: string): void {
  switch (field) {
    case "©nam":
      metadata.set("dc:title", value);
      break;
    case "©too":
      metadata.set("xmp:CreatorTool", value);
      break;
    case "©ART":
      metadata.set("xmpDM:artist", value);
      metadata.set("dc:creator", value);
      break;
    case "aART":
      metadata.set("xmpDM:albumArtist", value);
      break;
    case "©wrt":
      metadata.set("xmpDM:composer", value);
      break;
    case "©alb":
      metadata.set("xmpDM:album", value);
      break;
    case "©gen":
      metadata.set("xmpDM:genre", value);
      break;
    case "©day": {
      const releaseDate = keepPartialDate(value);
      if (releaseDate !== null) metadata.set("xmpDM:releaseDate", releaseDate);
      break;
    }
    case "©cmt":
      metadata.set("xmpDM:logComment", value);
      break;
    case "cprt":
      metadata.set("xmpDM:copyright", value);
      break;
    case "keyw":
      metadata.set("dc:subject", value);
      break;
    case "ldes":
    case "desc":
      metadata.set("dc:description", value);
      break;
    case "xid ":
      metadata.set("dc:identifier", value);
      break;
  }
}

/** Tika's `toMetadataStringKeepPartial`: a year or month is kept as written, a full date becomes an instant. */
function keepPartialDate(value: string): string | null {
  const text = value.trim();
  if (/^\d{4}$/.test(text) || /^\d{4}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Maps an ISO 6709 location string to `geo:lat`, `geo:long` and `geo:alt`, as Tika does. */
function addLocation(metadata: Metadata, iso6709: string): void {
  const match = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(iso6709);
  if (match === null) return;
  metadata.set("geo:lat", javaDoubleString(decodeAngle(match[1]!, 2)));
  metadata.set("geo:long", javaDoubleString(decodeAngle(match[2]!, 3)));
  if (match[3] !== undefined) metadata.set("geo:alt", javaDoubleString(Number(match[3])));
}

/** ISO 6709 also allows degrees and minutes (and seconds) packed into the integer part. */
function decodeAngle(token: string, degreeDigits: number): number {
  const sign = token[0] === "-" ? -1 : 1;
  const dot = token.indexOf(".");
  const intPart = dot < 0 ? token.slice(1) : token.slice(1, dot);
  const fraction = dot < 0 ? "" : token.slice(dot);
  const digits = intPart.length;
  let value: number;
  if (digits === degreeDigits + 2) {
    value = Number(intPart.slice(0, degreeDigits)) + Number(`${intPart.slice(degreeDigits)}${fraction}`) / 60;
  } else if (digits === degreeDigits + 4) {
    value = Number(intPart.slice(0, degreeDigits))
      + Number(intPart.slice(degreeDigits, degreeDigits + 2)) / 60
      + Number(`${intPart.slice(degreeDigits + 2)}${fraction}`) / 3600;
  } else {
    value = Number(`${intPart}${fraction}`);
  }
  return sign * value;
}

function parseTrack(
  data: Uint8Array,
  view: DataView,
  track: Box,
  movieTimescale: number,
  metadata: Metadata,
): void {
  const media = findBox(data, view, track.start, track.start + track.size, "mdia");
  if (media === null) return;
  const mediaEnd = media.start + media.size;
  const handler = findBox(data, view, media.start, mediaEnd, "hdlr");
  // hdlr: version and flags, a pre-defined field, then the four-character handler type.
  if (handler === null || handler.size < 12) return;
  const handlerType = fourCC(data, handler.start + 8);
  if (handlerType !== "vide" && handlerType !== "soun" && handlerType !== "meta") return;

  const info = findBox(data, view, media.start, mediaEnd, "minf");
  const table = info === null ? null : findBox(data, view, info.start, info.start + info.size, "stbl");
  const descriptions = table === null ? null : findBox(data, view, table.start, table.start + table.size, "stsd");
  const entry = descriptions === null ? null : firstSampleEntry(data, view, descriptions);
  if (handlerType === "vide") {
    parseVideoTrack(data, view, entry, table, mediaHeader(data, view, media.start, mediaEnd), metadata);
  } else if (handlerType === "soun") {
    parseSoundTrack(data, view, entry, mediaHeader(data, view, media.start, mediaEnd), metadata);
  } else {
    parseMetaTrack(data, view, track, entry, table, movieTimescale, metadata);
  }
}

/**
 * A timed metadata track (`hdlr` 'meta'): for a Live Photo's still-image-time track, the presentation time of its
 * single sample is the leading empty edit, in movie timescale units, emitted as microseconds.
 */
function parseMetaTrack(
  data: Uint8Array,
  view: DataView,
  track: Box,
  entry: Box | null,
  table: Box | null,
  movieTimescale: number,
  metadata: Metadata,
): void {
  if (entry === null || entry.type !== "mebx" || !mebxHasStillImageKey(data, view, entry)) return;
  const stts = table === null ? null : findBox(data, view, table.start, table.start + table.size, "stts");
  if (stts === null) return;
  let samples = 0;
  const count = readU32(view, stts.start + 4);
  for (let i = 0, offset = stts.start + 8; i < count && offset + 8 <= stts.start + stts.size; i++, offset += 8) {
    samples += readU32(view, offset);
  }
  if (samples !== 1) return;
  const emptyEdit = leadingEmptyEdit(data, view, track);
  if (emptyEdit <= 0) {
    metadata.set("quicktime:still-image-time", "0");
  } else if (movieTimescale > 0 && emptyEdit <= Number.MAX_SAFE_INTEGER / 1_000_000) {
    metadata.set("quicktime:still-image-time", String(Math.floor((emptyEdit * 1_000_000) / movieTimescale)));
  }
}

/** Whether a `mebx` sample entry declares the QuickTime still-image-time key in its `keys`/`keyd` boxes. */
function mebxHasStillImageKey(data: Uint8Array, view: DataView, entry: Box): boolean {
  const end = entry.start + entry.size;
  for (const keys of boxes(data, view, entry.start + SAMPLE_ENTRY_FIELDS, end)) {
    if (keys.type !== "keys") continue;
    for (const key of boxes(data, view, keys.start, keys.start + keys.size)) {
      for (const declaration of boxes(data, view, key.start, key.start + key.size)) {
        if (declaration.type !== "keyd" || declaration.size <= 4) continue;
        const name = new TextDecoder().decode(data.subarray(declaration.start + 4, declaration.start + declaration.size));
        if (name === "com.apple.quicktime.still-image-time") return true;
      }
    }
  }
  return false;
}

/** The total duration of a track's leading empty edits (media time -1) from its `edts`/`elst`, or -1. */
function leadingEmptyEdit(data: Uint8Array, view: DataView, track: Box): number {
  const edts = findBox(data, view, track.start, track.start + track.size, "edts");
  if (edts === null) return -1;
  const elst = findBox(data, view, edts.start, edts.start + edts.size, "elst");
  if (elst === null || elst.size < 8) return -1;
  const version = data[elst.start]!;
  const count = readU32(view, elst.start + 4);
  const entrySize = version === 1 ? 20 : 12;
  const end = elst.start + elst.size;
  let leading = 0;
  for (let i = 0, offset = elst.start + 8; i < count && offset + entrySize <= end; i++, offset += entrySize) {
    const segmentDuration = version === 1 ? Number(view.getBigUint64(offset)) : readU32(view, offset);
    const mediaTime = version === 1 ? Number(view.getBigInt64(offset + 8)) : view.getInt32(offset + 4);
    if (mediaTime !== -1) break;
    leading += segmentDuration;
  }
  return leading > 0 ? leading : -1;
}

function parseVideoTrack(
  data: Uint8Array,
  view: DataView,
  entry: Box | null,
  table: Box | null,
  header: MediaHeader | null,
  metadata: Metadata,
): void {
  if (entry !== null) {
    let codec = printableType(entry.type);
    if (PROTECTED_FORMATS.has(entry.type)) {
      const original = originalFormat(data, view, entry.start + VISUAL_ENTRY_SIZE, entry.start + entry.size);
      if (original !== null) codec = original;
    }
    if (codec !== null) metadata.set("video:fourcc", codec);
    if (entry.size >= 28) {
      metadata.set("tiff:ImageWidth", String(view.getUint16(entry.start + 24)));
      metadata.set("tiff:ImageLength", String(view.getUint16(entry.start + 26)));
    }
    const compressor = compressorName(data, entry);
    if (compressor !== "") metadata.set("xmpDM:videoCompressor", compressor);
    const bitrate = btrtAverageBitRate(data, view, entry.start + VISUAL_ENTRY_SIZE, entry.start + entry.size);
    if (bitrate > 0) metadata.set("video:bitrate", String(bitrate));
  }
  const stts = table === null ? null : findBox(data, view, table.start, table.start + table.size, "stts");
  if (stts !== null && header !== null) {
    const count = timeToSampleCount(data, view, stts);
    metadata.set("video:frame-rate", javaFloatString(frameRate(header.timescale, header.duration, count)));
  }
}

function parseSoundTrack(
  data: Uint8Array,
  view: DataView,
  entry: Box | null,
  header: MediaHeader | null,
  metadata: Metadata,
): void {
  if (entry !== null) {
    // The version field follows the SampleEntry fields and decides where the entry's child boxes start.
    const version = entry.size >= SAMPLE_ENTRY_FIELDS + 2 ? view.getUint16(entry.start + SAMPLE_ENTRY_FIELDS) : null;
    const children = entry.start + soundEntrySize(version);
    let codec = printableType(entry.type);
    if (PROTECTED_FORMATS.has(entry.type)) {
      metadata.set("audio:has-drm", "true");
      if (version !== null) {
        const original = originalFormat(data, view, children, entry.start + entry.size);
        if (original !== null) codec = original;
      }
    }
    if (codec !== null) metadata.set("audio:fourcc", codec);
    if (entry.size >= 20) {
      const channels = view.getUint16(entry.start + 16);
      metadata.set("audio:channels", String(channels));
      metadata.set("audio:bits-per-sample", String(view.getInt16(entry.start + 18)));
      if (channels === 1) metadata.set("xmpDM:audioChannelType", "Mono");
      else if (channels === 2) metadata.set("xmpDM:audioChannelType", "Stereo");
    }
    if (version !== null) {
      const bitrate = esdsAverageBitRate(data, view, children, entry.start + entry.size, 0);
      if (bitrate > 0) metadata.set("audio:bitrate", String(bitrate));
    }
  }
  // The sound handler writes the track's media time scale under the audio sample rate key, overriding the movie one.
  if (header !== null) metadata.set("xmpDM:audioSampleRate", String(header.timescale));
}

/**
 * Tika writes a date as Java's `Instant.toString`: `yyyy-MM-dd'T'HH:mm:ss'Z'`, with a sign and at least four digits
 * once the year falls outside 0000 to 9999.
 */
function setQuickTimeDate(metadata: Metadata, key: string, quickTimeSeconds: number): void {
  const date = new Date((quickTimeSeconds - QUICKTIME_EPOCH_OFFSET_SECONDS) * 1000);
  if (Number.isNaN(date.getTime())) return;
  const year = date.getUTCFullYear();
  const pad = (value: number) => String(value).padStart(2, "0");
  const yearText = year < 0 || year > 9999
    ? `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(4, "0")}`
    : String(year).padStart(4, "0");
  metadata.set(
    key,
    `${yearText}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`,
  );
}

/** Java's DecimalFormat("0.0#") on a Locale.ROOT number: two places at most, one at least, rounding half to even. */
export function formatDuration(seconds: number): string {
  // toFixed rounds from the exact binary value, as Java does, except that it rounds an exact tie up. A tie is an
  // odd multiple of 1/8 (x.125, x.375, ...), the only exact values that end in a 5 in the third place.
  let text = seconds.toFixed(2);
  const eighths = seconds * 8;
  if (Number.isInteger(eighths) && eighths % 2 === 1) {
    const down = Math.floor(seconds * 100);
    text = ((down % 2 === 0 ? down : down + 1) / 100).toFixed(2);
  }
  return text.replace(/0$/, "");
}

/** The sample entry's width and height are at fixed offsets in a VisualSampleEntry. */
function firstSampleEntry(data: Uint8Array, view: DataView, descriptions: Box): Box | null {
  for (const entry of boxes(data, view, descriptions.start + 8, descriptions.start + descriptions.size)) return entry;
  return null;
}

/** The 32-byte compressor name field, trimmed the way Java's String.trim trims it (every char at or below space). */
function compressorName(data: Uint8Array, entry: Box): string {
  if (entry.size < 42 + 32) return "";
  const text = new TextDecoder().decode(data.subarray(entry.start + 42, entry.start + 74));
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

interface MediaHeader {
  readonly timescale: number;
  readonly duration: number;
}

/** The track's media time scale and duration from its `mdhd` box. */
function mediaHeader(data: Uint8Array, view: DataView, start: number, end: number): MediaHeader | null {
  const box = findBox(data, view, start, end, "mdhd");
  if (box === null) return null;
  const version = data[box.start]!;
  if (version === 1) {
    if (box.size < 32) return null;
    return {
      timescale: readU32(view, box.start + 20),
      duration: Number(view.getBigUint64(box.start + 24)),
    };
  }
  if (box.size < 20) return null;
  return { timescale: readU32(view, box.start + 12), duration: readU32(view, box.start + 16) };
}

/** Sum of the sample counts in a `stts` box, accumulated as Java's float does. */
function timeToSampleCount(data: Uint8Array, view: DataView, box: Box): number {
  const end = box.start + box.size;
  if (box.size < 8) return 0;
  const entryCount = readU32(view, box.start + 4);
  let count = 0;
  let offset = box.start + 8;
  for (let i = 0; i < entryCount && offset + 8 <= end; i++) {
    count = Math.fround(count + readU32(view, offset));
    offset += 8;
  }
  return count;
}

/** metadata-extractor's frame rate: the time scale divided by the seconds each sample spans, in single precision. */
function frameRate(timescale: number, duration: number, sampleCount: number): number {
  const secondsPerSample = Math.fround(Math.fround(duration) / sampleCount);
  return Math.fround(Math.fround(timescale) / secondsPerSample);
}

/** Size of a sound sample entry up to where its child boxes start; -1 when the version was not read. */
function soundEntrySize(version: number | null): number {
  if (version === 1) return 44;
  if (version === 2) return 64;
  return 28;
}

/** The original codec of a protected sample entry from its child `sinf`/`frma` box, or null. */
function originalFormat(data: Uint8Array, view: DataView, start: number, end: number): string | null {
  const sinf = findBox(data, view, start, end, "sinf");
  if (sinf === null) return null;
  const frma = findBox(data, view, sinf.start, sinf.start + sinf.size, "frma");
  if (frma === null || frma.size < 4) return null;
  return printableType(fourCC(data, frma.start));
}

/** The average bitrate from a video sample entry's `btrt` box, or 0. */
function btrtAverageBitRate(data: Uint8Array, view: DataView, start: number, end: number): number {
  for (const box of boxes(data, view, start, end)) {
    if (box.type !== "btrt") continue;
    if (box.size < 12) return 0;
    const average = readU32(view, box.start + 8);
    return average > 0 && average <= 0x7fff_ffff ? average : 0;
  }
  return 0;
}

/** The average bitrate from an audio sample entry's `esds` box, following `wave` extensions, or 0. */
function esdsAverageBitRate(
  data: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  depth: number,
): number {
  if (depth > MAX_BOX_DEPTH) return 0;
  for (const box of boxes(data, view, start, end)) {
    if (box.type === "esds") return readEsdsAverageBitRate(data, view, box.start, box.start + box.size);
    if (box.type === "wave") {
      const nested = esdsAverageBitRate(data, view, box.start, box.start + box.size, depth + 1);
      if (nested > 0) return nested;
    }
  }
  return 0;
}

/**
 * The average bitrate from an `esds` box body: an ES_Descriptor (tag 0x03) with three optional fields signalled by its
 * flags byte, followed by a DecoderConfigDescriptor (tag 0x04) whose fixed fields end with the two bitrates.
 */
function readEsdsAverageBitRate(data: Uint8Array, view: DataView, start: number, end: number): number {
  let pos = start + 4;
  if (pos >= end || data[pos] !== 0x03) return 0;
  pos = skipDescriptorLength(data, pos + 1, end);
  if (pos + 3 > end) return 0;
  const flags = data[pos + 2]!;
  pos += 3;
  if ((flags & 0x80) !== 0) pos += 2;
  if ((flags & 0x40) !== 0) {
    if (pos >= end) return 0;
    pos += 1 + data[pos]!;
  }
  if ((flags & 0x20) !== 0) pos += 2;
  if (pos >= end || data[pos] !== 0x04) return 0;
  pos = skipDescriptorLength(data, pos + 1, end);
  // object type (1), stream type (1), buffer size (3), max bitrate (4)
  pos += 9;
  if (pos + 4 > end) return 0;
  const average = readU32(view, pos);
  return average > 0 && average <= 0x7fff_ffff ? average : 0;
}

/** Skips a descriptor's variable length encoding and returns the position of the payload. */
function skipDescriptorLength(data: Uint8Array, pos: number, end: number): number {
  while (pos < end && (data[pos]! & 0x80) !== 0) pos++;
  return pos + 1;
}

/** A FourCC for a metadata value: null unless it is printable ASCII, with trailing spaces trimmed. */
function printableType(type: string): string | null {
  let end = type.length;
  while (end > 0 && type.charCodeAt(end - 1) === 0x20) end--;
  if (end === 0) return null;
  for (let i = 0; i < end; i++) {
    const code = type.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return null;
  }
  return type.slice(0, end);
}

function fourCC(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
}

interface Box {
  readonly start: number;
  readonly size: number;
  readonly type: string;
}

function findBox(
  data: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  type: string,
): Box | null {
  for (const box of boxes(data, view, start, end)) if (box.type === type) return box;
  return null;
}

/** The boxes laid end to end between `start` and `end`; it stops at the first box that does not fit. */
function* boxes(data: Uint8Array, view: DataView, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readU32(view, offset);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size < header || offset + size > end) return;
    yield { start: offset + header, size: size - header, type: fourCC(data, offset + 4) };
    offset += size;
  }
}

function readU32(view: DataView, offset: number): number {
  return offset + 4 <= view.byteLength ? view.getUint32(offset) : 0;
}
