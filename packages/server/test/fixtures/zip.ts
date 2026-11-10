import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";

/** A zip of stored (uncompressed) entries, in the order given: a container with embedded documents. */
export function storedZip(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const value = entries[name] as string | Uint8Array;
    const nameBytes = encoder.encode(name);
    const data = typeof value === "string" ? encoder.encode(value) : value;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, names.length, true);
  end.setUint16(10, names.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

export interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly data: Buffer;
  /** MS-DOS date and time, as the central directory has them. */
  readonly date: number;
  readonly time: number;
}

/**
 * Reads a zip the way a strict reader does, and checks what it reads: the central directory ends where the end record
 * starts, every local header agrees with its entry, every entry inflates to its size and CRC, and an entry with a data
 * descriptor has a correct one right after its data.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "no end-of-central-directory record");
  assert.equal(end + 22, buf.length, "the end record is the last thing in the file");
  const count = buf.readUInt16LE(end + 10);
  assert.equal(buf.readUInt16LE(end + 8), count);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  assert.equal(start + size, end, "the central directory ends where the end record starts");

  const entries: ZipEntry[] = [];
  let at = start;
  let expectedOffset = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, `central header ${index}`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const time = buf.readUInt16LE(at + 12);
    const date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const unpacked = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    assert.equal(offset, expectedOffset, `${name} starts where the previous entry ended`);
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local header of ${name}`);
    assert.equal(buf.readUInt16LE(offset + 6), flags, `${name}: local flags are the central ones`);
    assert.equal(buf.readUInt16LE(offset + 8), method);
    const localName = buf.toString("utf8", offset + 30, offset + 30 + buf.readUInt16LE(offset + 26));
    assert.equal(localName, name);
    const dataStart = offset + 30 + nameLength + buf.readUInt16LE(offset + 28);
    const packedData = buf.subarray(dataStart, dataStart + packed);
    const data = method === 8 ? inflateRawSync(packedData) : Buffer.from(packedData);
    assert.equal(data.length, unpacked, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: crc`);
    expectedOffset = dataStart + packed;
    if ((flags & 8) !== 0) {
      assert.equal(buf.readUInt32LE(expectedOffset), 0x08074b50, `${name}: data descriptor`);
      assert.equal(buf.readUInt32LE(expectedOffset + 4), crc);
      assert.equal(buf.readUInt32LE(expectedOffset + 8), packed);
      assert.equal(buf.readUInt32LE(expectedOffset + 12), unpacked);
      expectedOffset += 16;
    }
    entries.push({ name, flags, method, data, date, time });
  }
  assert.equal(expectedOffset, start, "the entries run into the central directory");
  return entries;
}
