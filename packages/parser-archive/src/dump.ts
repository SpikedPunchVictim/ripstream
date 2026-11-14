import { isFatalParseError } from "@spikedpunch/ripstream-core";
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
  WriteLimitReachedError,
  AttributesImpl,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
  type XHTMLContentHandler,
} from "@spikedpunch/ripstream-core";
import {
  MAX_ADDRESSES,
  RECORD,
  SEGMENT,
  RecordReader,
  blockCount,
  isDirectory,
  isHeader,
  isOnTape,
  type Segment,
} from "./dump-records.ts";
import { safeEntryName, withXhtml } from "./util.ts";

/*
 * Unix dump volumes (application/x-tika-unix-dump), which Tika 4.2.0's PackageParser reads through commons-compress's
 * DumpArchiveInputStream. Read from PackageParser.java and AbstractArchiveParser.java; the reading order and the
 * format are from memory of commons-compress, which is not in the Tika tree (see dump-records.ts). Not run against a
 * Tika (tikajs-68os.47).
 */

const DUMP_TYPE = "application/x-tika-unix-dump";
const XHTML = "http://www.w3.org/1999/xhtml";
/** DumpArchiveSummary.isCompressed: bit 0x0080 of the volume header's flags. */
const COMPRESSED_FLAG = 0x0080;
/** Offsets in the volume header (DumpArchiveSummary). */
const FLAGS_OFFSET = 888;
const BLOCK_RECORDS_OFFSET = 896;
const ROOT_INO = 2;
/** The ratio between a file's size and the tape it takes is checked only past this size, as for ZIP entries. */
const RATIO_CHECK_THRESHOLD_BYTES = 1_000_000;
const HOLE = new Uint8Array(RECORD);

interface Dirent {
  readonly ino: number;
  readonly parentIno: number;
  readonly name: string;
}

export class UnixDumpParser implements Parser {
  readonly name = "UnixDumpParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(DUMP_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const reader = new RecordReader(stream, ctx);
    const header = await readVolumeHeader(reader);
    if (header.compressed) reader.enableCompression(header.blockRecords);
    await skipMap(reader, SEGMENT.CLRI);
    await skipMap(reader, SEGMENT.BITS);
    metadata.set("Content-Type", DUMP_TYPE);
    await withXhtml(handler, metadata, (xhtml) => new Volume(reader, xhtml, metadata, ctx).walk());
  }
}

/** The volume header: a valid header record, whose summary says how the volume is laid out. */
async function readVolumeHeader(reader: RecordReader): Promise<{ compressed: boolean; blockRecords: number }> {
  const record = await reader.readRecord();
  if (!isHeader(record)) throw new MalformedDocumentError("Not a Unix dump volume: the first record is not a header");
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const blockRecords = view.getInt32(BLOCK_RECORDS_OFFSET, true);
  if (blockRecords < 1) {
    throw new MalformedDocumentError("Unix dump volume with no records to the block");
  }
  return { compressed: (view.getInt32(FLAGS_OFFSET, true) & COMPRESSED_FLAG) !== 0, blockRecords };
}

/** The CLRI and BITS maps that follow the volume header: a header of that type, then its blocks, all skipped. */
async function skipMap(reader: RecordReader, type: number): Promise<void> {
  const segment = await reader.readHeader();
  if (segment.type !== type) throw new MalformedDocumentError(`Unix dump volume without its segment of type ${type}`);
  if (segment.count < 0) throw new MalformedDocumentError("Unix dump map of a negative block count");
  await reader.skipRecords(segment.count);
}

/** Walks the inodes of a volume: directories fill in the names, files are emitted under them. */
class Volume {
  private readonly names = new Map<number, Dirent>([[ROOT_INO, { ino: ROOT_INO, parentIno: ROOT_INO, name: "." }]]);
  private readonly reader: RecordReader;
  private readonly xhtml: XHTMLContentHandler;
  private readonly metadata: Metadata;
  private readonly ctx: ParseContext;
  private readonly extractor: EmbeddedDocumentExtractor;
  private files = 0;
  private total = 0;

