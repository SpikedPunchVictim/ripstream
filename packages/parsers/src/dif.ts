import { createDecoder } from "./charset.ts";
import {
  AttributesImpl,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  RipstreamError,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";
import { detectXmlEncoding } from "./xml-encoding.ts";

/** Real DIF records nest about eight levels. saxes resolves namespaces per element, which is quadratic in the depth. */
export const DEFAULT_MAX_DIF_DEPTH = 2000;

/** The prefix of DIFContentHandler's `KeyPrefix.file("dif:", "DIF XML element-name paths")`. */
const DIF_PREFIX = "dif:";
/** Metadata.MAX_PREFIX_ROUTE_NAME_LENGTH: a source-derived name longer than this is skipped. */
const MAX_KEY_NAME_CHARS = 1024;
/** Metadata.MAX_PREFIX_ROUTE_NAMES: after this many distinct names, a new one is skipped. */
const MAX_KEY_NAMES = 10_000;

const EMPTY_ATTRIBUTES = new AttributesImpl();

type Event =
  | { readonly type: "open"; readonly name: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "close"; readonly name: string };

export interface DifParserOptions {
  /** Maximum element nesting; deeper input is a LimitExceededError. */
  readonly maxDepth?: number;
}

/**
 * Port of Tika's DIFParser and its DIFContentHandler (tika-parser-miscoffice-module) for NASA GCMD Directory Interchange
 * Format records (`application/dif+xml`).
 *
 * Every leaf element becomes a `dif:` metadata value under the path of element names that leads to it, joined with `-`
 * (`dif:DIF-Entry_ID`). The text is only what the handler writes: an `h3` "Title: ..." for `Entry_Title`, and for
 * `Spatial_Coverage` an `h3` "Geographic Data: " and a `table` with one `tr` of two `td` for each of the four bounds.
 * As in Tika these elements go to the handler as they are, in no namespace, beside the XHTML the parser writes (`<p>`
 * wraps them all); the handler is not run through XHTMLContentHandler.
 *
 * Differences from Tika, all read from the source and not run against a Tika:
 *  - saxes reports one text event for a run of character data. Xerces may split a run at an entity reference or a buffer
 *    boundary, and DIFContentHandler writes one row (and one data-stack entry) per characters() call, so a title with
 *    `&amp;` in it makes extra rows in Tika.
 *  - A DOCTYPE is accepted but its DTD is never read (see XmlParser): a reference to an entity it declares is a malformed document.
 *  - Nesting past `maxDepth` is a LimitExceededError (Tika has no cap).
 *  - Like XmlParser, the parser does not close `<p>` and the document when the parse fails (Tika does, in a `finally`).
 */
export class DifParser implements Parser {
  readonly name = "DIFParser";
  readonly #maxDepth: number;

  constructor(options: DifParserOptions = {}) {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DIF_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError(`maxDepth must be a positive integer, got ${maxDepth}`);
    }
    this.#maxDepth = maxDepth;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow("application/dif+xml")]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const maxDepth = this.#maxDepth;
    const tick = signalCheckpoint(ctx);
    const prefix = await stream.peek(64 * 1024);

    const events: Event[] = [];
    let failed: Error | null = null;
    let depth = 0;
    const parser = new SaxesParser({ xmlns: true });
    parser.on("opentag", (tag) => {
      if (failed !== null) return;
      if (++depth > maxDepth) throw new LimitExceededError(`DIF nesting exceeds ${maxDepth} open elements`);
      events.push({ type: "open", name: (tag as unknown as { local: string }).local });
    });
    // saxes reports the whitespace around the root element as text; a SAX parser does not.
    parser.on("text", (text) => {
      if (failed === null && depth > 0) events.push({ type: "text", text });
    });
    parser.on("cdata", (text) => {
      if (failed === null && depth > 0) events.push({ type: "text", text });
    });
    parser.on("closetag", (tag) => {
      if (failed !== null) return;
      depth--;
      events.push({ type: "close", name: (tag as unknown as { local: string }).local });
    });
    parser.on("error", (error) => {
      failed ??= error;
    });

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.startElement("p");
    const writer = new DifWriter(handler, metadata);

    const { decoder } = createDecoder(detectXmlEncoding(prefix));
    try {
      for await (const chunk of stream) {
        parser.write(decoder.decode(chunk, { stream: true }));
        await drain(events, writer, tick);
        if (failed !== null) break;
      }
      if (failed === null) {
        parser.write(decoder.decode());
        parser.close();
        await drain(events, writer, tick);
      }
    } catch (error) {
      if (error instanceof RipstreamError) throw error;
      throw new MalformedDocumentError("Malformed XML", { cause: error });
    }
    if (failed !== null) throw new MalformedDocumentError("Malformed XML", { cause: failed });

    await xhtml.endElement("p");
    await xhtml.endDocument();
  }
}

