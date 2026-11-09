import { MediaType } from "@spikedpunch/ripstream-core";
import type { ZipArchive } from "./zip-archive.ts";
import { scanXmlElements } from "./xml-scan.ts";

/** Port of Tika 4.2.0 `OPCPackageDetector.detect(ZipFile, ...)`, with POI's package parsing done by hand. */

const MAX_XML_BYTES = 1024 * 1024;
const CONTENT_TYPES_PART = "[Content_Types].xml";
const ROOT_RELS_PART = "_rels/.rels";

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
  /** Lower-cased part name (leading slash) to content type. */
  readonly overrides: ReadonlyMap<string, string>;
}

/** POI could not open the package; Tika falls back to the content-type scan. */
class PackageUnreadable extends Error {}

export async function detectOpc(zip: ZipArchive): Promise<MediaType | null> {
  if (!zip.has(CONTENT_TYPES_PART)) return null;

  const contentTypesXml = await zip.read(CONTENT_TYPES_PART, MAX_XML_BYTES);
  if (contentTypesXml === null) return null;

  let type: MediaType | null = null;
  try {
    type = await detectViaPackage(zip, contentTypesXml);
  } catch (error) {
    if (!(error instanceof PackageUnreadable)) throw error;
  }
  return type ?? firstKnownContentType(contentTypesXml);
}

async function detectViaPackage(
  zip: ZipArchive,
  contentTypesXml: Uint8Array,
): Promise<MediaType | null> {
  const contentTypes = parseContentTypes(contentTypesXml);
  const parts = zip.entries
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith("/") && name.toLowerCase() !== CONTENT_TYPES_PART.toLowerCase());
  // POI refuses a package holding a part it has no content type for.
  for (const part of parts) {
    if (contentTypeOf(contentTypes, part) === null) throw new PackageUnreadable(part);
  }

  const rels = await parseRootRelationships(zip);
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
  if (core.length !== 1 || only === undefined || only.external) return null;

  const partName = only.target.startsWith("/") ? only.target.slice(1) : only.target;
  const corePart = parts.find((name) => name.toLowerCase() === partName.toLowerCase());
  if (corePart === undefined) return null;

  const coreType = contentTypeOf(contentTypes, corePart);
  if (coreType === null) return null;
  return mediaTypeOfCoreContentType(coreType);
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
  const wellFormed = scanXmlElements(contentTypesXml, (element) => {
    const attribute = (name: string): string | undefined =>
      element.attributes.find((candidate) => candidate.local === name)?.value;
    const contentType = attribute("ContentType");
    if (element.local === "Default") {
      const extension = attribute("Extension");
      if (extension !== undefined && contentType !== undefined) {
        defaults.set(extension.toLowerCase(), contentType);
      }
    } else if (element.local === "Override") {
      const partName = attribute("PartName");
      if (partName !== undefined && contentType !== undefined) {
        overrides.set(partName.toLowerCase(), contentType);
      }
    }
    return false;
  });
  if (!wellFormed) throw new PackageUnreadable(CONTENT_TYPES_PART);
  return { defaults, overrides };
}

async function parseRootRelationships(zip: ZipArchive): Promise<Relationship[]> {
  if (!zip.has(ROOT_RELS_PART)) return [];
  const bytes = await zip.read(ROOT_RELS_PART, MAX_XML_BYTES);
  if (bytes === null) throw new PackageUnreadable(ROOT_RELS_PART);

  const rels: Relationship[] = [];
  const wellFormed = scanXmlElements(bytes, (element) => {
    if (element.local !== "Relationship") return false;
    const attribute = (name: string): string | undefined =>
      element.attributes.find((candidate) => candidate.local === name)?.value;
    const type = attribute("Type");
    const target = attribute("Target");
    if (type !== undefined && target !== undefined) {
      rels.push({ type, target, external: attribute("TargetMode") === "External" });
    }
    return false;
  });
  if (!wellFormed) throw new PackageUnreadable(ROOT_RELS_PART);
  return rels;
}

function contentTypeOf(contentTypes: ContentTypes, part: string): string | null {
  const override = contentTypes.overrides.get(`/${part}`.toLowerCase());
  if (override !== undefined) return override;
  const dot = part.lastIndexOf(".");
  if (dot === -1) return null;
  return contentTypes.defaults.get(part.slice(dot + 1).toLowerCase()) ?? null;
}

function mediaType(value: string): MediaType {
  const parsed = MediaType.parse(value);
  if (parsed === null) throw new Error(`invalid media type literal: ${value}`);
  return parsed;
}
