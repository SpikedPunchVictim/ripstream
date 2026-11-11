import {
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import { CompoundFile, hasSignature } from "./cfb.ts";
import { applyPropertySetMetadata, parsePropertySets } from "./property-sets.ts";

const GENERIC = "application/x-tika-msoffice";
const EMBEDDED = "application/x-tika-msoffice-embedded";
const DRM_ENCRYPTED = "application/x-tika-ole-drm-encrypted";
const OOXML_PROTECTED = "application/x-tika-ooxml-protected";
const SOLIDWORKS = "application/sldworks";

// OfficeParser.SUPPORTED_TYPES, the members no other parser here claims. The embedded type carries the format parameter
// Tika names it with; a composite parser matches on the base type, so the comp_obj container reaches this parser as it
// reaches OfficeParser.
const TYPES = [GENERIC, `${EMBEDDED}; format=ole10_native`, DRM_ENCRYPTED, OOXML_PROTECTED, SOLIDWORKS];

const SUMMARY_STREAMS = ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"];

/**
 * The part of Tika's OfficeParser that handles the OLE2 containers no format parser here reads: the generic container
 * (application/x-tika-msoffice), the embedded-object containers (x-tika-msoffice-embedded, Ole10Native and CompObj), the
 * SolidWorks files, and the two encrypted kinds.
 *
 * OfficeParser puts the SummaryInformation and DocumentSummaryInformation streams in the metadata first, then switches on
 * the type: for all of these but the encrypted ones it writes no text; the DRM type throws EncryptedDocumentException; and
 * the ooxml-protected type opens the package with the default password (or the PasswordProvider's) and hands it to the
 * OOXML parser. This one refuses that last type as encrypted, since the package cannot be decrypted here.
 */
export class OleContainerParser implements Parser {
  readonly name = "OfficeParser";
  readonly capabilities = { requiresRandomAccess: true, metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(TYPES.map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    if (!hasSignature(data)) throw new MalformedDocumentError("Not an OLE2 compound file");
    const compound = CompoundFile.parse(data);
    applySummaries(compound, metadata);
    const refusal = encryptionRefusal(compound, baseTypeOf(metadata));
    if (refusal !== undefined) throw new EncryptedDocumentError(refusal);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.endDocument();
  }
}

function baseTypeOf(metadata: Metadata): string {
  return MediaType.parse(metadata.get("Content-Type"))?.getBaseType().toString() ?? "";
}

/**
 * The summary streams, as `SummaryExtractor.parseSummaries` reads them. A stream that is not a property set is left out of
 * the metadata and the container is still read (Tika ignores NoPropertySetStreamException); a limit or abort is not.
 */
function applySummaries(compound: CompoundFile, metadata: Metadata): void {
  for (const name of SUMMARY_STREAMS) {
    if (!compound.has(name)) continue;
    try {
      applyPropertySetMetadata(metadata, parsePropertySets(compound.read(name)));
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
    }
  }
}

/** Why the container cannot be read, where OfficeParser throws EncryptedDocumentException; undefined when it can. */
function encryptionRefusal(compound: CompoundFile, baseType: string): string | undefined {
  if (baseType === DRM_ENCRYPTED) return "DRM encrypted document is not supported";
  if (baseType === OOXML_PROTECTED) {
    return "Password-protected OOXML package: decrypting it with the default password or a supplied one is not supported";
  }
  if (compound.has("EncryptedPackage")) return "OLE2 file with an unrecognized EncryptedPackage entry";
  return undefined;
}
