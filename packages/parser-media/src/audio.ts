import {
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { parseBuffer } from "music-metadata";

/** Audio metadata for MP3/FLAC/OGG/WAV/AIFF/M4A/WMA via music-metadata. */
export class AudioParser implements Parser {
  readonly name = "AudioParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "audio/mpeg",
        "audio/flac",
        "audio/ogg",
        "audio/wav",
        "audio/x-wav",
        "audio/aiff",
        "audio/x-aiff",
        "audio/mp4",
        "audio/x-m4a",
        "audio/x-ms-wma",
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
    const contentType = metadata.get("Content-Type");
    const parsed = await parseBuffer(
      data,
      contentType === null ? { size: total } : { mimeType: contentType, size: total },
      { duration: true },
    );
    const common = parsed.common;
    assign(metadata, "dc:title", common.title);
    assign(metadata, "xmpDM:artist", common.artist);
    assign(metadata, "xmpDM:album", common.album);
    assign(metadata, "xmpDM:albumArtist", common.albumartist);
    assign(metadata, "xmpDM:genre", common.genre?.join(", "));
    assign(metadata, "xmpDM:trackNumber", common.track?.no ?? undefined);
    if (common.year !== undefined) metadata.set("dcterms:created", String(common.year));
    if (parsed.format.duration !== undefined) {
      metadata.set("xmpDM:duration", String(parsed.format.duration));
      metadata.set("audio:spi-duration", String(parsed.format.duration));
    }
    if (parsed.format.bitrate !== undefined) {
      metadata.set("audio:bitrate", String(Math.round(parsed.format.bitrate)));
    }
    if (parsed.format.codec !== undefined) {
      metadata.set("audio:codec", parsed.format.codec);
    }
  }
}

function assign(
  metadata: Metadata,
  key: string,
  value: string | number | undefined,
): void {
  if (value !== undefined && String(value).length > 0) {
    metadata.set(key, String(value));
  }
}
