import type { ContentHandler } from "./content-handler.ts";
import { LimitExceededError, limitError, type LimitExceededOptions } from "./errors.ts";
import { Metadata } from "./metadata.ts";
import { TIKA_KEYS } from "./tika-keys.ts";
import { CONTEXT_KEYS, type ParseContext } from "./parse-context.ts";
import type { Parser } from "./parser.ts";
import { RipstreamInputStream } from "./ripstream-input-stream.ts";
import { BodyContentHandler } from "./handlers/text.ts";

export interface EmbeddedDocumentExtractor {
  shouldParseEmbedded(metadata: Metadata): boolean;
  parseEmbedded(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void>;
}

/**
 * Limits of the whole parse (the count of embedded resources, their total bytes, the output): the parse is out of
 * room, whichever document it was in. A limit of one document (its size, its depth, its metadata) is not on this list.
 */
const WHOLE_PARSE_LIMITS = new WeakSet<Error>();

/** A LimitExceededError for a limit of the whole parse, which no document's failure record may absorb. */
export function wholeParseLimit(message: string, options: LimitExceededOptions = {}): LimitExceededError {
  const error = new LimitExceededError(message, options);
  WHOLE_PARSE_LIMITS.add(error);
  return error;
}

export function isWholeParseLimit(error: unknown): boolean {
  return error instanceof Error && WHOLE_PARSE_LIMITS.has(error);
}

/**
 * `maxEmbeddedResources` crossed: the parse is out of room for embedded documents. A whole-parse limit like any other
 * (nothing absorbs it on the way up); the root catches it only under `onEmbeddedLimit: "truncate"` (see
 * `isEmbeddedCountLimit`), and the numbers are what it notes on the container.
 */
export class EmbeddedCountLimitError extends LimitExceededError {
  declare readonly max: number;
  readonly seen: number;

  constructor(seen: number, max: number) {
    super(`Embedded count ${seen} exceeds ${max}`, { limit: "embeddedResources", observed: seen, max });
    // The same name an isolated parse gives it (the error codec rebuilds it by code as a LimitExceededError).
    this.name = "LimitExceededError";
    this.seen = seen;
    WHOLE_PARSE_LIMITS.add(this);
  }
}

export function isEmbeddedCountLimit(error: unknown): error is EmbeddedCountLimitError {
  return error instanceof EmbeddedCountLimitError;
}

/** Whether this parse keeps what it read when an archive has too many entries (`ParseOptions.onEmbeddedLimit: "truncate"`). */
export function truncatesEmbeddedLimit(ctx: ParseContext): boolean {
  return ctx.get(CONTEXT_KEYS.TRUNCATE_EMBEDDED_LIMIT) === true;
}

/**
 * Notes on `metadata` that a limit on embedded documents or archive entries cut a document short: Tika's
 * `tk:exception:embedded-resource-limit-reached`, which of ripstream's limits it was, its value, how many the parse had
 * come across and how many it read. `set`, so a document that met both limits carries the numbers of the later.
 */
export function noteEmbeddedLimit(
  metadata: Metadata,
  note: { readonly limit: "maxEmbeddedResources" | "maxZipEntries"; readonly max: number; readonly seen: number; readonly read: number },
): void {
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_REACHED, "true");
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT, note.limit);
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_MAX, String(note.max));
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_SEEN, String(note.seen));
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_READ, String(note.read));
}

function budgetFor(ctx: ParseContext): { count: number; bytes: number } {
  let budget = ctx.get(CONTEXT_KEYS.EMBEDDED_BUDGET);
  if (budget === undefined) {
    budget = { count: 0, bytes: 0 };
    ctx.set(CONTEXT_KEYS.EMBEDDED_BUDGET, budget);
  }
  return budget;
}

/**
 * Counts one embedded resource against the budget shared by the whole parse
 * tree (child contexts inherit the same budget object) and enforces depth.
 */
export function chargeEmbeddedResource(ctx: ParseContext): number {
  const budget = budgetFor(ctx);
  budget.count += 1;
  if (budget.count > ctx.limits.maxEmbeddedResources) {
    throw new EmbeddedCountLimitError(budget.count, ctx.limits.maxEmbeddedResources);
  }
  const depth = (ctx.get(CONTEXT_KEYS.EMBEDDED_DEPTH) ?? 0) + 1;
  if (depth > ctx.limits.maxNodeDepth) {
    throw limitError(`Embedded depth ${depth} exceeds ${ctx.limits.maxNodeDepth}`, "nodeDepth", depth, ctx.limits.maxNodeDepth);
  }
  return depth;
}

