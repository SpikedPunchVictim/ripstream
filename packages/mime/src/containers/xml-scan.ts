import { SaxesParser } from "saxes";

export interface XmlAttribute {
  readonly local: string;
  readonly value: string;
}

export interface XmlElement {
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
}

const STOP = Symbol("xml-scan-stop");

/**
 * Walks start tags in document order, as the SAX handlers in Tika's container detectors do: namespace-aware, local
 * names only, and whatever the visitor saw before a syntax error still counts. A visitor returns true to stop.
 * saxes resolves no entities and fetches nothing, so a hostile DOCTYPE cannot expand or reach out.
 *
 * Returns true only when the whole document parsed without error and the visitor never stopped early.
 */
export function scanXmlElements(
  data: Uint8Array,
  visit: (element: XmlElement) => boolean,
): boolean {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    const named = tag as unknown as {
      local: string;
      attributes: Record<string, { local: string; value: string }>;
    };
    const attributes = Object.values(named.attributes).map(({ local, value }) => ({ local, value }));
    if (visit({ local: named.local, attributes })) throw STOP;
  });

  try {
    parser.write(new TextDecoder("utf-8").decode(data)).close();
    return true;
  } catch {
    return false;
  }
}
