import {
  MalformedDocumentError,
  MediaType,
  UnsupportedFormatError,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import { declineUnlessVersion } from "./exact-version.ts";
import { OleFile } from "./ole-stream.ts";

/*
 * Port of Tika 4.2.0's QuattroProParser, QPWTextExtractor and WPInputStream (tika-parser-miscoffice-module): the text
 * and a few metadata fields of a Quattro Pro 9 notebook, read from the records of its NativeContent_MAIN stream.
 * Read from those sources; not run against a Tika (there is no JDK here).
 */

const QP_9 = "application/x-quattro-pro; version=9";
const MAIN_STREAM = "NativeContent_MAIN";
const LINE_SEPARATOR = "\n";

export class QuattroProParser implements Parser {
  readonly name = "QuattroProParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(QP_9)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    declineUnlessVersion(metadata, "application/x-quattro-pro", ["version"], ["9"]);
    if (metadata.get("Content-Type") === null) metadata.set("Content-Type", QP_9);

    const file = OleFile.open(await readAll(stream));
    const main = file.read(MAIN_STREAM);
    if (main === undefined) {
      throw new UnsupportedFormatError(`Unsupported QuattroPro file format. Looking for OLE entry "${MAIN_STREAM}"`);
    }
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.startElement("p");
    await extractRecords(new WordPerfectReader(main), xhtml, metadata);
    await xhtml.endElement("p");
    await xhtml.endDocument();
  }
}

/**
 * WPInputStream over bytes held in memory. Tika's reads throw EOFException at the end of the stream; here a read past
 * the end is a malformed document, so no declared count or length can run beyond the bytes there are.
 */
class WordPerfectReader {
  readonly #data: Uint8Array;
  #position = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  hasNext(): boolean {
    return this.#position < this.#data.length;
  }

  /** An unsigned 16-bit value, low byte first. */
  short(): number {
    const start = this.#take(2);
    return this.#data[start]! | (this.#data[start + 1]! << 8);
  }

  /** A 32-bit value, low byte first; Tika adds the bytes as ints, so the top bit makes it negative. */
  long(): number {
    const start = this.#take(4);
    const data = this.#data;
    return data[start]! | (data[start + 1]! << 8) | (data[start + 2]! << 16) | (data[start + 3]! << 24);
  }

  /** `length` characters of one byte each, the byte being the character code (ISO-8859-1). */
  string(length: number): string {
    const start = this.#take(length);
    let text = "";
    for (let index = start; index < start + length; index++) text += String.fromCharCode(this.#data[index]!);
    return text;
  }

  skip(length: number): void {
    if (length > 0) this.#take(length);
  }

  /** A QSTR: the character count, a type byte, then one character more than the count says. */
  qstr(): string {
    const count = this.short();
    this.skip(1);
    return this.string(count + 1);
  }

  #take(length: number): number {
    if (length > this.#data.length - this.#position) throw new MalformedDocumentError("Truncated Quattro Pro record");
    const start = this.#position;
    this.#position += length;
    return start;
  }
}

/** The records QPWTextExtractor reads; every other record type is skipped by its body length. */
async function extractRecords(reader: WordPerfectReader, xhtml: XHTMLContentHandler, metadata: Metadata): Promise<void> {
  const line = async (text: string): Promise<void> => {
    await xhtml.characters(text);
    await xhtml.characters(LINE_SEPARATOR);
  };
  while (reader.hasNext()) {
    const type = reader.short();
    const bodyLength = reader.short();
    switch (type) {
      case 0x0001: // beginning of file
        metadata.set("quattropro:id", reader.string(4));
        metadata.set("quattropro:version", String(reader.short()));
        metadata.set("quattropro:build", String(reader.short()));
        reader.short(); // last saved bits
        metadata.set("quattropro:lowest-version", String(reader.short()));
        metadata.set("meta:page-count", String(reader.short()));
        reader.skip(bodyLength - 14);
        break;
      case 0x0005: // user
        metadata.set("dc:creator", reader.qstr());
        metadata.set("meta:last-author", reader.qstr());
        break;
      case 0x0403: // external link
        reader.short(); // index
        reader.short(); // page first
        reader.short(); // page last
        await line(reader.qstr());
        break;
      case 0x0407: {
        // string table; a declared count is only a count, each entry has to be there to be read
        const entries = reader.long();
        reader.long(); // total used
        reader.long(); // total saved
        for (let index = 0; index < entries; index++) await line(reader.qstr());
        break;
      }
      case 0x0601: // beginning of sheet
        reader.short(); // sheet number
        reader.short(); // first column
        reader.short(); // last column
        reader.long(); // first row
        reader.long(); // last row
        reader.short(); // format
        reader.short(); // flags
        await line(reader.qstr());
        break;
      case 0x0605: // sheet header
      case 0x0606: // sheet footer
        reader.short(); // flag
        await line(reader.qstr());
        break;
      case 0x0c02: // formula string value
        reader.short(); // column
        reader.long(); // row
        await xhtml.characters(reader.qstr());
        break;
      case 0x0c72: // generic label cell
        reader.short(); // column
        reader.long(); // row
        reader.short(); // format index
        await xhtml.characters(reader.qstr());
        break;
      case 0x0c80: // comment
        reader.short(); // column
        reader.long(); // row
        reader.long(); // flag
        await xhtml.characters(reader.qstr()); // author
        await xhtml.characters(reader.qstr()); // comment
        break;
      default:
        reader.skip(bodyLength);
    }
  }
}
