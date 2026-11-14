import {
  LimitExceededError,
  MalformedDocumentError,
  tikaDateMetadataString,
  type Metadata,
} from "@spikedpunch/ripstream-core";
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

/*
 * Port of Tika 4.2.0's OpenDocumentMetaParser (tika-parser-miscoffice-module) with the handlers it composes from the
 * tika-parser-xml-module (ElementMetadataHandler, MetadataHandler, AttributeMetadataHandler, AbstractMetadataHandler,
 * AttributeDependantMetadataHandler) and DateElementHandler, NSNormalizerContentHandler and MatchingContentHandler. Read
 * from those sources and ODFParserTest; not run against a Tika.
 *
 * Differences, on purpose:
 *  - ElementMetadataHandler's rdf:Bag/rdf:li reading is left out: an ODF meta.xml has no RDF.
 *  - NSNormalizerContentHandler passes the original attributes on, not its namespace-mapped copy, so an OpenOffice 1.x
 *    attribute namespace is never mapped; that is kept (the element namespaces are mapped).
 *  - A meta.xml that is not well-formed is a MalformedDocumentError; Tika's SAX parse would end with a SAXException.
 *  - Four keys this port wrote before Tika's were matched (pdf:Keywords, meta:initial-creator, meta:generator and
 *    meta:editing-cycles) are still written next to Tika's (the `legacyKey` of MetaElementJoined), so nothing that reads
 *    them breaks; they are not Tika keys and the owner may want them gone.
 */

const META_NS = "urn:oasis:names:tc:opendocument:xmlns:meta:1.0";
const OFFICE_NS = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const DC_NS = "http://purl.org/dc/elements/1.1/";

/** NSNormalizerContentHandler: OpenOffice 1.x element namespaces become the OpenDocument ones. */
const OLD_NS = "http://openoffice.org/2000/";
const NEW_NS = "urn:oasis:names:tc:opendocument:xmlns:";

interface Handler {
  start(uri: string, local: string, attributes: readonly SaxesAttributeNS[], depth: number): void;
  text(text: string): void;
  end(uri: string, local: string): void;
}

/** AbstractMetadataHandler.addMetadata for a property that does not permit several values. */
function addSingle(metadata: Metadata, key: string, value: string): void {
  if (value.length === 0) return;
  const previous = metadata.getAll(key);
  if (previous.length > 1) {
    // Metadata.isMultiValued: add the value unless it is there.
    if (!previous.includes(value)) metadata.add(key, value);
    return;
  }
  // One value or none: the value replaces it (Tika sets, or leaves an equal one as it is).
  metadata.set(key, value);
}

/** ElementMetadataHandler.addMetadata for a bag property: a value that is not already there is added. */
function addToBag(metadata: Metadata, key: string, value: string): void {
  if (value.length === 0) return;
  if (!metadata.getAll(key).includes(value)) metadata.add(key, value);
}

/** An element in `ns` named `local`, whose text becomes one value (ElementMetadataHandler, without RDF). */
class ElementText implements Handler {
  private level = 0;
  private buffer = "";

  private readonly ns: string;
  private readonly local: string;
  private readonly add: (value: string) => void;

  constructor(ns: string, local: string, add: (value: string) => void) {
    this.ns = ns;
    this.local = local;
    this.add = add;
  }

  start(uri: string, local: string): void {
    if (uri === this.ns && local === this.local) this.level++;
  }

  text(text: string): void {
    if (this.level > 0) this.buffer += text;
  }

  end(uri: string, local: string): void {
    if (uri !== this.ns || local !== this.local) return;
    this.level--;
    if (this.level !== 0) return;
    // The text of an element is kept (and not cleared) when it is empty or contains "Bag", as Tika does.
    if (this.buffer.length > 0 && !this.buffer.includes("Bag")) {
      this.add(this.buffer.trim());
      this.buffer = "";
    }
  }
}

/**
 * OpenDocumentMetaParser.getMeta: a meta: element whose text, with that of everything inside it, is added to `key`
 * through MetadataHandler, so that several of them are joined with ", ". `legacyKey` is the key this port wrote before.
 */
class MetaElementJoined implements Handler {
  private open = 0;
  private buffer = "";

  private readonly metadata: Metadata;
  private readonly local: string;
  private readonly key: string;
  constructor(metadata: Metadata, local: string, key: string) {
    this.metadata = metadata;
    this.local = local;
    this.key = key;
  }

