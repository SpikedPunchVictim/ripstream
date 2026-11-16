/*
 * Builds OLE property set streams for tests: any number of sections, each a list of typed properties and an optional
 * dictionary (property 0, which has no type word, as the format defines it).
 */

export const SUMMARY_INFORMATION_ID = [0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9];
export const DOCUMENT_SUMMARY_ID = [0x02, 0xd5, 0xcd, 0xd5, 0x9c, 0x2e, 0x1b, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2b, 0x2c, 0xf9, 0xae];
export const USER_DEFINED_ID = [0x05, 0xd5, 0xcd, 0xd5, 0x9c, 0x2e, 0x1b, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2b, 0x2c, 0xf9, 0xae];

export type Prop =
  | { id: number; type: "string"; value: string }
  | { id: number; type: "int"; value: number }
  | { id: number; type: "uint"; value: number }
  | { id: number; type: "bool"; value: boolean }
  | { id: number; type: "double"; value: number }
  | { id: number; type: "filetime"; value: bigint };

export interface Section {
  readonly fmtid: readonly number[];
  readonly props: readonly Prop[];
  readonly dictionary?: Readonly<Record<number, string>>;
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function pad(bytes: number[]): number[] {
  while (bytes.length % 4 !== 0) bytes.push(0);
  return bytes;
}

function encode(property: Prop): number[] {
  switch (property.type) {
    case "string": {
      const text = [...new TextEncoder().encode(`${property.value}\0`)];
      return [...u16(30), 0, 0, ...u32(text.length), ...pad(text)];
    }
    case "int":
      return [...u16(3), 0, 0, ...u32(property.value)];
    case "uint":
      return [...u16(19), 0, 0, ...u32(property.value)];
    case "bool":
      return [...u16(11), 0, 0, ...u32(property.value ? 0xffff : 0)];
    case "double": {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, property.value, true);
      return [...u16(5), 0, 0, ...bytes];
    }
    case "filetime":
      return [...u16(64), 0, 0, ...u32(Number(property.value & 0xffffffffn)), ...u32(Number(property.value >> 32n))];
  }
}

function encodeSection(section: Section): number[] {
  const entries: { id: number; bytes: number[] }[] = [{ id: 1, bytes: [...u16(2), 0, 0, ...u16(1252), 0, 0] }];
  if (section.dictionary !== undefined) {
    const names = Object.entries(section.dictionary);
    const bytes: number[] = [...u32(names.length)];
    for (const [id, name] of names) {
      const text = [...new TextEncoder().encode(`${name}\0`)];
      bytes.push(...u32(Number(id)), ...u32(text.length), ...text);
    }
    entries.push({ id: 0, bytes: pad(bytes) });
  }
  for (const property of section.props) entries.push({ id: property.id, bytes: encode(property) });

  let offset = 8 + entries.length * 8;
  const table: number[] = [];
  const body: number[] = [];
  for (const entry of entries) {
    table.push(...u32(entry.id), ...u32(offset));
    body.push(...entry.bytes);
    offset += entry.bytes.length;
  }
  return [...u32(offset), ...u32(entries.length), ...table, ...body];
}

/** The 100-nanosecond FILETIME ticks of an instant. */
export function filetimeOf(iso: string): bigint {
  return (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n;
}

export function propertySet(sections: readonly Section[]): Uint8Array {
  const encoded = sections.map(encodeSection);
  const header = [...u16(0xfffe), ...new Array(22).fill(0), ...u32(sections.length)];
  let offset = 28 + sections.length * 20;
  const table: number[] = [];
  const body: number[] = [];
  sections.forEach((section, index) => {
    table.push(...section.fmtid, ...u32(offset));
    body.push(...encoded[index]!);
    offset += encoded[index]!.length;
  });
  return Uint8Array.from([...header, ...table, ...body]);
}
