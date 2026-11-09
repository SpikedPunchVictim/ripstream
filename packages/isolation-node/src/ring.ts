const DEFAULT_CAPACITY_BYTES = 8 * 1024;

/**
 * Bounded buffer that keeps only the LAST `capacity` bytes pushed into it.
 * Used for the child's stderr: never grows regardless of how much a hostile
 * child writes, and the tail is what explains a crash.
 */
export class StderrRing {
  readonly #buffer: Uint8Array;
  #length = 0;
  #truncated = false;

  constructor(capacityBytes: number = DEFAULT_CAPACITY_BYTES) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 4) {
      throw new RangeError(
        `StderrRing capacity must be a safe integer >= 4 bytes, got ${String(capacityBytes)}`,
      );
    }
    this.#buffer = new Uint8Array(capacityBytes);
  }

  push(chunk: Uint8Array): void {
    const capacity = this.#buffer.length;
    if (chunk.length === 0) return;
    if (chunk.length >= capacity) {
      this.#buffer.set(chunk.subarray(chunk.length - capacity));
      this.#length = capacity;
      this.#truncated = this.#truncated || chunk.length > capacity;
      return;
    }
    const overflow = this.#length + chunk.length - capacity;
    if (overflow > 0) {
      this.#buffer.copyWithin(0, overflow, this.#length);
      this.#length -= overflow;
      this.#truncated = true;
    }
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.length;
  }

  /** Bytes currently held (never more than `capacityBytes`). */
  retainedBytes(): number {
    return this.#length;
  }

  /** Size of the backing store, fixed at construction. */
  get capacityBytes(): number {
    return this.#buffer.length;
  }

  /**
   * The retained tail decoded as UTF-8. Invalid sequences become U+FFFD. When
   * bytes were dropped, leading continuation bytes (the tail of a code point
   * cut at the boundary) are discarded instead of decoded as garbage.
   */
  text(): string {
    let start = 0;
    if (this.#truncated) {
      while (start < this.#length && start < 3 && ((this.#buffer[start] ?? 0) & 0xc0) === 0x80) {
        start++;
      }
    }
    return new TextDecoder("utf-8").decode(this.#buffer.subarray(start, this.#length));
  }
}
