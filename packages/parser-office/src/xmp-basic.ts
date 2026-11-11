import { MalformedDocumentError, tikaDateMetadataString, type Metadata } from "@spikedpunch/ripstream-core";
import { parseXmlChunked, type XmlEvents } from "./xml-events.ts";

/*
 * A narrow port of Tika 4.2.0's XmpExtractor and XmpSaxFlattener (tika-parser-xmp-commons), read from those sources.
 * Of the table of properties it maps, this reads four, all of the xmp namespace: CreateDate, ModifyDate, MetadataDate
 * and CreatorTool, with the dates normalised by TikaDates and the creation and modification dates also filling
 * dcterms:created and dcterms:modified when those are not set.
 *
 * Not ported: every other property (dc:, xmpMM: and the History and DerivedFrom bags, pdf:, tiff:, exif: ...), rdf:about,
 * rdf:resource and rdf:value, language alternatives (a property with an xml:lang), and the xmp-raw: keys of what the
 * table does not map.
 */

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const META_NS = "adobe:ns:meta/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";
/** XmpSaxFlattener drops a leaf whose value is longer than this. */
const MAX_VALUE_CHARS = 1 << 20;
/**
 * Elements nested deeper than this are not looked at. An XMP packet puts the properties three levels down (xmpmeta,
 * RDF, Description), so this bounds the work a hostile packet can ask for; a real one does not meet it.
 */
const MAX_TRACKED_DEPTH = 16;

const DATE_PROPERTIES = new Set(["CreateDate", "ModifyDate", "MetadataDate"]);
const TEXT_PROPERTIES = new Set(["CreatorTool"]);
/** XmpExtractor.FILL_IF_ABSENT: the canonical date that the xmp date fills when it is not set. */
const FILLS: Readonly<Record<string, string>> = { CreateDate: "dcterms:created", ModifyDate: "dcterms:modified" };

interface Leaf {
  readonly local: string;
  readonly value: string;
}

/** One open element. */
interface Frame {
  /** The namespaces the element declares, if any. */
  readonly declared: ReadonlyMap<string, string> | undefined;
  /** A property of the packet, as opposed to the RDF scaffolding around it. */
  readonly property: boolean;
  /** The property was met outside any other property: one that the extractor maps. */
  readonly topLevel: boolean;
  readonly uri: string;
  readonly local: string;
  /** The property has an xml:lang: a language alternative, which is not handled here. */
  readonly alternative: boolean;
  /** Children that are properties themselves; a property with any is a struct or an array, not a leaf. */
  children: number;
  text: string;
}

function frame(
  declared: ReadonlyMap<string, string> | undefined,
  uri: string,
  local: string,
  property: boolean,
  topLevel: boolean,
  alternative: boolean,
): Frame {
  return { declared, property, topLevel, uri, local, alternative, children: 0, text: "" };
}

class BasicXmpHandler implements XmlEvents {
  readonly leaves: Leaf[] = [];
  private readonly frames: Frame[] = [];
  /** Open elements, including those below the depth that is tracked. */
  private depth = 0;
  /** Open property frames. */
  private propertyDepth = 0;

  open(_local: string, attributes: Record<string, string>, qualifiedName: string): void {
    this.depth++;
    if (this.depth > MAX_TRACKED_DEPTH) return;

    const declared = declarations(attributes);
    const [prefix, local] = splitName(qualifiedName);
    const uri = this.resolve(prefix, declared) ?? "";
    const rdf = uri === RDF_NS;
    if (rdf && local === "Description") this.descriptionAttributes(attributes, declared);
    if (uri === META_NS || (rdf && (local === "RDF" || local === "Description" || local === "value" || isContainer(local)))) {
      // Nothing of the packet itself: the frame keeps the depth and the namespace declarations.
      this.frames.push(frame(declared, uri, local, false, false, false));
      return;
    }

    // Every other element is a property (an rdf:li is an entry of an array) and a child of the property around it.
    const parent = this.nearestProperty();
    if (parent !== undefined) parent.children++;
    const alternative = !rdf && trimJava(attributes["xml:lang"] ?? "") !== "";
    this.frames.push(frame(declared, uri, local, true, this.propertyDepth === 0, alternative));
    this.propertyDepth++;
  }

