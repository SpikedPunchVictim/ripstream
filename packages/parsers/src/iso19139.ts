import { createDecoder } from "./charset.ts";
import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  RipstreamError,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";
import { javaDoubleString, parseJavaDouble } from "./java-compat.ts";
import { KeyPrefixWriter } from "./key-prefix.ts";
import { detectXmlEncoding } from "./xml-encoding.ts";

/** An ISO 19139 record is a few tens of kilobytes; this bounds one that never ends. */
export const DEFAULT_MAX_ISO19139_BYTES = 16 * 1024 * 1024;
/** Real records nest about ten levels. saxes resolves namespaces per element, which is quadratic in the depth. */
export const DEFAULT_MAX_ISO19139_DEPTH = 2000;
/** The element tree is held in memory; this bounds it. */
export const DEFAULT_MAX_ISO19139_NODES = 1_000_000;

const ISO19139_MIME_TYPE = "text/iso19139+xml";
const GMD = "http://www.isotc211.org/2005/gmd";
const GCO = "http://www.isotc211.org/2005/gco";
const GMX = "http://www.isotc211.org/2005/gmx";
const XMLNS = "http://www.w3.org/2000/xmlns/";

export interface GeographicInformationParserOptions {
  /** Maximum size of the file in bytes (default {@link DEFAULT_MAX_ISO19139_BYTES}); a larger one is a LimitExceededError. */
  readonly maxBytes?: number;
  /** Maximum element nesting (default {@link DEFAULT_MAX_ISO19139_DEPTH}); a deeper document is a LimitExceededError. */
  readonly maxDepth?: number;
  /** Maximum number of elements (default {@link DEFAULT_MAX_ISO19139_NODES}); a larger document is a LimitExceededError. */
  readonly maxNodes?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

/**
 * Port of Tika's GeographicInformationParser (tika-parser-scientific-module) for ISO 19139 geographic metadata
 * (`text/iso19139+xml`, a `gmd:MD_Metadata` record).
 *
 * Tika gives the file to Apache SIS, which unmarshals it into its ISO 19115 model, and writes `iso19115:` metadata, `dc:title`,
 * `dc:description` and `dc:language` from that model, then a heading per identification (title, one line per cited party, the
 * abstract) and the four sides of each geographic bounding box. SIS is not in the Tika tree and was not read: this reads the
 * ISO 19139 elements that SIS maps to each getter Tika calls, in the order Tika calls them. What was assumed about SIS, each
 * a place where this could differ from Tika on a file that is not the sample:
 *  - A code (`CI_RoleCode`, `MD_ProgressCode` ...) is written as GeoAPI's `CodeList.name()`, the upper-case form of the
 *    `codeListValue` (`resourceProvider` is `RESOURCE_PROVIDER`). Tika also calls `toString()` on a role; it is taken to be
 *    the same name.
 *  - A collection Tika gets as a `CodeListSet` (status, topic categories, access and use constraints) is written in the order
 *    of the code list, without repeats, not in the file's order.
 *  - Text is trimmed, and an empty string is no value. A character string may be a `gco:CharacterString`, a `gmx:Anchor` or the
 *    first `gmd:LocalisedCharacterString` of a `gmd:PT_FreeText`.
 *  - A `gco:Date` is midnight UTC (shifted by a zone when it has one), a `gco:DateTime` without a zone is UTC, and `dateStamp`
 *    is a CREATION date of the metadata. A date that cannot be read is no date.
 *  - The character sets of `gmd:characterSet` and `gmd:locale` are written as Java charset names for UTF-8, UTF-16, US-ASCII,
 *    ISO 8859-1 to -9, -13 and -15, Shift_JIS, EUC-JP, EUC-KR, Big5 and GB2312; another code gives no `iso19115:character-set`.
 *    A language with no character set gives none either.
 *  - `gmd:parentIdentifier` is the title of the parent metadata citation, and `gmd:fileIdentifier` the metadata identifier code.
 *
 * Where Tika would fail with a NullPointerException or a ClassCastException (a keyword group with no thesaurus, an
 * identification with no abstract, a service identification, no `gmd:distributionInfo` ...) this is a MalformedDocumentError.
 * Only `gmd:MD_Metadata` is read; SIS's other ISO 19115-3 namespaces are not, and the root of any other file is a
 * MalformedDocumentError (Tika's UnsupportedStorageException).
 *
 * Differences from Tika, all read from the source and not run against a Tika:
 *  - A file over `maxBytes`, a document nested deeper than `maxDepth` or with more than `maxNodes` elements is a
 *    LimitExceededError. Tika reads it all.
 *  - A DOCTYPE is accepted and its DTD never read, and an `xlink:href` is never followed (SIS does not either: Tika's test
 *    has a loopback server it must not reach). A reference to an entity the DOCTYPE declares is a malformed document.
 */
export class GeographicInformationParser implements Parser {
  readonly name = "GeographicInformationParser";
  readonly #maxBytes: number;
  readonly #maxDepth: number;
  readonly #maxNodes: number;

