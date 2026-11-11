/*
 * Hand-built "bplist00" files for the property-list and iWork tests: the objects (each already encoded, references
 * written as object numbers), then the offset table and the 32-byte trailer, as Apple's published layout has them.
 */

const enc = new TextEncoder();

export function binaryPlist(objects: number[][], options: { top?: number; refSize?: number; offsetSize?: number } = {}): Uint8Array {
  const { top = 0, offsetSize = 1 } = options;
  const header = [...enc.encode("bplist00")];
  const offsets: number[] = [];
  let at = header.length;
  for (const object of objects) {
    offsets.push(at);
    at += object.length;
  }
  const table = offsets.flatMap((offset) => bigEndian(offset, offsetSize));
  const trailer = [0, 0, 0, 0, 0, 0, offsetSize, options.refSize ?? 1, ...bigEndian(objects.length, 8), ...bigEndian(top, 8), ...bigEndian(at, 8)];
  return Uint8Array.from([...header, ...objects.flat(), ...table, ...trailer]);
}

export function bigEndian(value: number, size: number): number[] {
  return Array.from({ length: size }, (_, i) => Number((BigInt(value) >> BigInt(8 * (size - 1 - i))) & 0xffn));
}

/** An ASCII string object of at most 14 characters. */
export const ascii = (text: string): number[] => [0x50 | text.length, ...enc.encode(text)];
export const dict = (...refs: number[]): number[] => [0xd0 | (refs.length / 2), ...refs];
export const array = (...refs: number[]): number[] => [0xa0 | refs.length, ...refs];

/** A binary dictionary of short string keys and short string values, the shape of iWork's Properties.plist. */
export function stringDictionaryPlist(entries: Record<string, string>): Uint8Array {
  const pairs = Object.entries(entries);
  const keyRefs = pairs.map((_, index) => 1 + index);
  const valueRefs = pairs.map((_, index) => 1 + pairs.length + index);
  return binaryPlist([dict(...keyRefs, ...valueRefs), ...pairs.map(([key]) => ascii(key)), ...pairs.map(([, value]) => ascii(value))]);
}
