import {
  BodyContentHandler,
  CONTEXT_KEYS,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  XHTMLContentHandler,
  type Parser,
} from "@spikedpunch/ripstream-core";

/** What the embedded-document parser saw: the entry's bytes and its resource name. */
export interface Captured {
  readonly bytes: Uint8Array;
  readonly name: string | undefined;
}

/** A parser that records every embedded document it is handed and writes nothing. */
export function capturingParser(captured: Captured[]): Parser {
  return {
    getSupportedTypes: () => new Set(),
    async parse(stream, handler, metadata) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      captured.push({ bytes: Buffer.concat(chunks), name: metadata.get("tk:resource-name") });
      const xhtml = new XHTMLContentHandler(handler, new Metadata());
      await xhtml.startDocument();
      await xhtml.endDocument();
    },
  };
}

/** Limits where the absolute output cap is what trips: the ratio check is switched off. */
export function boundedContext(captured: Captured[] = []): ParseContext {
  const context = new ParseContext({
    limits: { maxEmbeddedResourceBytes: 100_000, maxDecompressionRatio: 1e9 },
  });
  context.set(CONTEXT_KEYS.PARSER, capturingParser(captured));
  return context;
}

export function capturingContext(captured: Captured[]): ParseContext {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, capturingParser(captured));
  return context;
}

/** Runs `parser.parse` over `bytes`, closing the stream whatever happens. */
export async function runParser(
  parser: Parser,
  bytes: Uint8Array,
  context: ParseContext,
  metadata: Metadata = new Metadata(),
): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await parser.parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

export const fromBase64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "base64"));