  constructor(reader: RecordReader, xhtml: XHTMLContentHandler, metadata: Metadata, ctx: ParseContext) {
    this.reader = reader;
    this.xhtml = xhtml;
    this.metadata = metadata;
    this.ctx = ctx;
    this.extractor =
      (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
      new ParsingEmbeddedDocumentExtractor();
  }

  async walk(): Promise<void> {
    let segment = await this.reader.readHeader();
    for (;;) {
      segment = await this.skipAddressSegments(segment);
      if (segment.type === SEGMENT.END) return;
      if (segment.type !== SEGMENT.INODE) {
        await this.reader.skipBlocks(segment, 0);
        segment = await this.reader.readHeader();
      } else if (isDirectory(segment)) {
        segment = await this.readDirectory(segment);
      } else {
        segment = await this.readFile(segment);
      }
    }
  }

  /** ADDR segments that belong to an inode already passed: their blocks on the tape are skipped. */
  private async skipAddressSegments(first: Segment): Promise<Segment> {
    let segment = first;
    while (segment.type === SEGMENT.ADDR) {
      await this.reader.skipBlocks(segment, 0);
      segment = await this.reader.readHeader();
    }
    return segment;
  }

  /**
   * The directory's blocks, a segment at a time, are struct direct entries: each names an inode under this directory.
   * Returns the header after them, which is not an ADDR segment.
   */
  private async readDirectory(first: Segment): Promise<Segment> {
    let remaining = this.entrySize(first);
    let segment = first;
    for (;;) {
      const data = await this.reader.readRecords(blockCount(segment));
      this.addEntries(data, segment.ino, remaining);
      const next = await this.reader.readHeader();
      if (next.type !== SEGMENT.ADDR) return next;
      segment = next;
      remaining -= RECORD;
    }
  }

  private addEntries(data: Uint8Array, parentIno: number, size: number): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset < data.length - 8 && offset < size - 8) {
      const ino = view.getUint32(offset, true);
      const length = view.getUint16(offset + 4, true);
      if (length === 0) throw new MalformedDocumentError("Unix dump directory entry of record length 0");
      const nameLength = data[offset + 7]!;
      if (offset + 8 + nameLength > data.length) {
        throw new MalformedDocumentError("Unix dump directory entry runs past its block");
      }
      const name = new TextDecoder().decode(data.subarray(offset + 8, offset + 8 + nameLength));
      if (name !== "." && name !== "..") this.addName({ ino, parentIno, name });
      offset += length;
    }
  }

  private addName(dirent: Dirent): void {
    this.names.set(dirent.ino, dirent);
    // The root is in the map from the start and is not an entry of the volume.
    if (this.names.size - 1 > this.ctx.limits.maxZipEntries) {
      throw new LimitExceededError(`Unix dump directory entries exceed ${this.ctx.limits.maxZipEntries}`);
    }
  }

  /** The path of an inode from the root, or null when a directory on the way has not been read. */
  private pathOf(ino: number): string | null {
    const parts: string[] = [];
    let current = ino;
    for (let depth = 0; ; depth++) {
      const dirent = this.names.get(current);
      if (dirent === undefined) return null;
      parts.push(dirent.name);
      if (dirent.ino === dirent.parentIno) break;
      if (depth >= this.ctx.limits.maxNodeDepth) {
        throw new LimitExceededError(`Unix dump path deeper than ${this.ctx.limits.maxNodeDepth} directories`);
      }
      current = dirent.parentIno;
    }
    const path = parts.reverse().join("/");
    // DumpArchiveEntry.setName drops the root's "./".
    return path.startsWith("./") ? path.slice(2) : path;
  }

  /** A file inode: emitted as an embedded document when a directory names it, otherwise its blocks are skipped. */
  private async readFile(first: Segment): Promise<Segment> {
    const path = this.pathOf(first.ino);
    if (path === null) {
      await this.reader.skipBlocks(first, 0);
      return this.reader.readHeader();
    }
    if (safeEntryName(path) === null) {
      this.metadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, `unsafe archive path skipped: ${path}`);
      await this.reader.skipBlocks(first, 0);
      return this.reader.readHeader();
    }
    const size = this.entrySize(first);
    this.charge(size);
    const { bytes, last, index } = await this.readBlocks(first, size);
    await this.reader.skipBlocks(last, index);
    await this.emit(path, bytes, first);
    return this.reader.readHeader();
  }

  /** The size a segment declares, refused before anything is read when it is negative or over the per-entry limit. */
  private entrySize(segment: Segment): number {
    if (segment.size < 0n) throw new MalformedDocumentError(`Unix dump inode of negative size ${segment.size}`);
    if (segment.size > BigInt(this.ctx.limits.maxEmbeddedResourceBytes)) {
      throw new LimitExceededError(
        `Unix dump entry of ${segment.size} bytes exceeds the per-entry limit ${this.ctx.limits.maxEmbeddedResourceBytes}`,
      );
    }
    return Number(segment.size);
  }

  private charge(size: number): void {
    this.files++;
    if (this.files > this.ctx.limits.maxZipEntries) {
      throw new LimitExceededError(`Unix dump entries exceed ${this.ctx.limits.maxZipEntries}`);
    }
    this.total += size;
    if (this.total > this.ctx.limits.maxTotalEmbeddedBytes) {
      throw new LimitExceededError("Unix dump exceeds the embedded byte limit");
    }
  }

  /**
   * The file's `size` bytes: each block on the tape is read, each hole is zeros, and past 512 blocks the next header
   * (an ADDR segment) carries the address map. Returns the segment and block index where reading stopped. Nothing is
   * allocated from the declared size until that many bytes have been read or counted against the ratio limit.
   */
  private async readBlocks(first: Segment, size: number): Promise<{ bytes: Uint8Array; last: Segment; index: number }> {
    const chunks: Uint8Array[] = [];
    let last = first;
    let index = 0;
    let produced = 0;
    let consumed = RECORD;
    while (produced < size) {
      if (index >= MAX_ADDRESSES) {
        last = await this.reader.readHeader();
        index = 0;
        consumed += RECORD;
      }
      const onTape = isOnTape(last, index++);
      if (onTape) consumed += RECORD;
      const block = onTape ? await this.reader.readRecord() : HOLE;
      const take = Math.min(RECORD, size - produced);
      chunks.push(block.subarray(0, take));
      produced += take;
      this.checkRatio(consumed, produced);
    }
    return { bytes: concat(chunks, produced), last, index };
  }

  private checkRatio(consumed: number, produced: number): void {
    if (produced > RATIO_CHECK_THRESHOLD_BYTES && produced / consumed > this.ctx.limits.maxDecompressionRatio) {
      throw new LimitExceededError("Unix dump entry exceeds the decompression ratio limit: it is mostly holes");
    }
  }

  /** AbstractArchiveParser.handleEntryMetadata, then PackageParser.parseEntry's embedded parse. */
  private async emit(path: string, bytes: Uint8Array, segment: Segment): Promise<void> {
    const name = path.replace(/\\/g, "/");
    const embedded = new Metadata();
    embedded.set("fs:modified", `${new Date(segment.modifiedMillis).toISOString().slice(0, 19)}Z`);
    embedded.set("Content-Length", String(bytes.byteLength));
    embedded.set(TIKA_KEYS.RESOURCE_NAME, name);
    embedded.set("tk:internal-path", name);
    const attributes = new AttributesImpl();
    attributes.addAttribute("", "class", "class", "CDATA", "embedded");
    attributes.addAttribute("", "id", "id", "CDATA", name);
    await this.xhtml.startElement(XHTML, "div", "div", attributes);
    await this.xhtml.endElement("div");
    if (!this.extractor.shouldParseEmbedded(embedded)) return;

    const stream = await RipstreamInputStream.from(bytes, { context: this.ctx });
    await this.xhtml.startElement("div", "class", "package-entry");
    await this.xhtml.element("h1", name);
    try {
      await this.extractor.parseEmbedded(stream, this.xhtml, embedded, this.ctx);
    } catch (error) {
      if (isFatalParseError(error, this.ctx)) throw error;
      this.metadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, describe(error));
    } finally {
      await stream.close();
    }
    await this.xhtml.endElement("div");
  }

}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