async function drain(events: Event[], writer: DifWriter, tick: () => void): Promise<void> {
  for (const event of events.splice(0)) {
    tick();
    if (event.type === "open") await writer.startElement(event.name);
    else if (event.type === "close") await writer.endElement(event.name);
    else await writer.characters(event.text);
  }
}

/** java.util.Stack.peek()/pop() on an empty stack throw EmptyStackException; there is no better answer than a malformed document. */
function emptyStack(): MalformedDocumentError {
  return new MalformedDocumentError("Malformed DIF: an element ends with no text seen since the one before it (Tika's EmptyStackException)");
}

/** DIFContentHandler, with the writes it makes to its delegate and its metadata. */
class DifWriter {
  readonly #handler: ContentHandler;
  readonly #metadata: Metadata;
  /** Element names from the root to the current element. */
  readonly #tree: string[] = [];
  /** `#pathLength[i]` is the length of the key for `#tree[0..i]`: names plus one `-` each. Keeps a leaf's key check O(1). */
  readonly #pathLength: number[] = [];
  /** One entry per characters() event; one is popped per element end (so it leaks when an element has several). */
  readonly #data: string[] = [];
  readonly #names = new Set<string>();
  #isLeaf = false;

  constructor(handler: ContentHandler, metadata: Metadata) {
    this.#handler = handler;
    this.#metadata = metadata;
  }

  async characters(value: string): Promise<void> {
    this.#data.push(value);
    const current = this.#tree.at(-1);
    if (current === undefined) throw emptyStack();

    if (current === "Entry_Title") {
      await this.#text("\n");
      await this.#text("\t");
      await this.#open("h3");
      await this.#text(`Title: ${value}`);
      await this.#close("h3");
    }
    if (
      current === "Southernmost_Latitude" ||
      current === "Northernmost_Latitude" ||
      current === "Westernmost_Longitude" ||
      current === "Easternmost_Longitude"
    ) {
      await this.#text("\n");
      await this.#text("\t");
      await this.#text("\t");
      await this.#open("tr");
      await this.#open("td");
      await this.#text(`${current} : `);
      await this.#close("td");
      await this.#open("td");
      await this.#text(value);
      await this.#close("td");
      await this.#close("tr");
    }
  }

  async startElement(localName: string): Promise<void> {
    this.#isLeaf = true;
    if (localName === "Spatial_Coverage") {
      await this.#text("\n");
      await this.#text("\t");
      await this.#open("h3");
      await this.#text("Geographic Data: ");
      await this.#close("h3");
      await this.#text("\n");
      await this.#text("\t");
      await this.#open("table");
    }
    this.#tree.push(localName);
    this.#pathLength.push((this.#pathLength.at(-1) ?? 0) + localName.length + 1);
  }

  async endElement(localName: string): Promise<void> {
    if (localName === "Spatial_Coverage") {
      await this.#text("\n");
      await this.#text("\t");
      await this.#close("table");
    }
    if (this.#isLeaf) {
      const value = this.#data.at(-1);
      if (value === undefined) throw emptyStack();
      this.#addMetadata(value);
      this.#isLeaf = false;
    }
    this.#tree.pop();
    this.#pathLength.pop();
    if (this.#data.pop() === undefined) throw emptyStack();
  }

  /** Metadata.add(KeyPrefix, name, value): a name over 1024 characters is skipped, and so is a new one after 10,000. */
  #addMetadata(value: string): void {
    if ((this.#pathLength.at(-1) ?? 0) - 1 > MAX_KEY_NAME_CHARS) return;
    const key = `${DIF_PREFIX}${this.#tree.join("-")}`;
    if (!this.#names.has(key)) {
      if (this.#names.size >= MAX_KEY_NAMES) return;
      this.#names.add(key);
    }
    this.#metadata.add(key, value);
  }

  async #text(text: string): Promise<void> {
    await this.#handler.characters?.(text, 0, text.length);
  }

  async #open(name: string): Promise<void> {
    await this.#handler.startElement?.("", name, name, EMPTY_ATTRIBUTES);
  }

  async #close(name: string): Promise<void> {
    await this.#handler.endElement?.("", name, name);
  }
}
