import { parseXml } from "./xml-parse.ts";

export interface XmlAttribute {
  readonly local: string;
  readonly value: string;
}

export interface XmlElement {
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
}

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
  return parseXml(data, (element) =>
    visit({
      local: element.local,
      attributes: element.attributes.map(({ local, value }) => ({ local, value })),
    }),
  );
}
