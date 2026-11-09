import { MediaType } from "@spikedpunch/ripstream-core";
import type { TikaMagic, TikaMatch, TikaMimeEntry } from "./registry-types.ts";
import { TIKA_MIME_REGISTRY } from "./generated/registry.ts";

export interface MagicCandidate {
  readonly type: MediaType;
  readonly priority: number;
}

interface CompiledMatch {
  readonly raw: TikaMatch;
  readonly value: Uint8Array | null;
  readonly mask: Uint8Array | null;
  readonly offset: number;
  readonly rangeEnd: number | null;
  readonly regex: RegExp | null;
  readonly anchoredRegex: RegExp | null;
  readonly children: CompiledMatch[];
  readonly minShouldMatch: number;
}

interface CompiledMagic {
  readonly type: MediaType;
  readonly priority: number;
  readonly matches: CompiledMatch[];
}

/**
 * Port of Ripstream's magic matching pipeline. Rules are evaluated in descending
 * priority order; the first priority band with a hit wins, and every type in
 * that band is returned in registration order.
 */
export class MagicDetector {
  private readonly magics: CompiledMagic[];

  constructor(registry: readonly TikaMimeEntry[] = TIKA_MIME_REGISTRY) {
    this.magics = [];
    for (const entry of registry) {
      const type = MediaType.parse(entry.type);
      if (type === null) continue;
      for (const magic of entry.magic) {
        this.magics.push({
          type,
          priority: magic.priority,
          matches: magic.matches.map(compileMatch),
        });
      }
    }
    this.magics.sort((a, b) => b.priority - a.priority);
  }

  detect(prefix: Uint8Array): MediaType[] {
    const results: MediaType[] = [];
    let currentPriority = -1;

    for (const magic of this.magics) {
      if (
        results.length > 0 &&
        currentPriority > 0 &&
        currentPriority > magic.priority
      ) {
        break;
      }

      if (magic.matches.some((match) => evaluate(match, prefix))) {
        results.push(magic.type);
        currentPriority = magic.priority;
      }
    }

    return results;
  }

  /** Whether any rule for `type` matches, whatever its priority band. */
  matches(prefix: Uint8Array, type: MediaType): boolean {
    return this.magics.some(
      (magic) => magic.type.equals(type) && magic.matches.some((match) => evaluate(match, prefix)),
    );
  }

  get ruleCount(): number {
    return this.magics.length;
  }
}

function compileMatch(raw: TikaMatch): CompiledMatch {
  const [offset, rangeEnd] = parseOffset(raw.offset);
  const isGroup = raw.value === "";
  const value = isGroup ? null : decodeValue(raw.value, raw.type);
  const mask =
    raw.mask === undefined
      ? null
      : (encodeNumber(raw.mask, raw.type) ?? decodeMask(raw.mask));
  const children = (raw.children ?? []).map(compileMatch);
  const regex = raw.type === "regex" ? compileJavaRegex(raw.value) : null;

  return {
    raw,
    value,
    mask,
    offset,
    rangeEnd,
    regex,
    anchoredRegex:
      regex === null
        ? null
        : new RegExp(`^(?:${regex.source})`, regex.flags),
    children,
    // Tika ORs a match's sub-matches (AND with the match itself) unless minShouldMatch says otherwise: a docx
    // is `PK\003\004` followed by `[Content_Types].xml` OR `_rels/.rels`, never both.
    minShouldMatch: raw.minShouldMatch ?? (isGroup || children.length === 0 ? children.length : 1),
  };
}

function parseOffset(offset: string): [number, number | null] {
  const colon = offset.indexOf(":");
  if (colon === -1) return [Number(offset), null];
  return [Number(offset.slice(0, colon)), Number(offset.slice(colon + 1))];
}

function evaluate(match: CompiledMatch, data: Uint8Array): boolean {
  const childrenMatched = countMatchingChildren(match, data);
  if (match.raw.value === "") {
    return match.children.length > 0 && childrenMatched >= match.minShouldMatch;
  }

  const selfMatched = evaluateLeaf(match, data);
  if (!selfMatched) return false;
  return childrenMatched >= match.minShouldMatch;
}

function countMatchingChildren(match: CompiledMatch, data: Uint8Array): number {
  let count = 0;
  for (const child of match.children) if (evaluate(child, data)) count++;
  return count;
}

function evaluateLeaf(match: CompiledMatch, data: Uint8Array): boolean {
  if (match.anchoredRegex !== null) {
    const end = match.rangeEnd ?? data.length;
    const start = Math.min(match.offset, data.length);
    const window = latin1(data.subarray(start, Math.min(end, data.length)));
    return match.anchoredRegex.test(window);
  }

  if (match.value === null) return false;
  const value = match.value;
  const start = match.offset;
  const last = match.rangeEnd ?? start;

  for (let position = start; position <= last; position++) {
    if (match.rangeEnd !== null && position >= last) break;
    if (position + value.length > data.length) {
      if (match.rangeEnd === null) return false;
      break;
    }
    if (equalsAt(data, position, value, match.mask, match.raw.type === "stringignorecase")) {
      return true;
    }
  }
  return false;
}

