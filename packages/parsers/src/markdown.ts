import { createDecoder, recordDetectedEncoding, withCharset } from "./charset.ts";
import {
  CONTEXT_KEYS,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";

/** Markdown text extraction. Formatting markers are removed; block text is kept. */
export class MarkdownParser implements Parser {
  readonly name = "MarkdownParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("text/markdown")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const prefix = await stream.peek(64 * 1024);
    const { decoder, charset } = createDecoder(detectEncoding(prefix, ctx.get(CONTEXT_KEYS.CHARSET_HINT)).charset);
    metadata.set("Content-Encoding", charset);
    recordDetectedEncoding(metadata, charset);
    metadata.set("Content-Type", withCharset(null, "text/markdown", charset));

    let text = "";
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const stripped = stripFences(text);
    const hints = ctx.get(CONTEXT_KEYS.SEGMENT_HINTS);
    const lines = hints === undefined ? undefined : lineFinder(text, stripped.pieces);
    for (const block of blocks(stripped.text)) {
      if (hints !== undefined) {
        hints.line(lines!(block.offset));
        if (block.heading > 0) hints.heading(block.heading, block.title);
      }
      await xhtml.startElement("p");
      await xhtml.characters(block.text);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

interface Block {
  readonly text: string;
  /** Where the block's first written line starts in the fence-stripped text. */
  readonly offset: number;
  /** The level of a block that is one ATX heading line (`## Title`), 0 otherwise. */
  readonly heading: number;
  /** The heading's text when the block is a setext heading (`Title` over `=====`), whose text also holds the underline. */
  readonly title?: string;
}

function blocks(markdown: string): Block[] {
  const result: Block[] = [];
  let start = 0;
  for (const separator of [...markdown.matchAll(/\n{2,}/g), null]) {
    const end = separator === null ? markdown.length : separator.index;
    let offset = -1;
    let heading = 0;
    let written = 0;
    let lineStart = start;
    const cleaned: string[] = [];
    for (const line of markdown.slice(start, end).split("\n")) {
      const clean = cleanLongLine(line)[0]!;
      if (clean.length > 0) {
        if (offset < 0) {
          offset = lineStart;
          heading = /^\s{0,3}(#{1,6})\s+/.exec(line)?.[1]?.length ?? 0;
        }
        written++;
        cleaned.push(clean);
      }
      lineStart += line.length + 1;
    }
    if (cleaned.length > 0) {
      const setext = setextHeading(cleaned);
      if (setext !== undefined) result.push({ text: cleaned.join(" "), offset, heading: setext.level, title: setext.title });
      else result.push({ text: cleaned.join(" "), offset, heading: written === 1 ? heading : 0 });
    }
    if (separator !== null) start = separator.index + separator[0].length;
  }
  return result;
}

/** A block of lines that ends in `===` or `---` under text is a setext heading: level 1 for `=`, 2 for `-`. */
function setextHeading(lines: readonly string[]): { readonly level: number; readonly title: string } | undefined {
  if (lines.length < 2) return undefined;
  const underline = /^\s{0,3}(=+|-+)\s*$/.exec(lines[lines.length - 1]!)?.[1];
  const title = lines.slice(0, -1).join(" ").trim();
  // A rule, or the rule that closes a front matter, is not the underline of a heading.
  if (underline === undefined || /^[-=*_\s]*$/.test(title) || /^\s{0,3}(---|\+\+\+)\s*$/.test(lines[0]!)) return undefined;
  return { level: underline.startsWith("=") ? 1 : 2, title };
}

/** A piece of the fence-stripped text: from `at` on, it is the source from `source` on. */
interface Piece {
  readonly at: number;
  readonly source: number;
}

/** Linear replacement for /```[^\n]*\n([\s\S]*?)```/g, which is quadratic on unclosed fences. */
function stripFences(markdown: string): { readonly text: string; readonly pieces: readonly Piece[] } {
  let out = "";
  let index = 0;
  const pieces: Piece[] = [];
  for (;;) {
    const open = markdown.indexOf("```", index);
    const newline = open === -1 ? -1 : markdown.indexOf("\n", open + 3);
    const close = newline === -1 ? -1 : markdown.indexOf("```", newline + 1);
    pieces.push({ at: out.length, source: index });
    if (close === -1) return { text: out + markdown.slice(index), pieces };
    out += markdown.slice(index, open);
    pieces.push({ at: out.length, source: newline + 1 });
    out += markdown.slice(newline + 1, close);
    index = close + 3;
  }
}

/** The source line (1-based) of an offset into the fence-stripped text; asked in increasing order of offset. */
function lineFinder(source: string, pieces: readonly Piece[]): (offset: number) => number {
  const lineStarts = [0];
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) lineStarts.push(at + 1);
  let index = 0;
  return (offset) => {
    while (index + 1 < pieces.length && pieces[index + 1]!.at <= offset) index++;
    const piece = pieces[index]!;
    const position = piece.source + (offset - piece.at);
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle]! <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

/**
 * The inline-marker regexes below are quadratic on lines with many unclosed
 * markers, so very long lines are cleaned in bounded windows. A window ends at the last whitespace within
 * MAX_WORD_LOOKBACK of its limit, so a word is not cut in two; with none there the window is cut where it
 * stands (not between the halves of a surrogate pair) and the pieces are joined without a space. A marker pair that
 * spans two windows is left as written, which is the cost of the bound.
 */
const MAX_INLINE_WINDOW = 256;
const MAX_WORD_LOOKBACK = 64;
function cleanLongLine(line: string): string[] {
  if (line.length <= MAX_INLINE_WINDOW) return [cleanLine(line, true)];
  let out = "";
  let start = 0;
  let first = true;
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
    const piece = cleanLine(line.slice(start, end), first);
    first = false;
    out += piece;
    start = end + separator.length;
    if (start < line.length) out += separator;
  }
  return [out];
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `lineStart` is false for a window that continues a line: the block markers only apply where a line begins. */
function cleanLine(line: string, lineStart: boolean): string {
  return (lineStart
    ? line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    : line
  )
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    // CommonMark does not open or close underscore emphasis inside a word, so `_gitlab_session` keeps its underscores.
    .replace(/(^|[\s([{>])__(.+?)__(?=$|[\s)\]}.,;:!?])/g, "$1$2")
    .replace(/(^|[\s([{>])_(?!_)(.+?)_(?=$|[\s)\]}.,;:!?])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*\|.*\|\s*$/, (row) => row.replace(/\|/g, " ").trim())
    .trim();
}
