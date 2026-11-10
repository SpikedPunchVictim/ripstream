import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  OutputBudget,
  inflateBounded,
  type ContentHandler,
  type InflateLimits,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import bzip from "seek-bzip";
import { checkDecompression, parseEntry, readAll, withXhtml } from "./util.ts";

/** Output cap for a decompressor, derived from the parse context limits. */
export function inflateLimits(ctx: ParseContext): InflateLimits {
  return {
    maxOutputBytes: Math.min(
      ctx.limits.maxEmbeddedResourceBytes,
      ctx.limits.maxTotalEmbeddedBytes,
    ),
    maxRatio: ctx.limits.maxDecompressionRatio,
  };
}

/** Growable output buffer that counts every byte against an OutputBudget. */
export class BudgetedSink {
  #buffer = new Uint8Array(16384);
  #length = 0;

  readonly #budget: OutputBudget;

  constructor(budget: OutputBudget) {
    this.#budget = budget;
  }

  writeByte(value: number): void {
    this.#budget.add(1);
    this.#grow(1);
    this.#buffer[this.#length++] = value;
  }

  write(chunk: Uint8Array): void {
    this.#budget.add(chunk.byteLength);
    this.#grow(chunk.byteLength);
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.byteLength;
  }

  /** Appends stack[top-1] down to stack[0]. */
  writeReversed(stack: Uint8Array, top: number): void {
    this.#budget.add(top);
    this.#grow(top);
    for (let index = top - 1; index >= 0; index--) {
      this.#buffer[this.#length++] = stack[index]!;
    }
  }

  result(): Uint8Array {
    return this.#buffer.subarray(0, this.#length);
  }

  #grow(extra: number): void {
    if (this.#length + extra <= this.#buffer.byteLength) return;
    const next = new Uint8Array(
      Math.max(this.#buffer.byteLength * 2, this.#length + extra),
    );
    next.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = next;
  }
}

abstract class CompressorParser implements Parser {
  abstract readonly name: string;
  abstract readonly types: readonly string[];
  protected abstract decompress(
    data: Uint8Array,
    budget: OutputBudget,
    ctx: ParseContext,
  ): Uint8Array | Promise<Uint8Array>;
  protected abstract readonly extension: RegExp;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(this.types.map((type) => MediaType.parse(type)!));
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
      decompressed = await this.decompress(
        data,
        new OutputBudget(data.byteLength, inflateLimits(ctx), `${this.name} output`),
        ctx,
      );
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError(`Invalid ${this.name} stream`, {
        cause: error,
      });
    }

    checkDecompression(ctx, data.byteLength, decompressed.byteLength, this.name);

    const name = (metadata.get("tk:resource-name") ?? "embedded").replace(
      this.extension,
      "",
    );

    await withXhtml(handler, metadata, async (xhtml) => {
      await parseEntry(xhtml, name || "embedded", decompressed, metadata, ctx);
    });
  }
}

export class Bzip2Parser extends CompressorParser {
  readonly name = "Bzip2Parser";
  readonly types = ["application/x-bzip2", "application/x-bzip"] as const;
  protected readonly extension = /\.(bz2|bz|tbz2|tbz)$/i;

  protected decompress(data: Uint8Array, budget: OutputBudget): Uint8Array {
    const sink = new BudgetedSink(budget);
    // seek-bzip accepts any object with writeByte as output stream.
    (bzip.decode as (input: Uint8Array, output: BudgetedSink) => unknown)(data, sink);
    return sink.result();
  }
}

export class BrotliParser extends CompressorParser {
  readonly name = "BrotliParser";
  readonly types = ["application/x-brotli"] as const;
  protected readonly extension = /\.(br|brotli)$/i;

  protected decompress(
    data: Uint8Array,
    _budget: OutputBudget,
    ctx: ParseContext,
  ): Uint8Array {
    return inflateBounded(data, "brotli", inflateLimits(ctx));
  }
}

interface Lz4Module {
  readonly decompress?: (value: Uint8Array, maxSize?: number) => Uint8Array;
  readonly decompressBound?: (value: Uint8Array) => number;
}

/** Largest LZ4 block (4 MiB); decompressBound assumes every block is full. */
const LZ4_MAX_BLOCK_BYTES = 4 * 1024 * 1024;

