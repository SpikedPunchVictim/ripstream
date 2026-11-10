import type { ContentHandler } from "./content-handler.ts";
import { MarkdownContentHandler } from "./handlers/markdown.ts";
import { BodyContentHandler, TextContentHandler } from "./handlers/text.ts";
import { ToHTMLContentHandler, ToXMLContentHandler } from "./handlers/xml.ts";

/**
 * The shape a parse's content is written in, by Tika's `BasicContentHandlerFactory.HANDLER_TYPE` (`TEXT`, `BODY`,
 * `HTML`, `XML`, `MARKDOWN`, `IGNORE`):
 *
 * - "text" (the library default): plain text. `parse` writes the characters of the body; `parseRecursive` writes every
 *   character of the container and the body's characters of each embedded document.
 * - "body": the characters of the XHTML body only, for the container too.
 * - "html" / "xml": the XHTML the parsers write, serialized (with the document's metadata as `<meta>` in the head).
 * - "markdown": the XHTML as Markdown. Best effort: Tika's own Markdown is not reproduced byte for byte.
 * - "ignore": no content at all, for a caller that wants only the metadata.
 */
export type HandlerType = "text" | "body" | "html" | "xml" | "markdown" | "ignore";

/** Every handler type, for validating one that arrives from outside. */
export const HANDLER_TYPES: readonly HandlerType[] = ["text", "body", "html", "xml", "markdown", "ignore"];

/** Every spelling Tika's `parseHandlerType` accepts, for messages. */
export const HANDLER_TYPE_NAMES = "text, txt, html, xml, body, markdown, md, ignore";

/**
 * A handler type by Tika's spellings (case-insensitive): `txt` is `text`, `md` is `markdown`. A missing name is
 * `fallback`; a name Tika does not know is a caller's mistake and throws a RangeError, with Tika's message.
 */
export function parseHandlerType(name: string | null | undefined, fallback: HandlerType = "text"): HandlerType {
  if (name === null || name === undefined) return fallback;
  switch (name.toLowerCase()) {
    case "text":
    case "txt":
      return "text";
    case "body":
      return "body";
    case "html":
      return "html";
    case "xml":
      return "xml";
    case "markdown":
    case "md":
      return "markdown";
    case "ignore":
      return "ignore";
    default:
      throw new RangeError(`Unrecognized handler type '${name}'. Valid types: ${HANDLER_TYPE_NAMES}`);
  }
}

/** The handler type as Tika names it in `tk:content-handler-type` (its enum constant: `TEXT`, `MARKDOWN`, ...). */
export function handlerTypeName(type: HandlerType): string {
  return type.toUpperCase();
}

/** A handler that gathers its output, which is what `toString()` answers. */
export interface OutputContentHandler extends ContentHandler {
  toString(): string;
}

/** Tika's NoOpContentHandler: takes every event, keeps nothing. */
class NoOpContentHandler implements OutputContentHandler {
  startDocument(): void {}
  endDocument(): void {}
  toString(): string {
    return "";
  }
}

/** A new handler that writes a document's content in the given shape. */
export function createOutputHandler(type: HandlerType): OutputContentHandler {
  switch (type) {
    case "text":
      return new TextContentHandler();
    case "body":
      return new BodyContentHandler();
    case "html":
      return new ToHTMLContentHandler();
    case "xml":
      return new ToXMLContentHandler("UTF-8", false);
    case "markdown":
      return new MarkdownContentHandler();
    case "ignore":
      return new NoOpContentHandler();
  }
}
