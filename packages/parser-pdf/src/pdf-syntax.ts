import { inflateSync } from "node:zlib";

/**
 * Just enough PDF syntax to read the dictionaries and streams of a damaged file: the raw text of a dictionary's entries,
 * references, literal strings and the common stream filters. Everything works on latin1 strings (one char per byte) and
 * tolerates input that stops part way through.
 */

/** A dictionary nested deeper than this is treated as cut off: hostile nesting must not exhaust the stack. */
const MAX_DEPTH = 64;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
}

function isDelimiter(char: string | undefined): boolean {
  return char !== undefined && "()<>[]{}/%".includes(char);
}

export function skipSpace(text: string, at: number, end: number): number {
  while (at < end) {
    const code = text.charCodeAt(at);
    if (code === 0x25) {
      // A comment runs to the end of the line.
      while (at < end && text[at] !== "\n" && text[at] !== "\r") at++;
      continue;
    }
    if (!isSpace(code)) break;
    at++;
  }
  return at;
}

/** The index just past the value starting at `at`, or `end` when the value is cut off. */
export function skipValue(text: string, at: number, end: number, depth: number): number {
  if (depth > MAX_DEPTH) return end;
  const char = text[at];
  if (char === "<" && text[at + 1] === "<") {
    at += 2;
    for (;;) {
      at = skipSpace(text, at, end);
      if (at >= end) return end;
      if (text.startsWith(">>", at)) return at + 2;
      at = skipValue(text, at, end, depth + 1);
    }
  }
  if (char === "[") {
    at++;
    for (;;) {
      at = skipSpace(text, at, end);
      if (at >= end) return end;
      if (text[at] === "]") return at + 1;
      at = skipValue(text, at, end, depth + 1);
    }
  }
  if (char === "(") return skipLiteralString(text, at, end);
  if (char === "<") {
    const close = text.indexOf(">", at + 1);
    return close === -1 || close >= end ? end : close + 1;
  }
  if (char === "/") {
    at++;
    while (at < end && !isSpace(text.charCodeAt(at)) && !isDelimiter(text[at])) at++;
    return at;
  }
  // A stray delimiter (")", ">", "]", "{", "}") is garbage: step over it so the caller makes progress.
  if (isDelimiter(char)) return at + 1;
  while (at < end && !isSpace(text.charCodeAt(at)) && !isDelimiter(text[at])) at++;
  return at;
}

function skipLiteralString(text: string, at: number, end: number): number {
  let depth = 0;
  for (let i = at; i < end; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
  }
  return end;
}

const REFERENCE_TAIL = /^\s+(\d{1,5})\s+R(?![^\s()<>[\]{}/%])/;

/** Where one entry of a dictionary sits in its text: the key (without the slash) and the raw value. */
export interface EntryRange {
  readonly key: string;
  /** Index of the key's slash. */
  readonly keyStart: number;
  /** Index just past the key. */
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/**
 * The entries of the dictionary whose `<<` is at or after `from`, with their positions, in file order (a repeated key
 * appears each time). An indirect reference is one value (`"12 0 R"`). A dictionary that is cut off yields the entries
 * read before the cut.
 */
export function dictEntryRanges(text: string, from = 0, end = text.length): EntryRange[] {
  const ranges: EntryRange[] = [];
  let at = text.indexOf("<<", from);
  if (at === -1 || at >= end) return ranges;
  at += 2;
  for (;;) {
    at = skipSpace(text, at, end);
    if (at >= end || text.startsWith(">>", at)) return ranges;
    if (text[at] !== "/") {
      // Not a key: skip the stray value and carry on.
      at = skipValue(text, at, end, 1);
      continue;
    }
    const keyEnd = skipValue(text, at, end, 1);
    const keyStart = at;
    at = skipSpace(text, keyEnd, end);
    if (at >= end || text.startsWith(">>", at)) return ranges;
    const valueStart = at;
    at = skipValue(text, at, end, 1);
    if (/^\d+$/.test(text.slice(valueStart, at))) {
      const tail = REFERENCE_TAIL.exec(text.slice(at, Math.min(end, at + 16)));
      if (tail !== null) at += tail[0].length;
    }
    ranges.push({ key: text.slice(keyStart + 1, keyEnd), keyStart, keyEnd, valueStart, valueEnd: at });
  }
}

/**
 * The entries of the dictionary whose `<<` is at or after `from`, as raw value text by key (without the slash); the
 * first of a repeated key wins. See dictEntryRanges.
 */
export function dictEntries(text: string, from = 0, end = text.length): Map<string, string> {
  const entries = new Map<string, string>();
  for (const range of dictEntryRanges(text, from, end)) {
    if (!entries.has(range.key)) entries.set(range.key, text.slice(range.valueStart, range.valueEnd));
  }
  return entries;
}

export interface Reference {
  readonly num: number;
  readonly gen: number;
}

/** The reference a raw value is, or null. */
export function parseReference(value: string | undefined): Reference | null {
  const match = value === undefined ? null : /^(\d{1,7})\s+(\d{1,5})\s+R$/.exec(value.trim());
  return match === null ? null : { num: Number(match[1]), gen: Number(match[2]) };
}

/** Every reference in a raw value, in order (the kids of a page tree node, an array of content streams). */
export function referencesIn(value: string | undefined): Reference[] {
  if (value === undefined) return [];
  return [...value.matchAll(/(?<![0-9])(\d{1,7})\s+(\d{1,5})\s+R(?![^\s()<>[\]{}/%])/g)].map((match) => ({
    num: Number(match[1]),
    gen: Number(match[2]),
  }));
}

/** The name a raw value is (`/Catalog` gives `Catalog`), or null. */
export function parseName(value: string | undefined): string | null {
  const match = value === undefined ? null : /^\/([^\s()<>[\]{}/%]*)$/.exec(value.trim());
  return match === null ? null : match[1]!;
}

/** The bytes of a literal `( ... )` or hex `< ... >` string value, as latin1 text; null for anything else. */
export function parseString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const raw = value.trim();
  if (raw.startsWith("<") && !raw.startsWith("<<")) {
    const hex = raw.slice(1, raw.endsWith(">") ? -1 : undefined).replace(/[^0-9A-Fa-f]/g, "");
    return Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, "hex").toString("latin1");
  }
  if (!raw.startsWith("(")) return null;
  const body = raw.slice(1, raw.endsWith(")") ? -1 : undefined);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\") {
      // An end of line inside a string is read as a line feed.
      if (char === "\r") {
        out += "\n";
        if (body[i + 1] === "\n") i++;
      } else out += char;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    const escape: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (next in escape) out += escape[next];
    else if (next >= "0" && next <= "7") {
      let digits = next;
      while (digits.length < 3 && body[i + 1] !== undefined && body[i + 1]! >= "0" && body[i + 1]! <= "7") digits += body[++i];
      out += String.fromCharCode(parseInt(digits, 8) & 0xff);
    } else if (next === "\r") {
      if (body[i + 1] === "\n") i++;
    } else if (next !== "\n") out += next;
  }
  return out;
}

