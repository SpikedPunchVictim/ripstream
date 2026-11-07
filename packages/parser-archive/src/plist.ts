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
import { parseBuffer } from "bplist-parser";
import { SaxesParser } from "saxes";
import { readAll } from "./util.ts";

/** Apple property list parser for XML and binary plists. */
export class PlistParser implements Parser {
  readonly name = "PListParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/x-plist", "application/x-bplist", "application/x-itunes-bplist"].map(
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
    const data = await readAll(stream);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    if (startsWith(data, "bplist")) {
      try {
        const [parsed] = parseBuffer(Buffer.from(data));
        await xhtml.element("p", JSON.stringify(parsed));
      } catch (error) {
        throw new MalformedDocumentError("Invalid binary plist", { cause: error });
      }
    } else {
      const lines = xmlPlistLines(new TextDecoder("utf-8", { fatal: false }).decode(data));
      for (const line of lines) await xhtml.element("p", line);
    }

    await xhtml.endDocument();
  }
}

const VALUE_TAGS = new Set([
  "key",
  "string",
  "integer",
  "real",
  "date",
  "data",
]);

function xmlPlistLines(xml: string): string[] {
  const lines: string[] = [];
  let collecting = false;
  let current = "";
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    const name = tag.name.toLowerCase();
    if (VALUE_TAGS.has(name)) {
      collecting = true;
      current = "";
    } else if (name === "true" || name === "false") {
      lines.push(`${name}`);
    }
  });
  parser.on("text", (text) => {
    if (collecting) current += text;
  });
  parser.on("closetag", (tag) => {
    const name = tag.name.toLowerCase();
    if (VALUE_TAGS.has(name) && collecting) {
      const value = current.trim();
      if (value.length > 0) lines.push(value);
      collecting = false;
      current = "";
    }
  });
  parser.write(xml).close();
  return lines;
}

function startsWith(data: Uint8Array, prefix: string): boolean {
  const bytes = new TextEncoder().encode(prefix);
  if (data.length < bytes.length) return false;
  return bytes.every((byte, index) => data[index] === byte);
}
