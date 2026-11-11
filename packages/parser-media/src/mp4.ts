import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** Seconds from the QuickTime epoch (1904-01-01) to the Unix epoch. */
const QUICKTIME_EPOCH_OFFSET_SECONDS = 2_082_844_800;

/**
 * MP4/MOV/3GP metadata from ISO base media file format boxes. It writes the movie header's duration (`xmpDM:duration`),
 * creation and modification time (`dcterms:created`, `dcterms:modified`) and the size of the video track
 * (`tiff:ImageWidth`, `tiff:ImageLength`), under the keys Tika's MP4Parser writes. It reads no other box.
 */
export class Mp4Parser implements Parser {
  readonly name = "MP4Parser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "video/mp4",
        "audio/mp4",
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
    if (movieHeader !== null) {
      const start = movieHeader.start;
      const version = data[start]!;
      if (movieHeader.size < (version === 1 ? 32 : 20)) {
        throw new MalformedDocumentError("Truncated MP4 mvhd box");
      }
      const timescaleOffset = version === 1 ? start + 20 : start + 12;
      const durationOffset = version === 1 ? start + 24 : start + 16;
      const timescale = readU32(view, timescaleOffset);
      const duration =
        version === 1
          ? Number(view.getBigUint64(durationOffset))
          : readU32(view, durationOffset);
      const created = version === 1 ? Number(view.getBigUint64(start + 4)) : readU32(view, start + 4);
      const modified = version === 1 ? Number(view.getBigUint64(start + 12)) : readU32(view, start + 8);
      setQuickTimeDate(metadata, "dcterms:created", created);
      setQuickTimeDate(metadata, "dcterms:modified", modified);
      if (timescale > 0) metadata.set("xmpDM:duration", formatDuration(duration / timescale));
    }
    // Tika sets the size once per video track, so the last video track wins.
    for (const track of boxes(data, view, movie.start, movie.start + movie.size)) {
      if (track.type !== "trak") continue;
      const size = videoTrackSize(data, view, track);
      if (size === null) continue;
      metadata.set("tiff:ImageWidth", String(size.width));
      metadata.set("tiff:ImageLength", String(size.height));
    }
  }
}

/** Tika writes a date as `yyyy-MM-dd'T'HH:mm:ss'Z'`. A time outside the years 1904 to 9999 is left out. */
function setQuickTimeDate(metadata: Metadata, key: string, quickTimeSeconds: number): void {
  const date = new Date((quickTimeSeconds - QUICKTIME_EPOCH_OFFSET_SECONDS) * 1000);
  const year = date.getUTCFullYear();
  if (year >= 1904 && year <= 9999) metadata.set(key, `${date.toISOString().slice(0, 19)}Z`);
}

/** Java's DecimalFormat("0.0#") on a Locale.ROOT number: two places at most, one at least, rounding half to even. */
function formatDuration(seconds: number): string {
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

/** The width and height in the first sample entry of a video track (`hdlr` 'vide'), or null for any other track. */
function videoTrackSize(
  data: Uint8Array,
  view: DataView,
  track: Box,
): { readonly width: number; readonly height: number } | null {
  const trackEnd = track.start + track.size;
  const media = findBox(data, view, track.start, trackEnd, "mdia");
  if (media === null) return null;
  const mediaEnd = media.start + media.size;
  const handler = findBox(data, view, media.start, mediaEnd, "hdlr");
  // hdlr: version and flags, a pre-defined field, then the four-character handler type.
  if (handler === null || handler.size < 12 || fourCC(data, handler.start + 8) !== "vide") return null;
  const info = findBox(data, view, media.start, mediaEnd, "minf");
  const table = info === null ? null : findBox(data, view, info.start, info.start + info.size, "stbl");
  const descriptions = table === null ? null : findBox(data, view, table.start, table.start + table.size, "stsd");
  if (descriptions === null) return null;
  // stsd: version and flags, an entry count, then the entries; only the first is read.
  for (const entry of boxes(data, view, descriptions.start + 8, descriptions.start + descriptions.size)) {
    // A VisualSampleEntry: 8 bytes of SampleEntry and 16 of pre-defined and reserved fields, then width and height.
    if (entry.size < 28) return null;
    return { width: view.getUint16(entry.start + 24), height: view.getUint16(entry.start + 26) };
  }
  return null;
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
