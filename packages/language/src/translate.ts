import { TranslationError, type Translator } from "@spikedpunch/ripstream-core";

export type TranslationProvider = "libre" | "deepl" | "google" | "microsoft" | "local";

export interface TranslationConfig {
  readonly provider: TranslationProvider;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly local?: (text: string, target: string) => string;
}

/** HTTP translation adapters for LibreTranslate, DeepL, Google and Microsoft. */
export class RemoteTranslator implements Translator {
  readonly #config: TranslationConfig;
  readonly #fetch: typeof fetch;

  constructor(config: TranslationConfig) {
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async translate(text: string, target: string, source?: string): Promise<string> {
    switch (this.#config.provider) {
      case "local":
        if (this.#config.local === undefined) {
          throw new TranslationError("Local translator requires a function");
        }
        return this.#config.local(text, target);
      case "libre":
        return this.#libre(text, target, source);
      case "deepl":
        return this.#deepl(text, target, source);
      case "google":
        return this.#google(text, target, source);
      case "microsoft":
        return this.#microsoft(text, target, source);
      default:
        throw new TranslationError(`Unsupported provider: ${String(this.#config.provider)}`);
    }
  }

  async #libre(text: string, target: string, source?: string): Promise<string> {
    const endpoint = this.#config.endpoint ?? "https://libretranslate.com/translate";
    const payload = await this.#json(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target, ...(source === undefined ? {} : { source }), format: "text" }),
    });
    return String(payload.translatedText ?? "");
  }

  async #deepl(text: string, target: string, source?: string): Promise<string> {
    const endpoint = this.#config.endpoint ?? "https://api-free.deepl.com/v2/translate";
    const body = new URLSearchParams({ text, target_lang: target.toUpperCase() });
    if (source !== undefined) body.set("source_lang", source.toUpperCase());
    const payload = await this.#json(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(this.#config.apiKey === undefined ? {} : { Authorization: `DeepL-Auth-Key ${this.#config.apiKey}` }),
      },
      body,
    });
    return String((payload.translations as Array<{ text?: string }> | undefined)?.[0]?.text ?? "");
  }

  async #google(text: string, target: string, source?: string): Promise<string> {
    const endpoint = this.#config.endpoint ?? "https://translation.googleapis.com/language/translate/v2";
    const url = new URL(endpoint);
    if (this.#config.apiKey !== undefined) url.searchParams.set("key", this.#config.apiKey);
    const payload = await this.#json(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target, format: "text", ...(source === undefined ? {} : { source }) }),
    });
    return String((payload.data as { translations?: Array<{ translatedText?: string }> } | undefined)?.translations?.[0]?.translatedText ?? "");
  }

  async #microsoft(text: string, target: string, source?: string): Promise<string> {
    const endpoint = this.#config.endpoint ?? "https://api.cognitive.microsofttranslator.com/translate";
    const url = new URL(endpoint);
    url.searchParams.set("api-version", "3.0");
    url.searchParams.set("to", target);
    if (source !== undefined) url.searchParams.set("from", source);
    const payload = await this.#json(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.#config.apiKey === undefined ? {} : { "Ocp-Apim-Subscription-Key": this.#config.apiKey }),
      },
      body: JSON.stringify([{ Text: text }]),
    });
    const first = Array.isArray(payload) ? payload[0] : payload;
    return String((first as { translations?: Array<{ text?: string }> } | undefined)?.translations?.[0]?.text ?? "");
  }

  async #json(url: string | URL, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      throw new TranslationError(`Translation request failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

export interface ReliabilityOptions {
  readonly attempts?: number;
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
}

/** Adds retry, timeout and minimum interval between calls to any translator. */
export class ReliableTranslator implements Translator {
  readonly #delegate: Translator;
  readonly #options: Required<ReliabilityOptions>;
  #lastCall = 0;

  constructor(delegate: Translator, options: ReliabilityOptions = {}) {
    this.#delegate = delegate;
    this.#options = {
      attempts: options.attempts ?? 3,
      minIntervalMs: options.minIntervalMs ?? 0,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
  }

  async translate(text: string, target: string, source?: string): Promise<string> {
    let last: unknown;
    for (let attempt = 0; attempt < this.#options.attempts; attempt++) {
      const wait = this.#lastCall + this.#options.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.#lastCall = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.#delegate.translate(text, target, source),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new TranslationError("Translation timed out")),
              this.#options.timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw last instanceof Error ? last : new TranslationError(String(last));
  }
}
