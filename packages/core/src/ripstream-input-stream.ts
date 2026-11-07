import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputSource } from "./content-handler.ts";
import { LimitExceededError } from "./errors.ts";
import type { ParseContext } from "./parse-context.ts";
import { toAsyncIterable, type StreamOptions } from "./streams.ts";

export interface RipstreamInputStreamOptions extends StreamOptions {
  readonly spoolThreshold?: number;
  readonly context?: ParseContext;
}

/**
 * Port of org.apache.tika.io.TikaInputStream's storage model: bytes stay in
 * memory until a threshold, then migrate to a temporary file so parsers can
 * seek/mark/reset. Sequential consumers keep streaming through `read()`.
 */
export class RipstreamInputStream implements AsyncIterable<Uint8Array>, AsyncDisposable {
  static async from(
    source: InputSource,
    options: RipstreamInputStreamOptions = {},
  ): Promise<RipstreamInputStream> {
    const iterator = toAsyncIterable(source, options)[Symbol.asyncIterator]();
    const stream = new RipstreamInputStream(iterator, options);
    options.context?.resources.add(stream);
    return stream;
  }

  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly spoolThreshold: number;
  private readonly signal: AbortSignal | undefined;
  private readonly chunks: Uint8Array[] = [];
  private bytesStored = 0;
  private cursor = 0;
  private markedCursor = 0;
  private eof = false;
  private closed = false;
  private handle: FileHandle | null = null;
  private directory: string | null = null;
  private path: string | null = null;

  private constructor(
    iterator: AsyncIterator<Uint8Array>,
    options: RipstreamInputStreamOptions,
  ) {
    this.iterator = iterator;
    this.spoolThreshold = options.spoolThreshold ?? 1024 * 1024;
    this.signal = options.signal;
  }

  get hasFile(): boolean {
    return this.path !== null;
  }

  get length(): number | null {
    return this.eof ? this.bytesStored : null;
  }

  get position(): number {
    return this.cursor;
  }

  getPath(): string | null {
    return this.path;
  }

  async peek(count: number): Promise<Uint8Array> {
    await this.ensureBuffered(count);
    const available = this.bytesStored - this.cursor;
    return this.readAt(this.cursor, Math.min(count, available));
  }

  async read(): Promise<Uint8Array | null> {
    await this.ensureBuffered(1);
    const available = this.bytesStored - this.cursor;
    if (available <= 0) return null;
    const length = Math.min(64 * 1024, available);
    const chunk = await this.readAt(this.cursor, length);
    this.cursor += chunk.length;
    return chunk;
  }

  async readFully(maxBytes: number): Promise<Uint8Array> {
    await this.ensureBuffered(maxBytes);
    const available = this.bytesStored - this.cursor;
    if (available > maxBytes) {
      throw new LimitExceededError(`Input exceeds ${maxBytes} bytes`);
    }
    const result = await this.readAt(this.cursor, available);
    this.cursor += result.length;
    return result;
  }

  mark(): void {
    this.markedCursor = this.cursor;
  }

  async reset(): Promise<void> {
    if (this.markedCursor > this.bytesStored) {
      await this.ensureBuffered(this.markedCursor - this.cursor);
    }
    this.cursor = Math.min(this.markedCursor, this.bytesStored);
  }

  async seek(
    offset: number,
    whence: "start" | "current" | "end" = "start",
  ): Promise<number> {
    if (whence === "end") await this.drain();
    const target =
      whence === "start" ? offset : whence === "current" ? this.cursor + offset : this.bytesStored + offset;
    if (target < 0) throw new RangeError("Negative seek position");
    if (target > this.bytesStored) {
      await this.ensureBuffered(target - this.cursor);
      if (target > this.bytesStored) throw new RangeError("Seek past end of stream");
    }
    this.cursor = target;
    return target;
  }

  async getFile(): Promise<string> {
    await this.drain();
    await this.spill();
    return this.path!;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) return;
      yield chunk;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.iterator.return?.(undefined);
    } catch {
      // Iterator cleanup must not mask the original failure.
    }
    if (this.handle !== null) {
      await this.handle.close().catch(() => undefined);
      this.handle = null;
    }
    if (this.directory !== null) {
      await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
      this.directory = null;
      this.path = null;
    }
    this.chunks.length = 0;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async drain(): Promise<void> {
    while (!this.eof) await this.pull();
  }

  private async ensureBuffered(count: number): Promise<void> {
    while (this.bytesStored - this.cursor < count && !this.eof) {
      await this.pull();
    }
  }

  private async pull(): Promise<void> {
    if (this.eof) return;
    if (this.signal?.aborted === true) {
      throw this.signal.reason instanceof Error
        ? this.signal.reason
        : new DOMException("Aborted", "AbortError");
    }

    const { done, value } = await this.iterator.next();
    if (done) {
      this.eof = true;
      return;
    }
    if (value.byteLength === 0) return;

    if (this.handle !== null) {
      await this.handle.write(value, 0, value.byteLength, this.bytesStored);
    } else {
      this.chunks.push(value);
    }
    this.bytesStored += value.byteLength;
    // Spill as soon as the threshold is crossed so drain()/getFile()/seek("end")
    // never hold the whole input in memory.
    if (this.handle === null && this.bytesStored > this.spoolThreshold) {
      await this.spill();
    }
  }

  private async spill(): Promise<void> {
    if (this.path !== null) return;

    this.directory = await mkdtemp(join(tmpdir(), "ripstream-"));
    this.path = join(this.directory, "stream.bin");
    this.handle = await open(this.path, "w+", 0o600);

    let offset = 0;
    for (const chunk of this.chunks) {
      await this.handle.write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
    }
    this.chunks.length = 0;
  }

  private async readAt(cursor: number, max: number): Promise<Uint8Array> {
    if (this.handle !== null) {
      const buffer = new Uint8Array(max);
      const { bytesRead } = await this.handle.read(buffer, 0, max, cursor);
      return buffer.subarray(0, bytesRead);
    }

    const parts: Uint8Array[] = [];
    let position = 0;
    let remaining = max;
    for (const chunk of this.chunks) {
      const end = position + chunk.byteLength;
      if (end <= cursor) {
        position = end;
        continue;
      }
      const from = Math.max(0, cursor - position);
      const take = Math.min(chunk.byteLength - from, remaining);
      parts.push(chunk.subarray(from, from + take));
      remaining -= take;
      position = end;
      if (remaining === 0) break;
    }

    const result = new Uint8Array(max - remaining);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }
}
