import { MediaType } from "@spikedpunch/ripstream-core";
import type { ZipArchive } from "./zip-archive.ts";
import {
  hasValidDecodedName,
  isValidContentType,
  isValidPartName,
  partNameKey,
  partNameOfEntry,
  targetPartName,
} from "./opc-syntax.ts";
import { readPackageXml } from "./opc-xml.ts";
import { scanXmlElements } from "./xml-scan.ts";

/** Port of Tika 4.2.0 `OPCPackageDetector.detect(ZipFile, ...)`, with POI's package parsing done by hand. */

/**
 * The most inflated bytes read from one package XML part. POI reads a part whole, and Tika 4.2.0 measured accepts a
 * 40 MiB `[Content_Types].xml`; a real package has tens of kilobytes. Detection runs before any parser limit, so a
 * part is read only up to this, and a larger one is treated as unreadable (a deliberate deviation).
 */
const MAX_XML_BYTES = 40 * 1024 * 1024;
/**
 * POI parses the relationships of every part when it opens a package. Detection runs before any parser limit, so the
 * inflated size of those parts is budgeted; a package past it is taken as readable rather than read to the end.
 */
const MAX_PART_RELATIONSHIPS_BYTES = 16 * 1024 * 1024;
const CONTENT_TYPES_PART = "[Content_Types].xml";
const ROOT_RELS_PART_NAME = "/_rels/.rels";
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

const REL_CORE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_STRICT_CORE = "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument";
const REL_VISIO_CORE = "http://schemas.microsoft.com/visio/2010/relationships/document";
const REL_XPS = "http://schemas.microsoft.com/xps/2005/06/fixedrepresentation";
const REL_OPEN_XPS = "http://schemas.openxps.org/oxps/v1.0/fixedrepresentation";
const REL_DWFX = "http://schemas.autodesk.com/dwfx/2007/relationships/documentsequence";
const REL_3MF = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

