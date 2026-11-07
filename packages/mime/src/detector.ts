import {
  MediaType,
  Metadata,
  type Detector,
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

export interface DefaultDetectorOptions extends MimeTypesOptions {
  readonly magic?: MagicDetector;
  readonly trustContentTypeHeader?: boolean;
  readonly prefixLength?: number;
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

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

    if (stream !== null && startsWith(prefix, ZIP_SIGNATURE)) {
      const container = await detectZipContainer(stream);
      if (container !== null) return applyHint(container, byName);
    }
    if (stream !== null && startsWith(prefix, ZIP_EMPTY_SIGNATURE)) {
      return applyHint(MediaType.APPLICATION_ZIP, byName);
    }
    if (stream !== null && startsWith(prefix, OLE2_SIGNATURE)) {
      const container = await detectOle2Container(stream);
      if (container !== null) return applyHint(container, byName);
    }

    const magic = this.magic.detect(prefix)[0] ?? null;
    if (magic !== null) {
      if (magic.equals(MediaType.APPLICATION_XML) || magic.equals(MediaType.TEXT_HTML)) {
        const root = extractXmlRoot(prefix);
        if (root !== null) {
          const byRoot = this.mimeTypes.forRootXML(
            root.localName,
            root.namespaceURI,
          );
          if (byRoot !== null) return applyHint(byRoot, byName);
        }
      }
      return applyHint(magic, byName);
    }

    if (byName !== null) return byName;

    if (prefix.length === 0) return MediaType.OCTET_STREAM;

    const encoding = detectEncoding(prefix);
    if (!encoding.binary) return MediaType.TEXT_PLAIN;
    return MediaType.OCTET_STREAM;
  }
}

function applyHint(type: MediaType, hint: MediaType | null): MediaType {
  if (hint === null) return type;
  if (hint.equals(type)) return hint;
  return type;
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
