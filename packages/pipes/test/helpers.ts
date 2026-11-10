import { crc32 } from "node:zlib";
import { FileSystemFetcher, FileSystemPipesIterator, type PipesEngineOptions } from "../src/index.ts";

/**
 * The file-system fetcher and iterator over a directory, as an engine takes them. Symbolic links are walked through and
 * read wherever they lead unless a test says otherwise, which is what the shorthand config's followSymlinks does.
 */
export function fileSystem(
  directory: string,
  symlinks: "fetch" | "follow" | "skip" = "follow",
): Pick<PipesEngineOptions, "iterator" | "fetchers"> {
  return {
    iterator: new FileSystemPipesIterator({ basePath: directory, fetcherId: "fs", symlinks }),
    fetchers: { fs: new FileSystemFetcher({ basePath: directory, confineSymlinks: symlinks !== "follow" }) },
  };
}

/** Minimal "stored" (uncompressed) zip writer; fflate is not a dependency of this package. */
export function storedZip(files: Readonly<Record<string, string>>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}
