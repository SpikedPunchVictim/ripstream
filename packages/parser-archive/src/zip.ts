import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { unzipSync } from "fflate";
import { parseEntry, readAll, safeEntryName, withXhtml } from "./util.ts";

/**
 * An entry at or below this many bytes is never refused for its decompression ratio. It is Tika's
 * OutputLimits.zipBombThreshold (1,000,000): SecureContentHandler checks its ratio only once the output passes it,
 * so a document that starts with a highly compressible run (a blank bitmap) is not taken for a bomb. The per-entry
 * and total byte limits still bound what an entry may expand to.
 */
const RATIO_CHECK_THRESHOLD_BYTES = 1_000_000;

/** Port of Ripstream's PackageParser ZIP path. */
export class ZipParser implements Parser {
  readonly name = "ZipParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.APPLICATION_ZIP,
      MediaType.parse("application/java-archive")!,
      MediaType.parse("application/vnd.android.package-archive")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    let entries = 0;
    let originalTotal = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(data, {
        filter: (file) => {
          entries++;
          if (entries > ctx.limits.maxZipEntries) {
            throw new LimitExceededError(
              `ZIP entry count exceeds ${ctx.limits.maxZipEntries}`,
            );
          }
          originalTotal += file.originalSize;
          if (originalTotal > ctx.limits.maxTotalEmbeddedBytes) {
            throw new LimitExceededError(
              "ZIP archive exceeds the embedded byte limit",
            );
          }
          if (file.originalSize > ctx.limits.maxEmbeddedResourceBytes) {
            throw new LimitExceededError(
              `ZIP entry ${file.name} exceeds the per-entry limit`,
            );
          }
          if (
            file.originalSize > RATIO_CHECK_THRESHOLD_BYTES &&
            file.size > 0 &&
            file.originalSize / file.size > ctx.limits.maxDecompressionRatio
          ) {
            throw new LimitExceededError(
              `ZIP entry ${file.name} exceeds the decompression ratio limit`,
            );
          }
          return true;
        },
      });
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError("Invalid ZIP archive", { cause: error });
    }

    const names = Object.keys(files);
    if (names.length > ctx.limits.maxZipEntries) {
      throw new LimitExceededError(
        `ZIP entry count ${names.length} exceeds ${ctx.limits.maxZipEntries}`,
      );
    }

    let total = 0;
    await withXhtml(handler, metadata, async (xhtml) => {
      for (const name of names) {
        if (name.endsWith("/")) continue;
        if (safeEntryName(name) === null) {
          metadata.add(
            "tk:exception:embedded-stream-exception",
            `unsafe archive path skipped: ${name}`,
          );
          continue;
        }
        const bytes = files[name]!;
        total += bytes.byteLength;
        if (bytes.byteLength > ctx.limits.maxEmbeddedResourceBytes) {
          throw new LimitExceededError(`Entry ${name} exceeds the per-entry limit`);
        }
        if (total > ctx.limits.maxTotalEmbeddedBytes) {
          throw new LimitExceededError("Archive exceeds the embedded byte limit");
        }

        await xhtml.startElement("div", "class", "package-entry");
        await xhtml.element("h1", name);
        await parseEntry(xhtml, name, bytes, metadata, ctx);
        await xhtml.endElement("div");
      }
    });
  }
}