function equalsAt(
  data: Uint8Array,
  position: number,
  value: Uint8Array,
  mask: Uint8Array | null,
  ignoreCase: boolean,
): boolean {
  for (let index = 0; index < value.length; index++) {
    const maskByte = mask === null ? 0xff : (mask[index] ?? mask[mask.length - 1] ?? 0xff);
    let actual = data[position + index]! & maskByte;
    let expected = value[index]! & maskByte;
    if (ignoreCase) {
      actual = asciiLower(actual);
      expected = asciiLower(expected);
    }
    if (actual !== expected) return false;
  }
  return true;
}

function asciiLower(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

const NUMERIC_TYPES: Readonly<Record<string, { bytes: number; little: boolean }>> = {
  big16: { bytes: 2, little: false },
  little16: { bytes: 2, little: true },
  host16: { bytes: 2, little: true },
  big32: { bytes: 4, little: false },
  little32: { bytes: 4, little: true },
  host32: { bytes: 4, little: true },
};

/** Java Integer.decode semantics: 0x/# hex, leading-0 octal, else decimal. */
function decodeNumber(text: string): number {
  const trimmed = text.trim();
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  if (/^#[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(1), 16);
  if (/^0[0-7]+$/.test(trimmed)) return Number.parseInt(trimmed, 8);
  if (/^[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  throw new Error(`Invalid numeric magic value: ${text}`);
}

function encodeNumber(text: string, type: string): Uint8Array | null {
  const spec = NUMERIC_TYPES[type];
  if (spec === undefined) return null;
  let number = decodeNumber(text);
  const bytes = new Uint8Array(spec.bytes);
  for (let index = 0; index < spec.bytes; index++) {
    bytes[spec.little ? index : spec.bytes - 1 - index] = number % 256;
    number = Math.floor(number / 256);
  }
  return bytes;
}

function decodeValue(value: string, type: string): Uint8Array {
  const numeric = encodeNumber(value, type);
  if (numeric !== null) return numeric;
  if (type === "unicodeLE" || type === "unicodeBE") {
    return encodeUtf16(value, type === "unicodeLE");
  }
  return decodeEscapes(value);
}

function decodeMask(mask: string): Uint8Array {
  return decodeEscapes(mask);
}

/** Tika magic strings: 0x hex, \xNN, \NNN octal, and C escapes. */
function decodeEscapes(value: string): Uint8Array {
  if (/^0x[0-9a-fA-F]*$/.test(value)) {
    const bytes = new Uint8Array((value.length - 2) / 2);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return bytes;
  }

  const bytes: number[] = [];
  for (let index = 0; index < value.length; ) {
    const char = value[index]!;
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0) & 0xff);
      index++;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    switch (next) {
      case "n":
        bytes.push(0x0a);
        index += 2;
        break;
      case "r":
        bytes.push(0x0d);
        index += 2;
        break;
      case "t":
        bytes.push(0x09);
        index += 2;
        break;
      case "f":
        bytes.push(0x0c);
        index += 2;
        break;
      case "b":
        bytes.push(0x08);
        index += 2;
        break;
      case "\\":
        bytes.push(0x5c);
        index += 2;
        break;
      case "x": {
        const hex = value.slice(index + 2, index + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(Number.parseInt(hex, 16));
          index += 4;
        } else {
          bytes.push(0x5c);
          index++;
        }
        break;
      }
      default: {
        const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1));
        if (octal !== null) {
          bytes.push(Number.parseInt(octal[0], 8) & 0xff);
          index += 1 + octal[0].length;
        } else {
          bytes.push(next.charCodeAt(0) & 0xff);
          index += 2;
        }
      }
    }
  }
  return new Uint8Array(bytes);
}

function encodeUtf16(value: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes[index * 2 + (littleEndian ? 0 : 1)] = code & 0xff;
    bytes[index * 2 + (littleEndian ? 1 : 0)] = code >> 8;
  }
  return bytes;
}

function latin1(data: Uint8Array): string {
  let result = "";
  for (let index = 0; index < data.length; index += 4096) {
    result += String.fromCharCode(...data.subarray(index, index + 4096));
  }
  return result;
}

function compileJavaRegex(pattern: string): RegExp | null {
  let source = pattern;
  let flags = "u";
  const inline = /^\(\?([ims]+)\)/.exec(source);
  if (inline !== null) {
    flags += inline[1]!;
    source = source.slice(inline[0].length);
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export type { TikaMagic };
