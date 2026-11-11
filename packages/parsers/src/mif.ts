import { createDecoder, recordDetectedEncoding } from "./charset.ts";
import { LineSplitter } from "./line-splitter.ts";
import {
  LimitExceededError,
  MediaType,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";

/** One line of a real MIF file is far shorter; this bounds a file that never ends its line. CsvParser's row cap is the same. */
export const DEFAULT_MAX_MIF_LINE_CHARS = 10_000_000;
/** The characters (and one more each) of the names of the elements open at once. Real MIF files nest a few dozen deep. */
export const DEFAULT_MAX_MIF_OPEN_CHARS = 1_000_000;

/** MIFParser.getContentHandler's Content-Type: the first of its three types in a HashSet, which MIFParserTest pins down. */
const CONTENT_TYPE = "application/x-mif";
const START_TAG_VALUE = "`";
const END_TAG_VALUE = "'";

export interface MifParserOptions {
  /** Maximum characters in one line (default {@link DEFAULT_MAX_MIF_LINE_CHARS}); a longer one is a LimitExceededError. */
  readonly maxLineChars?: number;
  /** Maximum characters held in the names of the open elements (default {@link DEFAULT_MAX_MIF_OPEN_CHARS}). */
  readonly maxOpenChars?: number;
}

/**
 * Port of Tika's MIFParser, MIFExtractor and MIFContentHandler (tika-parser-miscoffice-module) for Adobe FrameMaker MIF
 * (`application/vnd.mif`, `application/x-maker`, `application/x-mif`).
 *
 * The file is read as text, a line at a time. A line with `<` and no `>` opens an element named by what follows the `<` up to
 * the first space; a line that starts with `>` ends the element on top (and pops it only when the name at the end of the line
 * is that element's); any other line of the form `<Name value>` is a statement. Of the statements only three names matter:
 * `String` is text (the value, with its backtick and closing quote removed and then XML-escaped, which a text handler writes
 * as it is), `Para` is a paragraph, and `PageType` is counted into `meta:page-count` and the `mif:` counts.
 *
 * The regular expressions of MIFExtractor and Java's `String.trim()` are written out by hand, because they differ from
 * JavaScript's: `\S` and `\s` are ASCII only, `.` stops at U+0085, U+2028 and U+2029, and `trim()` takes every character up to
 * U+0020 off. Java's `StringEscapeUtils.escapeXml` is commons-lang3's, written here from memory (it is not in the Tika tree).
 *
 * Differences from Tika, all read from the source and not run against a Tika:
 *  - A line over `maxLineChars` and open-element names over `maxOpenChars` are a LimitExceededError. Tika has no cap and keeps
 *    a tree of every statement it has read (which it never uses); this port keeps only the names of the open elements.
 *  - The character set comes from ripstream's detector, as for the other text parsers, not Tika's AutoDetectReader.
 *  - Tika's StringEscapeUtils also removes an unpaired surrogate; decoded text has none.
 */
export class MifParser implements Parser {
  readonly name = "MIFParser";
  readonly #maxLineChars: number;
  readonly #maxOpenChars: number;

  constructor(options: MifParserOptions = {}) {
    this.#maxLineChars = positive("maxLineChars", options.maxLineChars ?? DEFAULT_MAX_MIF_LINE_CHARS);
    this.#maxOpenChars = positive("maxOpenChars", options.maxOpenChars ?? DEFAULT_MAX_MIF_OPEN_CHARS);
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(["application/vnd.mif", "application/x-maker", "application/x-mif"].map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const tick = signalCheckpoint(ctx);
    const prefix = await stream.peek(64 * 1024);
    const { decoder, charset } = createDecoder(detectEncoding(prefix).charset);
    metadata.set("Content-Encoding", charset);
    recordDetectedEncoding(metadata, charset);
    metadata.set("Content-Type", CONTENT_TYPE);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const statements = new MifStatements(new MifContent(xhtml, metadata), this.#maxOpenChars);
    const lines = new LineSplitter(this.#maxLineChars, "a MIF line");
    const read = async (found: readonly string[]): Promise<void> => {
      for (const line of found) {
        tick();
        await statements.line(line);
      }
    };

    for await (const chunk of stream) await read(lines.push(decoder.decode(chunk, { stream: true })));
    await read(lines.push(decoder.decode()));
    await read(lines.finish());
    statements.endDocument();
    await xhtml.endDocument();
  }
}

function positive(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** MIFExtractor.parse: the statements of the lines, passed to the content handler. */
class MifStatements {
  readonly #content: MifContent;
  readonly #maxOpenChars: number;
  /** The names of the open elements. Tika also keeps a Tag tree it never reads. */
  readonly #parents: string[] = [];
  #openChars = 0;

  constructor(content: MifContent, maxOpenChars: number) {
    this.#content = content;
    this.#maxOpenChars = maxOpenChars;
  }

  async line(line: string): Promise<void> {
    if (line.includes("<") && !line.includes(">")) {
      const name = openName(javaTrim(line));
      if (name === null) return;
      this.#open(name);
      await this.#content.startElement(name);
    } else if (javaTrim(line).startsWith(">")) {
      const trimmed = javaTrim(line);
      const tagName = trimmed.slice(trimmed.lastIndexOf(" ") + 1);
      // peek() on an empty stack throws EmptyStackException, which MIFExtractor swallows.
      const parent = this.#parents.at(-1);
      if (parent === undefined) return;
      if (tagName === parent) this.#close();
      await this.#content.endElement(parent);
    } else {
      const statement = statementOf(javaTrim(line));
      if (statement !== null) await this.#statement(statement.name, statement.value);
    }
  }

  endDocument(): void {
    this.#content.endDocument();
  }

  #open(name: string): void {
    this.#openChars += name.length + 1;
    if (this.#openChars > this.#maxOpenChars) {
      throw new LimitExceededError(`the open elements of a MIF file hold more than ${this.#maxOpenChars} characters of names`);
    }
    this.#parents.push(detach(name));
  }

  #close(): void {
    const name = this.#parents.pop();
    if (name !== undefined) this.#openChars -= name.length + 1;
  }

  /** MIFExtractor.processTag. */
  async #statement(name: string, value: string): Promise<void> {
    await this.#content.startElement(name);
    let text = value;
    if (text.startsWith(START_TAG_VALUE)) text = text.slice(START_TAG_VALUE.length);
    if (text.endsWith(END_TAG_VALUE)) text = text.slice(0, -END_TAG_VALUE.length);
    await this.#content.characters(escapeXml(text));
    await this.#content.endElement(name);
  }
}

/** MIFContentHandler: the text of the Strings, a p for each Para, and the page counts. */
class MifContent {
  readonly #xhtml: XHTMLContentHandler;
  readonly #metadata: Metadata;
  #inContent = false;
  #inPage = false;
  #bodyPageCount = 0;
  #masterPageCount = 0;
  #referencePageCount = 0;

  constructor(xhtml: XHTMLContentHandler, metadata: Metadata) {
    this.#xhtml = xhtml;
    this.#metadata = metadata;
  }

  async startElement(name: string): Promise<void> {
    if (name === "PageType") this.#inPage = true;
    if (name === "Para") await this.#xhtml.startElement("p");
    if (name === "String") this.#inContent = true;
  }

  async characters(value: string): Promise<void> {
    if (this.#inContent) await this.#xhtml.characters(value, 0, value.length);
    if (this.#inPage) {
      switch (value) {
        case "BodyPage":
          this.#bodyPageCount++;
          break;
        case "LeftMasterPage":
        case "RightMasterPage":
        case "OtherMasterPage":
          this.#masterPageCount++;
          break;
        case "ReferencePage":
          this.#referencePageCount++;
          break;
        default:
          break;
      }
    }
  }

  async endElement(name: string): Promise<void> {
    if (name === "String") this.#inContent = false;
    if (name === "Para") await this.#xhtml.endElement("p");
    if (name === "PageType") this.#inPage = false;
  }

  endDocument(): void {
    this.#metadata.set("meta:page-count", String(this.#bodyPageCount));
    this.#metadata.set("mif:master-page-count", String(this.#masterPageCount));
    this.#metadata.set("mif:reference-page-count", String(this.#referencePageCount));
    this.#metadata.set("mif:total-page-count", String(this.#bodyPageCount + this.#referencePageCount + this.#masterPageCount));
  }
}

/** java.lang.String.trim(): every character up to U+0020 is taken off both ends. */
function javaTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

/** Where Java's `\s` first matches at or after `from`: it is [ \t\n\x0B\f\r]. `line.length` when it does not. */
function endOfName(line: string, from: number): number {
  let index = from;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) break;
    index++;
  }
  return index;
}

const LINE_TERMINATORS = /[\u0085\u2028\u2029]/g;

/** Whether Java's `.` would stop before `line.length`: it does not match these (\n and \r are not in a line). */
function hasTerminatorFrom(line: string, from: number): boolean {
  LINE_TERMINATORS.lastIndex = from;
  return LINE_TERMINATORS.test(line);
}

/** `<(\S*).*` matched against all of `line`: the name after the `<`, or null. */
function openName(line: string): string | null {
  if (!line.startsWith("<")) return null;
  const nameEnd = endOfName(line, 1);
  return hasTerminatorFrom(line, nameEnd) ? null : line.slice(1, nameEnd);
}

/** `(<(\S*))(\s)(.*)(\>).*` matched against all of `line`: the name, and the value up to the last `>`, or null. */
function statementOf(line: string): { readonly name: string; readonly value: string } | null {
  if (!line.startsWith("<")) return null;
  const nameEnd = endOfName(line, 1);
  if (nameEnd === line.length) return null;
  const valueStart = nameEnd + 1;
  if (hasTerminatorFrom(line, valueStart)) return null;
  const close = line.lastIndexOf(">");
  if (close < valueStart) return null;
  return { name: line.slice(1, nameEnd), value: line.slice(valueStart, close) };
}

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

/** A long slice of a string keeps the whole string alive; a name held on the stack must not keep its line. */
function detach(name: string): string {
  return name.length < 13 ? name : UTF8.decode(UTF8_ENCODER.encode(name));
}

/**
 * commons-lang3 StringEscapeUtils.escapeXml (escapeXml10), from memory: `"` `&` `<` `>` `'` become entities, the control
 * characters XML 1.0 forbids (and U+FFFE, U+FFFF) are removed, and DEL and the C1 range other than U+0085 become numeric
 * references.
 */
function escapeXml(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /["&<>']|[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\u007f-\u0084\u0086-\u009f]/g,
    (char) => {
      const entity = XML_ENTITIES[char];
      if (entity !== undefined) return entity;
      const code = char.charCodeAt(0);
      return code >= 0x7f && code <= 0x9f ? `&#${code};` : "";
    },
  );
}

const XML_ENTITIES: Readonly<Record<string, string | undefined>> = {
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&apos;",
};