/** Adds embedded bytes to the shared total and enforces both byte limits. */
export function chargeEmbeddedBytes(ctx: ParseContext, bytes: number): void {
  if (bytes > ctx.limits.maxEmbeddedResourceBytes) {
    throw limitError(`Embedded resource of ${bytes} bytes exceeds ${ctx.limits.maxEmbeddedResourceBytes}`, "entryBytes", bytes, ctx.limits.maxEmbeddedResourceBytes);
  }
  const budget = budgetFor(ctx);
  budget.bytes += bytes;
  if (budget.bytes > ctx.limits.maxTotalEmbeddedBytes) {
    throw wholeParseLimit(`Embedded bytes ${budget.bytes} exceed ${ctx.limits.maxTotalEmbeddedBytes}`, {
      limit: "totalBytes",
      observed: budget.bytes,
      max: ctx.limits.maxTotalEmbeddedBytes,
    });
  }
}

/**
 * Wraps a stream of unknown length so bytes are charged to the shared budget
 * as they are read, aborting the parse as soon as a byte limit is crossed
 * instead of after the child has been fully consumed.
 */
export async function meterEmbeddedStream(
  stream: RipstreamInputStream,
  ctx: ParseContext,
): Promise<RipstreamInputStream> {
  const budget = budgetFor(ctx);
  const { maxEmbeddedResourceBytes, maxTotalEmbeddedBytes } = ctx.limits;
  async function* metered(): AsyncGenerator<Uint8Array> {
    let own = 0;
    for await (const chunk of stream) {
      own += chunk.byteLength;
      budget.bytes += chunk.byteLength;
      if (own > maxEmbeddedResourceBytes) {
        throw limitError(`Embedded resource of at least ${own} bytes exceeds ${maxEmbeddedResourceBytes}`, "entryBytes", own, maxEmbeddedResourceBytes);
      }
      if (budget.bytes > maxTotalEmbeddedBytes) {
        throw wholeParseLimit(`Embedded bytes ${budget.bytes} exceed ${maxTotalEmbeddedBytes}`, {
          limit: "totalBytes",
          observed: budget.bytes,
          max: maxTotalEmbeddedBytes,
        });
      }
      yield chunk;
    }
  }
  return RipstreamInputStream.from(metered(), { signal: ctx.signal });
}

/**
 * Default embedded strategy: detect and parse the child, capture its text, and
 * write that text into the enclosing handler. Binary media falls through to
 * the parser's metadata-only behavior.
 */
