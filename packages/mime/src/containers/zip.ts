import { MediaType } from "@spikedpunch/ripstream-core";
import type { RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { detectIWork } from "./iwork.ts";
import { detectOpc } from "./opc.ts";
import { scanXmlElements } from "./xml-scan.ts";
import { ZipArchive } from "./zip-archive.ts";

/** A real `mimetype` entry is a short media type string. */
const MAX_MIMETYPE_BYTES = 4096;
const MAX_MANIFEST_BYTES = 1024 * 1024;

type ZipRule = (zip: ZipArchive) => MediaType | null | Promise<MediaType | null>;

/**
 * Port of Tika 4.2.0's `DefaultZipContainerDetector`: each container detector looks at the entry names (and, for
 * some, one small entry) and the first to name a type wins. The order is measured, not read: Tika loads these through
 * a service loader whose order the source does not fix, so overlapping fixtures were run against Tika 4.2.0 and
 * the order below reproduces every pairwise result (tikajs-68os.4).
 */
const RULES: readonly ZipRule[] = [
  detectIpa,
  detectJar,
  detectKmz,
  detectOpenDocument,
  detectStarOffice,
  detectFrictionless,
  detectGeoGebra,
  detectIWork,
  detectOpc,
];

/**
 * The container type of a ZIP, plain `application/zip` when no rule names one, or null when the file has no
 * readable central directory (or one past the detection bounds).
 */
export async function detectZipContainer(
  stream: RipstreamInputStream,
): Promise<MediaType | null> {
  const zip = await ZipArchive.open(await stream.getFile());
  if (zip === null) return null;
  try {
    for (const rule of RULES) {
      const type = await rule(zip);
      if (type !== null) return type;
    }
    return MediaType.APPLICATION_ZIP;
  } finally {
    await zip.close();
  }
}

const IPA_ENTRY_PATTERNS: readonly RegExp[] = [
  /^Payload\/$/,
  /^Payload\/.*\.app\/$/,
  /^Payload\/.*\.app\/_CodeSignature\/$/,
  /^Payload\/.*\.app\/_CodeSignature\/CodeResources$/,
  /^Payload\/.*\.app\/Info\.plist$/,
  /^Payload\/.*\.app\/PkgInfo$/,
];

/** An iOS app: every one of the six marker entries is present. */
function detectIpa(zip: ZipArchive): MediaType | null {
  const remaining = new Set(IPA_ENTRY_PATTERNS);
  for (const { name } of zip.entries) {
    for (const pattern of remaining) {
      if (pattern.test(name)) remaining.delete(pattern);
    }
    if (remaining.size === 0) return literal("application/x-itunes-ipa");
  }
  return null;
}

function detectJar(zip: ZipArchive): MediaType | null {
  if (zip.has("META-INF/MANIFEST.MF")) {
    if (zip.has("AndroidManifest.xml")) return literal("application/vnd.android.package-archive");
    if (zip.has("WEB-INF/")) return literal("application/x-tika-java-web-archive");
    if (zip.has("META-INF/application.xml")) return literal("application/x-tika-java-enterprise-archive");
    // Tika maps an Android App Bundle to this type; a bundle's base module carries the manifest.
    if (zip.has("base/manifest/AndroidManifest.xml")) return literal("application/x-authorware-bin");
    return literal("application/java-archive");
  }
  if (zip.has("AndroidManifest.xml")) return literal("application/vnd.android.package-archive");
  return null;
}

/** Google Earth: exactly one top-level `.kml`. */
function detectKmz(zip: ZipArchive): MediaType | null {
  let kmlCount = 0;
  for (const { name } of zip.entries) {
    if (name.endsWith("/") || name.includes("/") || name.includes("\\")) continue;
    if (name.toLowerCase().endsWith(".kml")) kmlCount++;
    if (kmlCount > 1) return null;
  }
  return kmlCount === 1 ? literal("application/vnd.google-earth.kmz") : null;
}

/** Whatever media type the `mimetype` entry parses as: ODF, EPUB, IDML, or any other package that declares one. */
async function detectOpenDocument(zip: ZipArchive): Promise<MediaType | null> {
  const bytes = await zip.read("mimetype", MAX_MIMETYPE_BYTES);
  if (bytes === null || bytes.length === 0) return null;
  return MediaType.parse(new TextDecoder().decode(bytes).trim());
}

const STAR_OFFICE_TYPES: ReadonlyMap<string, string> = new Map([
  ["application/vnd.sun.xml.writer", "application/vnd.sun.xml.writer"],
  ["application/vnd.sun.xml.calc", "application/vnd.sun.xml.calc"],
  ["application/vnd.sun.xml.draw", "application/vnd.sun.xml.draw"],
  ["application/vnd.sun.xml.impress", "application/vnd.sun.xml.impress"],
  ["application/vnd.sun.star.configuration-data", "application/vnd.openofficeorg.extension"],
]);

/** StarOffice 6 and OpenOffice extensions: named by a `file-entry` in `META-INF/manifest.xml`. */
async function detectStarOffice(zip: ZipArchive): Promise<MediaType | null> {
  const manifest = await zip.read("META-INF/manifest.xml", MAX_MANIFEST_BYTES);
  if (manifest === null) return null;

  let found: string | null = null;
  scanXmlElements(manifest, (element) => {
    if (element.local !== "file-entry") return false;
    let mediaTypeValue: string | null = null;
    let fullPath: string | null = null;
    for (const attribute of element.attributes) {
      if (attribute.local === "media-type") {
        mediaTypeValue = attribute.value;
        const known = STAR_OFFICE_TYPES.get(attribute.value);
        if (known !== undefined) {
          found = known;
          return true;
        }
      } else if (attribute.local === "full-path") {
        fullPath = attribute.value;
      }
    }
    if (mediaTypeValue === "" && fullPath === "/") {
      found = "application/vnd.openofficeorg.autotext";
      return true;
    }
    return false;
  });
  return found === null ? null : literal(found);
}

/** Frictionless data package (`datapackage.json` alone) or WACZ (a data package with web-archive parts). */
function detectFrictionless(zip: ZipArchive): MediaType | null {
  let hasPackage = false;
  let hasArchive = false;
  let hasIndexes = false;
  let hasPages = false;
  for (const { name } of zip.entries) {
    if (name.startsWith("archive/")) hasArchive = true;
    else if (name.startsWith("indexes/")) hasIndexes = true;
    else if (name.startsWith("pages/")) hasPages = true;
    else if (name === "datapackage.json") hasPackage = true;
  }
  if (!hasPackage) return null;
  if (hasArchive || (hasIndexes && hasPages)) return literal("application/x-wacz");
  // Entries outside the four marker prefixes do not count: a data package is `datapackage.json` plus what it describes.
  return hasIndexes || hasPages ? null : literal("application/x-vnd.datapackage+zip");
}

const GEOGEBRA_SLIDE = /^_slide\d+\/geogebra\.xml$/;

function detectGeoGebra(zip: ZipArchive): MediaType | null {
  if (zip.has("structure.json") && zip.entries.some(({ name }) => GEOGEBRA_SLIDE.test(name))) {
    return literal("application/vnd.geogebra.slides");
  }
  if (zip.has("geogebra.xml")) return literal("application/vnd.geogebra.file");
  if (zip.has("geogebra_macro.xml")) return literal("application/vnd.geogebra.tool");
  return null;
}

function literal(value: string): MediaType {
  const parsed = MediaType.parse(value);
  if (parsed === null) throw new Error(`invalid media type literal: ${value}`);
  return parsed;
}
