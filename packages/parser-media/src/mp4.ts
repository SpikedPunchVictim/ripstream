import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** MP4/MOV/3GP metadata from ISO base media file format boxes. */
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
      if (timescale > 0) {
        metadata.set("audio:spi-duration", String(duration / timescale));
      }
    }
  }
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
  let offset = start;
  while (offset + 8 <= end) {
    let size = readU32(view, offset);
    const boxType = String.fromCharCode(
      data[offset + 4]!,
      data[offset + 5]!,
      data[offset + 6]!,
      data[offset + 7]!,
    );
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size < header || offset + size > end) break;
    if (boxType === type) return { start: offset + header, size: size - header, type: boxType };
    offset += size;
  }
  return null;
}

function readU32(view: DataView, offset: number): number {
  return offset + 4 <= view.byteLength ? view.getUint32(offset) : 0;
}