export class ParsingEmbeddedDocumentExtractor
  implements EmbeddedDocumentExtractor
{
  shouldParseEmbedded(_metadata: Metadata): boolean {
    return true;
  }

  async parseEmbedded(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const parser = ctx.get(CONTEXT_KEYS.PARSER) as Parser | undefined;
    if (parser === undefined) {
      throw new LimitExceededError("No parser available for embedded document");
    }

    const depth = chargeEmbeddedResource(ctx);
    if (stream.length !== null) chargeEmbeddedBytes(ctx, stream.length);
    const source = stream.length !== null ? stream : await meterEmbeddedStream(stream, ctx);

    const parent =
      metadata.get("tk:embedded-resource-path") ??
      ctx.get(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH) ??
      "";
    const name = metadata.get("tk:resource-name") ?? "embedded";
    const path = `${parent}/${name}`;

    metadata.set("tk:embedded-resource-path", path);
    metadata.set("tk:embedded-depth", depth);

    const child = ctx.createChild({
      limits: { ...ctx.limits, maxNodeDepth: ctx.limits.maxNodeDepth },
    });
    child.set(CONTEXT_KEYS.EMBEDDED_DEPTH, depth);
    child.set(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH, path);
    // A plain parse returns the container's metadata and text, and this embedded document's metadata is dropped with
    // it: its digest would be made and thrown away (MD2 of a nested archive costs seconds). A recursive parse keeps
    // each document's metadata and digests it in its own extractor.
    child.remove(CONTEXT_KEYS.DIGESTS);
    child.remove(CONTEXT_KEYS.CHARSET_HINT);
    child.remove(CONTEXT_KEYS.ARCHIVE_ENTRY);
    // What the embedded document warns about goes to the same result, named by its path; whether it parsed is counted
    // on the container's side.
    const container = ctx.get(CONTEXT_KEYS.WARNINGS);
    const part = ctx.get(CONTEXT_KEYS.ARCHIVE_ENTRY) === true ? "entries-failed" : "embedded-failed";
    if (container !== undefined) child.set(CONTEXT_KEYS.WARNINGS, container.scoped(path));

    metadata.setMaxValueChars(ctx.limits.maxMetadataValueChars);
    metadata.setMaxTotalChars(ctx.limits.maxMetadataTotalChars);
    // Forward each chunk as it is produced so the enclosing handler's output
    // cap fires mid-child instead of after the whole child text is buffered.
    // A trailing high surrogate waits for the next chunk: the enclosing handler
    // filters per call and would turn the two halves of a split pair into U+FFFD.
    let heldHighSurrogate = "";
    const text = new BodyContentHandler(async (chunk) => {
      let out = heldHighSurrogate + chunk;
      heldHighSurrogate = "";
      const last = out.charCodeAt(out.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        heldHighSurrogate = out.slice(-1);
        out = out.slice(0, -1);
      }
      if (out.length > 0) await handler.characters?.(out, 0, out.length);
    });
    try {
      await parser.parse(source, text, metadata, child);
      container?.tally(part, true);
    } catch (error) {
      container?.tally(part, false);
      throw error;
    } finally {
      if (source !== stream) await source.close();
    }
    // A child that is itself a container records its children's failures on its own metadata and does not throw. Tika's
    // CompositeParser.recordEmbeddedMetadata puts them on the container whose parse is running; in a plain parse the
    // intermediate metadata is dropped, so the root carries them too.
    const root = ctx.get(CONTEXT_KEYS.ROOT_METADATA);
    if (root !== undefined && root !== metadata) {
      const known = new Set(root.getAll("tk:exception:embedded-exception"));
      for (const failure of metadata.getAll("tk:exception:embedded-exception")) {
        if (!known.has(failure)) {
          root.add("tk:exception:embedded-exception", failure);
          known.add(failure);
        }
      }
    }
    // An archive among the children that was cut at `maxZipEntries` says so on its own metadata, which a plain parse drops.
    // The first such archive is the one the root names.
    if (root !== undefined && root !== metadata && root.get(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_REACHED) === null) {
      for (const key of [
        TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_REACHED,
        TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT,
        TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_MAX,
        TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_SEEN,
        TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_READ,
      ]) {
        const value = metadata.get(key);
        if (value !== null && metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_REACHED) !== null) root.set(key, value);
      }
    }
    // The child ended on a lone high surrogate: let the enclosing handler filter it.
    if (heldHighSurrogate.length > 0) await handler.characters?.(heldHighSurrogate, 0, 1);
  }
}

export interface EmbeddedResource {
  readonly path: string;
  readonly uri: string;
  readonly metadata: Metadata;
  readonly bytes: Uint8Array;
}

/** Buffers embedded documents instead of parsing them, with stable URIs. */
export class EmbeddedDocumentBytesHandler implements EmbeddedDocumentExtractor {
  readonly resources: EmbeddedResource[] = [];

  shouldParseEmbedded(): boolean {
    return true;
  }

  async parseEmbedded(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    chargeEmbeddedResource(ctx);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > ctx.limits.maxEmbeddedResourceBytes) chargeEmbeddedBytes(ctx, total);
    }
    chargeEmbeddedBytes(ctx, total);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const name = metadata.get("tk:resource-name") ?? `embedded-${this.resources.length}`;
    const parent = ctx.get(CONTEXT_KEYS.EMBEDDED_RESOURCE_PATH) ?? "";
    const path = `${parent}/${name}`.replace(/\/+/g, "/");
    const uri = `embedded:${path}`;
    metadata.set("tk:embedded-resource-path", path);
    metadata.set("ripstream:embedded-resource-uri", uri);
    this.resources.push({ path, uri, metadata, bytes });
  }
}
