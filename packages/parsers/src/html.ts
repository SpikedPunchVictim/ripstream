import { createDecoder, withCharset } from "./charset.ts";
import {
  AttributesImpl,
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
    const { decoder, charset } = createDecoder(detectEncoding(prefix).charset);
    metadata.set("Content-Encoding", charset);
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
          if (name === "title") inTitle = true;

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
          events.push({ type: "text", text });
        },
        onclosetag(name) {
          if (name === "script" || name === "style") {
            suppressed = Math.max(0, suppressed - 1);
            return;
          }
          if (suppressed > 0) return;
          depth = Math.max(0, depth - 1);
          if (name === "title") {
            inTitle = false;
            const value = title.trim();
            if (value.length > 0) {
              metadata.set("dc:title", value);
              metadata.set("title", value);
            }
          }
          events.push({ type: "close", name });
        },
      },
      {
        decodeEntities: true,
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
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
  for (const event of events) {
    tick();
    if (event.type === "open") {
      await handler.startElement("", event.name, event.name, event.attributes);
    } else if (event.type === "close") {
      await handler.endElement("", event.name, event.name);
    } else {
      await handler.characters(event.text);
    }
  }
  events.length = 0;
}
