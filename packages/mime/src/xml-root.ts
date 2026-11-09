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

function decodePrefix(data: Uint8Array): string {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(data.subarray(2));
    }
    if (data[0] === 0xfe && data[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(data.subarray(2));
    }
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(data.subarray(3));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}
