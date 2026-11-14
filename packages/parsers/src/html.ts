import { createDecoder, recordDetectedEncoding, withCharset } from "./charset.ts";
import {
  AttributesImpl,
  CONTEXT_KEYS,
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
import { Parser as HtmlParser } from "htmlparser2";

type Event =
  | { readonly type: "open"; readonly name: string; readonly attributes: AttributesImpl }
  | { readonly type: "close"; readonly name: string }
  | { readonly type: "text"; readonly text: string };

/**
 * htmlparser2 keeps its open-element stack in an array with unshift/indexOf, so
 * unbounded nesting (e.g. 100k unclosed tags) is super-linear. Real documents
 * never nest this deep.
 */
export const DEFAULT_MAX_HTML_DEPTH = 2000;

/**
 * The elements go to the XHTML handler in the XHTML namespace, as Tika's JSoup parser writes them: the handler writes a
 * line break after block elements and a tab before a cell or list item only for elements in that namespace.
 */
const HEAD_ELEMENTS: ReadonlySet<string> = new Set(["html", "head", "title", "meta", "link", "base"]);

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

export interface HtmlParserOptions {
  /**
   * Maximum open-element nesting. Deliberately independent of
   * ctx.limits.maxNodeDepth, which bounds embedded-document depth (default
   * 100) and would reject ordinary deeply nested HTML.
   */
  readonly maxDepth?: number;
}

/**
 * Port of Ripstream's HTMLParser on top of htmlparser2's SAX callbacks. Script and
 * style content is suppressed, the title becomes metadata, and all other
 * events are replayed into the XHTML handler.
 */
export class HtmlDocumentParser implements Parser {
  readonly name = "HTMLParser";
  readonly #maxDepth: number;

  constructor(options: HtmlParserOptions = {}) {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_HTML_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError(`maxDepth must be a positive integer, got ${maxDepth}`);
    }
    this.#maxDepth = maxDepth;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    // Tika's JSoupParser. XUL leans on entities from chrome:// DTDs, which strict XML parsing rejects, so it is read as HTML.
    return new Set([
      MediaType.TEXT_HTML,
      MediaType.parse("application/xhtml+xml")!,
      MediaType.parse("application/vnd.wap.xhtml+xml")!,
      MediaType.parse("application/x-asp")!,
      MediaType.parse("application/vnd.mozilla.xul+xml")!,
    ]);
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
    const { decoder, charset } = createDecoder(detectEncoding(prefix, ctx.get(CONTEXT_KEYS.CHARSET_HINT)).charset);
    metadata.set("Content-Encoding", charset);
    recordDetectedEncoding(metadata, charset);
    // Tika's JSoupParser builds the type from a constant by the incoming type's prefix, and leaves any other type alone
    // (application/vnd.mozilla.xul+xml among them).
    const previous = metadata.get("Content-Type");
    if (previous === null || previous.startsWith("text/html")) {
      metadata.set("Content-Type", withCharset(null, "text/html", charset));
    } else if (previous.startsWith("application/xhtml+xml")) {
      metadata.set("Content-Type", withCharset(null, "application/xhtml+xml", charset));
    } else if (previous.startsWith("application/vnd.wap.xhtml+xml")) {
      metadata.set("Content-Type", withCharset(null, "application/vnd.wap.xhtml+xml", charset));
    } else if (previous.startsWith("application/x-asp")) {
      metadata.set("Content-Type", withCharset(null, "application/x-asp", charset));
    }

    const events: Event[] = [];
    let suppressed = 0;
    let depth = 0;
    let inTitle = false;
    // The title of the page's head is document metadata, not text: Tika's XHTML writes it from the metadata into the head.
    // A title that comes once the body has begun (text, or an element other than the head's) is an element of the body, and
    // its text is read like any other. A head title's own events are not replayed.
    let inHeadTitle = false;
    let bodyStarted = false;
    let titleDone = false;
    let svgDepth = 0;
    let title = "";

    const parser = new HtmlParser(
      {
        onopentag(name, attributes) {
          tick();
          if (name === "script" || name === "style") {
            suppressed++;
            return;
          }
          if (suppressed > 0) return;
          if (++depth > maxDepth) {
            throw new LimitExceededError(
              `HTML nesting exceeds ${maxDepth} open elements`,
            );
          }
          if (name === "svg") svgDepth++;
          // The document title is the first <title>; an inline SVG's <title> is its accessible name, not the page's.
          if (name === "title" && !titleDone && svgDepth === 0) inTitle = true;
          if (name === "title" && !bodyStarted && svgDepth === 0) {
            inHeadTitle = true;
            return;
          }
          if (!HEAD_ELEMENTS.has(name)) bodyStarted = true;

          const atts = new AttributesImpl();
          for (const [key, value] of Object.entries(attributes)) {
            if (value !== undefined) {
              atts.addAttribute("", key, key, "CDATA", value);
            }
          }
          events.push({ type: "open", name, attributes: atts });
        },
        ontext(text) {
          tick();
          if (suppressed > 0) return;
          if (inTitle) title += text;
          if (inHeadTitle) return;
          // Whitespace between the head's elements is the head's, not body text (the first character would open the body).
          if (text.trim().length === 0) {
            if (!bodyStarted) return;
          } else {
            bodyStarted = true;
          }
          events.push({ type: "text", text });
        },
        onclosetag(name) {
          if (name === "script" || name === "style") {
            suppressed = Math.max(0, suppressed - 1);
            return;
          }
          if (suppressed > 0) return;
          depth = Math.max(0, depth - 1);
          if (name === "svg") svgDepth = Math.max(0, svgDepth - 1);
          if (name === "title" && inTitle) {
            inTitle = false;
            titleDone = true;
            const value = title.trim();
            if (value.length > 0) {
              metadata.set("dc:title", value);
              metadata.set("title", value);
            }
          }
          if (name === "title" && inHeadTitle) {
            inHeadTitle = false;
            return;
          }
          events.push({ type: "close", name });
        },
      },
      {
        decodeEntities: true,
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
        recognizeCDATA: true,
      },
    );

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    for await (const chunk of stream) {
      parser.write(decoder.decode(chunk, { stream: true }));
      await drain(events, xhtml, tick);
    }
    parser.end();
    await drain(events, xhtml, tick);

    await xhtml.endDocument();
  }
}

async function drain(
  events: Event[],
  handler: XHTMLContentHandler,
  tick: () => void,
): Promise<void> {
  // Index cursor: Array.shift() on a large queue is O(n), making this quadratic.
  // A handler that answers synchronously is not awaited: a promise per event is costly on large documents.
  for (const event of events) {
    tick();
    let result;
    if (event.type === "open") {
      result = handler.startElement(XHTML_NAMESPACE, event.name, event.name, event.attributes);
    } else if (event.type === "close") {
      result = handler.endElement(XHTML_NAMESPACE, event.name, event.name);
    } else {
      result = handler.characters(event.text);
    }
    if (result !== undefined) await result;
  }
  events.length = 0;
}
