import { SaxesParser } from "saxes";

export interface XmlRoot {
  readonly localName: string;
  readonly namespaceURI: string;
}

const STOP = Symbol("xml-root-found");

/**
 * Extracts only the root element and namespace. DTDs are rejected so no
 * entity expansion or external resolution can occur during detection.
 */
export function extractXmlRoot(data: Uint8Array): XmlRoot | null {
  const text = decodePrefix(data);
  if (/<!DOCTYPE/i.test(text)) return null;

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
