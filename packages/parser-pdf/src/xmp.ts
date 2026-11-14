import { SaxesParser, type SaxesTagNS } from "saxes";
import { tikaDateMetadataString, type Metadata } from "@spikedpunch/ripstream-core";

/*
 * The XMP packet of a PDF, mapped onto metadata keys the way Tika 4.2.0's PDFParser does (XmpExtractor behind
 * PDMetadataExtractor). The mapping is not read from Tika's source: it was probed against a running Tika 4.2.0 server
 * (/rmeta on PDFs carrying one XMP property each, then combinations), and TABLE below is that probe's result. What a
 * property that is not in TABLE becomes, and the shapes that matter, as observed:
 *
 *  - A namespace is told by its URI, not its prefix (`DC2:rights` is dc:rights).
 *  - A table property writes each of its target keys: the canonical one (dc:title), usually a `xmp:<prefix>:<name>` copy,
 *    and sometimes a fill-in (dcterms:created from xmp:CreateDate when nothing else set it).
 *  - A property that is not in TABLE is written as `xmp-raw:<prefix>:<name>`; a struct as `...:<name>/<prefix>:<field>`
 *    and the structs in an array as `...:<name>[<n>]/<prefix>:<field>`.
 *  - A language alternative (a `li` with xml:lang) writes the key once for all of them, the x-default first, and
 *    `<key>:<lang>` for each; a single-valued key keeps the x-default, or the first language when there is none.
 *  - xmpMM:History and xmpMM:DerivedFrom are written field by field (`xmpMM:History:Action`), one value per event.
 *  - Dates go through TikaDates (seconds, UTC); a value that is not a date stays as written.
 * Not ported: whatever the table does not list, beyond the rule above.
 */

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const META_NS = "adobe:ns:meta/";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** URI to the prefix the table is written in. */
const NAMESPACES: ReadonlyMap<string, string> = new Map([
  ["http://purl.org/dc/elements/1.1/", "dc"],
  ["http://ns.adobe.com/xap/1.0/", "xmp"],
  ["http://ns.adobe.com/pdf/1.3/", "pdf"],
  ["http://ns.adobe.com/xap/1.0/mm/", "xmpMM"],
  ["http://ns.adobe.com/xap/1.0/rights/", "xmpRights"],
  ["http://ns.adobe.com/tiff/1.0/", "tiff"],
  ["http://ns.adobe.com/exif/1.0/", "exif"],
  ["http://ns.adobe.com/photoshop/1.0/", "photoshop"],
  ["http://ns.adobe.com/exif/1.0/aux/", "aux"],
  ["http://www.aiim.org/pdfa/ns/id/", "pdfaid"],
]);

/**
 * `<prefix>:<name>` to its targets. A target is a key, with `+` to add to the values already there (a bag or a sequence in
 * Tika's schema) and no mark to replace them (a single value), or `?` to fill the key in only when it has no value and the
 * XMP value is a date.
 */
