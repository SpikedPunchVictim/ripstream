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
import { parseEntry } from "@spikedpunch/ripstream-parser-archive";
import { SaxesParser } from "saxes";

/** WARC/ARC record reader with embedded payload parsing. */
export class WarcParser implements Parser {
  readonly name = "WARCParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/warc", "application/warc+zip"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const data = concat(chunks);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    let offset = 0;
    while (offset < data.length) {
      const headerEnd = indexOfDoubleCrlf(data, offset);
      if (headerEnd === -1) break;
      const header = new TextDecoder("latin1").decode(
        data.subarray(offset, headerEnd),
      );
      if (!header.startsWith("WARC/") && !header.startsWith("filedesc")) break;

      const fields = parseHeaders(header);
      const length = Number(fields.get("content-length") ?? "0");
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new MalformedDocumentError(
          `Invalid WARC Content-Length: ${fields.get("content-length")}`,
        );
      }
      const payloadStart = headerEnd + 4;
      const payload = data.subarray(payloadStart, payloadStart + length);
      offset = payloadStart + length;

      await xhtml.startElement("div", "class", "warc-record");
      const target = fields.get("warc-target-uri");
      if (target !== undefined) await xhtml.element("h1", target);
      const type = fields.get("warc-type");
      if (type !== undefined) await xhtml.element("p", type);

      const body = httpBody(payload);
      if (body.length > 0) {
        await parseEntry(xhtml, target ?? "payload", body, metadata, ctx);
      }
      await xhtml.endElement("div");
    }

    await xhtml.endDocument();
  }
}

function httpBody(payload: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1").decode(payload.subarray(0, 4096));
  if (!/^HTTP\/\d\.\d/.test(text)) return payload;
  const index = indexOfDoubleCrlf(payload, 0);
  return index === -1 ? payload : payload.subarray(index + 4);
}

function parseHeaders(header: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of header.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return fields;
}

function indexOfDoubleCrlf(data: Uint8Array, from: number): number {
  for (let index = from; index + 3 < data.length; index++) {
    if (
      data[index] === 0x0d &&
      data[index + 1] === 0x0a &&
      data[index + 2] === 0x0d &&
      data[index + 3] === 0x0a
    ) {
      return index;
    }
  }
  return -1;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** XLIFF 1.2/2.0 translation-unit extraction. */
export class XliffParser implements Parser {
  readonly name = "XLIFFParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/xliff+xml", "application/x-xliff+xml"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const xml = await readText(stream);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of xmlSegments(xml, new Set(["trans-unit", "source", "target"]))) {
      await xhtml.element("p", value);
    }
    await xhtml.endDocument();
  }
}

/** TMX translation memory extraction. */
export class TmxParser implements Parser {
  readonly name = "TMXParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/x-tmx", "application/x-tmx+xml"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const xml = await readText(stream);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of xmlSegments(xml, new Set(["seg"]))) {
      await xhtml.element("p", value);
    }
    await xhtml.endDocument();
  }
}

async function readText(stream: RipstreamInputStream): Promise<string> {
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function xmlSegments(xml: string, containers: Set<string>): string[] {
  const values: string[] = [];
  let depth = 0;
  let current = "";
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    const name = local(tag.name);
    if (containers.has(name)) {
      depth++;
      if (depth === 1) current = "";
    }
  });
  parser.on("text", (text) => {
    if (depth > 0) current += text;
  });
  parser.on("closetag", (tag) => {
    const name = local(tag.name);
    if (!containers.has(name)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const value = current.replace(/\s+/g, " ").trim();
      if (value.length > 0) values.push(value);
      current = "";
    }
  });
  parser.write(xml).close();
  return values;
}

function local(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}
