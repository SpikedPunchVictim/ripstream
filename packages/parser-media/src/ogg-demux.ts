import { LimitExceededError } from "@spikedpunch/ripstream-core";

/*
 * The Ogg framing (RFC 3533) as vorbis-java's OggFile and OggPacketReader give it to Tika's Ogg parsers: pages, and
 * the packets that the lacing values cut out of them, one pass over the stream. Bytes between pages are skipped to the
 * next "OggS", as the library does. The page checksum is not checked. A page cut short by the end of the input ends the
 * read: what came before it is kept.
 *
 * The input is read in 64 KB chunks and a page is at most 65307 bytes, so memory is a few pages, plus the packets that
 * the caller asks to keep, which are held up to a cap. Nothing is allocated for a size that a page only declares.
 */

const PAGE_HEADER_BYTES = 27;
const BEGINNING_OF_STREAM = 0x02;
const END_OF_STREAM = 0x04;

/** Streams that have begun and not ended. A real file has a handful. */
const MAX_OPEN_STREAMS = 1000;
/** Bytes of packets held at once. A comment header with cover art is megabytes; no header is as large as this. */
const MAX_HELD_BYTES = 32 * 1024 * 1024;

export interface OggPacket {
  readonly sid: number;
  /** Its place in its stream, from 0. */
  readonly index: number;
  /** The first packet of a stream that began with a beginning-of-stream page. */
  readonly beginningOfStream: boolean;
  readonly data: Uint8Array;
}

export interface OggReadOptions {
  /** How many packets at the start of each stream are assembled and passed on; later ones are only counted. */
  readonly keepPackets: number;
  onPacket(packet: OggPacket): void;
  /** The granule position of a page that ends a packet, in a stream whose beginning was seen. */
  onGranule?(sid: number, granule: bigint): void;
  readonly maxHeldBytes?: number;
  readonly maxStreams?: number;
}

export async function readOgg(input: AsyncIterable<Uint8Array>, options: OggReadOptions): Promise<void> {
  const window = new ByteWindow(input);
  const packets = new PacketAssembler(options);
  while (await window.seekCapture()) {
    if (!(await window.ensure(PAGE_HEADER_BYTES))) return;
    const headerLength = PAGE_HEADER_BYTES + window.bytes[26]!;
    if (!(await window.ensure(headerLength))) return;
    let pageLength = headerLength;
    for (let index = PAGE_HEADER_BYTES; index < headerLength; index++) pageLength += window.bytes[index]!;
    if (!(await window.ensure(pageLength))) return;
    packets.addPage(window.bytes.subarray(0, pageLength));
    window.consume(pageLength);
  }
}

class ByteWindow {
  bytes = new Uint8Array(0);
  private readonly iterator: AsyncIterator<Uint8Array>;
  private ended = false;

  constructor(input: AsyncIterable<Uint8Array>) {
    this.iterator = input[Symbol.asyncIterator]();
  }

  /** Reads input until `count` bytes are here, or false if it ends first. */
  async ensure(count: number): Promise<boolean> {
    while (this.bytes.length < count) {
      if (this.ended) return false;
      const next = await this.iterator.next();
      if (next.done === true) {
        this.ended = true;
        return false;
      }
      // Copied: the stream may reuse the chunk it gave.
      const joined = new Uint8Array(this.bytes.length + next.value.length);
      joined.set(this.bytes, 0);
      joined.set(next.value, this.bytes.length);
      this.bytes = joined;
    }
    return true;
  }

  consume(count: number): void {
    this.bytes = this.bytes.subarray(count);
  }

  /** Moves to the next "OggS", or false at the end of the input. */
  async seekCapture(): Promise<boolean> {
    while (await this.ensure(4)) {
      const at = findCapture(this.bytes);
      if (at >= 0) {
        this.consume(at);
        return true;
      }
      // The end of what is read may be the start of a capture pattern.
      this.consume(this.bytes.length - 3);
    }
    return false;
  }
}

function findCapture(bytes: Uint8Array): number {
  for (let at = bytes.indexOf(0x4f); at >= 0; at = bytes.indexOf(0x4f, at + 1)) {
    if (bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53) return at;
  }
  return -1;
}

interface StreamState {
  readonly beginning: boolean;
  /** Packets finished so far. */
  index: number;
  /** The parts of the packet in progress, kept only for the first `keepPackets` packets. */
  parts: Uint8Array[];
  held: number;
}

class PacketAssembler {
  private readonly streams = new Map<number, StreamState>();
  private held = 0;
  private readonly options: OggReadOptions;

  constructor(options: OggReadOptions) {
    this.options = options;
  }

  addPage(page: Uint8Array): void {
    const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const flags = page[5]!;
    const sid = view.getUint32(14, true);
    if ((flags & BEGINNING_OF_STREAM) !== 0) this.open(sid);
    // A page of a stream whose beginning was not seen can not be told from junk: it is passed over.
    const stream = this.streams.get(sid);
    if (stream === undefined) return;

    const segments = page[26]!;
    let runStart = PAGE_HEADER_BYTES + segments;
    let runLength = 0;
    let finished = 0;
    for (let index = 0; index < segments; index++) {
      const lacing = page[PAGE_HEADER_BYTES + index]!;
      runLength += lacing;
      if (lacing === 255) continue;
      this.append(sid, stream, page.subarray(runStart, runStart + runLength));
      this.finish(sid, stream);
      finished++;
      runStart += runLength;
      runLength = 0;
    }
    // A last segment of 255 bytes says the packet goes on in the next page.
    if (runLength > 0) this.append(sid, stream, page.subarray(runStart, runStart + runLength));

    const granule = view.getBigInt64(6, true);
    if (finished > 0 && granule >= 0n) this.options.onGranule?.(sid, granule);
    if ((flags & END_OF_STREAM) !== 0) this.drop(sid);
  }

  private open(sid: number): void {
    this.drop(sid);
    if (this.streams.size >= (this.options.maxStreams ?? MAX_OPEN_STREAMS)) {
      throw new LimitExceededError(`More than ${this.options.maxStreams ?? MAX_OPEN_STREAMS} Ogg streams are open at once`);
    }
    this.streams.set(sid, { beginning: true, index: 0, parts: [], held: 0 });
  }

  private drop(sid: number): void {
    const stream = this.streams.get(sid);
    if (stream === undefined) return;
    this.held -= stream.held;
    this.streams.delete(sid);
  }

  private append(sid: number, stream: StreamState, part: Uint8Array): void {
    if (stream.index >= this.options.keepPackets) return;
    const limit = this.options.maxHeldBytes ?? MAX_HELD_BYTES;
    if (this.held + part.length > limit) {
      throw new LimitExceededError(`Ogg packets of stream ${sid} hold more than ${limit} bytes`);
    }
    stream.parts.push(part);
    stream.held += part.length;
    this.held += part.length;
  }

  private finish(sid: number, stream: StreamState): void {
    if (stream.index < this.options.keepPackets) {
      const data = new Uint8Array(stream.held);
      let offset = 0;
      for (const part of stream.parts) {
        data.set(part, offset);
        offset += part.length;
      }
      this.options.onPacket({ sid, index: stream.index, beginningOfStream: stream.beginning && stream.index === 0, data });
    }
    this.held -= stream.held;
    stream.held = 0;
    stream.parts = [];
    stream.index++;
  }
}
