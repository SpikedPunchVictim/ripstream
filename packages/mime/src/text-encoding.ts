import { isAscii } from "node:buffer";
import { analyse } from "chardet";
import { latin1 } from "./latin1.ts";

export interface EncodingDetection {
  readonly charset: string;
  readonly confidence: number;
  readonly bom: boolean;
  readonly binary: boolean;
}

const BOMS: Array<{ bytes: number[]; charset: string; skip: number }> = [
  { bytes: [0x00, 0x00, 0xfe, 0xff], charset: "UTF-32BE", skip: 4 },
  { bytes: [0xff, 0xfe, 0x00, 0x00], charset: "UTF-32LE", skip: 4 },
  { bytes: [0xef, 0xbb, 0xbf], charset: "UTF-8", skip: 3 },
  { bytes: [0xfe, 0xff], charset: "UTF-16BE", skip: 2 },
  { bytes: [0xff, 0xfe], charset: "UTF-16LE", skip: 2 },
];

/**
 * Port of Ripstream's text/encoding heuristics: BOM, HTML/XML declarations,
 * UTF-8 validation, control-byte binary check, then statistical detection.
 *
 * `declared` is a charset the caller was told of (the charset parameter of an incoming Content-Type, or of a mail part).
 * It is tried before the document's own declaration, and, like it, only when the bytes can be in that charset (see
 * `chooseDeclared`). Measured against Tika 4.2.0, whose chain does the same for every text parser.
 */
export function detectEncoding(data: Uint8Array, declared?: string): EncodingDetection {
  const bom = detectBom(data);
  if (bom !== null) {
    return { charset: bom.charset, confidence: 1, bom: true, binary: false };
  }

  const utf16 = detectUtf16WithoutBom(data);
  if (utf16 !== null) {
    return { charset: utf16, confidence: 0.8, bom: false, binary: false };
  }

  // Whether this is text comes first and is decided by the bytes alone: a declaration or an escape sequence is no proof of
  // text, since binary data can hold the bytes of either. Which charset the text is in comes after.
  if (!looksLikeText(data)) {
    // A caller's charset is kept for binary-looking bytes, as before: it never decided whether they are text.
    return { charset: declared === undefined ? "ISO-8859-1" : canonicalLabel(declared), confidence: 0.1, bom: false, binary: true };
  }

  const chosen = chooseDeclared(data, declared);
  if (chosen !== null) {
    return { charset: chosen, confidence: 0.9, bom: false, binary: false };
  }

  const iso2022 = detectIso2022(data);
  if (iso2022 !== null) {
    return { charset: iso2022, confidence: 0.9, bom: false, binary: false };
  }

  // Tika 4.2.0's MojibusterEncodingDetector answers windows-1252 (the WHATWG default for unlabeled Western text) for a
  // probe under two bytes and for one that is pure ASCII, before it weighs any other charset.
  if (data.length < 2 || isPureAscii(data)) {
    return { charset: "windows-1252", confidence: 0.2, bom: false, binary: false };
  }

  if (isValidUtf8(data)) {
    return { charset: "UTF-8", confidence: 0.95, bom: false, binary: false };
  }

  const matches = analyse(data.subarray(0, 65_536));
  const best = matches[0];
  if (best !== undefined) {
    return {
      charset: canonicalLabel(normalizeCharset(best.name)),
      confidence: best.confidence / 100,
      bom: false,
      binary: false,
    };
  }

  return { charset: "windows-1252", confidence: 0.2, bom: false, binary: false };
}

/**
 * Whether the bytes are text, as far as the bytes can say: no NUL, and not more than 2% control bytes other than tab, line
 * feed, form feed, carriage return and ESC. ESC is safe because ISO-2022 text and the colours of a terminal's log are
 * made with it. The caller gives a prefix, as the detector does.
 */
export function looksLikeText(data: Uint8Array): boolean {
  return !isBinary(data);
}

/**
 * `detectEncoding(data).binary` without the charset work: the BOM and BOM-less UTF-16 checks answer text before the
 * control-byte count does, so they run first, and the statistical detector never does. For a caller that only needs to
 * know whether the bytes are text.
 */
export function isBinaryBytes(data: Uint8Array): boolean {
  if (detectBom(data) !== null) return false;
  if (detectUtf16WithoutBom(data) !== null) return false;
  return isBinary(data);
}

