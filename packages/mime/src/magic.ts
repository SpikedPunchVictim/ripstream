import { MediaType } from "@spikedpunch/ripstream-core";
import type { TikaMagic, TikaMatch, TikaMimeEntry } from "./registry-types.ts";
import { TIKA_MIME_REGISTRY } from "./generated/registry.ts";

export interface MagicCandidate {
  readonly type: MediaType;
  readonly priority: number;
}

/** A single byte pattern, as Tika's `MagicDetector` holds it. */
interface Leaf {
  /** Already masked; padded with zeros to `length`. */
  readonly pattern: Uint8Array;
  readonly mask: Uint8Array;
  readonly length: number;
  readonly start: number;
  readonly end: number;
  readonly ignoreCase: boolean;
  /** Set for a regex rule; null `regex` with a source means this runtime could not compile it. */
  readonly regexSource: string | null;
  readonly regex: RegExp | null;
}

/**
 * Tika's clause tree: a match with sub-matches is `AND(match, OR(subs))`, a `minShouldMatch` group is a threshold over
 * its subs, and every clause has a `size` that orders rules of equal priority.
 */
interface Clause {
  readonly leaf: Leaf | null;
  readonly children: readonly Clause[];
  readonly minShouldMatch: number;
  readonly size: number;
}

interface CompiledMagic {
  readonly type: MediaType;
  readonly priority: number;
  readonly clause: Clause;
}

/** Java's `MagicDetector` reads a regex window of this many bytes (its `length` for a regex). */
const REGEX_WINDOW = 8 * 1024;

/**
 * Port of Tika's `MimeTypes` magic pipeline. Every top-level match is its own rule, rules are ordered as
 * `Magic.compareTo` does (priority, then clause size, then type name, all descending), and the first priority band with
 * a hit is returned in that order.
 */
export class MagicDetector {
  private readonly magics: CompiledMagic[];
  private readonly failed: string[] = [];