/** A shared allowance of decoded bytes, so one hostile document cannot inflate without bound. */
export interface DecodeBudget {
  left: number;
}

/**
 * Stream data run through its filters (`/Filter` and `/DecodeParms` from `entries`). Handles FlateDecode without a
 * predictor, ASCII85Decode and ASCIIHexDecode; null for any other filter, data that does not decode, or a decoded size
 * over the budget. Flate data cut off part way yields what inflated before the cut.
 */
export function decodeStream(entries: ReadonlyMap<string, string>, data: string, budget: DecodeBudget): string | null {
  const filterValue = entries.get("Filter")?.trim();
  const filters =
    filterValue === undefined ? [] : [...filterValue.matchAll(/\/([^\s()<>[\]{}/%]+)/g)].map((match) => match[1]!);
  if (filters.length > 0 && /\/Predictor\s+(?:[2-9]|1\d)/.test(entries.get("DecodeParms") ?? "")) return null;
  let out = data;
  for (const filter of filters) {
    if (filter === "FlateDecode" || filter === "Fl") {
      if (budget.left <= 0) return null;
      try {
        const inflated = inflateSync(Buffer.from(out, "latin1"), {
          maxOutputLength: budget.left,
          finishFlush: 2, // Z_SYNC_FLUSH: keep what inflated from a stream that is cut off
        });
        out = inflated.toString("latin1");
      } catch {
        return null;
      }
    } else if (filter === "ASCII85Decode" || filter === "A85") {
      const decoded = ascii85(out, budget.left);
      if (decoded === null) return null;
      out = decoded;
    } else if (filter === "ASCIIHexDecode" || filter === "AHx") {
      const end = out.indexOf(">");
      const hex = (end === -1 ? out : out.slice(0, end)).replace(/[^0-9A-Fa-f]/g, "");
      out = Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, "hex").toString("latin1");
    } else return null;
    budget.left -= out.length;
    if (budget.left < 0) return null;
  }
  return out;
}

/**
 * ASCII85 data decoded into a buffer made for at most `limit` bytes (one more, to tell the limit was passed), or null
 * when the output would be longer. The size is the allowance, not what the input could make: a run of `z` is four bytes a
 * character, and decoding it into an array first held hundreds of megabytes before the budget was looked at.
 */
function ascii85(data: string, limit: number): string | null {
  if (limit < 0) return null;
  const start = data.startsWith("<~") ? 2 : 0;
  const stop = data.indexOf("~>", start);
  const body = data.slice(start, stop === -1 ? undefined : stop);
  const out = Buffer.allocUnsafe(Math.min(4 * body.length, limit + 1));
  let length = 0;
  const put = (value: number, count: number): boolean => {
    if (length + count > limit) return false;
    for (let shift = 24, written = 0; written < count; shift -= 8, written++) out[length++] = (value >>> shift) & 0xff;
    return true;
  };
  const group: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code === 0x7a && group.length === 0) {
      // "z": four zero bytes.
      if (!put(0, 4)) return null;
      continue;
    }
    if (code < 33 || code > 117) continue;
    group.push(code - 33);
    if (group.length === 5) {
      if (!put(group.reduce((sum, digit) => sum * 85 + digit, 0), 4)) return null;
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84);
    if (!put(group.reduce((sum, digit) => sum * 85 + digit, 0), count)) return null;
  }
  return out.toString("latin1", 0, length);
}
