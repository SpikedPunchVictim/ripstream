import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** MIDI header metadata (format, track count, division). */
export class MidiParser implements Parser {
  readonly name = "MidiParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["audio/midi", "audio/x-midi"].map((type) => MediaType.parse(type)!),
    );
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
    if (
      data.length < 14 ||
      String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!) !== "MThd"
    ) {
      throw new MalformedDocumentError("Not a MIDI file");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const format = view.getUint16(8);
    const tracks = view.getUint16(10);
    const division = view.getUint16(12);
    metadata.set("audio:track-count", String(tracks));
    metadata.set("midi:format", String(format));
    metadata.set("midi:division", String(division));

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("p", `MIDI format: ${format}`);
    await xhtml.element("p", `Tracks: ${tracks}`);
    await xhtml.element("p", `Division: ${division}`);
    await xhtml.endDocument();
  }
}
