import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { parseEntry, readAll, withXhtml } from "./util.ts";

const SECTOR = 2048;
const MAX_ENTRIES = 10_000;

interface IsoEntry {
  readonly name: string;
  readonly extent: number;
  readonly size: number;
  readonly directory: boolean;
}

/** ISO 9660 image parser: walks the directory tree and parses files. */
export class Iso9660Parser implements Parser {
  readonly name = "ISO9660Parser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/x-iso9660-image")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    if (data.length < 17 * SECTOR + 6) {
      throw new MalformedDocumentError("Truncated ISO image");
    }
    const pvd = 16 * SECTOR;
    if (String.fromCharCode(...data.subarray(pvd + 1, pvd + 6)) !== "CD001") {
      throw new MalformedDocumentError("Not an ISO 9660 image");
    }
    const rootRecord = pvd + 156;
    if (data[rootRecord] === undefined) throw new MalformedDocumentError("Missing root directory");
    const root = parseRecord(data, rootRecord);
    if (root === null) throw new MalformedDocumentError("Invalid root directory");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    await withXhtml(handler, metadata, async (xhtml) => {
      const visited = new Set<number>();
      let count = 0;
      const walk = async (
        entry: IsoEntry,
        prefix: string,
        depth: number,
      ): Promise<void> => {
        if (depth > ctx.limits.maxNodeDepth) {
          throw new LimitExceededError(
            `ISO directory depth ${depth} exceeds ${ctx.limits.maxNodeDepth}`,
          );
        }
        if (visited.has(entry.extent) || count >= MAX_ENTRIES) return;
        visited.add(entry.extent);
        const start = entry.extent * SECTOR;
        const end = Math.min(start + entry.size, data.length);
        let position = start;
        while (position < end && count < MAX_ENTRIES) {
          const length = data[position]!;
          if (length === 0) {
            position = (Math.floor(position / SECTOR) + 1) * SECTOR;
            continue;
          }
          const child = parseRecord(data, position);
          if (child === null) break;
          position += length;
          if (child.name === "." || child.name === "..") continue;
          count++;
          const path = `${prefix}/${child.name}`;
          if (child.directory) {
            await walk(child, path, depth + 1);
            continue;
          }
          await xhtml.startElement("div", "class", "iso-entry");
          await xhtml.element("h1", path);
          const fileStart = child.extent * SECTOR;
          const fileEnd = Math.min(fileStart + child.size, data.length);
          if (fileEnd > fileStart) {
            await parseEntry(
              xhtml,
              child.name,
              data.subarray(fileStart, fileEnd),
              metadata,
              ctx,
            );
          }
          await xhtml.endElement("div");
        }
      };
      await walk(root, "", 0);
      metadata.set("iso:entry-count", String(count));
    });
    void view;
  }
}

function parseRecord(data: Uint8Array, offset: number): IsoEntry | null {
  const length = data[offset]!;
  if (length < 34 || offset + length > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const extent = view.getUint32(offset + 2, true);
  const size = view.getUint32(offset + 10, true);
  const flags = data[offset + 25]!;
  const nameLength = data[offset + 32]!;
  const name = new TextDecoder("latin1")
    .decode(data.subarray(offset + 33, offset + 33 + nameLength))
    .replace(/;\d+$/, "")
    .trim();
  return {
    name,
    extent,
    size,
    directory: (flags & 0x02) !== 0,
  };
}
