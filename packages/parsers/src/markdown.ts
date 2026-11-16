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
  type SegmentHints,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";
import { cleanInline } from "./markdown-inline.ts";
import { parseMarkdownBlocks, type Block } from "./markdown-blocks.ts";

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
    const writer = new BlockWriter(xhtml, ctx.get(CONTEXT_KEYS.SEGMENT_HINTS));
    for (const block of parseMarkdownBlocks(text)) await writer.write(block, false);
    await xhtml.endDocument();
  }
}

/** The elements whose start the segment hints' line applies to: the ones that open a segment of their own. */
const SEGMENT_ELEMENTS: ReadonlySet<string> = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "blockquote"]);

/** What goes between two lines of a paragraph or a heading: a line break is a newline, as it is in Tika's text. */
const LINE_BREAK = "\n";
const SOFT_BREAK = "\n";

/**
 * Writes the blocks as the XHTML Tika's Markdown parser writes (a paragraph is `p`, a list `ul`/`ol` of `li`, a table
 * `table` of `tr` of `td`), so that the XHTML handler lays the text out as it does for Tika: a newline after a block, a tab
 * before a list item or a cell.
 */
class BlockWriter {
  readonly #xhtml: XHTMLContentHandler;
  readonly #hints: SegmentHints | undefined;

  constructor(xhtml: XHTMLContentHandler, hints: SegmentHints | undefined) {
    this.#xhtml = xhtml;
    this.#hints = hints;
  }

  async write(block: Block, tight: boolean): Promise<void> {
    switch (block.kind) {
      case "paragraph":
        // The paragraphs of a tight list item are not wrapped in a `p`: the item holds the text.
        if (tight) await this.#xhtml.characters(inlineText(block.lines));
        else await this.#element("p", block.line, inlineText(block.lines));
        return;
      case "heading":
        // Front matter is text between two rules: it is not announced as a heading.
        await this.#element(block.frontMatter ? "p" : `h${block.level}`, block.line, inlineText(block.lines));
        return;
      case "code":
        await this.#element("pre", block.line, block.lines.length === 0 ? "" : `${block.lines.join("\n")}\n`);
        return;
      case "html":
        await this.#element("p", block.line, block.lines.join("\n"));
        return;
      case "rule":
        await this.#xhtml.startElement("hr");
        await this.#xhtml.endElement("hr");
        return;
      case "quote":
        this.#line("blockquote", block.line);
        await this.#xhtml.startElement("blockquote");
        for (const child of block.children) await this.write(child, false);
        await this.#xhtml.endElement("blockquote");
        return;
      case "list": {
        const name = block.ordered ? "ol" : "ul";
        await this.#xhtml.startElement(name);
        for (const item of block.items) {
          this.#line("li", item.line);
          await this.#xhtml.startElement("li");
          for (const child of item.children) await this.write(child, block.tight);
          await this.#xhtml.endElement("li");
        }
        await this.#xhtml.endElement(name);
        return;
      }
      case "table":
        await this.#xhtml.startElement("table");
        await this.#row("th", block.header);
        for (const row of block.rows) await this.#row("td", row);
        await this.#xhtml.endElement("table");
        return;
    }
  }

  async #row(cell: "th" | "td", cells: readonly string[]): Promise<void> {
    await this.#xhtml.startElement("tr");
    for (const text of cells) {
      await this.#xhtml.startElement(cell);
      await this.#xhtml.characters(cleanInline(text));
      await this.#xhtml.endElement(cell);
    }
    await this.#xhtml.endElement("tr");
  }

  async #element(name: string, line: number, text: string): Promise<void> {
    this.#line(name, line);
    await this.#xhtml.startElement(name);
    await this.#xhtml.characters(text);
    await this.#xhtml.endElement(name);
  }

  #line(name: string, line: number): void {
    if (this.#hints !== undefined && SEGMENT_ELEMENTS.has(name)) this.#hints.line(line);
  }
}

/** The lines of a paragraph or a heading as one text: marks removed, a hard break (two spaces or a backslash) a newline. */
function inlineText(lines: readonly string[]): string {
  let text = "";
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    const last = index + 1 === lines.length;
    let hard = false;
    if (!last) {
      if (line.endsWith("  ")) hard = true;
      else if (endsWithOddBackslashes(line)) {
        hard = true;
        line = line.slice(0, -1);
      }
    }
    text += cleanInline(line);
    if (!last) text += hard ? LINE_BREAK : SOFT_BREAK;
  }
  return text;
}

function endsWithOddBackslashes(line: string): boolean {
  let count = 0;
  while (count < line.length && line.charCodeAt(line.length - 1 - count) === 0x5c) count++;
  return count % 2 === 1;
}
