import { dictEntryRanges, parseName, type EntryRange } from "./pdf-syntax.ts";

/**
 * Font dictionaries whose key names lost their last character (`/Registr`, `/Orderin`, `/FontNam`, `/Typ`), or a `/W`
 * that lost its only character (a key `/` followed by the widths array). pdf.js refuses a CID font whose
 * /CIDSystemInfo has no /Ordering and reads a CID font with no /W as having zero-width glyphs, so its text is dropped
 * or comes out one glyph to a line; PDFBox's reader takes the keys it knows and the text comes out whole (tikajs-1myi,
 * tikajs-f301).
 *
 * A key is renamed only when it is one character short of exactly one key that dictionary kind can hold, and the
 * dictionary does not already have that key. A key that is itself valid (`/FontFile` for `/FontFile2`) is left alone.
 */

type Kind = "font" | "descriptor" | "cidSystemInfo";

const KNOWN: Readonly<Record<Kind, readonly string[]>> = {
  font: [
    "Type", "Subtype", "Name", "BaseFont", "FirstChar", "LastChar", "Widths", "FontDescriptor", "Encoding", "ToUnicode",
    "DescendantFonts", "CIDSystemInfo", "CIDToGIDMap", "W", "DW", "W2", "DW2",
  ],
  descriptor: [
    "Type", "FontName", "FontFamily", "FontStretch", "FontWeight", "Flags", "FontBBox", "ItalicAngle", "Ascent", "Descent",
    "Leading", "CapHeight", "XHeight", "StemV", "StemH", "AvgWidth", "MaxWidth", "MissingWidth", "FontFile", "FontFile2",
    "FontFile3", "CharSet",
  ],
  cidSystemInfo: ["Registry", "Ordering", "Supplement"],
};

const CID_FONT_SUBTYPES = new Set(["CIDFontType0", "CIDFontType2"]);
/** The start of a widths array: `[ 0 [ 750 ...` or `[ 0 5 600 ...`. */
const WIDTHS_ARRAY = /^\[\s*\d+\s*(?:\[|\d+(?:\.\d+)?\s+\d)/;
/** Nested dictionaries are read this deep (a font holds CIDSystemInfo, and DescendantFonts holds fonts). */
const MAX_DEPTH = 3;

interface Edit {
  readonly at: number;
  readonly end: number;
  readonly text: string;
}

/** The key `key` stands for in `known`: the one it is a character short of, or null. */
function completion(key: string, known: readonly string[], present: ReadonlySet<string>): string | null {
  if (key.length < 3 || known.includes(key)) return null;
  const candidates = known.filter((name) => name.length === key.length + 1 && name.startsWith(key) && !present.has(name));
  return candidates.length === 1 ? candidates[0]! : null;
}

/** What kind of font dictionary the entries make, by their /Type or by the keys only such a dictionary has. */
function kindOf(text: string, ranges: readonly EntryRange[]): Kind | null {
  const present = new Set(ranges.map((range) => range.key));
  const typeRange = ranges.find((range) => range.key === "Type" || range.key === "Typ");
  const type = typeRange === undefined ? null : parseName(text.slice(typeRange.valueStart, typeRange.valueEnd));
  const has = (...names: string[]): boolean => names.some((name) => present.has(name) || present.has(name.slice(0, -1)));
  if (type === "Font" || has("BaseFont", "DescendantFonts", "FontDescriptor")) return "font";
  if (type === "FontDescriptor" || (has("FontName", "FontBBox") && has("Flags", "FontBBox", "Ascent"))) return "descriptor";
  return null;
}

function collect(text: string, from: number, end: number, kind: Kind | null, depth: number, edits: Edit[]): void {
  const ranges = dictEntryRanges(text, from, end);
  const detected = kind ?? kindOf(text, ranges);
  if (detected === null) return;
  const present = new Set(ranges.map((range) => range.key));
  const known = KNOWN[detected];
  const subtypeRange = ranges.find((range) => range.key === "Subtype" || range.key === "Subtyp");
  const subtype = subtypeRange === undefined ? null : parseName(text.slice(subtypeRange.valueStart, subtypeRange.valueEnd));
  for (const range of ranges) {
    let key = range.key;
    const value = text.slice(range.valueStart, range.valueEnd);
    const full = completion(key, known, present);
    if (full !== null) {
      edits.push({ at: range.keyStart + 1, end: range.keyEnd, text: full });
      present.add(full);
      key = full;
    } else if (key === "" && detected === "font" && subtype !== null && CID_FONT_SUBTYPES.has(subtype) && !present.has("W") && WIDTHS_ARRAY.test(value)) {
      edits.push({ at: range.keyStart + 1, end: range.keyEnd, text: "W" });
      present.add("W");
      continue;
    }
    if (depth >= MAX_DEPTH) continue;
    if (key === "CIDSystemInfo" && value.startsWith("<<")) {
      collect(text, range.valueStart, range.valueEnd, "cidSystemInfo", depth + 1, edits);
    } else if (key === "DescendantFonts" && value.startsWith("[")) {
      for (let at = text.indexOf("<<", range.valueStart); at !== -1 && at < range.valueEnd; ) {
        collect(text, at, range.valueEnd, "font", depth + 1, edits);
        const inner = dictEntryRanges(text, at, range.valueEnd);
        const close = text.indexOf(">>", inner.length === 0 ? at + 2 : inner[inner.length - 1]!.valueEnd);
        at = close === -1 ? -1 : text.indexOf("<<", close);
      }
    }
  }
}

/** `body` (an object's dictionary text) with damaged font keys put right, or `body` itself when none was. */
export function repairFontKeys(body: string): string {
  const edits: Edit[] = [];
  collect(body, body.indexOf("<<"), body.length, null, 0, edits);
  if (edits.length === 0) return body;
  let result = body;
  for (const edit of edits.sort((left, right) => right.at - left.at)) {
    result = `${result.slice(0, edit.at)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}
