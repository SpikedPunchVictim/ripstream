import { RipstreamError } from "./errors.ts";

export interface LanguageResult {
  readonly language: string;
  readonly confidence: number;
  readonly isReasonablyCertain: boolean;
}

export interface LanguageDetector {
  detect(text: string): LanguageResult | Promise<LanguageResult>;
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
