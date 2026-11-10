import { MediaType } from "@spikedpunch/ripstream-core";
import type { RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { CompoundFile, type CfbNode } from "./cfb.ts";

const OLE = literal("application/x-tika-msoffice");
const OOXML_PROTECTED = literal("application/x-tika-ooxml-protected");
const DRM_ENCRYPTED = literal("application/x-tika-ole-drm-encrypted");
const OLE10_NATIVE = literal("application/x-tika-msoffice-embedded; format=ole10_native");
const COMP_OBJ = literal("application/x-tika-msoffice-embedded; format=comp_obj");
const MS_GRAPH_CHART = literal("application/vnd.ms-graph");
const MS_EQUATION = literal("application/vnd.ms-equation");
const XLS = literal("application/vnd.ms-excel");
const DOC = literal("application/msword");
const PPT = literal("application/vnd.ms-powerpoint");
const PUB = literal("application/x-mspublisher");
const VSD = literal("application/vnd.visio");
const WPS = literal("application/vnd.ms-works");
const XLR = literal("application/x-tika-msworks-spreadsheet");
const MSG = literal("application/vnd.ms-outlook");
const MPP = literal("application/vnd.ms-project");
const SDC = literal("application/vnd.stardivision.calc");
const SDA = literal("application/vnd.stardivision.draw");
const SDD = literal("application/vnd.stardivision.impress");
const SDW = literal("application/vnd.stardivision.writer");
const SLDWORKS = literal("application/sldworks");
const ESRI_LAYER = literal("application/x-esri-layer");
const DGN_8 = literal("image/vnd.dgn; version=8");
const HWP = literal("application/x-hwp-v5");
const COREL_PRESENTATIONS = literal("application/x-corelpresentations");
const QUATTRO_PRO_7_8 = literal("application/x-quattro-pro; version=7-8");
const QUATTRO_PRO_9 = literal("application/x-quattro-pro; version=9");

/** Tika's `findRecursively` bound: the root is depth 0 and no entry deeper than 10 is looked at. */
const MAX_SEARCH_DEPTH = 10;

const COMP_OBJ_NAME = "\u0001COMPOBJ";
const MS_GRAPH_CHART_BYTES = ascii("MSGraph.Chart");
const STAR_DRAW_BYTES = ascii("StarDraw");
const STAR_IMPRESS_BYTES = ascii("StarImpress");
const WORKS_QUILL96_BYTES = ascii("Quill96");

/** Tika's MPP project data stream name: three whitespace characters, then digits (Java `\s` is ASCII only). */
const MPP_DATA_NAME = /^[ \t\n\x0B\f\r]{3}[0-9]+$/;

/**
 * Port of Tika 4.2.0's two OLE2 detectors, which both run on every OLE2 file: `POIFSContainerDetector` (Office
 * and StarOffice formats, case-insensitive, with a look into DRM storages and the `CompObj` stream) and then
 * `MiscOLEDetector` (HWP, Quattro Pro, Corel; case-sensitive). Tika sorts its service-loaded detectors by class
 * name, so POIFS comes first, and a later detector's answer replaces the running one only when it specialises it.
 * Everything the miscellaneous detector can name specialises `application/x-tika-msoffice` and nothing else it
 * could be following, so it applies exactly when POIFS found no specific type. Measured: a file with both
 * `WordDocument` and `\u0005HwpSummaryInformation` is `application/msword`.
 *
 * Null when the file is not a readable compound file; Tika then sees no entries and answers plain
 * `application/x-tika-msoffice`, which the caller's magic detector reaches as well.
 */
export async function detectOle2Container(
  stream: RipstreamInputStream,
  /** Which of Tika's two detectors run; a configuration can turn either off. */
  run: { readonly poifs: boolean; readonly misc: boolean } = { poifs: true, misc: true },
): Promise<MediaType | null> {
  const file = await CompoundFile.open(await stream.getFile());
  if (file === null) return null;
  try {
    const topLevelNames = (file.root.children ?? []).map((node) => node.name);
    // MiscOLEDetector on its own answers plain OLE when it finds nothing, as POIFSContainerDetector does.
    if (!run.poifs) return run.misc ? detectMisc(topLevelNames) : null;
    const poifs = detectPoifs(topLevelNames, file.root, await compObjFormat(file));
    return run.misc && poifs.equals(OLE) ? detectMisc(topLevelNames) : poifs;
  } finally {
    await file.close();
  }
}

/**
 * Tika's `POIFSContainerDetector.detect(names, null)`, the names-only form that has no directory to look into: a
 * DRM storage is not searched for and `CompObj` is not read.
 */
export function detectOle2Names(names: Iterable<string>): MediaType {
  return detectPoifs([...names], null, OLE);
}

/**
 * `compObj` is what `processCompObjFormatType` made of the root `CompObj` stream, which Tika reads only on the paths
 * that need it; it is passed in resolved so the rules stay synchronous.
 */
function detectPoifs(names: readonly string[], root: CfbNode | null, compObj: MediaType): MediaType {
  if (names.length === 0) return OLE;
  const upper = new Set(names.map((name) => name.toUpperCase()));

  const encrypted = detectEncrypted(upper, root);
  if (encrypted !== null) return encrypted;

  // POI lists "Workbook", "WORKBOOK" and "BOOK"; Tika compares upper-cased names, so only the last two can match.
  if (upper.has("WORKBOOK") || upper.has("BOOK")) {
    return compObj.equals(MS_GRAPH_CHART) ? MS_GRAPH_CHART : XLS;
  }
  if (upper.has("SWDOCCONTENTMGR") && upper.has("SWDOCMGRTEMPSTORAGE")) return SLDWORKS;
  if (upper.has("STARCALCDOCUMENT")) return SDC;
  if (upper.has("STARWRITERDOCUMENT")) return SDW;
  if (upper.has("STARDRAWDOCUMENT3")) return compObj; // Draw or Impress: only the CompObj stream tells
  if (upper.has("WKSSSWORKBOOK")) return XLR;
  if (upper.has("WORDDOCUMENT")) return DOC;
  if (upper.has("QUILL")) return PUB;
  if (upper.has("POWERPOINT DOCUMENT")) return PPT;
  if (upper.has("VISIODOCUMENT")) return VSD;
  if (upper.has("\u0001OLE10NATIVE")) return OLE10_NATIVE;
  if (upper.has("MATOST")) return WPS; // Works Word Processor 3.0 and 4.0
  if (upper.has("CONTENTS") && upper.has("SPELLING")) return WPS; // newer Works
  if (upper.has("EQUATION NATIVE")) return MS_EQUATION;
  if (upper.has("\u0003OCXNAME")) return OLE; // an ActiveX control: parsed as OLE, not as an embedded object (TIKA-4091)
  if (upper.has("CONTENTS") && upper.has("\u0003OBJINFO")) return COMP_OBJ;
  if (upper.has("CONTENTS") && upper.has(COMP_OBJ_NAME)) {
    // CompObj is a general embedding, but an old Works file stores its application name there.
    return compObj.equals(WPS) ? WPS : COMP_OBJ;
  }
  if (upper.has("CONTENTS")) return OLE; // an embedded non-Office object, most often in a nested storage
  if (upper.has(COMP_OBJ_NAME) && (upper.has("PROPS") || upper.has("PROPS9") || upper.has("PROPS12"))) {
    // Project: look for its numbered data stream. No match ends the decision, it does not fall through.
    for (const name of upper) {
      if (MPP_DATA_NAME.test(name)) return MPP;
    }
    return OLE;
  }
  if (upper.has("LAYER")) return ESRI_LAYER;
  if (upper.has("DGN~MF") && upper.has("DGN~S") && upper.has("DGN~H")) return DGN_8;
  for (const name of upper) {
    if (name.startsWith("__SUBSTG1.0_")) return MSG;
  }
  return OLE;
}

/** Tika's `checkEncrypted`: password-protected OOXML and DRM-protected OLE2, decided before any other rule. */
function detectEncrypted(upper: ReadonlySet<string>, root: CfbNode | null): MediaType | null {
  if (upper.has("\u0006DATASPACES") && findRecursively(root, "\tDRMDATASPACE", 0)) return DRM_ENCRYPTED;
  if (upper.has("ENCRYPTEDPACKAGE")) {
    // Without decrypting the package the OOXML flavour is unknown; the name hint settles it later.
    if (upper.has("ENCRYPTIONINFO")) return OOXML_PROTECTED;
    if (upper.has("\u0006DATASPACES") && findRecursively(root, "DRMENCRYPTEDDATASPACE", 0)) return DRM_ENCRYPTED;
  }
  return null;
}

function findRecursively(node: CfbNode | null, upperTarget: string, depth: number): boolean {
  if (node === null) return false;
  if (node.name.toUpperCase() === upperTarget) return true;
  if (depth >= MAX_SEARCH_DEPTH || node.children === null) return false;
  return node.children.some((child) => findRecursively(child, upperTarget, depth + 1));
}

/**
 * Tika's `processCompObjFormatType`: some formats store only an application name in the root `CompObj` stream. The
 * checks run in Tika's order, and anything unreadable is plain OLE.
 */
async function compObjFormat(file: CompoundFile | null): Promise<MediaType> {
  if (file === null) return OLE;
  const entry = file.root.children?.find((node) => node.name.toUpperCase() === COMP_OBJ_NAME);
  if (entry === undefined || entry.children !== null) return OLE;
  // Tika tests the names in this order over the whole stream, so which one occurs matters, not where.
  const found = await file.findInStream(entry, [MS_GRAPH_CHART_BYTES, STAR_DRAW_BYTES, STAR_IMPRESS_BYTES, WORKS_QUILL96_BYTES]);
  if (found === null) return OLE;

  if (found[0]) return MS_GRAPH_CHART;
  if (found[1]) return SDA;
  if (found[2]) return SDD;
  if (found[3]) return WPS;
  return OLE;
}

/** Tika's `MiscOLEDetector`, on the exact (not upper-cased) top-level names. */
function detectMisc(names: readonly string[]): MediaType {
  const exact = new Set(names);
  if (exact.has("\u0005HwpSummaryInformation")) return HWP; // Hangul Word Processor 5 and later
  if (exact.has("PerfectOffice_MAIN")) {
    if (exact.has("SlideShow")) return COREL_PRESENTATIONS;
    if (exact.has("PerfectOffice_OBJECTS")) return QUATTRO_PRO_7_8;
    return OLE;
  }
  if (exact.has("NativeContent_MAIN")) return QUATTRO_PRO_9;
  return OLE;
}

function ascii(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

function literal(value: string): MediaType {
  return MediaType.parse(value)!;
}
