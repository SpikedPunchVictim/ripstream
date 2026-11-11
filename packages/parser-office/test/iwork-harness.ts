import {
  CONTEXT_KEYS,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  TIKA_KEYS,
  createOutputHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";

/*
 * Shared by the iWork package tests: a ZIP built from named entries, and a run of a parser over it with an embedded
 * document extractor that records what it is handed, so a test can say which entries a parser emitted and as what.
 */

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

export interface Seen {
  readonly name: string;
  readonly metadata: Metadata;
  readonly bytes: Uint8Array;
}

/** An embedded-document extractor that records what it is handed, and fails for the names it is told to. */
export class Recorder implements EmbeddedDocumentExtractor {
  readonly seen: Seen[] = [];
  readonly #failures: ReadonlyMap<string, Error>;

  constructor(failures: ReadonlyMap<string, Error> = new Map()) {
    this.#failures = failures;
  }

  shouldParseEmbedded(): boolean {
    return true;
  }

  async parseEmbedded(stream: RipstreamInputStream, _handler: ContentHandler, metadata: Metadata): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const name = metadata.get(TIKA_KEYS.RESOURCE_NAME) ?? "";
    this.seen.push({ name, metadata, bytes: Uint8Array.from(chunks.flatMap((chunk) => [...chunk])) });
    const failure = this.#failures.get(name);
    if (failure !== undefined) throw failure;
  }
}

export function archive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) files[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(files);
}

export interface Run {
  readonly metadata: Metadata;
  readonly recorder: Recorder;
  readonly xml: string;
}

export interface RunOptions {
  /** The file name the caller gives, as the resource name. */
  readonly name?: string;
  readonly failures?: ReadonlyMap<string, Error>;
  readonly context?: ParseContext;
}

export async function runPackage(parser: Parser, data: Uint8Array, options: RunOptions = {}): Promise<Run> {
  const context = options.context ?? new ParseContext();
  const recorder = new Recorder(options.failures);
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, recorder);
  const stream = await RipstreamInputStream.from(data);
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  if (options.name !== undefined) metadata.set(TIKA_KEYS.RESOURCE_NAME, options.name);
  try {
    await parser.parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, recorder, xml: handler.toString() };
}
