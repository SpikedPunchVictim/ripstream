export interface VlmOcrOptions {
  readonly language?: string;
  readonly prompt?: string;
  readonly timeoutMs?: number;
}

export interface VlmOcrResult {
  readonly text: string;
  readonly model?: string;
  readonly confidence?: number;
}

export interface VlmOcrProvider {
  readonly name: string;
  ocr(image: Uint8Array, options?: VlmOcrOptions): Promise<VlmOcrResult>;
}

export class VlmError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "VlmError";
  }
}

/** Disabled provider used when no VLM backend is configured. */
export class DisabledVlmProvider implements VlmOcrProvider {
  readonly name = "disabled";
  async ocr(): Promise<VlmOcrResult> {
    throw new VlmError("No VLM OCR provider is configured");
  }
}
