import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { parseEntry, readAll, withXhtml } from "./util.ts";

/** CPIO newc/odc archive parser. */
export class CpioParser implements Parser {
  readonly name = "CpioParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/x-cpio", "application/x-bcpio", "application/x-sv4cpio"].map(
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
    const data = await readAll(stream);
    const text = new TextDecoder("latin1").decode(data.subarray(0, 6));
    if (!["070701", "070702"].includes(text)) {
      throw new MalformedDocumentError("Not a newc CPIO archive");
    }
    await withXhtml(handler, metadata, async (xhtml) => {
      let position = 0;
      for (let count = 0; count < ctx.limits.maxZipEntries && position + 110 <= data.length; count++) {
        const header = new TextDecoder("latin1").decode(data.subarray(position, position + 110));
        if (!["070701", "070702"].includes(header.slice(0, 6))) break;
        const field = (index: number): number => Number.parseInt(header.slice(6 + index * 8, 14 + index * 8), 16);
        const size = field(6);
        const nameSize = field(11);
        const nameStart = position + 110;
        const name = new TextDecoder("latin1")
          .decode(data.subarray(nameStart, nameStart + Math.max(0, nameSize - 1)))
          .trim();
        const dataStart = align4(nameStart + nameSize);
        if (name === "TRAILER!!!") break;
        const content = data.subarray(dataStart, Math.min(dataStart + size, data.length));
        if (name.length > 0) {
          await xhtml.startElement("div", "class", "package-entry");
          await xhtml.element("h1", name);
          await parseEntry(xhtml, name, content, metadata, ctx);
          await xhtml.endElement("div");
        }
        position = align4(dataStart + size);
      }
    });
  }
}

/** Unix ar archive parser. */
export class ArParser implements Parser {
  readonly name = "ArParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/x-archive")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    if (new TextDecoder("latin1").decode(data.subarray(0, 8)) !== "!<arch>\n") {
      throw new MalformedDocumentError("Not an ar archive");
    }
    await withXhtml(handler, metadata, async (xhtml) => {
      let position = 8;
      for (let count = 0; count < ctx.limits.maxZipEntries && position + 60 <= data.length; count++) {
        const header = new TextDecoder("latin1").decode(data.subarray(position, position + 60));
        const name = header.slice(0, 16).trim().replace(/\/$/, "");
        const size = Number.parseInt(header.slice(48, 58).trim(), 10);
        if (!Number.isFinite(size) || size < 0) break;
        const start = position + 60;
        if (start + size > data.length) break;
        if (name.length > 0 && name !== "/") {
          await xhtml.startElement("div", "class", "package-entry");
          await xhtml.element("h1", name);
          await parseEntry(xhtml, name, data.subarray(start, start + size), metadata, ctx);
          await xhtml.endElement("div");
        }
        const next = start + size + (size % 2);
        if (next <= position) break; // require strictly monotonic advance
        position = next;
      }
    });
  }
}

function align4(value: number): number {
  return value + ((4 - (value % 4)) % 4);
}
