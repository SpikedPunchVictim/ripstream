import { open, type FileHandle } from "node:fs/promises";
import { Inflate } from "fflate";
import {
  LimitExceededError,
  OutputBudget,
  MalformedDocumentError,
  type ParseLimits,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

interface OpcEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Central-directory OPC reader; decompresses only requested parts. */
export class OpcPackage {
  readonly #handle: FileHandle;
  readonly #entries: ReadonlyMap<string, OpcEntry>;
  readonly #limits: ParseLimits;
  #totalInflated = 0;

  private constructor(
    handle: FileHandle,
    entries: ReadonlyMap<string, OpcEntry>,
    limits: ParseLimits,
  ) {
    this.#handle = handle;
    this.#entries = entries;
    this.#limits = limits;
  }

  static async open(
    stream: RipstreamInputStream,
    limits: ParseLimits,
  ): Promise<OpcPackage> {
    const handle = await open(await stream.getFile(), "r");
    try {
      const entries = await readCentralDirectory(handle, limits);
      return new OpcPackage(handle, entries, limits);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get names(): readonly string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  async read(name: string): Promise<Uint8Array> {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new MalformedDocumentError(`Missing OPC part: ${name}`);
    }
    if (entry.uncompressedSize > this.#limits.maxEmbeddedResourceBytes) {
      throw new LimitExceededError(`OPC part ${name} exceeds the per-entry limit`);
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize >
        this.#limits.maxDecompressionRatio
    ) {
      throw new LimitExceededError(`OPC part ${name} exceeds the ratio limit`);
    }

    const header = new Uint8Array(30);
    await this.#readAt(header, entry.localOffset);
    const view = new DataView(header.buffer);
    if (view.getUint32(0, true) !== LOCAL) {
      throw new MalformedDocumentError(`Invalid local header for ${name}`);
    }
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const { size: fileSize } = await this.#handle.stat();
    if (dataOffset + entry.compressedSize > fileSize) {
      throw new MalformedDocumentError(`OPC part ${name} extends past end of file`);
    }
    const compressed = new Uint8Array(entry.compressedSize);
    await this.#readAt(compressed, dataOffset);

    if (entry.method === 0) return compressed;
    if (entry.method === 8) {
      const inflated = this.#inflate(name, compressed);
      return inflated;
    }
    throw new MalformedDocumentError(`Unsupported ZIP method ${entry.method} for ${name}`);
  }

  /** Streams the inflate so a lying declared size cannot exceed the budgets. */
  #inflate(name: string, compressed: Uint8Array): Uint8Array {
    const entryBudget = new OutputBudget(
      compressed.byteLength,
      {
        maxOutputBytes: this.#limits.maxEmbeddedResourceBytes,
        maxRatio: this.#limits.maxDecompressionRatio,
      },
      `OPC part ${name}`,
    );
    const chunks: Uint8Array[] = [];
    let produced = 0;
    try {
      const inflate = new Inflate((chunk) => {
        entryBudget.add(chunk.byteLength);
        this.#totalInflated += chunk.byteLength;
        if (this.#totalInflated > this.#limits.maxTotalEmbeddedBytes) {
          throw new LimitExceededError("OPC parts exceed the embedded byte limit");
        }
        chunks.push(chunk);
        produced += chunk.byteLength;
      });
      inflate.push(compressed, true);
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      throw new MalformedDocumentError(`Unable to inflate ${name}`, { cause: error });
    }
    const out = new Uint8Array(produced);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }

  async #readAt(target: Uint8Array, position: number): Promise<void> {
    let offset = 0;
    while (offset < target.byteLength) {
      const { bytesRead } = await this.#handle.read(
        target,
        offset,
        target.byteLength - offset,
        position + offset,
      );
      if (bytesRead === 0) {
        throw new MalformedDocumentError("Truncated OPC package");
      }
      offset += bytesRead;
    }
  }
}

