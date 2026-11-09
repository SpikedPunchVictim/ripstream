const encoder = new TextEncoder();

export interface ZipFixtureEntry {
  readonly name: string;
  readonly data?: string;
  readonly bytes?: Uint8Array;
  readonly deflated?: Uint8Array;
  /** Write the central entry as a streaming ZIP64 writer does: 0xFFFFFFFF sizes/offset, real values in the extra field. */
  readonly zip64?: boolean;
}

/** A minimal ZIP: stored entries (or pre-deflated ones), a central directory, no extras. */
export function zip(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.deflated ?? entry.bytes ?? encoder.encode(entry.data ?? "x");
    const method = entry.deflated === undefined ? 0 : 8;
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const extraLength = entry.zip64 === true ? 4 + 24 : 0;
    const central = new Uint8Array(46 + name.length + extraLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, extraLength, true);
    central.set(name, 46);
    if (entry.zip64 === true) {
      centralView.setUint32(20, 0xffffffff, true);
      centralView.setUint32(24, 0xffffffff, true);
      centralView.setUint32(42, 0xffffffff, true);
      const extra = 46 + name.length;
      centralView.setUint16(extra, 0x0001, true);
      centralView.setUint16(extra + 2, 24, true);
      centralView.setBigUint64(extra + 4, BigInt(data.length), true);
      centralView.setBigUint64(extra + 12, BigInt(data.length), true);
      centralView.setBigUint64(extra + 20, BigInt(offset), true);
    } else {
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint32(42, offset, true);
    }
    centrals.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(centralOffset + centralSize + 22);
  let cursor = 0;
  for (const local of locals) {
    result.set(local, cursor);
    cursor += local.length;
  }
  for (const central of centrals) {
    result.set(central, cursor);
    cursor += central.length;
  }
  const end = new DataView(result.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  return result;
}