const TABLE: Readonly<Record<string, readonly string[]>> = {
  "aux:Lens": ["aux:Lens"],
  "aux:LensID": ["aux:LensID"],
  "aux:LensInfo": ["aux:LensInfo"],
  "aux:SerialNumber": ["aux:SerialNumber"],
  "dc:contributor": ["+dc:contributor", "+xmp:dc:contributor"],
  "dc:coverage": ["+dc:coverage", "xmp:dc:coverage"],
  "dc:creator": ["+dc:creator", "+xmp:dc:creator"],
  "dc:date": ["xmp:dc:date"],
  "dc:description": ["+dc:description", "xmp:dc:description"],
  "dc:format": ["xmp:dc:format"],
  "dc:identifier": ["+dc:identifier", "xmp:dc:identifier"],
  "dc:language": ["+dc:language", "xmp:dc:language"],
  "dc:publisher": ["+dc:publisher", "xmp:dc:publisher"],
  "dc:relation": ["+dc:relation", "xmp:dc:relation"],
  "dc:rights": ["+dc:rights", "xmp:dc:rights"],
  "dc:source": ["+dc:source", "xmp:dc:source"],
  "dc:subject": ["+dc:subject", "+xmp:dc:subject"],
  "dc:title": ["+dc:title", "xmp:dc:title"],
  "dc:type": ["+dc:type", "xmp:dc:type"],
  "exif:DateTimeOriginal": ["exif:DateTimeOriginal", "?dcterms:created", "xmp:exif:DateTimeOriginal"],
  "exif:ISOSpeedRatings": ["+exif:IsoSpeedRatings", "+xmp:exif:IsoSpeedRatings"],
  "exif:PixelXDimension": ["tiff:ImageWidth", "xmp:exif:PixelXDimension"],
  "exif:PixelYDimension": ["tiff:ImageLength", "xmp:exif:PixelYDimension"],
  "pdf:Keywords": ["+dc:subject", "+meta:keyword", "+xmp:pdf:Keywords"],
  "pdf:PDFVersion": ["xmp:pdf:PDFVersion"],
  "pdf:Producer": ["pdf:producer", "xmp:pdf:Producer"],
  "pdf:Trapped": ["pdf:trapped", "xmp:pdf:Trapped"],
  "pdfaid:conformance": ["pdfaid:conformance"],
  "pdfaid:part": ["pdfaid:part"],
  "photoshop:ColorMode": ["photoshop:ColorMode"],
  "photoshop:DateCreated": ["photoshop:DateCreated", "?dcterms:created"],
  "photoshop:ICCProfile": ["photoshop:ICCProfile"],
  "tiff:BitsPerSample": ["+tiff:BitsPerSample", "+xmp:tiff:BitsPerSample"],
  "tiff:ImageLength": ["tiff:ImageLength", "xmp:tiff:ImageLength"],
  "tiff:ImageWidth": ["tiff:ImageWidth", "xmp:tiff:ImageWidth"],
  "tiff:Make": ["tiff:Make", "xmp:tiff:Make"],
  "tiff:Model": ["tiff:Model", "xmp:tiff:Model"],
  "tiff:Orientation": ["tiff:Orientation", "xmp:tiff:Orientation"],
  "tiff:SamplesPerPixel": ["tiff:SamplesPerPixel", "xmp:tiff:SamplesPerPixel"],
  "tiff:Software": ["tiff:Software", "xmp:tiff:Software"],
  "xmp:Advisory": ["+xmp:Advisory"],
  "xmp:CreateDate": ["xmp:CreateDate", "?dcterms:created"],
  "xmp:CreatorTool": ["xmp:CreatorTool"],
  "xmp:Identifier": ["+xmp:Identifier"],
  "xmp:Label": ["xmp:Label"],
  "xmp:MetadataDate": ["xmp:MetadataDate"],
  "xmp:ModifyDate": ["xmp:ModifyDate", "?dcterms:modified"],
  "xmp:Nickname": ["xmp:NickName"],
  "xmp:Rating": ["xmp:Rating"],
  "xmp:Title": ["+dc:title", "xmp:Title"],
  "xmpMM:DocumentID": ["xmpMM:DocumentID"],
  "xmpMM:InstanceID": ["xmpMM:InstanceID"],
  "xmpMM:OriginalDocumentID": ["xmpMM:OriginalDocumentID"],
  "xmpMM:RenditionClass": ["xmpMM:RenditionClass"],
  "xmpMM:RenditionParams": ["xmpMM:RenditionParams"],
  "xmpRights:Certificate": ["xmpRights:Certificate"],
  "xmpRights:Marked": ["xmpRights:Marked"],
  "xmpRights:Owner": ["+xmpRights:Owner"],
  "xmpRights:UsageTerms": ["xmpRights:UsageTerms"],
  "xmpRights:WebStatement": ["xmpRights:WebStatement"],
};

