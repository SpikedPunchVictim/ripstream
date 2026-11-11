import { SaxesParser } from "saxes";
import { localName } from "./xml-tree.ts";

/**
 * What a SAX handler of the Tika parsers sees: element local names, attributes by qualified name, character data. The
 * qualified name comes as well, for a handler that has to resolve a prefix itself (saxes is not namespace-aware here).
 */
export interface XmlEvents {
  open(localName: string, attributes: Record<string, string>, qualifiedName: string): void;
  text(text: string): void;
  close(localName: string, qualifiedName: string): void;
}

const CHUNK_CHARS = 64 * 1024;

/**
 * Feeds `xml` to saxes a chunk at a time and calls `drain` after each, so that a handler which queues what it wants
 * written holds one chunk's worth, not a whole document's, and the output limit is reached while the document is
 * still being read. saxes calls the handler synchronously; `drain` is where the asynchronous writes happen.
 *
 * Returns the error saxes raised on malformed XML, or undefined. The events before it have been delivered and
 * drained, as SAX events before a parse error are.
 */
export async function parseXmlChunked(
  xml: string,
  events: XmlEvents,
  drain: () => Promise<void>,
): Promise<Error | undefined> {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) =>
    events.open(localName(tag.name), tag.attributes as Record<string, string>, tag.name),
  );
  parser.on("text", (text) => events.text(text));
  parser.on("cdata", (text) => events.text(text));
  parser.on("closetag", (tag) => events.close(localName(tag.name), tag.name));

  let failure: Error | undefined;
  let at = 0;
  while (failure === undefined && at < xml.length) {
    let end = Math.min(at + CHUNK_CHARS, xml.length);
    // Never split a surrogate pair between two writes.
    const last = xml.charCodeAt(end - 1);
    if (end < xml.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    try {
      parser.write(xml.slice(at, end));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    at = end;
    await drain();
  }
  if (failure === undefined) {
    try {
      parser.close();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    await drain();
  }
  return failure;
}
