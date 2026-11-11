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
  UnsupportedFormatError,
  WriteLimitReachedError,
  XHTMLContentHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";

/*
 * Port of Tika 4.2.0's UniversalExecutableParser (tika-parser-code-module), read from that source and not run against
 * a Tika: a fat Mach-O file (a table of architectures, each a thin Mach-O) writes no text and sets no metadata; each
 * architecture is an embedded document, taken in the order of its offset.
 *
 * Where it differs: Tika reads each architecture into a byte array the size the table declares, up to 500,000,000, and
 * fails with a TikaException or an IllegalArgumentException when the file is short or the architectures overlap. Here an
 * architecture is a stream over the file between its offset and its end, once that end is known to be in the file, so
 * what the table declares is never allocated; every refusal is a MalformedDocumentError.
 */

const SUPPORTED_TYPE = "application/x-mach-o-universal";

/** Tika's caps on what a table may declare. */
const MAX_ARCHS_COUNT = 1000;
const MAX_ARCH_SIZE = 500_000_000;

/** The magic and the architecture count. */
const FAT_HEADER_BYTES = 8;

/** fat_arch is cputype, cpusubtype, offset, size, align; fat_arch_64 has 64-bit offset and size and a reserved word. */
const FAT_ARCH_BYTES = 20;
const FAT_ARCH_64_BYTES = 32;

interface Arch {
  readonly offset: bigint;
  readonly size: bigint;
}

interface FatTable {
  readonly archs: readonly Arch[];
  /** Where the table ends: the first byte an architecture may start at. */
  readonly end: number;
}

export class UniversalExecutableParser implements Parser {
  readonly name = "UniversalExecutableParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(SUPPORTED_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const extractor =
      (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
      new ParsingEmbeddedDocumentExtractor();

    // Offsets in the table are from the start of the file, which is where the stream is.
    const base = stream.position;
    const table = await readTable(stream);
    await extractArchs(stream, base, table, xhtml, extractor, ctx);
    await xhtml.endDocument();
  }
}

/** The magic, the count and the table, each bounded by what the file holds before anything is read from the table. */
async function readTable(stream: RipstreamInputStream): Promise<FatTable> {
  const head = await stream.peek(FAT_HEADER_BYTES);
  if (head.length < 4) throw new MalformedDocumentError("Truncated universal executable header");

  const [b0, b1, b2, b3] = [head[0], head[1], head[2], head[3]];
  // The two byte orders of fat_header.magic, 0xCAFEBABE (32-bit arch entries) and 0xCAFEBABF (64-bit).
  const little = (b0 === 0xbf || b0 === 0xbe) && b1 === 0xba && b2 === 0xfe && b3 === 0xca;
  const big = b0 === 0xca && b1 === 0xfe && b2 === 0xba && (b3 === 0xbf || b3 === 0xbe);
  if (!little && !big) throw new UnsupportedFormatError("Not a universal executable file");
  const wide = (little ? b0 : b3) === 0xbf;

  if (head.length < FAT_HEADER_BYTES) throw new MalformedDocumentError("Truncated universal executable header");
  const count = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt32(4, little);
  if (count < 1) throw new MalformedDocumentError(`Invalid number of architectures: ${count}`);
  if (count > MAX_ARCHS_COUNT) {
    throw new MalformedDocumentError(`Number of architectures=${count} greater than max allowed=${MAX_ARCHS_COUNT}`);
  }

  const entryBytes = wide ? FAT_ARCH_64_BYTES : FAT_ARCH_BYTES;
  const end = FAT_HEADER_BYTES + count * entryBytes;
  const bytes = await stream.peek(end);
  if (bytes.length < end) throw new MalformedDocumentError("Truncated universal executable architecture table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const archs: Arch[] = [];
  for (let index = 0; index < count; index++) {
    const at = FAT_HEADER_BYTES + index * entryBytes;
    // Signed, as the Java reads them: a 32-bit value of 0x80000000 and up is negative and refused below.
    const offset = wide ? view.getBigInt64(at + 8, little) : BigInt(view.getInt32(at + 8, little));
    const size = wide ? view.getBigInt64(at + 16, little) : BigInt(view.getInt32(at + 12, little));
    if (offset < BigInt(end)) throw new MalformedDocumentError(`Invalid offset: ${offset}`);
    if (size < 0n || size > BigInt(MAX_ARCH_SIZE)) {
      throw new MalformedDocumentError(`Arch size=${size} must be between 0 and ${MAX_ARCH_SIZE}`);
    }
    archs.push({ offset, size });
  }
  return { archs, end };
}

/** Each architecture in offset order, as an embedded document with nothing in its metadata but its length. */
async function extractArchs(
  stream: RipstreamInputStream,
  base: number,
  table: FatTable,
  xhtml: XHTMLContentHandler,
  extractor: EmbeddedDocumentExtractor,
  ctx: ParseContext,
): Promise<void> {
  // Array.prototype.sort is stable, so equal offsets keep the table's order, as the Java's sort of its pairs does.
  const sorted = [...table.archs].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  const furthest = BigInt(Number.MAX_SAFE_INTEGER - base);
  // Where the one before ended: the Java's currentOffset, which an architecture may not start before.
  let position = BigInt(table.end);

  for (const arch of sorted) {
    if (arch.offset < position) {
      throw new MalformedDocumentError(
        `Architecture at offset ${arch.offset} overlaps the one before it, which ends at ${position}`,
      );
    }
    const end = arch.offset + arch.size;
    if (end > furthest) throw new MalformedDocumentError(`Architecture ends at ${end}, past the end of any file`);
    // The bytes are in the file or the architecture is refused, before a stream is made over them.
    await seekTo(stream, base + Number(end));
    position = end;

    // TikaInputStream.get(bytes, metadata) puts the length in a metadata that is otherwise empty.
    const embedded = new Metadata();
    embedded.set("Content-Length", String(arch.size));
    if (!extractor.shouldParseEmbedded(embedded)) continue;

    const archStream = await RipstreamInputStream.from(slice(stream, base + Number(arch.offset), Number(arch.size)), {
      context: ctx,
      signal: ctx.signal,
    });
    try {
      await extractor.parseEmbedded(archStream, xhtml, embedded, ctx);
    } catch (error) {
      // A document that cannot be read is recorded and the next one is taken, as Tika's extractor does.
      if (isFatal(error, ctx)) throw error;
      embedded.add(TIKA_KEYS.EMBEDDED_EXCEPTION, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    } finally {
      await archStream.close();
    }
  }
}

/** Moves to a position, which pulls the stream that far and no further; a file that ends sooner is malformed. */
async function seekTo(stream: RipstreamInputStream, position: number): Promise<void> {
  try {
    await stream.seek(position);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new MalformedDocumentError("Universal executable architecture extends past the end of the file", { cause: error });
    }
    throw error;
  }
}

/** The `size` bytes of the file from `start`, in chunks, so no buffer is made for the whole of them. */
async function* slice(stream: RipstreamInputStream, start: number, size: number): AsyncGenerator<Uint8Array> {
  await stream.seek(start);
  let left = size;
  while (left > 0) {
    const chunk = await stream.read();
    // The architecture was shown to be in the file; a stream that now ends is a stream that changed under us.
    if (chunk === null) throw new MalformedDocumentError("Universal executable architecture ended early");
    const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
    left -= part.length;
    yield part;
  }
}

/** A failure that ends the parse rather than one document of it: a limit, a timeout, an abort, the output cut. */
function isFatal(error: unknown, ctx: ParseContext): boolean {
  return (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    error instanceof WriteLimitReachedError ||
    ctx.signal.aborted
  );
}
