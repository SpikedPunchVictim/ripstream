import { javaDoubleString } from "./java-double.ts";
import type { LanguageIdentifier } from "./language.ts";
import type { Metadata } from "./metadata.ts";
import { MetadataFilterBase } from "./metadata-filter.ts";
import { TIKA_KEYS } from "./tika-keys.ts";

export interface LanguageDetectionOptions {
  readonly identifier: LanguageIdentifier;
  /** The characters of the content to read. A whole number from 1 to 2147483647 (an `int`); absent, the identifier's own limit. */
  readonly maxLength?: number;
}

/** The `maxLength` a filter can use: Tika's is an `int`, and one that reads nothing makes every verdict NONE. */
export const LANGUAGE_MAX_LENGTH_RANGE = { min: 1, max: 2 ** 31 - 1 } as const;

/**
 * Detects the language of a document's `tk:content` and writes it as Tika's `CharSoupMetadataFilter` does: the language
 * to `tk:detected-language`, the confidence's name to `tk:detected-language-confidence` and the raw score, as
 * `Double.toString` writes it, to `tk:detected-language-confidence-raw`, each replacing what the document had. A document
 * with no content, or an empty one, is left alone; blank content is detected, and is NONE. Tika accepts a `maxLength`
 * that reads no characters and then reports NONE for every document; this refuses it up front.
 */
export class LanguageDetectionMetadataFilter extends MetadataFilterBase {
  readonly #identifier: LanguageIdentifier;
  readonly #maxLength: number | undefined;

  constructor(options: LanguageDetectionOptions) {
    super();
    const { maxLength } = options;
    const { min, max } = LANGUAGE_MAX_LENGTH_RANGE;
    if (maxLength !== undefined && !(Number.isInteger(maxLength) && maxLength >= min && maxLength <= max)) {
      throw new RangeError(`maxLength must be a whole number from ${min} to ${max}, not ${String(maxLength)}`);
    }
    this.#identifier = options.identifier;
    this.#maxLength = maxLength;
  }

  protected override filterOne(metadata: Metadata): void {
    const content = metadata.get(TIKA_KEYS.CONTENT);
    if (content === null || content === "") return;
    const found = this.#identifier.identify(content, this.#maxLength === undefined ? undefined : { maxLength: this.#maxLength });
    metadata.set(TIKA_KEYS.DETECTED_LANGUAGE, found.language);
    metadata.set(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE, found.confidence);
    metadata.set(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW, javaDoubleString(found.rawScore));
  }
}
