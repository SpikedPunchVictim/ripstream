import { analyse } from "chardet";

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
 */
export function detectEncoding(data: Uint8Array): EncodingDetection {
  const bom = detectBom(data);
  if (bom !== null) {
    return { charset: bom.charset, confidence: 1, bom: true, binary: false };
  }

  const utf16 = detectUtf16WithoutBom(data);
  if (utf16 !== null) {
    return { charset: utf16, confidence: 0.8, bom: false, binary: false };
  }

  const declared = declaredCharset(data);
  if (declared !== null) {
    return { charset: declared, confidence: 0.9, bom: false, binary: false };
  }

  const iso2022 = detectIso2022(data);
  if (iso2022 !== null) {
    return { charset: iso2022, confidence: 0.9, bom: false, binary: false };
  }

  if (isBinary(data)) {
    return { charset: "ISO-8859-1", confidence: 0.1, bom: false, binary: true };
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
      charset: normalizeCharset(best.name),
      confidence: best.confidence / 100,
      bom: false,
      binary: false,
    };
  }

  return { charset: "windows-1252", confidence: 0.2, bom: false, binary: false };
}

export function decodeText(data: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(data);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
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

function declaredCharset(data: Uint8Array): string | null {
  const head = latin1(data.subarray(0, 4096));

  const html =
    /<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>;]+)/i.exec(head) ??
    /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^"'\s;]+)/i.exec(
      head,
    );
  if (html !== null) return normalizeCharset(html[1]!);

  const xml = /<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (xml !== null) return normalizeCharset(xml[1]!);

  return null;
}

function isBinary(data: Uint8Array): boolean {
  if (data.length === 0) return false;

  let control = 0;
  let nul = 0;
  for (const byte of data) {
    if (byte === 0) nul++;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control++;
  }
  if (nul > 0) return true;
  return control / data.length > 0.02;
}

function isPureAscii(data: Uint8Array): boolean {
  for (const byte of data) {
    if (byte >= 0x80) return false;
  }
  return true;
}

function isValidUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

function latin1(data: Uint8Array): string {
  let result = "";
  for (let index = 0; index < data.length; index += 4096) {
    result += String.fromCharCode(...data.subarray(index, index + 4096));
  }
  return result;
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
