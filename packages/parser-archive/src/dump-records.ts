import {
  MalformedDocumentError,
  inflateBounded,
  type ParseContext,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/*
 * The records of a Unix dump(8) volume, read as commons-compress's DumpArchiveInputStream and DumpArchiveEntry.parse
 * read them (Tika's PackageParser hands application/x-tika-unix-dump to it). That source is not in the Tika tree: the
 * offsets, constants and the checksum rule below are from memory of it, and no real dump file was available to check
 * them against (tikajs-68os.47).
 *
 * A volume is a run of 1024-byte records, little endian. A header record holds the segment type, the inode number, the
 * inode itself (mode, size, times) and an address map of up to 512 bytes, one per data block that follows the header:
 * 1 when the block is on the tape, 0 for a hole.
 */

export const RECORD = 1024;
/** The 512 entries of a header's address map. */
export const MAX_ADDRESSES = 512;

const NFS_MAGIC = 60012;
const CHECKSUM = 84446;
const MAGIC_OFFSET = 24;
const CHECKSUM_OFFSET = 28;
const ADDRESS_MAP_OFFSET = 164;

export const SEGMENT = { TAPE: 1, INODE: 2, BITS: 3, ADDR: 4, END: 5, CLRI: 6 } as const;
/** The file type, the high four bits of the 16-bit mode. */
export const FILE_TYPE_DIRECTORY = 4;

export interface Segment {
  readonly type: number;
  readonly ino: number;
  readonly mode: number;
  /** The inode's 64-bit size, signed as commons-compress reads it. */
  readonly size: bigint;
  /** Milliseconds since the epoch, as commons-compress computes them: 1000 * seconds + nanoseconds / 1000. */
  readonly modifiedMillis: number;
  readonly count: number;
  readonly addresses: Uint8Array;
}

export function isDirectory(segment: Segment): boolean {
  return ((segment.mode >> 12) & 0x0f) === FILE_TYPE_DIRECTORY;
}

/** `DumpArchiveUtil.verify`: the magic number, and the 256 words of the record summing to the checksum constant. */
export function isHeader(record: Uint8Array): boolean {
  const view = new DataView(record.buffer, record.byteOffset, RECORD);
  if (view.getInt32(MAGIC_OFFSET, true) !== NFS_MAGIC) return false;
  let sum = 0;
  for (let word = 0; word < RECORD / 4; word++) sum = (sum + view.getInt32(4 * word, true)) | 0;
  const others = (sum - view.getInt32(CHECKSUM_OFFSET, true)) | 0;
  return view.getInt32(CHECKSUM_OFFSET, true) === ((CHECKSUM - others) | 0);
}

/** `DumpArchiveEntry.parse`, the fields the reader uses. */
export function parseSegment(record: Uint8Array): Segment {
  const view = new DataView(record.buffer, record.byteOffset, RECORD);
  const seconds = view.getInt32(56, true);
  const nanoseconds = view.getInt32(60, true);
  return {
    type: view.getInt32(0, true),
    ino: view.getUint32(20, true),
    mode: view.getUint16(32, true),
    size: view.getBigInt64(40, true),
    modifiedMillis: 1000 * seconds + Math.trunc(nanoseconds / 1000),
    count: view.getInt32(160, true),
    addresses: record.slice(ADDRESS_MAP_OFFSET, ADDRESS_MAP_OFFSET + MAX_ADDRESSES),
  };
}

/** How many blocks the segment's address map covers; a count outside 0 to 512 has no map to read. */
export function blockCount(segment: Segment): number {
  if (segment.count < 0 || segment.count > MAX_ADDRESSES) {
    throw new MalformedDocumentError(`Unix dump segment of ${segment.count} blocks, a header maps 0 to ${MAX_ADDRESSES}`);
  }
  return segment.count;
}

/** Whether block `index` of the segment is on the tape (otherwise it is a hole, read as zeros). */
export function isOnTape(segment: Segment, index: number): boolean {
  return (segment.addresses[index]! & 1) === 1;
}

/** Whole records out of the stream: the cursor only ever moves by 1024 bytes or by a count of records that exist. */
export class RecordReader {
  private readonly stream: RipstreamInputStream;
  private readonly ctx: ParseContext;
  /** Compressed volumes put a 4-byte header before each tape block; a block holds `blockSize` logical bytes. */
  #compressed = false;
  #blockSize = RECORD;
  #block: Uint8Array | null = null;
  #blockOffset = 0;
  /** TapeInputStream.resetBlockSize: the rest of the first tape block is raw, headers start with the next block. */
  #firstBlockRest = 0;

  constructor(stream: RipstreamInputStream, ctx: ParseContext) {
    this.stream = stream;
    this.ctx = ctx;
  }

  /** Called after the volume header: the volume is compressed, in tape blocks of `ntrec` records. */
  enableCompression(ntrec: number): void {
    if (!Number.isSafeInteger(ntrec) || ntrec < 1 || ntrec > 65_536) {
      throw new MalformedDocumentError(`Unix dump volume with ${ntrec} records to the block`);
    }
    this.#compressed = true;
    this.#blockSize = ntrec * RECORD;
    this.#firstBlockRest = this.#blockSize - RECORD;
    this.#block = null;
    this.#blockOffset = 0;
  }

  async readRecord(): Promise<Uint8Array> {
    this.ctx.throwIfAborted();
    if (this.#compressed) return this.#compressedRecord();
    const record = await this.stream.peek(RECORD);
    if (record.byteLength < RECORD) throw truncated();
    await this.stream.seek(RECORD, "current");
    return record;
  }

  /** One record out of the current decompressed tape block, reading the next block when this one is spent. */
  async #compressedRecord(): Promise<Uint8Array> {
    if (this.#block === null || this.#blockOffset + RECORD > this.#block.byteLength) {
      this.#block = await this.#readBlock();
      this.#blockOffset = 0;
    }
    const record = this.#block.slice(this.#blockOffset, this.#blockOffset + RECORD);
    this.#blockOffset += RECORD;
    return record;
  }

  /** A tape block: 4-byte header, then either `blockSize` raw bytes or a zlib stream that inflates to exactly that. */
  async #readBlock(): Promise<Uint8Array> {
    if (this.#firstBlockRest > 0) {
      const rest = this.#readBytes(this.#firstBlockRest);
      this.#firstBlockRest = 0;
      return rest;
    }
    const header = await this.#readBytes(4);
    const view = new DataView(header.buffer, header.byteOffset, 4);
    const h = view.getUint32(0, true);
    if ((h & 1) === 0) return this.#readBytes(this.#blockSize);
    const length = (h >>> 4) & 0x0fff_ffff;
    if (length === 0) throw new MalformedDocumentError("Unix dump compressed block of no bytes");
    const packed = await this.#readBytes(length);
    let plain: Uint8Array;
    try {
      plain = inflateBounded(packed, "deflate", { maxOutputBytes: this.#blockSize, maxRatio: Number.MAX_SAFE_INTEGER });
    } catch (error) {
      throw new MalformedDocumentError("Unix dump compressed block is not valid zlib data", { cause: error });
    }
    if (plain.byteLength !== this.#blockSize) {
      throw new MalformedDocumentError("Unix dump compressed block does not inflate to one tape block");
    }
    return plain;
  }

  async #readBytes(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await this.stream.peek(length - offset);
      if (chunk.byteLength === 0) throw truncated();
      out.set(chunk, offset);
      offset += chunk.byteLength;
      await this.stream.seek(chunk.byteLength, "current");
    }
    return out;
  }

  /** The next record, which must be a header. */
  async readHeader(): Promise<Segment> {
    const record = await this.readRecord();
    if (!isHeader(record)) throw new MalformedDocumentError("Unix dump record is not a valid header");
    return parseSegment(record);
  }

  /** `count` records joined, for a directory's blocks (at most 512 of them, so at most 512 KB). */
  async readRecords(count: number): Promise<Uint8Array> {
    const joined = new Uint8Array(count * RECORD);
    for (let index = 0; index < count; index++) joined.set(await this.readRecord(), index * RECORD);
    return joined;
  }

  /** Moves past `count` records; one that is not in the stream is a truncated volume. */
  async skipRecords(count: number): Promise<void> {
    if (count === 0) return;
    this.ctx.throwIfAborted();
    if (this.#compressed) {
      for (let index = 0; index < count; index++) await this.readRecord();
      return;
    }
    try {
      await this.stream.seek(count * RECORD, "current");
    } catch (error) {
      if (error instanceof RangeError) throw truncated();
      throw error;
    }
  }

  /** The blocks of the segment on the tape from `from` on: what is left of a segment whose blocks were not all read. */
  async skipBlocks(segment: Segment, from: number): Promise<void> {
    let onTape = 0;
    for (let index = from; index < blockCount(segment); index++) {
      if (isOnTape(segment, index)) onTape++;
    }
    await this.skipRecords(onTape);
  }
}

function truncated(): MalformedDocumentError {
  return new MalformedDocumentError("Unix dump is truncated");
}