type XzConstructor = new (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;

export class XzParser extends CompressorParser {
  readonly name = "XzParser";
  readonly types = ["application/x-xz"] as const;
  protected readonly extension = /\.(xz|txz)$/i;

  protected async decompress(
    data: Uint8Array,
    budget: OutputBudget,
  ): Promise<Uint8Array> {
    const module = (await import("xz-decompress")) as unknown as {
      readonly default?: { readonly XzReadableStream?: XzConstructor };
      readonly XzReadableStream?: XzConstructor;
    };
    const XzReadableStream =
      module.default?.XzReadableStream ?? module.XzReadableStream;
    if (XzReadableStream === undefined) {
      throw new MalformedDocumentError("XZ decompressor is unavailable");
    }
    const stream = new XzReadableStream(
      new Blob([data.slice().buffer as ArrayBuffer]).stream(),
    );
    const sink = new BudgetedSink(budget);
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.write(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return sink.result();
  }
}

export class Lz4Parser extends CompressorParser {
  readonly name = "Lz4Parser";
  readonly types = ["application/x-lz4"] as const;
  protected readonly extension = /\.lz4$/i;

  protected async decompress(
    data: Uint8Array,
    budget: OutputBudget,
  ): Promise<Uint8Array> {
    const module = (await import("lz4js")) as unknown as {
      readonly default?: Lz4Module;
    } & Lz4Module;
    const lz4 = module.default?.decompress !== undefined ? module.default : module;
    if (lz4.decompress === undefined || lz4.decompressBound === undefined) {
      throw new MalformedDocumentError("LZ4 decompressor is unavailable");
    }
    // decompressBound only walks block headers; reject before allocating.
    const bound = lz4.decompressBound(data);
    if (!(bound <= budget.limit + LZ4_MAX_BLOCK_BYTES)) {
      throw new LimitExceededError(
        `Lz4Parser output exceeds ${budget.limit} bytes (declared ${bound})`,
      );
    }
    const result = lz4.decompress(data, bound);
    budget.add(result.byteLength);
    return result;
  }
}

export class SnappyParser extends CompressorParser {
  readonly name = "SnappyParser";
  readonly types = ["application/x-snappy-framed"] as const;
  protected readonly extension = /\.(sz|snappy)$/i;

  protected async decompress(
    data: Uint8Array,
    budget: OutputBudget,
  ): Promise<Uint8Array> {
    const module = (await import("snappyjs")) as unknown as {
      readonly default?: { uncompress?: SnappyUncompress };
      uncompress?: SnappyUncompress;
    };
    const uncompress = module.default?.uncompress ?? module.uncompress;
    if (uncompress === undefined) {
      throw new MalformedDocumentError("Snappy decompressor is unavailable");
    }
    return uncompressSnappyFrames(data, uncompress, budget);
  }
}

type SnappyUncompress = (value: Uint8Array, maxLength?: number) => Uint8Array;

/** The framing format caps each chunk's uncompressed data at 64 KiB. */
const SNAPPY_MAX_CHUNK_BYTES = 65536;

function uncompressSnappyFrames(
  data: Uint8Array,
  uncompress: SnappyUncompress,
  budget: OutputBudget,
): Uint8Array {
  const sink = new BudgetedSink(budget);
  let offset = 0;
  while (offset + 4 <= data.byteLength) {
    const type = data[offset]!;
    const length = data[offset + 1]! | (data[offset + 2]! << 8) | (data[offset + 3]! << 16);
    offset += 4;
    if (length > data.byteLength - offset) {
      throw new MalformedDocumentError("Truncated Snappy frame");
    }
    const chunk = data.subarray(offset, offset + length);
    offset += length;
    if (type === 0x00) {
      // snappyjs allocates the length declared in the chunk's varint preamble.
      sink.write(uncompress(chunk.subarray(4), SNAPPY_MAX_CHUNK_BYTES));
    } else if (type === 0x01) {
      sink.write(chunk.subarray(4));
    } else if (type === 0xff) {
      if (!isSnappyIdentifier(chunk)) {
        throw new MalformedDocumentError("Invalid Snappy stream identifier");
      }
    }
  }
  return sink.result();
}

function isSnappyIdentifier(chunk: Uint8Array): boolean {
  return (
    chunk.byteLength === 6 &&
    new TextDecoder("latin1").decode(chunk) === "sNaPpY"
  );
}
