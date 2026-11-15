import { SaxesParser } from "saxes";

export interface XmlRoot {
  readonly localName: string;
  readonly namespaceURI: string;
}

const STOP = Symbol("xml-root-found");

/**
 * Extracts only the root element and namespace. A DOCTYPE is read past (XHTML, DITA and SVG nearly all carry one), but
 * saxes keeps its internal subset as opaque text and never fetches an external one, so no entity is declared, expanded
 * or resolved; parsing stops at the root's start tag.
 */
export function extractXmlRoot(data: Uint8Array): XmlRoot | null {
  const text = decodePrefix(data);
  if (text === null) return null;

  const parser = new SaxesParser({ xmlns: true });
  let root: XmlRoot | null = null;

  parser.on("opentag", (tag) => {
    const namespaced = tag as unknown as { local: string; uri: string };
    root = {
      localName: namespaced.local,
      namespaceURI: namespaced.uri,
    };
    throw STOP;
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (error !== STOP) return null;
  }

  return root;
}

function decodePrefix(data: Uint8Array): string | null {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) {
      return utf16Prefix(new TextDecoder("utf-16le").decode(data.subarray(2)), "utf-16le");
    }
    if (data[0] === 0xfe && data[1] === 0xff) {
      return utf16Prefix(new TextDecoder("utf-16be").decode(data.subarray(2)), "utf-16be");
    }
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(data.subarray(3));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

/**
 * Xerces, which Tika reads the root with, takes the byte order mark as the encoding until the declaration names another:
 * `UTF-16` (or the same byte order) keeps it, anything else re-reads the rest of the bytes in that encoding, and the
 * 16-bit units then are not XML ("Content is not allowed in prolog"). Tika 4.2.0 finds no root there, so a UTF-16 document
 * that declares encoding="UTF-8" is plain text.
 */
function utf16Prefix(text: string, order: "utf-16le" | "utf-16be"): string | null {
  const declared = /^<\?xml[^>]*?\sencoding\s*=\s*["']([^"']+)["']/.exec(text)?.[1]?.toLowerCase();
  if (declared === undefined) return text;
  const compatible = declared === "utf-16" || declared === order || declared.startsWith("iso-10646-ucs-");
  return compatible ? text : null;
}