async function readCentralDirectory(
  handle: FileHandle,
  limits: ParseLimits,
): Promise<Map<string, OpcEntry>> {
  const { size } = await handle.stat();
  if (size < 22) throw new MalformedDocumentError("Not a ZIP/OPC package");

  const tailLength = Math.min(size, 65_557);
  const tail = new Uint8Array(tailLength);
  await handle.read(tail, 0, tailLength, size - tailLength);
  const tailView = new DataView(tail.buffer);

  let eocd = -1;
  for (let index = tailLength - 22; index >= 0; index--) {
    if (tailView.getUint32(index, true) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new MalformedDocumentError("Missing ZIP end record");

  let entryCount = tailView.getUint16(eocd + 10, true);
  let directorySize = tailView.getUint32(eocd + 12, true);
  let directoryOffset = tailView.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorPosition = size - tailLength + eocd - 20;
    if (locatorPosition < 0) throw new MalformedDocumentError("Missing ZIP64 locator");
    const locator = new Uint8Array(20);
    await handle.read(locator, 0, 20, locatorPosition);
    const locatorView = new DataView(locator.buffer);
    if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR) {
      throw new MalformedDocumentError("Invalid ZIP64 locator");
    }
    const zip64Offset = Number(locatorView.getBigUint64(8, true));
    const record = new Uint8Array(56);
    await handle.read(record, 0, 56, zip64Offset);
    const recordView = new DataView(record.buffer);
    if (recordView.getUint32(0, true) !== ZIP64_EOCD) {
      throw new MalformedDocumentError("Invalid ZIP64 end record");
    }
    entryCount = Number(recordView.getBigUint64(32, true));
    directorySize = Number(recordView.getBigUint64(40, true));
    directoryOffset = Number(recordView.getBigUint64(48, true));
  }

  if (entryCount > limits.maxZipEntries) {
    throw new LimitExceededError(
      `OPC entry count ${entryCount} exceeds ${limits.maxZipEntries}`,
    );
  }
  if (directorySize > limits.maxTotalEmbeddedBytes) {
    throw new LimitExceededError("OPC central directory exceeds the byte limit");
  }

  const directory = new Uint8Array(directorySize);
  await handle.read(directory, 0, directorySize, directoryOffset);
  const view = new DataView(directory.buffer);
  const entries = new Map<string, OpcEntry>();
  let position = 0;
  let total = 0;

  while (position + 46 <= directory.byteLength && entries.size < entryCount) {
    if (view.getUint32(position, true) !== CENTRAL) break;
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    let compressedSize = view.getUint32(position + 20, true);
    let uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    let localOffset = view.getUint32(position + 42, true);
    const nameBytes = directory.subarray(position + 46, position + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    const extra = directory.subarray(
      position + 46 + nameLength,
      position + 46 + nameLength + extraLength,
    );
    ({ compressedSize, uncompressedSize, localOffset } = readZip64Extra(
      extra,
      compressedSize,
      uncompressedSize,
      localOffset,
    ));

    if ((flags & 0x0001) !== 0) {
      throw new MalformedDocumentError("Encrypted ZIP entries are not supported");
    }
    if (name.length > 0) {
      total += uncompressedSize;
      if (total > limits.maxTotalEmbeddedBytes) {
        throw new LimitExceededError("OPC parts exceed the embedded byte limit");
      }
      entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZip64Extra(
  extra: Uint8Array,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
): { compressedSize: number; uncompressedSize: number; localOffset: number } {
  let position = 0;
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  while (position + 4 <= extra.byteLength) {
    const id = view.getUint16(position, true);
    const size = view.getUint16(position + 2, true);
    position += 4;
    if (id === 0x0001) {
      // A block may declare more than the extra field holds: read only what is there.
      const end = Math.min(position + size, extra.byteLength);
      let cursor = position;
      if (uncompressedSize === 0xffffffff && cursor + 8 <= end) {
        uncompressedSize = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (compressedSize === 0xffffffff && cursor + 8 <= end) {
        compressedSize = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (localOffset === 0xffffffff && cursor + 8 <= end) {
        localOffset = Number(view.getBigUint64(cursor, true));
      }
      break;
    }
    position += size;
  }
  return { compressedSize, uncompressedSize, localOffset };
}
