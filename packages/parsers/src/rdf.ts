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
import { Parser as N3Parser } from "n3";

const FORMATS: Record<string, string> = {
  "text/turtle": "text/turtle",
  "application/x-turtle": "text/turtle",
  "application/n-triples": "application/n-triples",
  "application/n-quads": "application/n-quads",
  "application/trig": "application/trig",
  "text/n3": "text/n3",
};

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
    const parser = new N3Parser({ format });
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
