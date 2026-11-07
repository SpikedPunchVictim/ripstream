export const FALLBACK_CHARSET = "utf-8";

export interface CharsetDecoder {
  readonly decoder: TextDecoder;
  /** The charset actually used (the fallback when the label was unsupported). */
  readonly charset: string;
}

/**
 * Creates a lenient TextDecoder. TextDecoder throws RangeError for labels it
 * does not know (UTF-32, vendor charsets); fall back to UTF-8 rather than
 * failing the whole parse, and report the charset actually used.
 */
export function createDecoder(label: string): CharsetDecoder {
  try {
    return { decoder: new TextDecoder(label, { fatal: false }), charset: label };
  } catch {
    return {
      decoder: new TextDecoder(FALLBACK_CHARSET, { fatal: false }),
      charset: FALLBACK_CHARSET,
    };
  }
}
