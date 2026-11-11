import { MediaType } from "@spikedpunch/ripstream-core";

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

/**
 * Tika's `new MediaType(incoming, charset)`, as its text parsers write `Content-Type`: the type the document was detected
 * as (`fallback` when there is none, or it does not parse), its other parameters kept, its `charset` set to the one the
 * document was decoded with. Pass `null` as `incoming` where Tika builds the type from a constant.
 */
export function withCharset(incoming: string | null, fallback: string, charset: string): string {
  const base = MediaType.parse(incoming) ?? MediaType.parseOrThrow(fallback);
  return base.withParameters({ charset }).toString();
}
