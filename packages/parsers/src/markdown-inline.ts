import { Parser as HtmlParser } from "htmlparser2";
import { trimSpaces } from "./markdown-blocks.ts";
import { removeEmphasis } from "./markdown-emphasis.ts";

/**
 * The text of a line of Markdown without its inline marks: emphasis, links, images and code spans are removed and the
 * entity references (`&amp;`, `&#38;`, `&hellip;`) are decoded, as in the text Tika writes. Code spans keep their text as
 * written: no mark inside one is removed and no entity is decoded. A backslash before ASCII punctuation is dropped and
 * leaves the character as it is (`\\*` is a star, not emphasis; `\\&amp;` is the text `&amp;`).
 *
 * The inline-marker regexes below are quadratic on lines with many unclosed markers, so very long lines are cleaned in
 * bounded windows. A window ends at the last whitespace within MAX_WORD_LOOKBACK of its limit, so a word is not cut in
 * two; with none there the window is cut where it stands (not between the halves of a surrogate pair) and the pieces are
 * joined without a space. A marker pair that spans two windows is left as written, which is the cost of the bound.
 */
const MAX_INLINE_WINDOW = 256;
const MAX_WORD_LOOKBACK = 64;

export function cleanInline(line: string): string {
  if (line.length <= MAX_INLINE_WINDOW) return cleanWindow(line);
  let out = "";
  let start = 0;
  while (start < line.length) {
    let end = Math.min(line.length, start + MAX_INLINE_WINDOW);
    let separator = "";
    if (end < line.length) {
      let space = end;
      while (space > start + 1 && end - space < MAX_WORD_LOOKBACK && !/\s/.test(line[space]!)) space--;
      if (/\s/.test(line[space]!) && space > start) {
        end = space;
        separator = " ";
      } else if (isHighSurrogate(line.charCodeAt(end - 1))) {
        end--;
      }
    }
    out += cleanWindow(line.slice(start, end));
    start = end + separator.length;
    if (start < line.length) out += separator;
  }
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** A character of the private use area that the window does not hold, to stand for a code span while the rest is cleaned. */
function freeMark(text: string): string | undefined {
  for (let code = 0xe000; code < 0xe010; code++) {
    const mark = String.fromCharCode(code);
    if (!text.includes(mark)) return mark;
  }
  return undefined;
}

/**
 * Replaces the backslash escapes of ASCII punctuation and the code spans of a window by a `mark`, an index and a `mark`, so
 * that nothing below touches them; `kept` has what each stands for. A code span is a run of backticks and the next run of
 * as many (no more, no fewer); a run without a partner is text. One space off each side of a span that has a non-space inside.
 */
function protect(window: string, mark: string, kept: string[]): string {
  let out = "";
  let index = 0;
  while (index < window.length) {
    const char = window[index]!;
    if (char === "\\" && index + 1 < window.length && /[!-/:-@[-`{-~]/.test(window[index + 1]!)) {
      out += `${mark}${kept.push(window[index + 1]!) - 1}${mark}`;
      index += 2;
    } else if (char === "`") {
      let end = index;
      while (window[end] === "`") end++;
      const close = findRun(window, end, end - index);
      if (close < 0) {
        out += window.slice(index, end);
        index = end;
      } else {
        let code = window.slice(end, close);
        if (code.length >= 2 && code[0] === " " && code[code.length - 1] === " " && code.trim() !== "") code = code.slice(1, -1);
        out += `${mark}${kept.push(code) - 1}${mark}`;
        index = close + (end - index);
      }
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

/** Where, from `from` on, the next run of exactly `length` backticks starts, or -1. */
function findRun(text: string, from: number, length: number): number {
  let index = text.indexOf("`", from);
  while (index >= 0) {
    let end = index;
    while (text[end] === "`") end++;
    if (end - index === length) return index;
    index = text.indexOf("`", end);
  }
  return -1;
}

function cleanWindow(raw: string): string {
  // The spaces at the ends of the line are not text (CommonMark); a space left at an end by what is removed below is.
  const window = trimSpaces(raw);
  const mark = window.includes("`") || window.includes("\\") ? freeMark(window) : undefined;
  const kept: string[] = [];
  const text = mark === undefined ? window : protect(window, mark, kept);
  const links = text
    // An image is nothing: Tika writes no alt text.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // An autolink is its address.
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/g, "$1")
    // Strikethrough: one or two tildes, the text between them not starting or ending in a space (`~5 and ~10` is no strikethrough).
    .replace(/(?<!~)~{1,2}(?![\s~])(.+?)(?<![\s~])~{1,2}(?!~)/g, "$1");
  const decoded = decodeEntities(removeEmphasis(links, mark));
  if (mark === undefined) return decoded;
  return decoded.replace(new RegExp(`${mark}(\\d+)${mark}`, "g"), (_, index: string) => kept[Number(index)]!);
}

const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (reference) => (reference[1] === "#" ? decodeNumeric(reference) : decodeNamed(reference)));
}

function decodeNumeric(reference: string): string {
  const hex = reference[2] === "x" || reference[2] === "X";
  const code = parseInt(reference.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

let entityParser: HtmlParser | undefined;
let entityText = "";

/** The character an HTML named reference stands for, by the tables of the HTML parser the package already has; unknown names are left as written. */
function decodeNamed(reference: string): string {
  entityParser ??= new HtmlParser({ ontext: (chunk) => void (entityText += chunk) }, { decodeEntities: true });
  entityText = "";
  entityParser.parseComplete(reference);
  return entityText;
}