/** The target keys whose values are dates. */
const DATE_KEYS: ReadonlySet<string> = new Set([
  "xmp:CreateDate",
  "xmp:ModifyDate",
  "xmp:MetadataDate",
  "xmp:dc:date",
  "exif:DateTimeOriginal",
  "xmp:exif:DateTimeOriginal",
  "photoshop:DateCreated",
]);

/** The fields of the two structs that are written field by field, by the name Tika gives each. */
const STRUCT_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "xmpMM:History": {
    action: "Action",
    changed: "Changed",
    instanceID: "InstanceID",
    parameters: "Parameters",
    softwareAgent: "SoftwareAgent",
    when: "When",
  },
  "xmpMM:DerivedFrom": {
    documentID: "DocumentID",
    instanceID: "InstanceID",
    manager: "Manager",
    managerVariant: "ManagerVariant",
    renditionClass: "RenditionClass",
    renditionParams: "RenditionParams",
    versionID: "VersionID",
  },
};

/** A packet is a few kilobytes; a hostile one is bounded rather than trusted. */
const MAX_PACKET_CHARS = 8 << 20;
const MAX_ELEMENTS = 100_000;
const MAX_DEPTH = 64;
/** A leaf longer than this is dropped, as XmpSaxFlattener does. */
const MAX_VALUE_CHARS = 1 << 20;

interface Attribute {
  readonly uri: string;
  readonly local: string;
  readonly prefix: string;
  readonly value: string;
}

interface Element {
  readonly uri: string;
  readonly local: string;
  readonly prefix: string;
  readonly attributes: readonly Attribute[];
  readonly children: Element[];
  text: string;
}

/** The unqualified name as written in the packet. */
function qname(element: Pick<Element, "prefix" | "local">): string {
  return element.prefix === "" ? element.local : `${element.prefix}:${element.local}`;
}

