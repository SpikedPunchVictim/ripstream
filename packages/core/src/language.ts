import { RipstreamError } from "./errors.ts";

export interface LanguageResult {
  readonly language: string;
  readonly confidence: number;
  readonly isReasonablyCertain: boolean;
}

export interface LanguageDetector {
  detect(text: string): LanguageResult | Promise<LanguageResult>;
}

/** Tika's `LanguageConfidence`: how far a verdict is to be trusted. */
export type LanguageConfidenceName = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** Tika's `LanguageResult` for one text: `language` is "" and `rawScore` 0 when no language was found. */
export interface LanguageIdentification {
  /** ISO 639-3 apart from the few codes a detector adds, or "" when there is none. */
  readonly language: string;
  readonly confidence: LanguageConfidenceName;
  /** The detector's own score; a float, which is how Tika reports it. */
  readonly rawScore: number;
}

/**
 * A detector that gives Tika's verdict for a whole text, which is what the language metadata filter writes. Core has none:
 * the one ripstream ships is in `@spikedpunch/ripstream-language`, and is handed to a chain by whoever builds it.
 */
export interface LanguageIdentifier {
  /** `maxLength` is the characters of the text to read; absent, the identifier's own limit. */
  identify(text: string, options?: { readonly maxLength?: number }): LanguageIdentification;
}

export class TranslationError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("TRANSLATION_FAILED", message, options);
  }
}

export interface Translator {
  translate(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<string>;
}

/** No-op translator used when translation is not configured. */
export class IdentityTranslator implements Translator {
  async translate(text: string): Promise<string> {
    return text;
  }
}

export function languageResult(
  language: string,
  confidence = 1,
): LanguageResult {
  return {
    language,
    confidence,
    isReasonablyCertain: confidence >= 0.8,
  };
}
