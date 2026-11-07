import {
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  XHTMLContentHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";

/**
 * Returns a normalized relative path, or null when the name would escape the
 * archive root (absolute, drive-qualified, or traversing above the root).
 */
export function safeEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** Enforces decompression size and ratio limits for one archive member. */
export function checkDecompression(
  ctx: ParseContext,
  compressedBytes: number,
  decompressedBytes: number,
  what: string,
): void {
  if (decompressedBytes > ctx.limits.maxEmbeddedResourceBytes) {
    throw new LimitExceededError(
      `${what} exceeds the per-entry byte limit`,
    );
  }
  if (decompressedBytes > ctx.limits.maxTotalEmbeddedBytes) {
    throw new LimitExceededError(
      `${what} exceeds the embedded byte limit`,
    );
  }
  if (
    compressedBytes > 0 &&
    decompressedBytes / compressedBytes > ctx.limits.maxDecompressionRatio
  ) {
    throw new LimitExceededError(
      `${what} exceeds the decompression ratio limit`,
    );
  }
}

export async function readAll(
  stream: AsyncIterable<Uint8Array>,
  limit = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit) throw new LimitExceededError(`Input exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function parseEntry(
  handler: ContentHandler,
  name: string,
  bytes: Uint8Array,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const childMetadata = new Metadata();
  childMetadata.set("resourceName", name);
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    const extractor =
      (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as
        | EmbeddedDocumentExtractor
        | undefined) ?? new ParsingEmbeddedDocumentExtractor();
    await extractor.parseEmbedded(stream, handler, childMetadata, ctx);
  } catch (error) {
    if (error instanceof LimitExceededError) throw error;
    childMetadata.set(
      `X-TIKA:EXCEPTION:${error instanceof Error ? error.constructor.name : "Error"}`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await stream.close();
  }
}

export async function withXhtml(
  handler: ContentHandler,
  metadata: Metadata,
  action: (xhtml: XHTMLContentHandler) => Promise<void>,
): Promise<void> {
  const xhtml = new XHTMLContentHandler(handler, metadata);
  await xhtml.startDocument();
  await action(xhtml);
  await xhtml.endDocument();
}

export type { Parser };
export { MalformedDocumentError, MediaType };
