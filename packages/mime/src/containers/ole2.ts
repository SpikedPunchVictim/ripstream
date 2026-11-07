import { open } from "node:fs/promises";
import { MalformedDocumentError, MediaType } from "@spikedpunch/ripstream-core";
import type { RipstreamInputStream } from "@spikedpunch/ripstream-core";

const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Port of Ripstream's OLE2 container detection: read the header, walk the FAT and
 * directory chain, and inspect root storage names.
 */
export async function detectOle2Container(
  stream: RipstreamInputStream,
): Promise<MediaType | null> {
  const path = await stream.getFile();
  const handle = await open(path, "r");
  try {
    const header = new Uint8Array(512);
    const { bytesRead } = await handle.read(header, 0, 512, 0);
    if (bytesRead < 512) return null;
    if (!OLE2_SIGNATURE.every((byte, index) => header[index] === byte)) return null;

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const sectorShift = view.getUint16(30, true);
    if (sectorShift < 7 || sectorShift > 16) {
      throw new MalformedDocumentError(`Invalid OLE2 sector shift: ${sectorShift}`);
    }
    const sectorSize = 1 << sectorShift;
    const firstDirectorySector = view.getUint32(48, true);
    const numberOfFatSectors = view.getUint32(44, true);
    const firstDifatSector = view.getUint32(68, true);
    const numberOfDifatSectors = view.getUint32(72, true);

    const fatSectorIds: number[] = [];
    for (let index = 0; index < 109; index++) {
      const sector = view.getUint32(76 + index * 4, true);
      if (sector !== 0xffffffff) fatSectorIds.push(sector);
    }

    const maxSectors = Math.floor((await handle.stat()).size / sectorSize);
    if (numberOfDifatSectors > maxSectors) {
      throw new MalformedDocumentError("OLE2 DIFAT count exceeds file size");
    }
    let difat = firstDifatSector;
    const seenDifat = new Set<number>();
    for (let index = 0; index < numberOfDifatSectors && difat !== 0xfffffffe; index++) {
      if (seenDifat.has(difat)) {
        throw new MalformedDocumentError("OLE2 DIFAT sector loop");
      }
      seenDifat.add(difat);
      const sector = await readSector(handle, difat, sectorSize);
      if (sector.length < sectorSize) break;
      const sectorView = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
      for (let entry = 0; entry < sectorSize / 4 - 1; entry++) {
        const fatSector = sectorView.getUint32(entry * 4, true);
        if (fatSector !== 0xffffffff) fatSectorIds.push(fatSector);
      }
      difat = sectorView.getUint32(sectorSize - 4, true);
    }

    const fat: number[] = [];
    for (const sectorId of fatSectorIds.slice(0, numberOfFatSectors)) {
      const sector = await readSector(handle, sectorId, sectorSize);
      if (sector.length < sectorSize) continue;
      const sectorView = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
      for (let offset = 0; offset < sectorSize; offset += 4) {
        fat.push(sectorView.getUint32(offset, true));
      }
    }

    const names = new Set<string>();
    let sector = firstDirectorySector;
    const visited = new Set<number>();
    while (sector !== 0xfffffffe && sector !== 0xffffffff && !visited.has(sector)) {
      visited.add(sector);
      const data = await readSector(handle, sector, sectorSize);
      if (data.length < sectorSize) break;
      const sectorView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let offset = 0; offset + 128 <= sectorSize; offset += 128) {
        const nameLength = sectorView.getUint16(offset + 64, true);
        if (nameLength < 2 || nameLength > 64) continue;
        const raw = data.subarray(offset, offset + nameLength - 2);
        names.add(new TextDecoder("utf-16le").decode(raw));
      }
      sector = fat[sector] ?? 0xfffffffe;
    }

    return detectOle2Names(names);
  } catch (error) {
    // Detection is best-effort: a corrupt header must not abort the detector
    // chain (magic/XML/text fallbacks); parsers report the malformation later.
    if (error instanceof MalformedDocumentError) return null;
    throw error;
  } finally {
    await handle.close();
  }
}

export function detectOle2Names(names: Iterable<string>): MediaType {
  const set = names instanceof Set ? (names as Set<string>) : new Set(names);

  if (set.has("EncryptedPackage")) return parse("application/x-tika-ooxml");
  if (set.has("WordDocument")) return parse("application/msword");
  if (set.has("Workbook") || set.has("Book")) return parse("application/vnd.ms-excel");
  if (set.has("PowerPoint Document")) return parse("application/vnd.ms-powerpoint");
  if (set.has("__properties_version1.0")) return parse("application/vnd.ms-outlook");
  if (set.has("VisioDocument")) return parse("application/vnd.visio");
  return parse("application/x-tika-msoffice");
}

function parse(value: string): MediaType {
  return MediaType.parse(value)!;
}

async function readSector(
  handle: Awaited<ReturnType<typeof open>>,
  sectorId: number,
  sectorSize: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(sectorSize);
  const offset = 512 + sectorId * sectorSize;
  const { bytesRead } = await handle.read(buffer, 0, sectorSize, offset);
  return buffer.subarray(0, bytesRead);
}