  text(text: string): void {
    if (this.depth > MAX_TRACKED_DEPTH) return;
    const property = this.nearestProperty();
    // The text is a slice of the packet already held in memory. Java caps the trimmed value, in collect().
    if (property !== undefined && property.topLevel) property.text += text;
  }

  close(): void {
    const tracked = this.depth <= MAX_TRACKED_DEPTH;
    this.depth--;
    if (!tracked) return;
    const closed = this.frames.pop();
    if (closed === undefined || !closed.property) return;
    this.propertyDepth--;
    if (!closed.topLevel || closed.alternative || closed.children > 0) return;
    const value = trimJava(closed.text);
    if (value !== "") this.collect(closed.uri, closed.local, value);
  }

  /** The attributes of an rdf:Description are properties as well (XmpSaxFlattener.emitAttrs). */
  private descriptionAttributes(
    attributes: Record<string, string>,
    declared: ReadonlyMap<string, string> | undefined,
  ): void {
    for (const [name, raw] of Object.entries(attributes)) {
      const [prefix, local] = splitName(name);
      // A declaration is not an attribute, and an attribute with no prefix is in no namespace.
      if (prefix === "" || prefix === "xmlns" || name === "xmlns") continue;
      const value = trimJava(raw);
      if (value === "") continue;
      const uri = this.resolve(prefix, declared);
      if (uri !== undefined) this.collect(uri, local, value);
    }
  }

  private collect(uri: string, local: string, value: string): void {
    if (uri !== XMP_NS || value.length > MAX_VALUE_CHARS) return;
    if (DATE_PROPERTIES.has(local) || TEXT_PROPERTIES.has(local)) this.leaves.push({ local, value });
  }

  private nearestProperty(): Frame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const candidate = this.frames[index]!;
      if (candidate.property) return candidate;
    }
    return undefined;
  }

  /** The namespace a prefix is bound to: the innermost declaration, starting with the element's own. */
  private resolve(prefix: string, own: ReadonlyMap<string, string> | undefined): string | undefined {
    if (prefix === "xml") return XML_NS;
    const ownUri = own?.get(prefix);
    if (ownUri !== undefined) return ownUri;
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const uri = this.frames[index]!.declared?.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  }
}

function declarations(attributes: Record<string, string>): ReadonlyMap<string, string> | undefined {
  let declared: Map<string, string> | undefined;
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "xmlns") (declared ??= new Map()).set("", value);
    else if (name.startsWith("xmlns:")) (declared ??= new Map()).set(name.slice("xmlns:".length), value);
  }
  return declared;
}

function splitName(name: string): [string, string] {
  const colon = name.indexOf(":");
  return colon < 0 ? ["", name] : [name.slice(0, colon), name.slice(colon + 1)];
}

function isContainer(local: string): boolean {
  return local === "Bag" || local === "Seq" || local === "Alt";
}

/** Java's String.trim: every character up to U+0020, and nothing else. */
function trimJava(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/**
 * Reads the four properties into `metadata`. Throws a MalformedDocumentError when the packet is not well-formed, and
 * then sets nothing: the extractor maps the properties only once the whole packet has been read.
 */
export async function extractBasicXmp(xml: string, metadata: Metadata): Promise<void> {
  const handler = new BasicXmpHandler();
  const failure = await parseXmlChunked(xml, handler, async () => {});
  if (failure !== undefined) throw new MalformedDocumentError(`The XMP packet is not well-formed XML: ${failure.message}`);
  for (const { local, value } of handler.leaves) {
    const fill = FILLS[local];
    if (fill !== undefined && metadata.get(fill) === null) {
      const normalised = tikaDateMetadataString(value);
      if (normalised !== null) metadata.set(fill, normalised);
    }
    // A date that is not one stays as written on the xmp key; the canonical key above takes only a real one.
    metadata.set(`xmp:${local}`, DATE_PROPERTIES.has(local) ? (tikaDateMetadataString(value) ?? value) : value);
  }
}
