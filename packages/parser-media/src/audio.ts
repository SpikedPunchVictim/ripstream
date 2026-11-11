import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { parseBuffer } from "music-metadata";
import { AU_HEADER_BYTES, applyAuHeader } from "./au.ts";

/**
 * The whole input is buffered for music-metadata, so this is what the parse can hold, and the same 64 MiB as
 * music-metadata's own ceiling on one allocation. It bounds memory, not the CPU cost of hostile data: music-metadata's
 * MPEG sync scan on 0xFF bytes costs about 3 s of CPU and 70 bytes of heap per byte, which no option of it bounds (tried:
 * duration false, skipPostHeaders), so a smaller limit is the way to a tighter bound. A real file is far smaller: a ten
 * minute MP3 at 320 kbit/s is 24 MB, three minutes of CD audio as WAV 30 MB.
 */
export const DEFAULT_MAX_AUDIO_BYTES = 64 * 1024 * 1024;

export interface AudioParserOptions {
  /** Largest input read for music-metadata (default {@link DEFAULT_MAX_AUDIO_BYTES}); a larger one is a LimitExceededError. */
  readonly maxBytes?: number;
}

/** Audio metadata for MP3/FLAC/WAV/AIFF/M4A/WMA via music-metadata, and AU by its header. Ogg has its own parsers. */
export class AudioParser implements Parser {
  readonly name = "AudioParser";
  readonly capabilities = { metadataOnly: true, unsafe: true } as const;
  readonly #maxBytes: number;

  constructor(options: AudioParserOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes must be a positive integer, got ${maxBytes}`);
    this.#maxBytes = maxBytes;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "audio/mpeg",
        // FLAC is the FlacParser's, as in Tika: it reads the comments and the pictures that music-metadata only sums up.
        // Tika's AudioParser reads .au files through javax.sound, which music-metadata cannot read: see parse().
        "audio/basic",
        "audio/wav",
        "audio/vnd.wave",
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
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    if (isBasicAudio(metadata.get("Content-Type"))) {
      // Only the header is read: the format is all the file gives. Tika's AudioParser then writes an empty document, so
      // that the metadata is in its head, whether the file was understood or only got the warning.
      applyAuHeader(await stream.peek(AU_HEADER_BYTES), metadata);
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      await xhtml.endDocument();
      return;
    }
    // Stops one chunk past the limit with a LimitExceededError, before music-metadata sees any of it.
    const data = await stream.readFully(this.#maxBytes);
    const total = data.byteLength;
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
    // AudioParser.java:146-148 writes the empty document for every type, so that the metadata is in its head.
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.endDocument();
  }
}

function isBasicAudio(contentType: string | null): boolean {
  return contentType !== null && contentType.split(";")[0]!.trim().toLowerCase() === "audio/basic";
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
