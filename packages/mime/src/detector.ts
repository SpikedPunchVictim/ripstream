import {
  MediaType,
  Metadata,
  RipstreamConfigError,
  type ComponentEntry,
  type Detector,
  type MediaTypeRegistry,
  type ParseContext,
  type RipstreamConfig,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { parseCustomMimeTypes, readCustomMimeTypesFile } from "./custom-mimetypes.ts";
import { MagicDetector } from "./magic.ts";
import {
  MimeTypes,
  filenameFromContentDisposition,
  type CustomMimeType,
  type MimeTypesOptions,
} from "./mime-types.ts";
import { detectEncoding } from "./text-encoding.ts";
import { extractXmlRoot } from "./xml-root.ts";
import { detectZipContainer } from "./containers/zip.ts";
import { detectOle2Container } from "./containers/ole2.ts";
import { detectBplist } from "./containers/bplist.ts";
import { detectCompressor } from "./containers/compressor.ts";
import { detectUnixDump } from "./containers/dump.ts";
import { detectGzipSpecialization } from "./containers/gzip.ts";
import { detectMatroska } from "./containers/matroska.ts";
import { detectOgg } from "./containers/ogg.ts";

export interface DefaultDetectorOptions extends MimeTypesOptions {
  /**
   * The text of a `custom-mimetypes.xml` (Tika's freedesktop mime-info shape): media types, globs, aliases, root
   * elements and magic added to Tika's registry, for names, magic and alias resolution alike. A definition ripstream
   * cannot apply is a `RipstreamConfigError`. It takes the place of the file the `config`'s `custom-mimetypes` names.
   */
  readonly customMimeTypes?: string;
  readonly magic?: MagicDetector;
  readonly trustContentTypeHeader?: boolean;
  readonly prefixLength?: number;
  /** A loaded configuration. Its `detectors` section chooses which of Tika's detectors run (tikajs-68os.8.6). */
  readonly config?: RipstreamConfig;
}

const TEXT_BASED_MESSAGE = MediaType.parse("text/x-tika-text-based-message") as MediaType;
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const BPLIST_SIGNATURE = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74];

/** The custom definitions of the options: the text given, else the file the configuration names, else none. */
function customDefinitions(options: DefaultDetectorOptions): readonly CustomMimeType[] {
  if (options.customMimeTypes !== undefined) return parseCustomMimeTypes(options.customMimeTypes, "custom-mimetypes");
  const path = options.config?.customMimeTypes ?? null;
  return path === null ? [] : parseCustomMimeTypes(readCustomMimeTypesFile(path), path);
}

/** What a stage is given: the stream (null when there is none) and the sniffing prefix of it. */
interface StageInput {
  readonly stream: RipstreamInputStream | null;
  readonly prefix: Uint8Array;
}

/**
 * One step of detection, and the Tika detectors it stands for. A Tika detector may be several steps (the ZIP container
 * detector is the ZIP check, the empty-ZIP signature and the compressor signatures) and one step may be two Tika
 * detectors (both OLE2 detectors read the same compound file), so `run` is told which of its names are on.
 */
interface Stage {
  readonly names: readonly string[];
  readonly run: (input: StageInput, on: ReadonlySet<string>) => Promise<MediaType | null> | MediaType | null;
}

const ZIP_CONTAINER = "default-zip-container-detector";
const POIFS_CONTAINER = "poifs-container-detector";
const MISC_OLE = "misc-ole-detector";
/** Tika's name for the name, magic and XML root detector (`MimeTypes`), which ripstream runs after the stages. */
const MIME_TYPES_NAME = "mime-types";
/** Tika's detector that never answers. Naming it adds nothing; it is accepted because it is a real name. */
const NO_OP_NAME = "no-op-detector";

/**
 * Tika's CompositeDetector: container detectors run first, the name/magic detector (`mime-types`) last, and a later
 * answer replaces the running one only when it is a specialization of it. The order is the order the default detector
 * runs them in: warc+gz is not a specialization of gzip, so the gzip detector must answer before the compressor check.
 */
const STAGES: readonly Stage[] = [
  { names: [ZIP_CONTAINER], run: ({ stream, prefix }) => (stream !== null && startsWith(prefix, ZIP_SIGNATURE) ? detectZipContainer(stream) : null) },
  { names: [ZIP_CONTAINER], run: ({ stream, prefix }) => (stream !== null && startsWith(prefix, ZIP_EMPTY_SIGNATURE) ? MediaType.APPLICATION_ZIP : null) },
  {
    names: [POIFS_CONTAINER, MISC_OLE],
    run: ({ stream, prefix }, on) =>
      stream !== null && startsWith(prefix, OLE2_SIGNATURE)
        ? detectOle2Container(stream, { poifs: on.has(POIFS_CONTAINER), misc: on.has(MISC_OLE) })
        : null,
  },
  { names: ["bp-list-detector"], run: ({ stream, prefix }) => (stream !== null && startsWith(prefix, BPLIST_SIGNATURE) ? detectBplist(stream) : null) },
  { names: ["gzip-specialization-detector"], run: ({ prefix }) => detectGzipSpecialization(prefix) },
  // DefaultZipContainerDetector names an archive type before it tries the compressor signatures.
  { names: [ZIP_CONTAINER], run: ({ prefix }) => detectUnixDump(prefix) },
  { names: [ZIP_CONTAINER], run: ({ prefix }) => detectCompressor(prefix) },
  { names: ["matroska-detector"], run: ({ prefix }) => detectMatroska(prefix) },
  { names: ["ogg-detector"], run: ({ prefix }) => detectOgg(prefix) },
];

