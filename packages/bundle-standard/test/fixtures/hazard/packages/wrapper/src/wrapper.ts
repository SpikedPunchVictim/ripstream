import { HazardParser } from "@spikedpunch/ripstream-fixture-base";

/** Wraps a hazard parser from another package: no hazard library is imported here, only the other package. */
export class CrossPackageWrapperParser {
  readonly #inner = new HazardParser();

  getSupportedTypes(): ReadonlySet<{ toString(): string }> {
    return this.#inner.getSupportedTypes();
  }

  parse(): Promise<void> {
    return this.#inner.parse();
  }
}
