import { MissingDependencyError, type LanguageDetector, type LanguageResult } from "@spikedpunch/ripstream-core";

interface Cld3Module {
  readonly create?: () => Promise<{ identify(text: string): { language: string; probability: number } }>;
}

/** Optional CLD3 backend; requires the `cld3-asm` package. */
export class Cld3LanguageDetector implements LanguageDetector {
  async detect(text: string): Promise<LanguageResult> {
    let module: Cld3Module;
    try {
      module = (await import("cld3-asm")) as unknown as Cld3Module;
    } catch {
      throw new MissingDependencyError("cld3-asm", "CLD3 language detection");
    }
    const detector = await module.create?.();
    if (detector === undefined) {
      throw new MissingDependencyError("cld3-asm", "CLD3 language detection");
    }
    const result = detector.identify(text);
    return {
      language: result.language,
      confidence: result.probability,
      isReasonablyCertain: result.probability >= 0.8,
    };
  }
}
