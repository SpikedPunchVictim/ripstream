import {
  LimitExceededError,
  MalformedDocumentError,
  RipstreamError,
  MediaType,
  noteEmbeddedLimit,
  truncatesEmbeddedLimit,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { extract as tarExtract, type ExtractEvents, type Header } from "tar-stream";
import { EntryNames, parseEntry, readAll, renamedEntryNote, withXhtml } from "./util.ts";

/** Port of Ripstream's tar handling from PackageParser. */
export class TarParser implements Parser {
  readonly name = "TarParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/x-tar")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    const extractor = tarExtract();
    // Under `onEmbeddedLimit: "truncate"` an archive with more than `maxZipEntries` entries is read up to that many, in
    // archive order. The rest are walked past (a tar has no index) only to count them and to leave their data unread.
    const truncate = truncatesEmbeddedLimit(ctx);
    let cut = false;

    await withXhtml(handler, metadata, async (xhtml) => {
      let failure: unknown = null;
      let chain = Promise.resolve();
      let entries = 0;
      let total = 0;
      const names = new EntryNames();

      extractor.on("entry", (header, entry, next) => {
        chain = chain.then(async () => {
          // After the first failure, drain the remaining entries untouched.
          if (failure !== null) {
            entry.resume();
            next();
            return;
          }
          try {
            await handleEntry(header, entry);
          } catch (error) {
            failure ??= error;
            entry.resume();
          }
          next();
        });
      });

      const handleEntry = async (
        header: Header,
        entry: ExtractEvents["entry"][1],
      ): Promise<void> => {
        entries++;
        if (entries > ctx.limits.maxZipEntries) {
          if (truncate) {
            cut = true;
            entry.resume();
            return;
          }
          throw new LimitExceededError(
            `Tar entries exceed ${ctx.limits.maxZipEntries}`,
          );
        }
        if (header.type === "symlink" || header.type === "link") {
          entry.resume();
          return;
        }
        const entryName = header.type === "file" ? names.resolve(header.name) : { name: header.name };
        if (entryName.original !== undefined) {
          // A file the archive holds under a path that leaves its root is read under a sanitised name, and the archive says so.
          metadata.add("tk:exception:embedded-stream-exception", renamedEntryNote(entryName));
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of entry as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > ctx.limits.maxEmbeddedResourceBytes) {
            throw new LimitExceededError(
              `Tar entry ${header.name} exceeds the per-entry limit`,
            );
          }
          chunks.push(chunk);
        }
        total += size;
        if (total > ctx.limits.maxTotalEmbeddedBytes) {
          throw new LimitExceededError(
            "Tar archive exceeds the embedded byte limit",
          );
        }
        if (header.type === "file") {
          await xhtml.startElement("div", "class", "package-entry");
          await xhtml.element("h1", entryName.name);
          await parseEntry(
            xhtml,
            entryName.name,
            concat(chunks, size),
            metadata,
            ctx,
            entryName.original,
          );
          await xhtml.endElement("div");
        }
      };

      const noteCut = (): void => {
        if (cut) noteEmbeddedLimit(metadata, { limit: "maxZipEntries", max: ctx.limits.maxZipEntries, seen: entries, read: ctx.limits.maxZipEntries });
      };

      const finished = new Promise<void>((resolve, reject) => {
        extractor.on("finish", resolve);
        extractor.on("error", reject);
      });

      extractor.end(data);
      try {
        await finished;
      } catch (error) {
        // Let the in-flight entry settle so nothing rejects unobserved.
        await chain;
        // #21: a limit/other RipstreamError from an entry keeps its code; a raw
        // tar-stream parse error becomes a 422 MalformedDocumentError, not a 500.
        const reason = failure ?? error;
        // The tail after the entries that were read is not read, so a fault in it is not this parse's to report.
        if (failure === null && cut) return noteCut();
        throw reason instanceof RipstreamError
          ? reason
          : new MalformedDocumentError("Invalid tar archive", { cause: reason });
      }
      await chain;
      if (failure !== null) throw failure;
      noteCut();
    });
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
