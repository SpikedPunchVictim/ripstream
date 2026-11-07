import {
  OutputBudget,
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { BudgetedSink, inflateLimits } from "./compressor.ts";
import { parseEntry, readAll, withXhtml } from "./util.ts";

/** Unix compress (.Z) LZW decoder. */
export class UnixCompressParser implements Parser {
  readonly name = "CompressorParser";
  readonly capabilities = { requiresRandomAccess: false } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/x-compress")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    const decompressed = uncompressZ(
      data,
      new OutputBudget(data.byteLength, inflateLimits(ctx), ".Z output"),
    );
    const name = (metadata.get("resourceName") ?? "embedded").replace(/\.Z$/, "");
    await withXhtml(handler, metadata, async (xhtml) => {
      await parseEntry(xhtml, name || "embedded", decompressed, metadata, ctx);
    });
  }
}

function uncompressZ(data: Uint8Array, budget: OutputBudget): Uint8Array {
  if (data.byteLength < 3 || data[0] !== 0x1f || data[1] !== 0x9d) {
    throw new MalformedDocumentError("Not a Unix compress stream");
  }
  const flags = data[2]!;
  const maxBits = flags & 0x1f;
  const blockMode = (flags & 0x80) !== 0;
  if (maxBits < 9 || maxBits > 16) {
    throw new MalformedDocumentError("Invalid compress code width");
  }

  const reader = new BitReader(data.subarray(3));
  const prefix = new Uint16Array(1 << maxBits);
  const suffix = new Uint8Array(1 << maxBits);
  const stack = new Uint8Array(1 << maxBits);
  const sink = new BudgetedSink(budget);
  for (let index = 0; index < 256; index++) suffix[index] = index;

  const initialFree = blockMode ? 257 : 256;
  let width = 9;
  let maxCode = (1 << width) - 1;
  let free = initialFree;
  let oldCode = reader.read(width);
  if (oldCode === -1) return new Uint8Array(0);
  if (oldCode > 255) throw new MalformedDocumentError("Invalid compress code");
  let first = oldCode;
  sink.writeByte(first);

  for (;;) {
    const code = reader.read(width);
    if (code === -1) break;
    if (blockMode && code === 256) {
      // Table reset: the encoder flushes its 8-code group, then restarts at 9 bits.
      reader.realign(width);
      width = 9;
      maxCode = (1 << width) - 1;
      free = initialFree;
      oldCode = reader.read(width);
      if (oldCode === -1) break;
      if (oldCode > 255) throw new MalformedDocumentError("Invalid compress code");
      first = oldCode;
      sink.writeByte(first);
      continue;
    }
    let current = code;
    let top = 0;
    if (current >= free) {
      if (current > free) throw new MalformedDocumentError("Invalid compress code");
      stack[top++] = first;
      current = oldCode;
    }
    while (current >= 256) {
      if (top >= stack.length) throw new MalformedDocumentError("Compress stack overflow");
      stack[top++] = suffix[current]!;
      current = prefix[current]!;
    }
    first = current;
    stack[top++] = first;
    sink.writeReversed(stack, top);
    if (free < 1 << maxBits) {
      prefix[free] = oldCode;
      suffix[free] = first;
      free++;
      if (free > maxCode && width < maxBits) {
        reader.realign(width);
        width++;
        maxCode = (1 << width) - 1;
      }
    }
    oldCode = code;
  }
  return sink.result();
}

/**
 * LSB-first code reader. The encoder emits codes in groups of 8 (width bytes)
 * and flushes the group whenever the code width changes or the table resets,
 * so realign() skips to the next group boundary.
 */
class BitReader {
  readonly #data: Uint8Array;
  #bitPosition = 0;
  #groupStart = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  read(width: number): number {
    if (this.#bitPosition + width > this.#data.byteLength * 8) return -1;
    let value = 0;
    for (let got = 0; got < width; ) {
      const byte = this.#data[this.#bitPosition >> 3]!;
      const offset = this.#bitPosition & 7;
      const take = Math.min(8 - offset, width - got);
      value |= ((byte >> offset) & ((1 << take) - 1)) << got;
      got += take;
      this.#bitPosition += take;
    }
    return value;
  }

  realign(width: number): void {
    const group = width * 8;
    const used = this.#bitPosition - this.#groupStart;
    this.#bitPosition = this.#groupStart + Math.ceil(used / group) * group;
    this.#groupStart = this.#bitPosition;
  }
}
