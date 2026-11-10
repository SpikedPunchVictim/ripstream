import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  inflateBounded,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { inflateLimits } from "./compressor.ts";
import { checkDecompression, parseEntry, readAll, withXhtml } from "./util.ts";

/** Port of Ripstream's CompressorParser GZIP path. */
export class GzipParser implements Parser {
  readonly name = "GzipParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.parse("application/gzip")!,
      MediaType.parse("application/x-gzip")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    let decompressed: Uint8Array;
    try {
      decompressed = inflateBounded(data, "gzip", inflateLimits(ctx));
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError("Invalid GZIP stream", { cause: error });
    }

    checkDecompression(ctx, data.byteLength, decompressed.byteLength, "GZIP");

    const name = (metadata.get("tk:resource-name") ?? "embedded")
      .replace(/\.(gz|gzip)$/i, "");

    await withXhtml(handler, metadata, async (xhtml) => {
      await parseEntry(xhtml, name || "embedded", decompressed, metadata, ctx);
    });
  }
}
