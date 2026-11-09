import { parseXml } from "./xml-parse.ts";

export interface PackageXmlElement {
  readonly local: string;
  /** The element's namespace URI, empty when it has none. */
  readonly uri: string;
  /** Attributes written without a prefix: what the DOM's `getAttribute(name)` sees. */
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * Port of how POI reads package XML (`DocumentHelper.readDocument`): a namespace-aware parse that refuses any DOCTYPE,
 * so a part with a DTD, or one that is not well formed, cannot be read. Tika's own SAX handlers are lenient and live in
 * `xml-scan.ts`; this is the strict reader behind `OPCPackage.open`.
 *
 * `visit`, when given, sees every start tag in document order. Returns false when the document must be refused;
 * anything `visit` collected before that is then to be discarded.
 */
export function readPackageXml(
  data: Uint8Array,
  visit?: (element: PackageXmlElement) => void,
): boolean {
  return parseXml(
    data,
    (element) => {
      if (visit === undefined) return;
      const attributes = new Map<string, string>();
      for (const attribute of element.attributes) {
        if (attribute.prefix === "") attributes.set(attribute.local, attribute.value);
      }
      visit({ local: element.local, uri: element.uri, attributes });
    },
    { refuseDoctype: true },
  );
}