  constructor(options: GeographicInformationParserOptions = {}) {
    this.#maxBytes = positiveInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_ISO19139_BYTES);
    this.#maxDepth = positiveInteger("maxDepth", options.maxDepth ?? DEFAULT_MAX_ISO19139_DEPTH);
    this.#maxNodes = positiveInteger("maxNodes", options.maxNodes ?? DEFAULT_MAX_ISO19139_NODES);
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(ISO19139_MIME_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const tick = signalCheckpoint(ctx);
    metadata.set("Content-Type", ISO19139_MIME_TYPE);
    const bytes = await stream.readFully(this.#maxBytes);
    const { decoder } = createDecoder(detectXmlEncoding(bytes.subarray(0, 64 * 1024)));
    const root = readTree(decoder.decode(bytes), this.#maxDepth, this.#maxNodes, tick);
    if (root.uri !== GMD || root.local !== "MD_Metadata") {
      throw new MalformedDocumentError(`not an ISO 19139 record: the root element is ${root.local}, not gmd:MD_Metadata`);
    }

    const record = readRecord(root);
    writeMetadata(record, metadata);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await writeContent(record, xhtml, tick);
  }
}

/** Where Tika's code would dereference null, and Java throws a RuntimeException that nothing catches. */
function npe(what: string): MalformedDocumentError {
  return new MalformedDocumentError(`ISO 19139: ${what}, which Tika's parser uses without a check (a NullPointerException there)`);
}

function classCast(what: string): MalformedDocumentError {
  return new MalformedDocumentError(`ISO 19139: ${what}, which Tika's parser casts to a data identification or legal constraints (a ClassCastException there)`);
}

// ---- the element tree ----

interface XmlElement {
  readonly uri: string;
  readonly local: string;
  /** Attribute values by local name; namespace declarations are left out. */
  readonly attributes: Record<string, string>;
  readonly children: XmlElement[];
  /** The character data directly inside the element, in order, without that of its children. */
  text: string;
}

interface SaxTag {
  readonly uri: string;
  readonly local: string;
  readonly attributes: Record<string, { readonly uri: string; readonly local: string; readonly value: string }>;
}

/** The element tree of an XML document. Never fetches anything: saxes reads no DTD and follows no reference. */
function readTree(text: string, maxDepth: number, maxNodes: number, tick: () => void): XmlElement {
  const parser = new SaxesParser({ xmlns: true });
  const open: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let failed: Error | null = null;

  parser.on("opentag", (tag) => {
    tick();
    if (open.length >= maxDepth) throw new LimitExceededError(`ISO 19139 nesting exceeds ${maxDepth} open elements`);
    if (++nodes > maxNodes) throw new LimitExceededError(`an ISO 19139 document has more than ${maxNodes} elements`);
    const { uri, local, attributes } = tag as unknown as SaxTag;
    const element: XmlElement = { uri, local, attributes: {}, children: [], text: "" };
    for (const attribute of Object.values(attributes)) {
      if (attribute.uri !== XMLNS) element.attributes[attribute.local] = attribute.value;
    }
    open.at(-1)?.children.push(element);
    root ??= element;
    open.push(element);
  });
  parser.on("closetag", () => {
    open.pop();
  });
  const characters = (value: string): void => {
    const current = open.at(-1);
    if (current !== undefined) current.text += value;
  };
  parser.on("text", characters);
  parser.on("cdata", characters);
  parser.on("error", (error) => {
    failed ??= error;
  });

  try {
    parser.write(text);
    parser.close();
  } catch (error) {
    if (error instanceof RipstreamError) throw error;
    throw new MalformedDocumentError("Malformed XML", { cause: error });
  }
  if (failed !== null) throw new MalformedDocumentError("Malformed XML", { cause: failed });
  if (root === null) throw new MalformedDocumentError("Malformed XML: no root element");
  return root;
}

// ---- reading the ISO 19139 elements ----

/** The children of `node` named `local`, in `uri` (gmd by default). A gmd child is a property: it wraps one object element. */
function kids(node: XmlElement | null | undefined, local: string, uri: string = GMD): XmlElement[] {
  return node?.children.filter((child) => child.local === local && child.uri === uri) ?? [];
}

function kid(node: XmlElement | null | undefined, local: string, uri: string = GMD): XmlElement | null {
  return kids(node, local, uri)[0] ?? null;
}

/** The object element a property wraps, when it is one of `locals`: an empty property (nilReason, xlink only) wraps none. */
function objectNamed(property: XmlElement | null | undefined, ...locals: string[]): XmlElement | null {
  return property?.children.find((child) => child.uri === GMD && locals.includes(child.local)) ?? null;
}

const present = <T>(value: T | null): value is T => value !== null;

/** A text property (`gco:CharacterString`, `gmx:Anchor` or `gmd:PT_FreeText`), trimmed; blank is no value. */
function characterString(property: XmlElement | null | undefined): string | null {
  if (property === null || property === undefined) return null;
  for (const child of property.children) {
    if ((child.uri === GCO && child.local === "CharacterString") || (child.uri === GMX && child.local === "Anchor")) {
      return child.text.trim() || null;
    }
  }
  const free = kid(kid(property, "PT_FreeText"), "textGroup");
  return kid(free, "LocalisedCharacterString")?.text.trim() || null;
}

function stringsOf(properties: readonly XmlElement[]): string[] {
  return properties.map(characterString).filter(present);
}

/** GeoAPI's CodeList.name() of the code a property holds: `codeListValue`, or the text, in upper case with `_` between words. */
function codeName(property: XmlElement | null | undefined): string | null {
  const element = property?.children[0];
  const value = (element?.attributes["codeListValue"] ?? element?.text ?? "").trim();
  return value === "" ? null : value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

// The code lists Tika holds in a CodeListSet, in GeoAPI's order (ISO 19115:2003). Codes outside the list follow in file order.
const PROGRESS = ["COMPLETED", "HISTORICAL_ARCHIVE", "OBSOLETE", "ON_GOING", "PLANNED", "REQUIRED", "UNDER_DEVELOPMENT"];
const RESTRICTION = ["COPYRIGHT", "PATENT", "PATENT_PENDING", "TRADEMARK", "LICENSE", "INTELLECTUAL_PROPERTY_RIGHTS", "RESTRICTED", "OTHER_RESTRICTIONS"];
const TOPIC_CATEGORY = [
  "FARMING",
  "BIOTA",
  "BOUNDARIES",
  "CLIMATOLOGY_METEOROLOGY_ATMOSPHERE",
  "ECONOMY",
  "ELEVATION",
  "ENVIRONMENT",
  "GEOSCIENTIFIC_INFORMATION",
  "HEALTH",
  "IMAGERY_BASE_MAPS_EARTH_COVER",
  "INTELLIGENCE_MILITARY",
  "INLAND_WATERS",
  "LOCATION",
  "OCEANS",
  "PLANNING_CADASTRE",
  "SOCIETY",
  "STRUCTURE",
  "TRANSPORTATION",
  "UTILITIES_COMMUNICATION",
];

/** What a CodeListSet iterates: each code once, in the order of the code list. */
function codeSet(names: readonly string[], family: readonly string[]): string[] {
  const unique = [...new Set(names)];
  const rank = (name: string): number => {
    const index = family.indexOf(name);
    return index === -1 ? family.length : index;
  };
  // Array.prototype.sort is stable, so codes outside the list keep the file's order.
  return unique.sort((a, b) => rank(a) - rank(b));
}

const JAVA_CHARSETS: Readonly<Record<string, string>> = {
  utf8: "UTF-8",
  utf16: "UTF-16",
  usascii: "US-ASCII",
  shiftjis: "Shift_JIS",
  eucjp: "EUC-JP",
  euckr: "EUC-KR",
  big5: "Big5",
  gb2312: "GB2312",
};

/** The Java charset name of a `MD_CharacterSetCode`, or null for a code with no Java charset here. */
function charsetName(property: XmlElement | null | undefined): string | null {
  const element = property?.children[0];
  const value = (element?.attributes["codeListValue"] ?? element?.text ?? "").trim().toLowerCase();
  const part = /^8859part(\d{1,2})$/.exec(value);
  if (part !== null) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 15].includes(Number(part[1])) ? `ISO-8859-${part[1]}` : null;
  return JAVA_CHARSETS[value] ?? null;
}

/** The language code of a `gmd:language` (a character string such as `eng`, or `eng; USA`) or a `gmd:LanguageCode`. */
function languageCode(property: XmlElement | null | undefined): string | null {
  const element = property?.children[0];
  if (element === undefined) return null;
  const raw = element.uri === GMD ? (element.attributes["codeListValue"] ?? element.text) : (characterString(property) ?? "");
  const match = /^\s*([A-Za-z]{2,3})(?![A-Za-z])/.exec(raw);
  return match === null ? null : match[1]!.toLowerCase();
}

let languageNames: Intl.DisplayNames | undefined;

/** Locale.getDisplayLanguage(Locale.ENGLISH): "English" for `eng`; a code with no name is its own display name. */
function displayLanguage(code: string): string {
  languageNames ??= new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });
  return languageNames.of(code) ?? code;
}

/** A gco:Date or gco:DateTime as epoch milliseconds, or null when it is missing or cannot be read. */
function dateValue(property: XmlElement | null | undefined): number | null {
  const element = property?.children.find((child) => child.uri === GCO && (child.local === "Date" || child.local === "DateTime"));
  if (element === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(element.text.trim());
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) => Number(match[index] ?? 0)) as [number, number, number, number, number, number];
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, day);
  moment.setUTCHours(hour, minute, second, 0);
  // A date that rolled over (February 30th) is no date.
  if (moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const zone = /^([+-])(\d{2}):(\d{2})$/.exec(match[7] ?? "");
  const offsetMinutes = zone === null ? 0 : (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
  return moment.getTime() - offsetMinutes * 60_000;
}

/** DateUtils.formatDate: ISO 8601 in UTC to the second. A missing date is the NullPointerException Calendar.setTime(null) throws. */
function formatDate(time: number | null): string {
  if (time === null) throw npe("a date that is missing or cannot be read");
  return new Date(time).toISOString().slice(0, 19) + "Z";
}

interface DateEntry {
  readonly type: string | null;
  readonly time: number | null;
}

interface Party {
  readonly role: string | null;
  readonly individualName: string | null;
  readonly organisationName: string | null;
  readonly positionName: string | null;
  /** null: no contact information. `emails` null: contact information with no address. */
  readonly contact: { readonly emails: string[] | null } | null;
}

interface Citation {
  readonly title: string | null;
  readonly alternateTitles: string[];
  readonly edition: string | null;
  readonly dates: DateEntry[];
  readonly parties: Party[];
}

function dateEntryOf(property: XmlElement): DateEntry | null {
  const date = objectNamed(property, "CI_Date");
  return date === null ? null : { type: codeName(kid(date, "dateType")), time: dateValue(kid(date, "date")) };
}

function partyOf(property: XmlElement | null | undefined): Party | null {
  const party = objectNamed(property, "CI_ResponsibleParty");
  if (party === null) return null;
  const contact = objectNamed(kid(party, "contactInfo"), "CI_Contact");
  // SIS's legacy CI_Contact.getAddress() is the first address.
  const address = objectNamed(kid(contact, "address"), "CI_Address");
  return {
    role: codeName(kid(party, "role")),
    individualName: characterString(kid(party, "individualName")),
    organisationName: characterString(kid(party, "organisationName")),
    positionName: characterString(kid(party, "positionName")),
    contact: contact === null ? null : { emails: address === null ? null : stringsOf(kids(address, "electronicMailAddress")) },
  };
}

function citationOf(property: XmlElement | null | undefined): Citation | null {
  const citation = objectNamed(property, "CI_Citation");
  if (citation === null) return null;
  return {
    title: characterString(kid(citation, "title")),
    alternateTitles: stringsOf(kids(citation, "alternateTitle")),
    edition: characterString(kid(citation, "edition")),
    dates: kids(citation, "date").map(dateEntryOf).filter(present),
    parties: kids(citation, "citedResponsibleParty").map(partyOf).filter(present),
  };
}

interface Keywords {
  readonly keywords: string[];
  readonly type: string | null;
  readonly thesaurus: Citation | null;
}

interface Identifier {
  readonly code: string | null;
  readonly authority: Citation | null;
}

type GeographicElement =
  | { readonly kind: "box"; readonly west: number; readonly east: number; readonly south: number; readonly north: number }
  | { readonly kind: "description"; readonly identifier: Identifier | null };

interface LegalConstraints {
  readonly access: string[];
  readonly other: string[];
  readonly use: string[];
}

interface Identification {
  readonly citation: Citation | null;
  readonly abstract: string | null;
  readonly status: string[];
  readonly formatNames: string[];
  readonly languages: string[];
  readonly topicCategories: string[];
  readonly keywords: Keywords[];
  readonly constraints: LegalConstraints[];
  readonly geographicElements: GeographicElement[];
}

interface Distribution {
  readonly formatNames: string[];
  readonly distributors: Party[];
  readonly onlineResources: OnlineResource[];
}

interface OnlineResource {
  readonly linkage: string | null;
  readonly protocol: string | null;
  readonly profile: string | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly function: string | null;
}

interface Record19139 {
  /** The charset of each language the record is written in, by display name of the language, as SIS's getLocalesAndCharsets(). */
  readonly charsets: Map<string, string>;
  readonly contacts: Party[];
  readonly identifications: Identification[];
  readonly distribution: Distribution | null;
  readonly dateStamps: number[];
  readonly scopes: string[];
  readonly parentTitle: string | null;
  readonly identifierCode: string | null;
  readonly standard: { readonly title: string | null; readonly edition: string | null } | null;
}

/** The name of each `MD_Format` among the properties: SIS's legacy Format.getName() (a null name is skipped by Tika). */
function formatNames(properties: readonly XmlElement[]): string[] {
  return properties.map((property) => characterString(kid(objectNamed(property, "MD_Format"), "name"))).filter(present);
}

function decimal(property: XmlElement | null): number {
  const text = property?.children.find((child) => child.uri === GCO && child.local === "Decimal")?.text;
  return text === undefined ? Number.NaN : (parseJavaDouble(text) ?? Number.NaN);
}

function geographicElementOf(property: XmlElement): GeographicElement | null {
  const box = objectNamed(property, "EX_GeographicBoundingBox");
  if (box !== null) {
    return {
      kind: "box",
      west: decimal(kid(box, "westBoundLongitude")),
      east: decimal(kid(box, "eastBoundLongitude")),
      south: decimal(kid(box, "southBoundLatitude")),
      north: decimal(kid(box, "northBoundLatitude")),
    };
  }
  const description = objectNamed(property, "EX_GeographicDescription");
  if (description === null) return null;
  const identifier = objectNamed(kid(description, "geographicIdentifier"), "MD_Identifier", "RS_Identifier");
  return identifier === null
    ? { kind: "description", identifier: null }
    : { kind: "description", identifier: { code: characterString(kid(identifier, "code")), authority: citationOf(kid(identifier, "authority")) } };
}

function keywordsOf(property: XmlElement): Keywords | null {
  const group = objectNamed(property, "MD_Keywords");
  if (group === null) return null;
  return {
    keywords: stringsOf(kids(group, "keyword")),
    type: codeName(kid(group, "type")),
    thesaurus: citationOf(kid(group, "thesaurusName")),
  };
}

function legalConstraintsOf(property: XmlElement): LegalConstraints | null {
  const child = property.children[0];
  if (child === undefined) return null;
  if (child.uri !== GMD || child.local !== "MD_LegalConstraints") throw classCast(`${child.local} among the resource constraints`);
  return {
    access: kids(child, "accessConstraints").map(codeName).filter(present),
    other: stringsOf(kids(child, "otherConstraints")),
    use: kids(child, "useConstraints").map(codeName).filter(present),
  };
}

function identificationOf(property: XmlElement): Identification | null {
  const element = property.children[0];
  if (element === undefined) return null;
  // SIS reads a data identification and a service identification (srv:SV_ServiceIdentification); Tika casts both to the former.
  if (element.uri !== GMD || element.local !== "MD_DataIdentification") throw classCast(`${element.local} as an identification`);
  const languages: string[] = [];
  for (const code of kids(element, "language").map(languageCode).filter(present)) {
    const name = displayLanguage(code);
    if (!languages.includes(name)) languages.push(name);
  }
  return {
    citation: citationOf(kid(element, "citation")),
    abstract: characterString(kid(element, "abstract")),
    status: codeSet(kids(element, "status").map(codeName).filter(present), PROGRESS),
    formatNames: formatNames(kids(element, "resourceFormat")),
    languages,
    topicCategories: codeSet(kids(element, "topicCategory").map(codeName).filter(present), TOPIC_CATEGORY),
    keywords: kids(element, "descriptiveKeywords").map(keywordsOf).filter(present),
    constraints: kids(element, "resourceConstraints").map(legalConstraintsOf).filter(present),
    geographicElements: kids(element, "extent").flatMap((extent) =>
      kids(objectNamed(extent, "EX_Extent"), "geographicElement").map(geographicElementOf).filter(present),
    ),
  };
}

function onlineResourceOf(property: XmlElement): OnlineResource | null {
  const resource = objectNamed(property, "CI_OnlineResource");
  if (resource === null) return null;
  const linkage = kid(resource, "linkage")?.children.find((child) => child.uri === GMD && child.local === "URL");
  return {
    linkage: linkage?.text.trim() || null,
    protocol: characterString(kid(resource, "protocol")),
    profile: characterString(kid(resource, "applicationProfile")),
    name: characterString(kid(resource, "name")),
    description: characterString(kid(resource, "description")),
    function: codeName(kid(resource, "function")),
  };
}

function distributionOf(property: XmlElement | null): Distribution | null {
  const distribution = objectNamed(property, "MD_Distribution");
  if (distribution === null) return null;
  return {
    formatNames: formatNames(kids(distribution, "distributionFormat")),
    distributors: kids(distribution, "distributor").flatMap((distributor) => partyOf(kid(objectNamed(distributor, "MD_Distributor"), "distributorContact")) ?? []),
    onlineResources: kids(distribution, "transferOptions").flatMap((options) =>
      kids(objectNamed(options, "MD_DigitalTransferOptions"), "onLine").map(onlineResourceOf).filter(present),
    ),
  };
}

/** SIS's getLocalesAndCharsets() of the record: gmd:language with gmd:characterSet, then each gmd:locale. */
function charsetsOf(root: XmlElement): Map<string, string> {
  const charsets = new Map<string, string>();
  const put = (language: string | null, charset: string | null): void => {
    if (language !== null && charset !== null) charsets.set(displayLanguage(language), charset);
  };
  put(languageCode(kid(root, "language")), charsetName(kid(root, "characterSet")));
  for (const locale of kids(root, "locale")) {
    const object = objectNamed(locale, "PT_Locale");
    put(languageCode(kid(object, "languageCode")), charsetName(kid(object, "characterEncoding")));
  }
  return charsets;
}

function readRecord(root: XmlElement): Record19139 {
  const standardTitle = characterString(kid(root, "metadataStandardName"));
  const standardEdition = characterString(kid(root, "metadataStandardVersion"));
  const dateStamp = dateValue(kid(root, "dateStamp"));
  return {
    charsets: charsetsOf(root),
    contacts: kids(root, "contact").map(partyOf).filter(present),
    identifications: kids(root, "identificationInfo").map(identificationOf).filter(present),
    distribution: distributionOf(kid(root, "distributionInfo")),
    dateStamps: dateStamp === null ? [] : [dateStamp],
    scopes: kids(root, "hierarchyLevel").map(codeName).filter(present),
    parentTitle: characterString(kid(root, "parentIdentifier")),
    identifierCode: characterString(kid(root, "fileIdentifier")),
    standard: standardTitle === null && standardEdition === null ? null : { title: standardTitle, edition: standardEdition },
  };
}

// ---- metadata: GeographicInformationParser.extract, in its order ----

const KEY = {
  characterSet: "iso19115:character-set",
  contactRole: "iso19115:contact-role",
  contactPartyName: "iso19115:contact-party-name",
  citationDate: "iso19115:citation-date",
  citedRole: "iso19115:cited-responsible-party-role",
  citedName: "iso19115:cited-responsible-party-name",
  citedOrganization: "iso19115:cited-responsible-party-organization-name",
  citedPosition: "iso19115:cited-responsible-party-position-name",
  citedEmail: "iso19115:cited-responsible-party-email",
  status: "iso19115:identification-info-status",
  resourceFormat: "iso19115:resource-format-specification-alternative-title",
  topicCategory: "iso19115:identification-info-topic-category",
  thesaurusDate: "iso19115:thesaurus-name-date",
  accessConstraints: "iso19115:access-constraints",
  otherConstraints: "iso19115:other-constraints",
  useConstraints: "iso19115:use-constraints",
  geographicCode: "iso19115:geographic-identifier-code",
  geographicAuthorityTitle: "iso19115:geographic-identifier-authority-title",
  geographicAuthorityAlternativeTitle: "iso19115:geographic-identifier-authority-alternative-title",
  geographicAuthorityDate: "iso19115:geographic-identifier-authority-date",
  distributionFormat: "iso19115:distribution-format-specification-alternative-title",
  distributorContact: "iso19115:distributor-contact",
  distributorOrganization: "iso19115:distributor-organization-name",
  linkage: "iso19115:transfer-options-online-linkage",
  protocol: "iso19115:transfer-options-online-protocol",
  profile: "iso19115:transfer-options-online-profile",
  onlineName: "iso19115:transfer-options-online-name",
  onlineDescription: "iso19115:transfer-options-online-description",
  onlineFunction: "iso19115:transfer-options-online-function",
  dateInfo: "iso19115:date-info",
  scope: "iso19115:metadata-resource-scope",
  parentTitle: "iso19115:parent-metadata-title",
  identifierCode: "iso19115:metadata-identifier-code",
  standardTitle: "iso19115:metadata-standard-title",
  standardEdition: "iso19115:metadata-standard-edition",
} as const;

/** Metadata.add(Property, ...) of a single-valued Property: a second value is a PropertyTypeException. */
function addSingleValued(metadata: Metadata, key: string, value: string | null): void {
  if (value === null) return;
  if (metadata.has(key)) throw new MalformedDocumentError(`${key} is single-valued and already set (Tika's PropertyTypeException)`);
  metadata.set(key, value);
}

function addAll(metadata: Metadata, key: string, values: readonly string[]): void {
  for (const value of values) metadata.add(key, value);
}

function writeMetadata(record: Record19139, metadata: Metadata): void {
  addAll(metadata, KEY.characterSet, [...record.charsets.values()]);
  for (const contact of record.contacts) {
    if (contact.role !== null) metadata.add(KEY.contactRole, contact.role);
    if (contact.organisationName !== null) metadata.add(KEY.contactPartyName, contact.organisationName);
  }
  const keywords = {
    text: new KeyPrefixWriter(metadata, "iso19115:keywords:"),
    type: new KeyPrefixWriter(metadata, "iso19115:keywords-type:"),
    thesaurusTitle: new KeyPrefixWriter(metadata, "iso19115:thesaurus-name-title:"),
    thesaurusAlternativeTitle: new KeyPrefixWriter(metadata, "iso19115:thesaurus-name-alternative-title:"),
  };
  for (const identification of record.identifications) writeIdentification(identification, metadata, keywords);
  writeDistribution(record.distribution, metadata);
  for (const stamp of record.dateStamps) metadata.add(KEY.dateInfo, `CREATION ${formatDate(stamp)}`);
  addAll(metadata, KEY.scope, record.scopes);
  addSingleValued(metadata, KEY.parentTitle, record.parentTitle);
  addSingleValued(metadata, KEY.identifierCode, record.identifierCode);
  if (record.standard?.title != null) metadata.add(KEY.standardTitle, record.standard.title);
  if (record.standard?.edition != null) metadata.add(KEY.standardEdition, record.standard.edition);
}

interface KeywordWriters {
  readonly text: KeyPrefixWriter;
  readonly type: KeyPrefixWriter;
  readonly thesaurusTitle: KeyPrefixWriter;
  readonly thesaurusAlternativeTitle: KeyPrefixWriter;
}

/** getMetaDataIdentificationInfo, for one identification. */
function writeIdentification(identification: Identification, metadata: Metadata, writers: KeywordWriters): void {
  const { citation } = identification;
  if (citation?.title != null) metadata.set("dc:title", citation.title);
  if (citation === null) throw npe("an identification with no citation");

  for (const date of citation.dates) {
    if (date.type !== null) metadata.add(KEY.citationDate, `${date.type}-->${formatDate(date.time)}`);
  }
  for (const party of citation.parties) {
    if (party.role !== null) metadata.add(KEY.citedRole, party.role);
    if (party.individualName !== null) metadata.add(KEY.citedName, party.individualName);
    if (party.organisationName !== null) metadata.add(KEY.citedOrganization, party.organisationName);
    if (party.positionName !== null) metadata.add(KEY.citedPosition, party.positionName);
    if (party.contact !== null) {
      if (party.contact.emails === null) throw npe("contact information with no address");
      addAll(metadata, KEY.citedEmail, party.contact.emails);
    }
  }
  if (identification.abstract !== null) metadata.set("dc:description", identification.abstract);
  addAll(metadata, KEY.status, identification.status);
  addAll(metadata, KEY.resourceFormat, identification.formatNames);
  // The map's keys are the languages, and Tika sets the property once for each: the last one stays.
  for (const language of identification.languages) metadata.set("dc:language", language);
  addAll(metadata, KEY.topicCategory, identification.topicCategories);

  // Tika's counter starts at 1 and is incremented before it is used, so the first group is 2.
  let group = 1;
  for (const keywords of identification.keywords) {
    group++;
    const name = String(group);
    for (const keyword of keywords.keywords) writers.text.add(name, keyword);
    if (keywords.type !== null) writers.type.add(name, keywords.type);
    const thesaurus = keywords.thesaurus;
    if (thesaurus?.title != null) writers.thesaurusTitle.add(name, thesaurus.title);
    // getAlternateTitles().toString(): the collection prints in brackets, so a thesaurus with none writes "[]".
    if (thesaurus !== null) writers.thesaurusAlternativeTitle.add(name, `[${thesaurus.alternateTitles.join(", ")}]`);
    if (thesaurus === null) throw npe("a keyword group with no thesaurus name");
    for (const date of thesaurus.dates) {
      if (date.type !== null) metadata.add(KEY.thesaurusDate, `${date.type}-->${formatDate(date.time)}`);
    }
  }

  for (const constraints of identification.constraints) {
    addAll(metadata, KEY.accessConstraints, codeSet(constraints.access, RESTRICTION));
    addAll(metadata, KEY.otherConstraints, constraints.other);
    addAll(metadata, KEY.useConstraints, codeSet(constraints.use, RESTRICTION));
  }

  for (const element of identification.geographicElements) {
    if (element.kind === "description") writeGeographicDescription(element.identifier, metadata);
  }
}

function writeGeographicDescription(identifier: Identifier | null, metadata: Metadata): void {
  if (identifier?.code != null) metadata.add(KEY.geographicCode, identifier.code);
  if (identifier?.authority?.title != null) metadata.add(KEY.geographicAuthorityTitle, identifier.authority.title);
  const authority = identifier?.authority;
  if (authority === null || authority === undefined) throw npe("a geographic description with no identifier authority");
  addAll(metadata, KEY.geographicAuthorityAlternativeTitle, authority.alternateTitles);
  for (const date of authority.dates) {
    if (date.type !== null && date.time !== null) metadata.add(KEY.geographicAuthorityDate, `${date.type} ${formatDate(date.time)}`);
  }
}

/** getMetaDataDistributionInfo. */
function writeDistribution(distribution: Distribution | null, metadata: Metadata): void {
  if (distribution === null) throw npe("a record with no distributionInfo");
  addAll(metadata, KEY.distributionFormat, distribution.formatNames);
  for (const distributor of distribution.distributors) {
    if (distributor.role !== null) metadata.add(KEY.distributorContact, distributor.role);
    if (distributor.organisationName !== null) metadata.add(KEY.distributorOrganization, distributor.organisationName);
  }
  for (const resource of distribution.onlineResources) {
    if (resource.linkage !== null) metadata.add(KEY.linkage, resource.linkage);
    if (resource.protocol !== null) metadata.add(KEY.protocol, resource.protocol);
    if (resource.profile !== null) metadata.add(KEY.profile, resource.profile);
    if (resource.name !== null) metadata.add(KEY.onlineName, resource.name);
    if (resource.description !== null) metadata.add(KEY.onlineDescription, resource.description);
    if (resource.function !== null) metadata.add(KEY.onlineFunction, resource.function);
  }
}

// ---- text: GeographicInformationParser.extractContent ----

async function writeContent(record: Record19139, xhtml: XHTMLContentHandler, tick: () => void): Promise<void> {
  await xhtml.startDocument();
  await xhtml.newline();
  await xhtml.newline();
  for (const identification of record.identifications) {
    tick();
    const title = identification.citation?.title;
    if (title === null || title === undefined) throw npe("an identification with no title");
    await xhtml.startElement("h1");
    await xhtml.characters(title);
    await xhtml.endElement("h1");
    await xhtml.newline();

    for (const party of identification.citation?.parties ?? []) {
      if (party.role === null) throw npe("a cited responsible party with no role");
      await xhtml.startElement("h3");
      await xhtml.newline();
      await xhtml.characters(`CitedResponsiblePartyRole ${party.role}`);
      // String concatenation with a null name writes "null".
      await xhtml.characters(`CitedResponsiblePartyName ${party.individualName}`);
      await xhtml.endElement("h3");
      await xhtml.newline();
    }

    if (identification.abstract === null) throw npe("an identification with no abstract");
    await xhtml.startElement("p");
    await xhtml.newline();
    await xhtml.characters(`IdentificationInfoAbstract ${identification.abstract}`);
    await xhtml.endElement("p");
    await xhtml.newline();

    for (const element of identification.geographicElements) {
      if (element.kind === "box") await writeBox(xhtml, element);
    }
  }
  await xhtml.newline();
  await xhtml.endDocument();
}

async function writeBox(xhtml: XHTMLContentHandler, box: { west: number; east: number; north: number; south: number }): Promise<void> {
  // Tika's labels say "Latitude" for the longitudes too, and the sides come in this order.
  const rows: ReadonlyArray<readonly [string, number]> = [
    ["GeographicElementWestBoundLatitude", box.west],
    ["GeographicElementEastBoundLatitude", box.east],
    ["GeographicElementNorthBoundLatitude", box.north],
    ["GeographicElementSouthBoundLatitude", box.south],
  ];
  for (const [label, value] of rows) {
    await xhtml.startElement("tr");
    await xhtml.startElement("td");
    await xhtml.characters(label);
    await xhtml.endElement("td");
    await xhtml.startElement("td");
    await xhtml.characters(javaDoubleString(value));
    await xhtml.endElement("td");
    await xhtml.endElement("tr");
  }
}