export function decodeText(data: Uint8Array, charset: string): string {
  const normalized = normalizeCharset(charset);
  if (/^UTF-32(LE|BE)?$/i.test(normalized)) return decodeUtf32(data, normalized);
  try {
    return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(data);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
}

/**
 * UTF-32, which TextDecoder does not have: four bytes to a code point, a leading BOM left out, and one U+FFFD for each
 * unit that is not a Unicode scalar value and for a last unit that is cut off. Without a byte order in the name the BOM
 * says it, and big-endian is the default, as the standard has it.
 */
function decodeUtf32(data: Uint8Array, charset: string): string {
  const named = /(LE|BE)$/i.exec(charset)?.[1]?.toUpperCase();
  let little = named === "LE";
  let start = 0;
  if (data.length >= 4) {
    const leBom = data[0] === 0xff && data[1] === 0xfe && data[2] === 0 && data[3] === 0;
    const beBom = data[0] === 0 && data[1] === 0 && data[2] === 0xfe && data[3] === 0xff;
    if (leBom || beBom) {
      start = 4;
      if (named === undefined) little = leBom;
    }
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts: string[] = [];
  let batch: number[] = [];
  const flush = (): void => {
    if (batch.length > 0) parts.push(String.fromCodePoint(...batch));
    batch = [];
  };
  let at = start;
  for (; at + 4 <= data.length; at += 4) {
    const unit = view.getUint32(at, little);
    batch.push(unit > 0x10ffff || (unit >= 0xd800 && unit <= 0xdfff) ? 0xfffd : unit);
    if (batch.length >= 4096) flush();
  }
  if (at < data.length) batch.push(0xfffd);
  flush();
  return parts.join("");
}

/**
 * Tika's StructuralEncodingRules.detectIso2022: the ESC designation sequences that distinguish ISO-2022-JP, -KR and
 * -CN. The text is 7-bit, so this must run before the pure-ASCII answer.
 */
function detectIso2022(data: Uint8Array): string | null {
  for (let index = 0; index < data.length - 1; index++) {
    if (data[index] !== 0x1b) continue;
    const next = data[index + 1]!;
    if (next === 0x28) continue; // ESC ( is a single-byte designation in every variant
    if (next !== 0x24) continue;
    if (index + 2 >= data.length) return "ISO-2022-JP";
    const third = data[index + 2]!;
    switch (third) {
      case 0x42: // ESC $ B — JIS X 0208-1983
      case 0x40: // ESC $ @ — JIS X 0208-1978
      case 0x28: // ESC $ ( — JIS X 0212 supplementary
        return "ISO-2022-JP";
      case 0x29: {
        if (index + 3 >= data.length) return "ISO-2022-JP";
        const fourth = data[index + 3]!;
        if (fourth === 0x43) return "ISO-2022-KR"; // ESC $ ) C
        if (fourth === 0x41 || fourth === 0x47) return "ISO-2022-CN"; // GB2312, CNS plane 1
        return "ISO-2022-JP";
      }
      case 0x2a: // ESC $ * — CNS 11643 plane 2
        return "ISO-2022-CN";
      default:
        return "ISO-2022-JP";
    }
  }
  return null;
}

function detectBom(data: Uint8Array): { charset: string } | null {
  for (const bom of BOMS) {
    if (data.length < bom.bytes.length) continue;
    if (bom.bytes.every((byte, index) => data[index] === byte)) {
      return { charset: bom.charset };
    }
  }
  return null;
}

function detectUtf16WithoutBom(data: Uint8Array): string | null {
  if (data.length < 8) return null;
  let evenZero = 0;
  let oddZero = 0;
  const sample = Math.min(data.length, 512);
  for (let index = 0; index < sample; index++) {
    if (data[index] === 0) {
      if (index % 2 === 0) evenZero++;
      else oddZero++;
    }
  }
  const pairs = sample / 2;
  if (oddZero / pairs > 0.6 && evenZero / pairs < 0.1) return "UTF-16LE";
  if (evenZero / pairs > 0.6 && oddZero / pairs < 0.1) return "UTF-16BE";
  return null;
}

/** Tika's HtmlEncodingDetector reads this many bytes: a declaration whose tag ends after them is not seen (measured: a meta ending at 8192 is read, one ending at 8200 is not). */
const DECLARATION_SCAN_BYTES = 8192;

/**
 * The label Tika reports for a charset the WHATWG standard reads as windows-1252 (its detectors answer windows-1252 for
 * iso-8859-1, latin1 and us-ascii, text parsers and HTML alike). Other labels are returned as they were written.
 */
export function canonicalLabel(label: string): string {
  return /^(iso[-_ ]?8859[-_]?1|latin-?1|l1|cp1252|x-cp1252|windows-1252|us-ascii|ascii|ansi_x3\.4-1968|iso-ir-100|ibm819|cp819|x-user-defined)$/i.test(
    label.trim(),
  )
    ? "windows-1252"
    : label;
}

/**
 * The first charset among `declared` and the document's own declarations that the bytes can be in. Tika 4.2.0 keeps the
 * declared charset (an incoming Content-Type's, then the page's) only when it is supported and the bytes decode in it
 * without a malformed sequence; otherwise it uses the statistical answer. And bytes that are valid UTF-8 and not ASCII are
 * UTF-8 whatever single-byte charset is declared ("structural" in its detection trace).
 */
function chooseDeclared(data: Uint8Array, declared: string | undefined): string | null {
  const candidates: string[] = [];
  if (declared !== undefined && declared.trim() !== "") candidates.push(normalizeCharset(declared));
  candidates.push(...declaredCharsets(data));
  for (const candidate of candidates) {
    if (!decodesCleanly(data, candidate)) continue;
    if (!/^utf-?8$/i.test(candidate) && !isPureAscii(data) && isValidUtf8(data)) return "UTF-8";
    return canonicalLabel(candidate);
  }
  return null;
}

/** Whether `charset` is one TextDecoder knows and `data` holds no malformed sequence in it. */
function decodesCleanly(data: Uint8Array, charset: string): boolean {
  try {
    // `stream` lets the sample end in the middle of a character.
    new TextDecoder(charset, { fatal: true }).decode(data, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The charsets the page declares, in the order Tika's HtmlEncodingDetector tries them: a meta tag outside a comment first
 * (a meta in a comment only when no other one declares anything), then an XML declaration. Any meta tag counts that has a
 * charset attribute or a content attribute with charset= in it, as in Tika (a `content="charset=..."` without
 * http-equiv, a refresh, a script's string). A declaration of UTF-16 or UTF-32 is read as UTF-8: a page whose own 8-bit
 * bytes say it is not in either, as the HTML standard has it.
 */
function declaredCharsets(data: Uint8Array): string[] {
  const head = latin1(data.subarray(0, DECLARATION_SCAN_BYTES));
  const outside = declaredNames(head.replace(/<!--[\s\S]*?-->/g, " "));
  const names = outside.length > 0 ? outside : declaredNames(head);
  return names.map((name) => (/^UTF-?(16|32)(LE|BE)?$/i.test(name) ? "UTF-8" : name));
}

function declaredNames(head: string): string[] {
  const found: Array<{ at: number; name: string }> = [];
  const add = (pattern: RegExp): void => {
    for (const match of head.matchAll(pattern)) found.push({ at: match.index ?? 0, name: normalizeCharset(match[1]!) });
  };
  add(/<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>;]+)/gi);
  const meta = found.sort((a, b) => a.at - b.at).map((entry) => entry.name);
  const xml = /<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  return xml === null ? meta : [...meta, normalizeCharset(xml[1]!)];
}

function isBinary(data: Uint8Array): boolean {
  if (data.length === 0) return false;

  let control = 0;
  let nul = 0;
  // Indexed: a for...of over a typed array goes through the iterator protocol, several times slower on a 64 KiB prefix.
  for (let index = 0; index < data.length; index++) {
    const byte = data[index]!;
    if (byte === 0) nul++;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) control++;
  }
  if (nul > 0) return true;
  return control / data.length > 0.02;
}

function isPureAscii(data: Uint8Array): boolean {
  return isAscii(data);
}

function isValidUtf8(data: Uint8Array): boolean {
  try {
    // `stream` lets the data end in the middle of a character: a sample cut from a longer file ends anywhere.
    new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function normalizeCharset(charset: string): string {
  const upper = charset.trim().toUpperCase();
  switch (upper) {
    case "ASCII":
    case "US-ASCII":
      return "US-ASCII";
    case "UTF8":
    case "UTF-8":
      return "UTF-8";
    case "LATIN1":
    case "ISO-8859-1":
      return "ISO-8859-1";
    case "WINDOWS-1252":
    case "CP1252":
      return "windows-1252";
    default:
      return charset.trim();
  }
}
