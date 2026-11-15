import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { DataFactory, Parser as N3Parser } from "n3";

const FORMATS: Record<string, string> = {
  "text/turtle": "text/turtle",
  "application/x-turtle": "text/turtle",
  "application/n-triples": "application/n-triples",
  "application/n-quads": "application/n-quads",
  "application/trig": "application/trig",
  "text/n3": "text/n3",
};

/**
 * A parser that numbers blank nodes for this parse alone. n3's own numbering is module state: the `b<N>_` prefix of
 * labelled blank nodes counts the parsers created and the `n3-<N>` name of anonymous ones counts every anonymous node
 * made, so the same document would print different labels depending on what the process parsed before, and those
 * labels would tell one document how many blank nodes earlier documents had (tikajs-dasw).
 */
function documentScopedParser(format: string): N3Parser {
  let anonymous = 0;
  // An empty name is anonymous too, as in n3's own factory, which would otherwise number it from its module counter.
  const blankNode = (name?: string) => DataFactory.blankNode(name === undefined || name === "" ? `n3-${anonymous++}` : name);
  const factory = { ...DataFactory, blankNode };
  return new N3Parser({ format, factory, blankNodePrefix: "b0_" });
}

/** RDF parsers backed by n3: Turtle, N-Triples/N-Quads, TriG, N3. */
export class RdfParser implements Parser {
  readonly name = "RDFParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(Object.keys(FORMATS).map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    const mediaType = metadata.get("Content-Type") ?? "text/turtle";
    const format = FORMATS[mediaType] ?? "text/turtle";

    let failure: Error | null = null;
    const lines: string[] = [];
    const parser = documentScopedParser(format);
    try {
      await new Promise<void>((resolve, reject) => {
        parser.parse(
          text,
          (
            error: Error | null,
            quad: {
              subject: { value: string };
              predicate: { value: string };
              object: { value: string };
            } | null,
          ) => {
            if (error !== null) {
              reject(error);
              return;
            }
            if (quad === null) {
              resolve();
              return;
            }
            lines.push(
              `${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`,
            );
          },
        );
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (failure !== null) {
      throw new MalformedDocumentError("Malformed RDF document", {
        cause: failure,
      });
    }

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const line of lines) await xhtml.element("p", line);
    await xhtml.endDocument();
  }
}
