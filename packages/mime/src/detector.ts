import {
  MediaType,
  Metadata,
  type Detector,
  type MediaTypeRegistry,
  type ParseContext,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { MagicDetector } from "./magic.ts";
import {
  MimeTypes,
  filenameFromContentDisposition,
  type MimeTypesOptions,
} from "./mime-types.ts";
import { detectEncoding } from "./text-encoding.ts";
import { extractXmlRoot } from "./xml-root.ts";
import { detectZipContainer } from "./containers/zip.ts";
import { detectOle2Container } from "./containers/ole2.ts";
import { detectBplist } from "./containers/bplist.ts";
import { detectCompressor } from "./containers/compressor.ts";
import { detectGzipSpecialization } from "./containers/gzip.ts";
import { detectMatroska } from "./containers/matroska.ts";
import { detectOgg } from "./containers/ogg.ts";

export interface DefaultDetectorOptions extends MimeTypesOptions {
  readonly magic?: MagicDetector;
  readonly trustContentTypeHeader?: boolean;
  readonly prefixLength?: number;
}

const TEXT_BASED_MESSAGE = MediaType.parse("text/x-tika-text-based-message") as MediaType;
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const BPLIST_SIGNATURE = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74];

/**
 * Port of Ripstream's DefaultDetector ordering: name hint, container sniffing,
 * magic, XML root refinement, then text detection. Container bytes are only
 * drained when the signature says ZIP or OLE2.
 */
export class DefaultDetector implements Detector {
  private readonly mimeTypes: MimeTypes;
  private readonly magic: MagicDetector;
  private readonly trustContentTypeHeader: boolean;
  private readonly prefixLength: number;

  constructor(options: DefaultDetectorOptions = {}) {
    this.mimeTypes = new MimeTypes(options);
    this.magic = options.magic ?? new MagicDetector(options.registry);
    this.trustContentTypeHeader = options.trustContentTypeHeader ?? false;
    this.prefixLength = options.prefixLength ?? 64 * 1024;
  }

  /** The registry this detector resolves aliases and supertypes with. */
  getMediaTypeRegistry(): MediaTypeRegistry {
    return this.mimeTypes.getMediaTypeRegistry();
  }

  async detect(
    stream: RipstreamInputStream | null,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<MediaType> {
    const name = resourceName(metadata);
    const byName = name === null ? null : this.mimeTypes.forName(name);

    if (this.trustContentTypeHeader) {
      const header = metadata.get("Content-Type");
      if (header !== null) {
        const hinted = MediaType.parse(header);
        if (hinted !== null) return this.mimeTypes.normalize(hinted) ?? hinted;
      }
    }

    const prefix =
      stream === null
        ? new Uint8Array()
        : await stream.peek(this.prefixLength);

    // Tika's CompositeDetector: container detectors run first, the name/magic detector last, and a later answer
    // replaces the running one only when it is a specialization of it.
    const registry = this.getMediaTypeRegistry();
    let detected = MediaType.OCTET_STREAM;
    const consider = (candidate: MediaType | null): void => {
      if (candidate !== null && registry.isSpecializationOf(candidate, detected)) detected = candidate;
    };

    if (stream !== null && startsWith(prefix, ZIP_SIGNATURE)) {
      consider(await detectZipContainer(stream));
    }
    if (stream !== null && startsWith(prefix, ZIP_EMPTY_SIGNATURE)) {
      consider(MediaType.APPLICATION_ZIP);
    }
    if (stream !== null && startsWith(prefix, OLE2_SIGNATURE)) {
      consider(await detectOle2Container(stream));
    }
    if (stream !== null && startsWith(prefix, BPLIST_SIGNATURE)) {
      consider(await detectBplist(stream));
    }
    // warc+gz is not a specialization of gzip, so the gzip detector must answer first.
    consider(detectGzipSpecialization(prefix));
    consider(detectCompressor(prefix));
    consider(detectMatroska(prefix));
    consider(detectOgg(prefix));
    consider(this.detectByMagicAndName(prefix, byName));
    return detected;
  }

  /** Tika's MimeTypes detector: magic (or XML root, or text) refined by the name hint. */
  private detectByMagicAndName(prefix: Uint8Array, byName: MediaType | null): MediaType {
    const registry = this.getMediaTypeRegistry();
    const magic = this.magic.detect(prefix).map((type) => this.refineByXmlRoot(prefix, type));
    const first = magic[0] ?? null;
    if (first !== null) return applyHint(registry, magic, byName)[0] ?? first;

    // No magic: Tika sniffs for text, and the name hint can only specialise that (a `.csv` of text is CSV, a `.docx`
    // of text is plain text; anything specialises octet-stream, so a name settles binary content).
    const sniffed =
      prefix.length === 0 || detectEncoding(prefix).binary ? MediaType.OCTET_STREAM : MediaType.TEXT_PLAIN;
    return applyHint(registry, [sniffed], byName)[0] ?? sniffed;
  }

  /**
   * Tika's `MimeTypes.getMimeType(byte[])`: a generic XML or HTML magic hit becomes the type its root element names (an
   * XHTML page matches both `application/xhtml+xml` and `text/html`, and both become XHTML). Generic XML that is not
   * well formed is HTML when an HTML magic rule matches, plain text otherwise.
   */
  private refineByXmlRoot(prefix: Uint8Array, matched: MediaType): MediaType {
    if (!matched.equals(MediaType.APPLICATION_XML) && !matched.equals(MediaType.TEXT_HTML)) return matched;
    const root = extractXmlRoot(prefix);
    if (root !== null) return this.mimeTypes.forRootXML(root.localName, root.namespaceURI) ?? matched;
    if (!matched.equals(MediaType.APPLICATION_XML)) return matched;
    return this.magic.matches(prefix, MediaType.TEXT_HTML) ? MediaType.TEXT_HTML : MediaType.TEXT_PLAIN;
  }
}

/**
 * Tika's `MimeTypes.applyHint`: the name hint wins when it is one of the magic types or a specialization of any of
 * them (a zip named `.docx` is a docx); otherwise the magic types stand. The exception is a message type: prose named
 * `.emlx` is not mail, so `text/plain` is not specialised into a text-based message (prose named `.java` still is java).
 */
function applyHint(
  registry: MediaTypeRegistry,
  possible: readonly MediaType[],
  hint: MediaType | null,
): readonly MediaType[] {
  if (hint === null) return possible;
  for (const type of possible) {
    if (hint.equals(type)) return [hint];
    if (
      registry.isSpecializationOf(hint, type) &&
      !(type.equals(MediaType.TEXT_PLAIN) && registry.isSpecializationOf(hint, TEXT_BASED_MESSAGE))
    ) {
      return [hint];
    }
  }
  return possible;
}

function resourceName(metadata: Metadata): string | null {
  const explicit =
    metadata.get("resourceName") ??
    metadata.get("X-TIKA:resourceName") ??
    metadata.get("Content-Disposition");
  if (explicit === null) return null;

  if (explicit.toLowerCase().includes("filename")) {
    const filename = filenameFromContentDisposition(explicit);
    return filename === null ? null : basename(filename);
  }
  return basename(explicit);
}

function basename(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return slash === -1 ? name : name.slice(slash + 1);
}

function startsWith(data: Uint8Array, signature: readonly number[]): boolean {
  if (data.length < signature.length) return false;
  return signature.every((byte, index) => data[index] === byte);
}