  start(uri: string, local: string): void {
    if (uri === META_NS && local === this.local) this.open++;
  }

  text(text: string): void {
    if (this.open > 0) this.buffer += text;
  }

  end(uri: string, local: string): void {
    if (uri !== META_NS || local !== this.local) return;
    const value = this.buffer;
    this.buffer = "";
    this.open--;
    if (value.length === 0) return;
    // MetadataHandler.addMetadata: a value after an earlier one is appended to it; the property is set, not added.
    const previous = this.metadata.get(this.key);
    this.metadata.set(this.key, previous !== null && previous.length > 0 ? `${previous}, ${value}` : value);
  }
}

/** DateElementHandler: the element's text as a Tika date string, set (so the last one wins); not a date is dropped. */
class DateElement implements Handler {
  private inElement = false;
  private buffer = "";

  private readonly metadata: Metadata;
  private readonly ns: string;
  private readonly local: string;
  private readonly key: string;

  constructor(metadata: Metadata, ns: string, local: string, key: string) {
    this.metadata = metadata;
    this.ns = ns;
    this.local = local;
    this.key = key;
  }

  start(uri: string, local: string): void {
    if (uri === this.ns && local === this.local) {
      this.inElement = true;
      this.buffer = "";
    }
  }

  text(text: string): void {
    if (this.inElement) this.buffer += text;
  }

  end(uri: string, local: string): void {
    if (!this.inElement || uri !== this.ns || local !== this.local) return;
    this.inElement = false;
    const value = tikaDateMetadataString(this.buffer);
    if (value !== null) this.metadata.set(this.key, value);
  }
}

/** getVersion: `office:version` on the root office:document-meta element. */
class RootVersion implements Handler {
  private readonly metadata: Metadata;

  constructor(metadata: Metadata) {
    this.metadata = metadata;
  }

  start(uri: string, local: string, attributes: readonly SaxesAttributeNS[], depth: number): void {
    if (depth !== 0 || uri !== OFFICE_NS || local !== "document-meta") return;
    for (const attribute of attributes) {
      if (attribute.uri === OFFICE_NS && attribute.local === "version") {
        addSingle(this.metadata, "odf:version", attribute.value.trim());
      }
    }
  }

  text(): void {}
  end(): void {}
}

/** getStatistic: one attribute of meta:document-statistic, trimmed, under each of `keys`. */
class StatisticAttribute implements Handler {
  private readonly metadata: Metadata;
  private readonly attribute: string;
  private readonly keys: readonly string[];

  constructor(metadata: Metadata, attribute: string, keys: readonly string[]) {
    this.metadata = metadata;
    this.attribute = attribute;
    this.keys = keys;
  }

  start(uri: string, local: string, attributes: readonly SaxesAttributeNS[]): void {
    if (uri !== META_NS || local !== "document-statistic") return;
    for (const attribute of attributes) {
      if (attribute.uri !== META_NS || attribute.local !== this.attribute) continue;
      for (const key of this.keys) addSingle(this.metadata, key, attribute.value.trim());
    }
  }

  text(): void {}
  end(): void {}
}

/**
 * getUserDefined: `<meta:user-defined meta:name="X">text</meta:user-defined>` becomes `custom:X`.
 * AttributeDependantMetadataHandler reads the name by its qualified name `meta:name`, keeps the last one it saw, and
 * only sees an element that carries that attribute (MatchingContentHandler drops the rest), though it sees the text
 * of every user-defined element; all of that is kept.
 */
class UserDefined implements Handler {
  private name: string | undefined;
  private buffer = "";
  private open = 0;
  private readonly delivered: boolean[] = [];

  private readonly metadata: Metadata;

  constructor(metadata: Metadata) {
    this.metadata = metadata;
  }

  start(uri: string, local: string, attributes: readonly SaxesAttributeNS[]): void {
    const matches = uri === META_NS && local === "user-defined";
    if (matches) this.open++;
    // MatchingContentHandler forwards the element only when it has a meta:name attribute in the meta namespace.
    const named = matches && attributes.some((a) => a.uri === META_NS && a.local === "name");
    this.delivered.push(named);
    if (!named) return;
    for (const attribute of attributes) {
      if (attribute.name === "meta:name") this.name = attribute.value;
    }
  }

  text(text: string): void {
    if (this.open > 0) this.buffer += text;
  }

