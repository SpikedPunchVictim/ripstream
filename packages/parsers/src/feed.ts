import { createDecoder } from "./charset.ts";
import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";
import { detectXmlEncoding } from "./xml-encoding.ts";

/**
 * RSS/Atom feed parser. Extracts feed metadata and each entry's title, link,
 * and content into XHTML blocks.
 */
export class FeedParser implements Parser {
  readonly name = "FeedParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/rss+xml",
        "application/atom+xml",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const data = concat(chunks);
    // Tika's news parser writes no Content-Encoding.
    const { decoder } = createDecoder(detectXmlEncoding(data));
    const xml = decoder.decode(data);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    let entryDepth = 0;
    let current: FeedEntry = emptyEntry();
    let field: string | null = null;
    const entries: FeedEntry[] = [];

    const parser = new SaxesParser({ xmlns: false });
    // #21: without a handler saxes throws a raw Error on malformed XML (→ 500);
    // surface it as a 422 MalformedDocumentError at the source instead.
    parser.on("error", (error) => {
      throw new MalformedDocumentError(`Malformed feed XML: ${error.message}`, {
        cause: error,
      });
    });
    // The feed's own title is the title directly under channel/feed, once: an <image><title> follows it and is not it.
    const open: string[] = [];
    let channelTitle: string | null = null;
    let channelTitleSet = false;
    parser.on("opentag", (tag) => {
      const name = local(tag.name);
      open.push(name);
      const attributes = tag.attributes as Record<string, string>;
      if (name === "item" || name === "entry") {
        entryDepth++;
        current = emptyEntry();
      } else if (name === "link" && attributes.href !== undefined) {
        // Atom: the address is an attribute. Only the page itself counts, not rel="self" or rel="enclosure".
        const rel = attributes.rel;
        if (rel === undefined || rel === "alternate") {
          if (entryDepth > 0) {
            if (current.link.length === 0) current.link = attributes.href;
          } else if (metadata.get("feed:link") === null) {
            metadata.set("feed:link", attributes.href);
          }
        }
      } else if (FIELD_NAMES.has(name)) {
        field = name;
        if (name === "title" && entryDepth === 0 && !channelTitleSet && FEED_PARENTS.has(open[open.length - 2] ?? "")) {
          channelTitle = "";
        }
      }
    });
    const onText = (text: string): void => {
      if (field === null) return;
      if (entryDepth > 0) {
        if (field === "title") current.title += text;
        else if (field === "link") current.link += text;
        else current.body += text;
      } else if (field === "title" && channelTitle !== null) {
        channelTitle += text;
      }
    };
    parser.on("text", onText);
    parser.on("cdata", onText);
    parser.on("closetag", (tag) => {
      const name = local(tag.name);
      open.pop();
      if (FIELD_NAMES.has(name)) field = null;
      if (name === "title" && channelTitle !== null) {
        metadata.set("dc:title", channelTitle.trim());
        channelTitle = null;
        channelTitleSet = true;
      }
      if ((name === "item" || name === "entry") && entryDepth > 0) {
        entryDepth--;
        entries.push(current);
        current = emptyEntry();
      }
    });
    parser.write(xml).close();

    for (const entry of entries) await emitEntry(entry, xhtml);

    await xhtml.endDocument();
  }
}

interface FeedEntry {
  title: string;
  link: string;
  body: string;
}

const FEED_PARENTS = new Set(["channel", "feed"]);
const FIELD_NAMES = new Set(["title", "link", "description", "content", "summary"]);

function emptyEntry(): FeedEntry {
  return { title: "", link: "", body: "" };
}

async function emitEntry(entry: FeedEntry, xhtml: XHTMLContentHandler): Promise<void> {
  await xhtml.startElement("div", "class", "feed-entry");
  if (entry.title.length > 0) await xhtml.element("h1", entry.title.trim());
  if (entry.body.length > 0) await xhtml.element("p", entry.body.trim());
  if (entry.link.length > 0) await xhtml.element("p", entry.link.trim());
  await xhtml.endElement("div");
}

function local(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
