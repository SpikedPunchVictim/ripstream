import type { LanguageDetector, LanguageResult } from "@spikedpunch/ripstream-core";

/** Incremental detector that buffers a bounded prefix of the text stream. */
export class StreamingLanguageDetector {
  readonly #detector: LanguageDetector;
  readonly #maxLength: number;
  #text = "";
  #result: LanguageResult = { language: "und", confidence: 0, isReasonablyCertain: false };

  constructor(detector: LanguageDetector, maxLength = 20_000) {
    this.#detector = detector;
    this.#maxLength = maxLength;
  }

  async feed(chunk: string): Promise<LanguageResult> {
    if (this.#text.length < this.#maxLength) {
      this.#text += chunk.slice(0, this.#maxLength - this.#text.length);
    }
    this.#result = await this.#detector.detect(this.#text);
    return this.#result;
  }

  get result(): LanguageResult {
    return this.#result;
  }

  reset(): void {
    this.#text = "";
    this.#result = { language: "und", confidence: 0, isReasonablyCertain: false };
  }
}
