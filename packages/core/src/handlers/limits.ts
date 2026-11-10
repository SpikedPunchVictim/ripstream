import {
  ContentHandlerDecorator,
  type MaybePromise,
} from "../content-handler.ts";
import { LimitExceededError } from "../errors.ts";

/**
 * The problem with an output-character limit, or null when it is valid. `-1` is the documented "unlimited" sentinel;
 * NaN and any other negative value would silently disable the cap (`written > NaN` is never true), so they fail fast.
 */
export function outputLimitIssue(name: string, value: unknown): string | null {
  if (typeof value !== "number" || Number.isNaN(value) || (value < 0 && value !== -1)) {
    return `${name} must be a non-negative number or -1 (unlimited), got ${String(value)}`;
  }
  return null;
}

/** Validates an output-character limit; see {@link outputLimitIssue}. */
export function assertValidOutputLimit(name: string, value: number): void {
  const issue = outputLimitIssue(name, value);
  if (issue !== null) throw new RangeError(issue);
}

/** Throws once more than the configured number of output characters is written. */
export class OutputLimitContentHandler extends ContentHandlerDecorator {
  readonly #limit: number;
  #written = 0;

  constructor(delegate: ConstructorParameters<typeof ContentHandlerDecorator>[0], limit: number) {
    super(delegate);
    assertValidOutputLimit("maxOutputChars", limit);
    this.#limit = limit;
  }

  characters(ch: string, start: number, length: number): MaybePromise<void> {
    this.#count(length);
    return super.characters(ch, start, length);
  }

  ignorableWhitespace(
    ch: string,
    start: number,
    length: number,
  ): MaybePromise<void> {
    this.#count(length);
    return super.ignorableWhitespace(ch, start, length);
  }

  #count(length: number): void {
    if (this.#limit < 0) return;
    this.#written += length;
    if (this.#written > this.#limit) {
      throw new LimitExceededError(`Output exceeds ${this.#limit} characters`);
    }
  }
}
