import { MediaType, type Metadata } from "@spikedpunch/ripstream-core";

export const FALLBACK_CHARSET = "utf-8";

/** The part of TextDecoder the parsers use, so that UTF-32, which TextDecoder lacks, can stand in for it. */
export interface StreamDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

export interface CharsetDecoder {
  readonly decoder: StreamDecoder;
  /** The charset actually used (the fallback when the label was unsupported). */
  readonly charset: string;
}

/**
 * Creates a lenient decoder. TextDecoder throws RangeError for labels it does not know (vendor charsets); fall back to
 * UTF-8 rather than failing the whole parse, and report the charset actually used. UTF-32 is decoded here.
 */
export function createDecoder(label: string): CharsetDecoder {
  if (/^utf-?32(le|be)?$/i.test(label)) return { decoder: new Utf32Decoder(label), charset: label };
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
 * UTF-32: four bytes to a code point, a leading BOM left out, one U+FFFD for each unit that is not a Unicode scalar value
 * and for a last unit that is cut off. Without a byte order in the label the BOM says it, and big-endian is the default.
 */
class Utf32Decoder implements StreamDecoder {
  #little: boolean;
  readonly #byteOrderKnown: boolean;
  #started = false;
  #pending = new Uint8Array(0);

  constructor(label: string) {
    const named = /(le|be)$/i.exec(label)?.[1]?.toLowerCase();
    this.#byteOrderKnown = named !== undefined;
    this.#little = named === "le";
  }

  decode(input?: Uint8Array, options?: { stream?: boolean }): string {
    let data = this.#pending;
    if (input !== undefined && input.length > 0) {
      data = new Uint8Array(this.#pending.length + input.length);
      data.set(this.#pending);
      data.set(input, this.#pending.length);
    }
    let at = 0;
    if (!this.#started) {
      if (data.length < 4 && options?.stream === true) {
        this.#pending = data;
        return "";
      }
      this.#started = true;
      if (data.length >= 4) {
        const leBom = data[0] === 0xff && data[1] === 0xfe && data[2] === 0 && data[3] === 0;
        const beBom = data[0] === 0 && data[1] === 0 && data[2] === 0xfe && data[3] === 0xff;
        if (leBom || beBom) {
          at = 4;
          if (!this.#byteOrderKnown) this.#little = leBom;
        }
      }
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const parts: string[] = [];
    let batch: number[] = [];
    for (; at + 4 <= data.length; at += 4) {
      const unit = view.getUint32(at, this.#little);
      batch.push(unit > 0x10ffff || (unit >= 0xd800 && unit <= 0xdfff) ? 0xfffd : unit);
      if (batch.length >= 4096) {
        parts.push(String.fromCodePoint(...batch));
        batch = [];
      }
    }
    if (options?.stream === true) {
      this.#pending = data.slice(at);
    } else {
      if (at < data.length) batch.push(0xfffd);
      this.#pending = new Uint8Array(0);
      this.#started = false;
    }
    if (batch.length > 0) parts.push(String.fromCodePoint(...batch));
    return parts.join("");
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

/**
 * `TikaCoreProperties.DETECTED_ENCODING` (`tk:detected-encoding`), which Tika's AutoDetectReader writes for every text parser that
 * reads through it: the charset the text is decoded with. Tika also writes `tk:encoding-detector` (the simple class name of the
 * detector that won, such as `MojibusterEncodingDetector`); it is not written here, because ripstream's detector is not Tika's
 * chain and has no name that would be true to it.
 */
export function recordDetectedEncoding(metadata: Metadata, charset: string): void {
  metadata.set("tk:detected-encoding", charset);
}