/** Main-part content types Tika recognises when POI cannot (or will not) resolve the package. */
const OOXML_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["application/vnd.ms-word.document.macroEnabled.main+xml", "application/vnd.ms-word.document.macroEnabled.12"],
  ["application/vnd.ms-word.template.macroEnabledTemplate.main+xml", "application/vnd.ms-word.template.macroenabled.12"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.template"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["application/vnd.ms-excel.sheet.macroEnabled.main+xml", "application/vnd.ms-excel.sheet.macroEnabled.12"],
  ["application/vnd.ms-excel.sheet.binary.macroEnabled.main", "application/vnd.ms-excel.sheet.binary.macroenabled.12"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.template"],
  ["application/vnd.ms-excel.template.macroEnabled.main+xml", "application/vnd.ms-excel.template.macroenabled.12"],
  ["application/vnd.ms-excel.addin.macroEnabled.main+xml", "application/vnd.ms-excel.addin.macroEnabled.12"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml", "application/vnd.ms-powerpoint.slideshow.macroEnabled.12"],
  ["application/vnd.ms-powerpoint.template.macroEnabled.main+xml", "application/vnd.ms-powerpoint.template.macroenabled.12"],
  // Tika puts PRESENTATIONML_TEMPLATE in twice (as pptm, then potx); the later put wins.
  ["application/vnd.openxmlformats-officedocument.presentationml.template.main+xml", "application/vnd.openxmlformats-officedocument.presentationml.template"],
  ["application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml", "application/vnd.openxmlformats-officedocument.presentationml.slideshow"],
  ["application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
  ["application/vnd.openxmlformats-officedocument.themeManager+xml", "application/vnd.openxmlformats-officedocument"],
  ["application/vnd.ms-visio.drawing.macroEnabled.main+xml", "application/vnd.ms-visio.drawing.macroEnabled.12"],
  ["application/vnd.ms-visio.drawing.main+xml", "application/vnd.ms-visio.drawing"],
  ["application/vnd.ms-visio.stencil.macroEnabled.main+xml", "application/vnd.ms-visio.stencil.macroenabled.12"],
  ["application/vnd.ms-visio.stencil.main+xml", "application/vnd.ms-visio.stencil"],
  ["application/vnd.ms-visio.template.macroEnabled.main+xml", "application/vnd.ms-visio.template.macroenabled.12"],
  ["application/vnd.ms-visio.template.main+xml", "application/vnd.ms-visio.template"],
  ["application/vnd.ms-package.xps-fixeddocumentsequence+xml", "application/vnd.ms-xpsdocument"],
]);

interface Relationship {
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

interface ContentTypes {
  /** Lower-cased extension to content type. */
  readonly defaults: ReadonlyMap<string, string>;
  /** Part name key (see `partNameKey`) to content type. */
  readonly overrides: ReadonlyMap<string, string>;
}

interface Part {
  /** The ZIP entry that holds the part. */
  readonly entry: string;
  readonly partName: string;
}

/** POI could not open the package; Tika falls back to the content-type scan. */
class PackageUnreadable extends Error {}

export async function detectOpc(zip: ZipArchive): Promise<MediaType | null> {
  const contentTypesEntry = findEntry(zip, CONTENT_TYPES_PART);
  if (contentTypesEntry === null) return null;

  const contentTypesXml = await zip.read(contentTypesEntry, MAX_XML_BYTES);
  if (contentTypesXml === null) return null;

  let type: MediaType | null = null;
  try {
    type = await detectViaPackage(zip, contentTypesXml);
  } catch (error) {
    if (!(error instanceof PackageUnreadable)) throw error;
  }
  return type ?? firstKnownContentType(contentTypesXml);
}

/** POI's `ZipFileZipEntrySource.getEntry`: the exact name, else the first entry that matches ignoring case. */
function findEntry(zip: ZipArchive, name: string): string | null {
  if (zip.has(name)) return name;
  const lowerName = name.toLowerCase();
  return zip.entries.find((entry) => entry.name.toLowerCase() === lowerName)?.name ?? null;
}

async function detectViaPackage(
  zip: ZipArchive,
  contentTypesXml: Uint8Array,
): Promise<MediaType | null> {
  const contentTypes = parseContentTypes(contentTypesXml);
  const parts = indexParts(zip.entries);
  // POI refuses a package holding a part whose content type is missing or malformed. Each distinct content type is
  // checked once: they all come from one bounded document, while the parts may be many.
  const checked = new Set<string>();
  for (const { entry, partName } of parts.values()) {
    const contentType = contentTypeOf(contentTypes, partName);
    if (contentType === null) throw new PackageUnreadable(entry);
    if (checked.has(contentType)) continue;
    if (!isValidContentType(contentType)) throw new PackageUnreadable(entry);
    checked.add(contentType);
  }

  await checkPartRelationships(zip, parts);
  const rels = await parseRootRelationships(zip, parts);
  const ofType = (type: string): Relationship[] => rels.filter((rel) => rel.type === type);

  let core = ofType(REL_CORE);
  if (core.length === 0) {
    core = ofType(REL_STRICT_CORE);
    if (core.length === 0) core = ofType(REL_VISIO_CORE);
    if (core.length === 0) {
      core = ofType(REL_XPS);
      if (core.length === 1) return mediaType("application/vnd.ms-xpsdocument");
      core = ofType(REL_OPEN_XPS);
      if (core.length === 1) return mediaType("application/vnd.ms-xpsdocument");
    }
    if (core.length === 0) {
      core = ofType(REL_DWFX);
      if (core.length === 1) return MediaType.parse("model/vnd.dwfx+xps");
    }
    if (core.length === 0) {
      core = ofType(REL_3MF);
      if (core.length === 1) return mediaType("application/vnd.ms-package.3dmanufacturing-3dmodel+xml");
    }
  }
  const [only] = core;
  if (core.length !== 1 || only === undefined) return null;

  const partName = targetPartName(only.target, only.external);
  if (partName === null) return null;
  if (!parts.has(partNameKey(partName))) return null;

  const coreType = contentTypeOf(contentTypes, partName);
  if (coreType === null) return null;
  return mediaTypeOfCoreContentType(coreType);
}

/**
 * The parts POI builds from the ZIP entries, by lower-cased part name. An entry whose name is not a valid part name is
 * skipped; two entries with the same part name, ignoring case, make the package unreadable.
 */
function indexParts(entries: readonly { readonly name: string }[]): Map<string, Part> {
  const parts = new Map<string, Part>();
  for (const { name } of entries) {
    if (name.toLowerCase() === CONTENT_TYPES_PART.toLowerCase()) continue;
    const partName = partNameOfEntry(name);
    if (partName === null) continue;
    if (!hasValidDecodedName(partName)) throw new PackageUnreadable(name);
    const key = partNameKey(partName);
    if (parts.has(key)) throw new PackageUnreadable(name);
    parts.set(key, { entry: name, partName });
  }
  return parts;
}

/**
 * POI loads the relationships of every part that has a `_rels/NAME.rels` next to it, so one that is not well formed
 * makes the package unreadable. Its contents are not examined: a duplicate Id or a bad TargetMode there is accepted.
 */
async function checkPartRelationships(zip: ZipArchive, parts: ReadonlyMap<string, Part>): Promise<void> {
  let remaining = MAX_PART_RELATIONSHIPS_BYTES;
  for (const { partName } of parts.values()) {
    if (isRelationshipsPart(partName)) continue;
    const relationships = parts.get(partNameKey(relationshipsPartNameOf(partName)));
    if (relationships === undefined) continue;
    if (remaining <= 0) return;

    const bytes = await zip.read(relationships.entry, MAX_XML_BYTES);
    if (bytes === null) throw new PackageUnreadable(relationships.entry);
    remaining -= bytes.length;
    if (!readPackageXml(bytes)) throw new PackageUnreadable(relationships.entry);
  }
}

/** POI's `isRelationshipPartURI`, which is case-sensitive. */
function isRelationshipsPart(partName: string): boolean {
  return /\/_rels\/.*\.rels$/.test(partName);
}

/** `/word/document.xml` to `/word/_rels/document.xml.rels`. */
function relationshipsPartNameOf(partName: string): string {
  const slash = partName.lastIndexOf("/");
  return `${partName.slice(0, slash)}/_rels/${partName.slice(slash + 1)}.rels`;
}

function mediaTypeOfCoreContentType(coreType: string): MediaType | null {
  if (coreType.includes(".xps")) return mediaType("application/vnd.ms-package.xps");

  const dot = coreType.lastIndexOf(".");
  // Java's substring(0, -1) throws here; the caller then takes the content-type scan instead.
  if (dot === -1) throw new PackageUnreadable(coreType);
  let docType = coreType.slice(0, dot);
  if (docType.toLowerCase().endsWith("macroenabled")) docType = `${docType.toLowerCase()}.12`;
  if (docType.toLowerCase().endsWith("macroenabledtemplate")) {
    docType = docType.replace(/macroenabledtemplate$/i, "macroenabled.12");
  }
  return MediaType.parse(docType);
}

/** Tika's fallback: the first ContentType attribute naming a known main part, even in a document that later breaks. */
function firstKnownContentType(contentTypesXml: Uint8Array): MediaType | null {
  let found: MediaType | null = null;
  scanXmlElements(contentTypesXml, (element) => {
    for (const attribute of element.attributes) {
      if (attribute.local !== "ContentType") continue;
      const known = OOXML_CONTENT_TYPES.get(attribute.value);
      if (known !== undefined) {
        found = MediaType.parse(known);
        return true;
      }
    }
    return false;
  });
  return found;
}

function parseContentTypes(contentTypesXml: Uint8Array): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  let invalidOverride = false;
  // POI finds Default and Override by namespace anywhere in the document, and reads a missing attribute as empty.
  const wellFormed = readPackageXml(contentTypesXml, (element) => {
    if (element.uri !== CONTENT_TYPES_NAMESPACE) return;
    const contentType = element.attributes.get("ContentType") ?? "";
    if (element.local === "Default") {
      defaults.set((element.attributes.get("Extension") ?? "").toLowerCase(), contentType);
    } else if (element.local === "Override") {
      const partName = element.attributes.get("PartName") ?? "";
      if (isValidPartName(partName)) overrides.set(partNameKey(partName), contentType);
      else invalidOverride = true;
    }
  });
  if (!wellFormed || invalidOverride) throw new PackageUnreadable(CONTENT_TYPES_PART);
  return { defaults, overrides };
}

async function parseRootRelationships(
  zip: ZipArchive,
  parts: ReadonlyMap<string, Part>,
): Promise<Relationship[]> {
  const rootRels = parts.get(ROOT_RELS_PART_NAME);
  if (rootRels === undefined) return [];
  const bytes = await zip.read(rootRels.entry, MAX_XML_BYTES);
  if (bytes === null) throw new PackageUnreadable(rootRels.entry);

  // POI keys relationships by Id: a later one replaces an earlier one, and one without an Id is given "rIdN".
  const byId = new Map<string, Relationship>();
  let generated = 1;
  const wellFormed = readPackageXml(bytes, (element) => {
    if (element.local !== "Relationship" || element.uri !== RELATIONSHIPS_NAMESPACE) return;
    let id = element.attributes.get("Id") ?? "";
    if (id === "") {
      while (byId.has(`rId${generated}`)) generated++;
      id = `rId${generated}`;
    }
    const mode = element.attributes.get("TargetMode");
    byId.set(id, {
      type: element.attributes.get("Type") ?? "",
      target: element.attributes.get("Target") ?? "",
      external: mode !== undefined && mode.toLowerCase() !== "internal",
    });
  });
  if (!wellFormed) throw new PackageUnreadable(rootRels.entry);
  return [...byId.values()];
}

/** The part's override, else the default for its extension (empty when it has none); null when it has neither. */
function contentTypeOf(contentTypes: ContentTypes, partName: string): string | null {
  const override = contentTypes.overrides.get(partNameKey(partName));
  if (override !== undefined) return override;
  const lower = partName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return contentTypes.defaults.get(dot === -1 ? "" : lower.slice(dot + 1)) ?? null;
}

function mediaType(value: string): MediaType {
  const parsed = MediaType.parse(value);
  if (parsed === null) throw new Error(`invalid media type literal: ${value}`);
  return parsed;
}