  end(uri: string, local: string): void {
    const named = this.delivered.pop() === true;
    if (uri === META_NS && local === "user-defined") this.open--;
    if (!named) return;
    const value = this.buffer;
    this.buffer = "";
    if (this.name !== undefined && value.length > 0) this.metadata.add(`custom:${this.name}`, value);
  }
}

/** OpenDocumentMetaParser.getContentHandler, in the order it composes the handlers. */
function buildHandlers(metadata: Metadata): Handler[] {
  const dc = (local: string, key: string): Handler =>
    new ElementText(DC_NS, local, (value) => addToBag(metadata, key, value));
  return [
    dc("title", "dc:title"),
    dc("creator", "dc:creator"),
    dc("description", "dc:description"),
    dc("publisher", "dc:publisher"),
    dc("contributor", "dc:contributor"),
    dc("type", "dc:type"),
    // DublinCore.FORMAT is the one single-valued Dublin Core text property.
    new ElementText(DC_NS, "format", (value) => addSingle(metadata, "dc:format", value)),
    dc("identifier", "dc:identifier"),
    dc("language", "dc:language"),
    dc("rights", "dc:rights"),
    new RootVersion(metadata),
    new DateElement(metadata, META_NS, "creation-date", "dcterms:created"),
    // ODF uses dc:date for modified.
    new DateElement(metadata, DC_NS, "date", "dcterms:modified"),
    // ODF uses dc:subject for the description.
    dc("subject", "dc:subject"),
    new MetaElementJoined(metadata, "keyword", "meta:keyword"),
    new MetaElementJoined(metadata, "editing-duration", "extended-properties:TotalTime"),
    new MetaElementJoined(metadata, "editing-cycles", "editing-cycles"),
    // initial-creator shares dc:creator with the Dublin Core handler above, so the two interleave in document order.
    new MetaElementJoined(metadata, "initial-creator", "dc:creator"),
    new MetaElementJoined(metadata, "generator", "generator"),
    new UserDefined(metadata),
    new StatisticAttribute(metadata, "object-count", ["meta:object-count"]),
    new StatisticAttribute(metadata, "image-count", ["meta:image-count"]),
    // page-count is also the XMP paged-text page count.
    new StatisticAttribute(metadata, "page-count", ["meta:page-count", "xmpTPg:NPages"]),
    new StatisticAttribute(metadata, "table-count", ["meta:table-count"]),
    new StatisticAttribute(metadata, "paragraph-count", ["meta:paragraph-count"]),
    new StatisticAttribute(metadata, "word-count", ["meta:word-count"]),
    new StatisticAttribute(metadata, "character-count", ["meta:character-count"]),
  ];
}

function mapOldNamespace(uri: string): string {
  return uri.startsWith(OLD_NS) ? `${NEW_NS}${uri.slice(OLD_NS.length)}:1.0` : uri;
}

/** Real meta.xml nests three levels. saxes resolves namespaces per element, which is quadratic in the depth (40,000 deep took 9.8 s). */
export const MAX_ODF_META_DEPTH = 2000;

/**
 * OpenDocumentMetaParser.parse: reads meta.xml into `metadata`, then copies dc:subject to dc:description when the
 * description is empty (OpenOffice 2), and makes dc:subject hold the keywords first and the subjects after them.
 */
export function applyOdfMetadata(metadata: Metadata, xml: string): void {
  const handlers = buildHandlers(metadata);
  let depth = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    throw new MalformedDocumentError(`Malformed ODF meta.xml: ${error.message}`, { cause: error });
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (depth >= MAX_ODF_META_DEPTH) throw new LimitExceededError(`ODF meta.xml nests deeper than ${MAX_ODF_META_DEPTH} elements`);
    const uri = mapOldNamespace(tag.uri);
    const attributes = Object.values(tag.attributes);
    for (const handler of handlers) handler.start(uri, tag.local, attributes, depth);
    depth++;
  });
  const onText = (text: string): void => {
    for (const handler of handlers) handler.text(text);
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.on("closetag", (tag: SaxesTagNS) => {
    depth--;
    const uri = mapOldNamespace(tag.uri);
    for (const handler of handlers) handler.end(uri, tag.local);
  });
  parser.write(xml).close();

  const subject = metadata.get("dc:subject");
  const description = metadata.get("dc:description");
  if (subject !== null && subject !== "" && (description === null || description === "")) {
    metadata.set("dc:description", subject);
  }
  const subjects = [...metadata.getAll("meta:keyword"), ...metadata.getAll("dc:subject")];
  if (subjects.length > 0) metadata.setAll("dc:subject", subjects);
}
