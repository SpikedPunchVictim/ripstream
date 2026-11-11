import { languageResult, type LanguageDetector, type LanguageResult } from "@spikedpunch/ripstream-core";
import { franc } from "franc";

/** franc-backed ISO 639-3 language detector. */
export class FrancLanguageDetector implements LanguageDetector {
  readonly #minimumLength: number;

  constructor(options: { minimumLength?: number } = {}) {
    this.#minimumLength = options.minimumLength ?? 10;
  }

  detect(text: string): LanguageResult {
    if (text.length < this.#minimumLength) {
      return { language: "und", confidence: 0, isReasonablyCertain: false };
    }
    const language = franc(text, { minLength: this.#minimumLength });
    return languageResult(
      language === "und" ? "und" : language,
      language === "und" ? 0 : 0.9,
    );
  }
}
export { toIso6391 } from "./iso639.ts";
export { StreamingLanguageDetector } from "./streaming.ts";
export { ReliableTranslator, RemoteTranslator, type ReliabilityOptions, type TranslationConfig, type TranslationProvider } from "./translate.ts";
export { Cld3LanguageDetector } from "./cld3.ts";
export { CharSoupLanguageDetector, type CharSoupConfidence, type CharSoupOptions, type CharSoupResult } from "./charsoup.ts";