  constructor(registry: readonly TikaMimeEntry[] = TIKA_MIME_REGISTRY) {
    this.magics = [];
    for (const entry of registry) {
      const type = MediaType.parse(entry.type);
      if (type === null) continue;
      for (const magic of entry.magic) {
        for (const match of magic.matches) {
          this.magics.push({ type, priority: magic.priority, clause: this.compile(match, entry.type) });
        }
      }
    }
    // Array#sort is stable: rules that tie on all three keys keep registration order.
    this.magics.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.clause.size - a.clause.size ||
        compareStrings(b.type.toString(), a.type.toString()),
    );
  }

  /** Regex patterns this runtime could not compile; such a rule never matches, so a non-empty list is a bug. */
  get uncompilableRegexes(): readonly string[] {
    return this.failed;
  }

  detect(prefix: Uint8Array): MediaType[] {
    const results: MediaType[] = [];
    let currentPriority = -1;

    for (const magic of this.magics) {
      if (currentPriority > 0 && currentPriority > magic.priority) break;
      if (evaluate(magic.clause, prefix)) {
        results.push(magic.type);
        currentPriority = magic.priority;
      }
    }

    return results;
  }

  /** Whether any rule for `type` matches, whatever its priority band. */
  matches(prefix: Uint8Array, type: MediaType): boolean {
    return this.magics.some((magic) => magic.type.equals(type) && evaluate(magic.clause, prefix));
  }

  get ruleCount(): number {
    return this.magics.length;
  }

  private compile(raw: TikaMatch, owner: string): Clause {
    const children = (raw.children ?? []).map((child) => this.compile(child, owner));
    const childSize = children.reduce((max, child) => Math.max(max, child.size), 0);

    // A `minShouldMatch` match is a threshold over its sub-matches and carries no pattern of its own.
    if (raw.minShouldMatch !== undefined || raw.value === "") {
      return { leaf: null, children, minShouldMatch: raw.minShouldMatch ?? children.length, size: childSize };
    }

    const leaf = this.compileLeaf(raw, owner);
    const subSize = children.length === 1 ? (children[0] as Clause).size : childSize;
    return { leaf, children, minShouldMatch: 1, size: leaf.length + subSize };
  }

  private compileLeaf(raw: TikaMatch, owner: string): Leaf {
    const [start, rangeEnd] = parseOffset(raw.offset);
    const ignoreCase = raw.type === "stringignorecase";
    const decoded = decodeValue(ignoreCase ? raw.value.toLowerCase() : raw.value, raw.type);
    const decodedMask = raw.mask === undefined ? null : decodeValue(raw.mask, raw.type);

    const length = Math.max(decoded.length, decodedMask?.length ?? 0);
    const mask = new Uint8Array(length).fill(0xff);
    if (decodedMask !== null) mask.set(decodedMask);
    const pattern = new Uint8Array(length);
    for (let index = 0; index < decoded.length; index++) pattern[index] = decoded[index]! & mask[index]!;

    let regexSource: string | null = null;
    let regex: RegExp | null = null;
    if (raw.type === "regex") {
      regexSource = new TextDecoder("utf-8").decode(pattern);
      regex = compileJavaRegex(regexSource, rangeEnd !== null);
      if (regex === null) this.failed.push(`${owner}: ${regexSource}`);
    }

    return { pattern, mask, length, start, end: rangeEnd ?? start, ignoreCase, regexSource, regex };
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseOffset(offset: string): [number, number | null] {
  const colon = offset.indexOf(":");
  if (colon === -1) return [Number(offset), null];
  return [Number(offset.slice(0, colon)), Number(offset.slice(colon + 1))];
}

function evaluate(clause: Clause, data: Uint8Array): boolean {
  if (clause.leaf === null) {
    let matched = 0;
    for (const child of clause.children) {
      if (evaluate(child, data) && ++matched >= clause.minShouldMatch) return true;
    }
    return false;
  }
  if (!evaluateLeaf(clause.leaf, data)) return false;
  return clause.children.length === 0 || clause.children.some((child) => evaluate(child, data));
}

/** `MagicDetector.matches(byte[])`. */
function evaluateLeaf(leaf: Leaf, data: Uint8Array): boolean {
  if (leaf.regexSource !== null) return leaf.regex !== null && evaluateRegex(leaf, leaf.regex, data);

  if (data.length < leaf.start + leaf.length) return false;
  if (leaf.length === 0) return leaf.start <= leaf.end && leaf.start <= data.length;

  const last = Math.min(leaf.end, data.length - leaf.length);
  for (let position = leaf.start; position <= last; position++) {
    if (equalsAt(leaf, data, position)) return true;
  }
  return false;
}

function evaluateRegex(leaf: Leaf, regex: RegExp, data: Uint8Array): boolean {
  if (data.length <= leaf.start) return false;
  const maxOffset = Math.min(leaf.end, data.length - 1);
  const windowLength = Math.min(data.length - leaf.start, REGEX_WINDOW + (maxOffset - leaf.start));
  if (windowLength <= 0) return false;

  const window = latin1(data.subarray(leaf.start, leaf.start + windowLength));
  regex.lastIndex = 0;
  const found = regex.exec(window);
  // A sticky regex matches only at index 0 (a fixed offset); a global one finds the leftmost match, which is in range
  // exactly when some start position in the range matches.
  return found !== null && found.index <= maxOffset - leaf.start;
}

function equalsAt(leaf: Leaf, data: Uint8Array, position: number): boolean {
  for (let index = 0; index < leaf.length; index++) {
    let actual = data[position + index]! & leaf.mask[index]!;
    if (leaf.ignoreCase && actual >= 0x41 && actual <= 0x5a) actual += 0x20;
    if (actual !== leaf.pattern[index]) return false;
  }
  return true;
}

/**
 * `MagicDetector.decodeValue`: a value starting `0x` is hex, a numeric type is read in octal unless it is hex (so a
 * bare `23` is 19), and a string or regex goes through `decodeString`.
 */
function decodeValue(value: string, type: string): Uint8Array {
  const hex = value.startsWith("0x");
  const digits = hex ? value.slice(2) : value;
  const radix = hex ? 16 : 8;

  switch (type) {
    case "little16":
    case "host16":
      return numberBytes(Number.parseInt(digits, radix), 2, true);
    case "big16":
      return numberBytes(Number.parseInt(digits, radix), 2, false);
    case "little32":
    case "host32":
      return numberBytes(Number.parseInt(digits, radix), 4, true);
    case "big32":
      return numberBytes(Number.parseInt(digits, radix), 4, false);
    case "byte":
      return new TextEncoder().encode(digits);
    default:
      // string, stringignorecase, regex, unicodeLE, unicodeBE
      return decodeString(value, type);
  }
}

function numberBytes(value: number, size: number, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(size);
  let rest = value;
  for (let index = 0; index < size; index++) {
    bytes[littleEndian ? index : size - 1 - index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

/**
 * `MagicDetector.decodeString`, quirks included: `\\`, `\xNN`, `\r` and `\n` are escapes; any other backslash reads up
 * to three following digits as an octal byte, and with no digits yields a NUL and keeps the next character as itself
 * (so `\t` is NUL then `t`, which is why Tika's own regexes write `\\d`).
 */
function decodeString(value: string, type: string): Uint8Array {
  if (value.startsWith("0x")) {
    const bytes = new Uint8Array(Math.floor((value.length - 2) / 2));
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return bytes;
  }

  const chars: number[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\\") {
      chars.push(value.charCodeAt(index));
      continue;
    }
    const next = value[index + 1];
    if (next === "\\") {
      chars.push(0x5c);
      index++;
    } else if (next === "x") {
      chars.push(Number.parseInt(value.slice(index + 2, index + 4), 16));
      index += 3;
    } else if (next === "r") {
      chars.push(0x0d);
      index++;
    } else if (next === "n") {
      chars.push(0x0a);
      index++;
    } else {
      let end = index + 1;
      while (end < index + 4 && end < value.length && value[end]! >= "0" && value[end]! <= "9") end++;
      chars.push(Number.parseInt(`0${value.slice(index + 1, end)}`, 8) & 0xff);
      index = end - 1;
    }
  }

  if (type === "unicodeLE" || type === "unicodeBE") {
    const little = type === "unicodeLE";
    const bytes = new Uint8Array(chars.length * 2);
    chars.forEach((code, index) => {
      bytes[index * 2 + (little ? 0 : 1)] = code & 0xff;
      bytes[index * 2 + (little ? 1 : 0)] = (code >> 8) & 0xff;
    });
    return bytes;
  }
  return Uint8Array.from(chars, (code) => code & 0xff);
}

function latin1(data: Uint8Array): string {
  let result = "";
  for (let index = 0; index < data.length; index += 4096) {
    result += String.fromCharCode(...data.subarray(index, index + 4096));
  }
  return result;
}

/**
 * A Java regex as a JS one. Java's `\s` is ASCII only (JS also takes U+00A0, a Latin-1 byte), an atomic group is
 * emulated (see `emulateAtomicGroups`), and inline flags lead the pattern. A fixed-offset rule is anchored with the
 * sticky flag; a range rule is searched. Null when the pattern cannot be translated or compiled.
 */
function compileJavaRegex(source: string, ranged: boolean): RegExp | null {
  let body = source;
  let flags = "";
  const inline = /^\(\?([ims]+)\)/.exec(body);
  if (inline !== null) {
    flags = inline[1]!;
    body = body.slice(inline[0].length);
  }
  const atomic = emulateAtomicGroups(body);
  if (atomic === null) return null;
  body = asciiWhitespace(atomic);
  try {
    return new RegExp(body, flags + (ranged ? "g" : "y"));
  } catch {
    return null;
  }
}

/**
 * JS has no atomic group, and reading `(?>X)` as `(?:X)` is not safe: a failing match then tries every way to split the
 * input (`(?>\r\n|[\r\n]){1,50}` on 40 CRLF pairs is 2^40 attempts, from a 100-byte upload). A lookahead's captured
 * text cannot be backtracked into, so `(?:(?=(X))\N)` is the same group; the wrapper keeps a quantifier on the group
 * applying to both parts. The extra capture group renumbers later ones, so a pattern that mixes atomic groups with
 * numeric backreferences is refused rather than silently shifted.
 */
function emulateAtomicGroups(source: string): string | null {
  if (!source.includes("(?>")) return source;
  if (/\\[1-9]/.test(source)) return null;

  let result = "";
  let inClass = false;
  let captures = 0;
  const open: (number | null)[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "\\") {
      result += char + (source[index + 1] ?? "");
      index++;
    } else if (inClass) {
      if (char === "]") inClass = false;
      result += char;
    } else if (char === "[") {
      inClass = true;
      result += char;
    } else if (char === "(") {
      if (source.startsWith("(?>", index)) {
        open.push(++captures);
        result += "(?:(?=(";
        index += 2;
      } else {
        // `(?:`, `(?=`, `(?!` and look-behinds do not capture; `(?<name>` and a bare `(` do.
        if (!/^\(\?(?:[:=!]|<[=!])/.test(source.slice(index, index + 4))) captures++;
        open.push(null);
        result += char;
      }
    } else if (char === ")") {
      const atomicIndex = open.pop();
      result += atomicIndex === null || atomicIndex === undefined ? char : `))\\${atomicIndex})`;
    } else {
      result += char;
    }
  }
  return result;
}

/** Replace `\s` with Java's ASCII whitespace set, inside and outside character classes. */
function asciiWhitespace(source: string): string {
  let result = "";
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "\\") {
      const next = source[index + 1];
      if (next === "s") result += inClass ? " \\t\\n\\x0B\\f\\r" : "[ \\t\\n\\x0B\\f\\r]";
      else result += char + (next ?? "");
      index++;
      continue;
    }
    if (char === "[" && !inClass) inClass = true;
    else if (char === "]" && inClass) inClass = false;
    result += char;
  }
  return result;
}

export type { TikaMagic };
