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
  | { readonly type: "newline" }
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

/**
 * The elements Tika's HtmlMapper keeps and that begin the body of its XHTML (measured on 4.2.0 with an empty element ahead of a
 * `div`: the line break after the `div` is written only when the body has begun). Any other element is dropped by Tika, and
 * the line break it ends with is written when the body has begun, and lost before.
 */
const BODY_STARTING_ELEMENTS: ReadonlySet<string> = new Set([
  "a", "q", "del", "ins", "img", "map", "area", "param", "iframe", "object", "p", "dl", "dd", "dt", "li", "ol", "ul", "menu",
  "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "address", "blockquote",
]);
/** The inline elements the XHTML handler holds back until text follows: they do not begin the body. */
const HELD_INLINE_ELEMENTS: ReadonlySet<string> = new Set(["b", "strong", "i", "em", "sup", "sub"]);
/** The elements after which the XHTML handler writes a line break. */
const LINE_ENDING_ELEMENTS: ReadonlySet<string> = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "ul", "ol", "dl", "pre", "hr", "blockquote", "address", "fieldset", "table",
  "form", "noscript", "li", "dt", "dd", "noframes", "br", "tr", "select", "option", "link", "script",
]);
/** Table parts HTML5 drops where no table is open: their text stays, their element (and its line break) does not (tikajs-ixsj). */
const TABLE_PARTS: ReadonlySet<string> = new Set([
  "tr", "td", "th", "tbody", "thead", "tfoot", "caption", "colgroup", "col",
]);

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
    // HTML5 does not close the body or the html element at their end tags: text and elements that follow still belong to
    // the body, and a second <html> or <body> only merges into the first. Their end events are written once the input ends.
    let htmlOpen = false;
    let bodyOpen = false;
    // Tika drops the whitespace-only text that follows an end of the body or html element, up to the first element or text
    // with a character in it (measured on 4.2.0: "</body>\n</html>\n" adds nothing, "</html>\n<p>y</p>" starts at the p).
    let afterEnd = false;
    // Whether the XHTML has begun its body: text has been written, or an element that starts it.
    let bodyWritten = false;
    // Per open element: whether its start was written. One that was not (dropped ahead of the body) writes no end either.
    const written: boolean[] = [];
    // Per open element: a table part HTML5 drops where no table is open (its text stays, its element does not).
    const ignoredElement: boolean[] = [];
    // Per open table: whether a row is open, and whether it is the implied one a cell outside a row makes.
    const tables: Array<{ row: boolean; implied: boolean }> = [];
    // HTML5 (and htmlparser2) closes a p when a table starts; Tika's parser keeps the table in the p, so the close waits
    // for the next event: a table means the p stays open, anything else applies the close first (tikajs-ixsj).
    let deferredPClose = false;
    const applyDeferredPClose = (): void => {
      if (!deferredPClose) return;
      deferredPClose = false;
      depth = Math.max(0, depth - 1);
      const sent = written.pop() ?? true;
      if (sent) events.push({ type: "close", name: "p" });
      else if (bodyWritten) events.push({ type: "newline" });
    };

    const parser = new HtmlParser(
      {
        onopentag(name, attributes) {
          tick();
          if (deferredPClose) {
            if (name === "table") deferredPClose = false;
            else applyDeferredPClose();
          }
          if (name === "script" || name === "style") {
            suppressed++;
            return;
          }
          if (suppressed > 0) return;
          if ((name === "html" && htmlOpen) || (name === "body" && bodyOpen)) return;
          afterEnd = false;
          // HTML5 drops a tr, td, th or another table part where no table is open (tikajs-ixsj): its text is written, its
          // element and the line break after it are not.
          const dropped = tables.length === 0 && TABLE_PARTS.has(name);
          if (!dropped) {
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
            if (name === "html") htmlOpen = true;
            if (name === "body") bodyOpen = true;
          }
          // The XHTML writes its own html, head and body: those of the page are not elements of it. Any other element that does
          // not begin the body is dropped ahead of it, as Tika drops it.
          const starts = BODY_STARTING_ELEMENTS.has(name);
          const send = !dropped && name !== "html" && name !== "body" && (bodyWritten || starts || HELD_INLINE_ELEMENTS.has(name));
          if (name !== "html" && name !== "body") {
            written.push(send);
            ignoredElement.push(dropped);
          }
          if (dropped) return;
          if (!send) return;
          if (starts) bodyWritten = true;

          // A cell outside a row is in the row HTML5 implies for it, which the table's end closes.
          if (name === "table") tables.push({ row: false, implied: false });
          else if (name === "tr" && tables.length > 0) {
            const table = tables.at(-1)!;
            if (table.implied) {
              events.push({ type: "close", name: "tr" });
              table.implied = false;
            }
            table.row = true;
          } else if ((name === "td" || name === "th") && tables.length > 0) {
            const table = tables.at(-1)!;
            if (!table.row) {
              events.push({ type: "open", name: "tr", attributes: new AttributesImpl() });
              table.row = true;
              table.implied = true;
            }
          }

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
          applyDeferredPClose();
          if (suppressed > 0) return;
          if (inTitle) title += text;
          if (inHeadTitle) return;
          // Whitespace between the head's elements is the head's, not body text (the first character would open the body).
          if (text.trim().length === 0) {
            if (!bodyStarted || afterEnd) return;
          } else {
            bodyStarted = true;
            afterEnd = false;
          }
          bodyWritten = true;
          events.push({ type: "text", text });
        },
        onclosetag(name, isImplied) {
          applyDeferredPClose();
          if (name === "script" || name === "style") {
            suppressed = Math.max(0, suppressed - 1);
            return;
          }
          if (suppressed > 0) return;
          if ((name === "html" && htmlOpen) || (name === "body" && bodyOpen)) {
            afterEnd = true;
            return;
          }
          // A p closed by a following block waits one event: a table keeps it open, as Tika's parser does.
          if (isImplied && name === "p") {
            deferredPClose = true;
            return;
          }
          const dropped = ignoredElement.pop() ?? false;
          if (dropped) return;
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
          if (name === "table" && tables.length > 0) {
            const table = tables.pop()!;
            if (table.implied) events.push({ type: "close", name: "tr" });
          } else if (name === "tr" && tables.length > 0) {
            tables.at(-1)!.row = false;
          }
          const sent = written.pop() ?? true;
          if (sent) events.push({ type: "close", name });
          else if (bodyWritten && LINE_ENDING_ELEMENTS.has(name)) events.push({ type: "newline" });
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
    applyDeferredPClose();
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
    } else if (event.type === "newline") {
      result = handler.newline();
    } else {
      result = handler.characters(event.text);
    }
    if (result !== undefined) await result;
  }
  events.length = 0;
}