function parsePacket(xml: string): Element | Error {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: Element[] = [];
  let root: Element | undefined;
  let count = 0;
  let failure: Error | undefined;
  parser.on("error", (error) => {
    failure ??= error;
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    if (++count > MAX_ELEMENTS) throw new Error("The XMP packet has too many elements");
    if (stack.length >= MAX_DEPTH) throw new Error("The XMP packet is nested too deeply");
    const attributes: Attribute[] = [];
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === XMLNS_NS || attribute.name === "xmlns") continue;
      attributes.push({ uri: attribute.uri, local: attribute.local, prefix: attribute.prefix, value: attribute.value });
    }
    const element: Element = { uri: tag.uri, local: tag.local, prefix: tag.prefix, attributes, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent === undefined) root ??= element;
    else parent.children.push(element);
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const onText = (text: string): void => {
    const open = stack[stack.length - 1];
    if (open !== undefined && open.text.length <= MAX_VALUE_CHARS) open.text += text;
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  try {
    parser.write(xml).close();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (failure !== undefined) return failure;
  return root ?? new Error("The XMP packet has no root element");
}

/** Java's String.trim: every character up to U+0020, and nothing else. */
function trimJava(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

function isRdf(element: Element, local: string): boolean {
  return element.uri === RDF_NS && element.local === local;
}

function isContainer(element: Element): boolean {
  return element.uri === RDF_NS && (element.local === "Bag" || element.local === "Seq" || element.local === "Alt");
}

function langOf(element: Element): string | undefined {
  const lang = element.attributes.find((attribute) => attribute.uri === XML_NS && attribute.local === "lang");
  const value = lang === undefined ? "" : trimJava(lang.value);
  return value === "" ? undefined : value;
}

function resourceOf(element: Element): string {
  const resource = element.attributes.find((attribute) => attribute.uri === RDF_NS && attribute.local === "resource");
  return resource === undefined ? "" : trimJava(resource.value);
}

/** The text of a property that has no property inside it: its trimmed content, else its rdf:resource. */
function leafValue(element: Element): string {
  const text = trimJava(element.text);
  if (text !== "") return text;
  return resourceOf(element);
}

/** The element's own children that are properties, as opposed to the RDF scaffolding. */
function structFields(element: Element): Element[] {
  const description = element.children.find((child) => isRdf(child, "Description"));
  return (description ?? element).children.filter((child) => !isContainer(child) && !isRdf(child, "Description"));
}

/** The `li` entries when the property holds a bag, a sequence or an alternative. */
function items(element: Element): Element[] | undefined {
  const container = element.children.find(isContainer);
  return container === undefined ? undefined : container.children.filter((child) => isRdf(child, "li"));
}

function isStruct(element: Element): boolean {
  if (items(element) !== undefined) return false;
  return element.children.length > 0;
}

interface Value {
  readonly text: string;
  readonly lang: string | undefined;
}

/** What a mapped property holds, or undefined when it holds a struct (which the table does not take). */
function simpleValues(element: Element): { values: Value[]; alternative: boolean } | undefined {
  const entries = items(element);
  if (entries === undefined) {
    if (isStruct(element)) return undefined;
    const text = leafValue(element);
    return { values: text === "" ? [] : [{ text, lang: undefined }], alternative: false };
  }
  const values: Value[] = [];
  for (const entry of entries) {
    if (isStruct(entry)) return undefined;
    const text = leafValue(entry);
    if (text !== "") values.push({ text, lang: langOf(entry) });
  }
  const container = element.children.find(isContainer)!;
  return { values, alternative: container.local === "Alt" };
}

class Writer {
  /** pdfaid:part and pdfaid:conformance, which together make pdfa:pdf-version. */
  private part: string | undefined;
  private conformance: string | undefined;

  private readonly metadata: Metadata;

  constructor(metadata: Metadata) {
    this.metadata = metadata;
  }

  description(description: Element): void {
    for (const attribute of description.attributes) {
      if (attribute.prefix === "" || attribute.uri === RDF_NS || attribute.uri === XML_NS) continue;
      const value = trimJava(attribute.value);
      if (value === "") continue;
      this.mapped(attribute.uri, attribute.prefix, attribute.local, [{ text: value, lang: undefined }], false);
    }
    for (const property of description.children) {
      if (isContainer(property) || isRdf(property, "Description")) continue;
      this.property(property);
    }
  }

  finish(): void {
    if (this.conformance === undefined) return;
    this.metadata.set("pdfa:pdf-version", `A-${this.part ?? "UNKNOWN"}${this.conformance.toLowerCase()}`);
  }

  private property(element: Element): void {
    const name = `${NAMESPACES.get(element.uri) ?? ""}:${element.local}`;
    if (STRUCT_FIELDS[name] !== undefined) {
      this.structFields(name, element);
      return;
    }
    const simple = NAMESPACES.has(element.uri) ? simpleValues(element) : undefined;
    if (simple !== undefined && TABLE[name] !== undefined) {
      this.mapped(element.uri, element.prefix, element.local, simple.values, simple.alternative);
      return;
    }
    this.raw(`xmp-raw:${qname(element)}`, element);
  }

  private mapped(uri: string, prefix: string, local: string, values: Value[], alternative: boolean): void {
    const known = NAMESPACES.get(uri);
    const targets = known === undefined ? undefined : TABLE[`${known}:${local}`];
    if (targets === undefined) {
      for (const value of values) this.metadata.add(`xmp-raw:${prefix}:${local}`, value.text);
      return;
    }
    if (known === "pdfaid" && values[0] !== undefined) {
      if (local === "part") this.part = values[0].text;
      else this.conformance = values[0].text;
    }
    // The x-default of a language alternative comes first, then the others as written.
    const ordered = [...values].sort((left, right) => Number(right.lang === "x-default") - Number(left.lang === "x-default"));
    const primary = alternative ? ordered[0] : undefined;
    for (const target of targets) {
      const mode = target.startsWith("+") || target.startsWith("?") ? target[0] : "";
      const key = mode === "" ? target : target.slice(1);
      const render = (text: string): string | null =>
        DATE_KEYS.has(key) || mode === "?" ? tikaDateMetadataString(text) ?? (mode === "?" ? null : text) : text;
      if (mode === "?") {
        const value = values[0] === undefined ? null : render(values[0].text);
        if (value !== null && this.metadata.get(key) === null) this.metadata.set(key, value);
        continue;
      }
      if (mode === "+") {
        for (const value of ordered) this.add(key, render(value.text));
      } else {
        const chosen = primary ?? values[values.length - 1];
        if (chosen !== undefined) this.metadata.set(key, render(chosen.text));
      }
      for (const value of values) {
        if (value.lang !== undefined) this.metadata.set(`${key}:${value.lang}`, render(value.text));
      }
    }
  }

  private add(key: string, value: string | null): void {
    if (value !== null) this.metadata.add(key, value);
  }

  /** xmpMM:History and xmpMM:DerivedFrom: one value per event for each field that any event has, "" where one lacks it. */
  private structFields(name: string, element: Element): void {
    const fields = STRUCT_FIELDS[name]!;
    const entries = items(element);
    const events = entries ?? [element];
    // A field that is not one of the named ones is written the way any struct field is.
    const rawPath = `xmp-raw:${qname(element)}`;
    events.forEach((event, index) => {
      for (const field of structFields(event)) {
        if (fields[field.local] === undefined) this.raw(`${rawPath}${entries === undefined ? "" : `[${index + 1}]`}/${qname(field)}`, field);
      }
    });
    const seen: string[] = [];
    const rows = events.map((event) => {
      const row = new Map<string, string>();
      for (const field of structFields(event)) {
        const target = fields[field.local];
        const value = leafValue(field);
        if (target === undefined || value === "") continue;
        row.set(target, target === "When" ? tikaDateMetadataString(value) ?? value : value);
        if (!seen.includes(target)) seen.push(target);
      }
      return row;
    });
    for (const target of seen.sort()) {
      for (const row of rows) this.metadata.add(`${name}:${target}`, row.get(target) ?? "");
    }
  }

  /** Everything the table does not take: `xmp-raw:` plus the path to the value. */
  private raw(path: string, element: Element): void {
    const entries = items(element);
    if (entries !== undefined) {
      entries.forEach((entry, index) => {
        if (isStruct(entry)) this.rawStruct(`${path}[${index + 1}]`, entry);
        else this.addRaw(path, leafValue(entry));
      });
      return;
    }
    if (isStruct(element)) {
      this.rawStruct(path, element);
      return;
    }
    this.addRaw(path, leafValue(element));
  }

  private rawStruct(path: string, element: Element): void {
    for (const field of structFields(element)) this.raw(`${path}/${qname(field)}`, field);
  }

  private addRaw(key: string, value: string): void {
    if (value !== "" && value.length <= MAX_VALUE_CHARS) this.metadata.add(key, value);
  }
}

/** The element holding rdf:Description children, found under x:xmpmeta and rdf:RDF. */
function descriptions(element: Element, found: Element[]): void {
  if (isRdf(element, "Description")) {
    found.push(element);
    return;
  }
  if (element.uri === META_NS || isRdf(element, "RDF")) {
    for (const child of element.children) descriptions(child, found);
  }
}

/**
 * Writes the XMP packet's properties into `metadata`. Returns the failure when the packet is not well-formed XML, with
 * nothing written: Tika flattens the whole packet before it maps any of it.
 */
export function extractXmp(xml: string, metadata: Metadata): Error | undefined {
  if (xml.length > MAX_PACKET_CHARS) return new Error(`The XMP packet is ${xml.length} characters, over the ${MAX_PACKET_CHARS} limit`);
  const root = parsePacket(xml);
  if (root instanceof Error) return root;
  const found: Element[] = [];
  descriptions(root, found);
  const writer = new Writer(metadata);
  for (const description of found) writer.description(description);
  writer.finish();
  return undefined;
}