/** Every Tika detector name ripstream can run, in a `detectors` section. */
const IMPLEMENTED_NAMES: ReadonlySet<string> = new Set([...STAGES.flatMap((stage) => stage.names), MIME_TYPES_NAME, NO_OP_NAME]);
/** What `default-detector` is: every stage and `mime-types`. */
const DEFAULT_NAMES: ReadonlySet<string> = new Set([...STAGES.flatMap((stage) => stage.names), MIME_TYPES_NAME]);

/** One Tika detector, or the default set: the steps that run for it, decided once. */
interface Component {
  readonly steps: readonly { readonly stage: Stage; readonly on: ReadonlySet<string> }[];
  readonly mimeTypes: boolean;
}

function compile(enabled: ReadonlySet<string>): Component {
  return {
    steps: STAGES.flatMap((stage) => {
      const on = new Set(stage.names.filter((name) => enabled.has(name)));
      return on.size === 0 ? [] : [{ stage, on }];
    }),
    mimeTypes: enabled.has(MIME_TYPES_NAME),
  };
}

/**
 * A `detectors` section (AbstractSpiComponentLoader and DetectorLoader, tika-serialization 4.2.0) as the detectors
 * that run, in order. `default-detector` is every detector Tika loads by default, less its `exclude` list and less
 * the ones also listed by name (those run where they are listed); a named entry is exactly that detector; with no
 * marker only the named entries run, so leaving out `mime-types` leaves out name and magic detection.
 */
function componentsOf(entries: readonly ComponentEntry[]): readonly Component[] {
  const issues: string[] = [];
  const listed = entries.filter((entry) => !entry.marker);
  for (const entry of listed) {
    if (!IMPLEMENTED_NAMES.has(entry.name)) {
      issues.push(
        `detector "${entry.name}" is not implemented: ripstream has no counterpart for it (implemented: ${[...IMPLEMENTED_NAMES].join(", ")})`,
      );
    }
  }
  const marker = entries.find((entry) => entry.marker);
  if (marker?.exclude.includes(MIME_TYPES_NAME)) {
    // Tika's default detector runs MimeTypes itself, outside the list that `exclude` filters, so excluding it does nothing.
    issues.push(`default-detector: "${MIME_TYPES_NAME}" cannot be excluded: the default detector always runs it`);
  }
  if (issues.length > 0) throw new RipstreamConfigError(issues);

  return entries.map((entry) => {
    if (!entry.marker) return compile(new Set([entry.name]));
    const left = new Set([...entry.exclude, ...listed.map((other) => other.name)]);
    left.delete(MIME_TYPES_NAME);
    return compile(new Set([...DEFAULT_NAMES].filter((name) => !left.has(name))));
  });
}

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
  /** The detectors that run, in order. One component, the default set, unless a `detectors` section says otherwise. */
  private readonly components: readonly Component[];

  constructor(options: DefaultDetectorOptions = {}) {
    this.mimeTypes = new MimeTypes({
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      custom: [...(options.custom ?? []), ...customDefinitions(options)],
    });
    // The magic a custom definition adds is in the merged entries, not in Tika's.
    this.magic = options.magic ?? new MagicDetector(this.mimeTypes.getEntries());
    this.trustContentTypeHeader = options.trustContentTypeHeader ?? false;
    this.prefixLength = options.prefixLength ?? 64 * 1024;
    const section = options.config?.detectors ?? null;
    this.components = section === null || section.length === 0 ? [compile(DEFAULT_NAMES)] : componentsOf(section);
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

    const input: StageInput = { stream, prefix };
    // Each detector answers in turn, and an answer replaces the running one only when it specializes it.
    const registry = this.getMediaTypeRegistry();
    let detected = MediaType.OCTET_STREAM;
    for (const component of this.components) {
      const answer = await this.run(component, input, byName);
      if (registry.isSpecializationOf(answer, detected)) detected = answer;
    }
    return detected;
  }

  /** One component: its stages in order, then name and magic, merged the same way. */
  private async run(component: Component, input: StageInput, byName: MediaType | null): Promise<MediaType> {
    const registry = this.getMediaTypeRegistry();
    let detected = MediaType.OCTET_STREAM;
    const consider = (candidate: MediaType | null): void => {
      if (candidate !== null && registry.isSpecializationOf(candidate, detected)) detected = candidate;
    };
    for (const { stage, on } of component.steps) consider(await stage.run(input, on));
    if (component.mimeTypes) consider(this.detectByMagicAndName(input.prefix, byName));
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
    metadata.get("tk:resource-name") ??
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
