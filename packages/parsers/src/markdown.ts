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
    for (const block of blocks(text)) {
      await xhtml.startElement("p");
      await xhtml.characters(block);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

function blocks(markdown: string): string[] {
  return stripFences(markdown)
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .flatMap((line) => cleanLongLine(line))
        .filter((line) => line.length > 0)
        .join(" "),
    )
    .filter((block) => block.length > 0);
}

/** Linear replacement for /```[^\n]*\n([\s\S]*?)```/g, which is quadratic on unclosed fences. */
function stripFences(markdown: string): string {
  let out = "";
  let index = 0;
  for (;;) {
    const open = markdown.indexOf("```", index);
    const newline = open === -1 ? -1 : markdown.indexOf("\n", open + 3);
    const close = newline === -1 ? -1 : markdown.indexOf("```", newline + 1);
    if (close === -1) return out + markdown.slice(index);
    out += markdown.slice(index, open) + markdown.slice(newline + 1, close);
    index = close + 3;
  }
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
