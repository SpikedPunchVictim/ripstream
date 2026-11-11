import type { Metadata } from "@spikedpunch/ripstream-core";
import { javaIsBlank } from "./java-compat.ts";

/** Metadata.MAX_PREFIX_ROUTE_NAME_LENGTH: a source-derived name longer than this is skipped. */
const MAX_NAME_CHARS = 1024;
/** Metadata.MAX_PREFIX_ROUTE_NAMES: after this many distinct names, a new one is skipped. */
const MAX_NAMES = 10_000;

/**
 * Tika's `Metadata.add(KeyPrefix, name, value)`: the route for names that come from the document, written as `prefix + name`.
 * A blank name, a name over 1024 characters, or a new name after 10,000 distinct ones is skipped (Tika logs a warning and goes on),
 * and an unpaired surrogate in the name or the value becomes U+FFFD. One writer serves one parse: Tika counts the distinct names
 * per Metadata object, this counts them per writer.
 */
export class KeyPrefixWriter {
  readonly #metadata: Metadata;
  readonly #prefix: string;
  #names = 0;

  constructor(metadata: Metadata, prefix: string) {
    this.#metadata = metadata;
    this.#prefix = prefix;
  }

  add(name: string, value: string): void {
    if (javaIsBlank(name) || name.length > MAX_NAME_CHARS) return;
    const key = this.#prefix + name.toWellFormed();
    if (!this.#metadata.has(key)) {
      if (this.#names >= MAX_NAMES) return;
      this.#names++;
    }
    this.#metadata.add(key, value.toWellFormed());
  }
}
