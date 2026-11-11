import { MalformedDocumentError, type OutputBudget } from "@spikedpunch/ripstream-core";

/**
 * Output of a back-reference decoder (LZMA, Deflate64). The bytes written so far are also the dictionary, so a
 * match reads straight from them. Every byte is counted against the OutputBudget before the buffer grows to hold
 * it, so a hostile stream stops at the cap instead of at the end of memory.
 */
export class OutputWindow {
  #buffer = new Uint8Array(65536);
  #length = 0;
  readonly #budget: OutputBudget;

  constructor(budget: OutputBudget) {
    this.#budget = budget;
  }

  get length(): number {
    return this.#length;
  }

  /** The byte `distance` + 1 places back; 0 is the byte written last. The caller has checked the distance. */
  byteBack(distance: number): number {
    return this.#buffer[this.#length - distance - 1]!;
  }

  put(value: number): void {
    this.#reserve(1);
    this.#buffer[this.#length++] = value;
  }

  /** Copies `count` bytes from `distance` + 1 places back (overlap repeats, as LZ77 requires). */
  copy(distance: number, count: number): void {
    if (distance >= this.#length) throw new MalformedDocumentError("Match distance is beyond the data");
    this.#reserve(count);
    let from = this.#length - distance - 1;
    for (let remaining = count; remaining > 0; remaining--) this.#buffer[this.#length++] = this.#buffer[from++]!;
  }

  /** Appends bytes that are already in hand (a stored block). */
  write(chunk: Uint8Array): void {
    this.#reserve(chunk.byteLength);
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.byteLength;
  }

  result(): Uint8Array {
    return this.#buffer.subarray(0, this.#length);
  }

  #reserve(extra: number): void {
    this.#budget.add(extra);
    const needed = this.#length + extra;
    if (needed <= this.#buffer.byteLength) return;
    const grown = new Uint8Array(Math.max(this.#buffer.byteLength * 2, needed));
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }
}
