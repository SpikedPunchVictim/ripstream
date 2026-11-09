import { FIXTURE_TYPE } from "@spikedpunch/ripstream-fixture-util";

/** Imports another package, but one that reaches no hazard: it must not be flagged. */
export class CleanParser {
  getSupportedTypes(): ReadonlySet<{ toString(): string }> {
    return new Set([{ toString: () => FIXTURE_TYPE }]);
  }

  async parse(): Promise<void> {}
}

/** A subclass of a clean parser: the prototype-chain check must not flag every subclass. */
export class CleanChildParser extends CleanParser {}
