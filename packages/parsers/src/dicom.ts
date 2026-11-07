import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

const TAGS: Record<string, string> = {
  "0008,0020": "StudyDate",
  "0008,0060": "Modality",
  "0008,0070": "Manufacturer",
  "0008,1030": "StudyDescription",
  "0010,0010": "PatientName",
  "0010,0020": "PatientID",
  "0020,000d": "StudyInstanceUID",
};

const LONG_VR = new Set(["OB", "OW", "OF", "SQ", "UT", "UN"]);

/** DICOM metadata extraction for explicit-VR little-endian datasets. */
export class DicomParser implements Parser {
  readonly name = "DicomParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/dicom")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (
      data.length < 132 ||
      String.fromCharCode(...data.subarray(128, 132)) !== "DICM"
    ) {
      throw new MalformedDocumentError("Not a DICOM file");
    }
    const values = readTags(data);
    if (Object.keys(values).length === 0) {
      throw new MalformedDocumentError("No DICOM metadata found");
    }
    for (const [name, value] of Object.entries(values)) {
      metadata.set(`dicom:${name}`, value);
    }
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const [name, value] of Object.entries(values)) {
      await xhtml.element("p", `${name}: ${value}`);
    }
    await xhtml.endDocument();
  }
}

function readTags(data: Uint8Array): Record<string, string> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const values: Record<string, string> = {};
  let offset = 132;
  while (offset + 8 <= data.length) {
    const group = view.getUint16(offset, true);
    const element = view.getUint16(offset + 2, true);
    const tag = `${group.toString(16).padStart(4, "0")},${element
      .toString(16)
      .padStart(4, "0")}`;
    const vrChars = String.fromCharCode(data[offset + 4]!, data[offset + 5]!);
    if (!/^[A-Z]{2}$/.test(vrChars)) break;
    let length: number;
    let valueOffset: number;
    if (LONG_VR.has(vrChars)) {
      length = view.getUint32(offset + 8, true);
      valueOffset = offset + 12;
    } else {
      length = view.getUint16(offset + 6, true);
      valueOffset = offset + 8;
    }
    if (group === 0x7fe0 && element === 0x0010) break;
    if (length === 0xffffffff) {
      // Undefined length is standard for sequences: walk past the items to the
      // sequence delimiter and keep reading the remaining tags.
      if (vrChars !== "SQ" && vrChars !== "UN") break;
      const next = skipUndefinedSequence(data, view, valueOffset, 0);
      if (next === -1) break;
      offset = next;
      continue;
    }
    if (valueOffset + length > data.length) break;
    const name = TAGS[tag];
    if (name !== undefined) {
      const value = stripTrailingNuls(
        new TextDecoder("utf-8", { fatal: false }).decode(
          data.subarray(valueOffset, valueOffset + length),
        ),
      ).trim();
      if (value.length > 0) values[name] = value;
    }
    offset = valueOffset + length;
  }
  return values;
}

const UNDEFINED_LENGTH = 0xffffffff;
const MAX_SEQUENCE_DEPTH = 64;

/**
 * Skips the items of an undefined-length sequence (explicit VR little endian).
 * `offset` is the start of the first item; returns the offset just past the
 * sequence delimiter (FFFE,E0DD), or -1 if the structure cannot be followed.
 */
function skipUndefinedSequence(
  data: Uint8Array,
  view: DataView,
  offset: number,
  depth: number,
): number {
  if (depth > MAX_SEQUENCE_DEPTH) return -1;
  while (offset + 8 <= data.length) {
    const group = view.getUint16(offset, true);
    const element = view.getUint16(offset + 2, true);
    const length = view.getUint32(offset + 4, true);
    if (group !== 0xfffe) return -1;
    if (element === 0xe0dd) return offset + 8; // sequence delimiter
    if (element !== 0xe000) return -1; // not an item
    offset += 8;
    if (length !== UNDEFINED_LENGTH) {
      if (length > data.length - offset) return -1;
      offset += length;
      continue;
    }
    offset = skipUndefinedItem(data, view, offset, depth);
    if (offset === -1) return -1;
  }
  return -1;
}

/** Skips explicit-VR elements up to the item delimiter (FFFE,E00D). */
function skipUndefinedItem(
  data: Uint8Array,
  view: DataView,
  offset: number,
  depth: number,
): number {
  while (offset + 8 <= data.length) {
    const group = view.getUint16(offset, true);
    const element = view.getUint16(offset + 2, true);
    if (group === 0xfffe && element === 0xe00d) return offset + 8;
    const vr = String.fromCharCode(data[offset + 4]!, data[offset + 5]!);
    if (!/^[A-Z]{2}$/.test(vr)) return -1;
    let length: number;
    let valueOffset: number;
    if (LONG_VR.has(vr)) {
      if (offset + 12 > data.length) return -1;
      length = view.getUint32(offset + 8, true);
      valueOffset = offset + 12;
    } else {
      length = view.getUint16(offset + 6, true);
      valueOffset = offset + 8;
    }
    if (length === UNDEFINED_LENGTH) {
      if (vr !== "SQ" && vr !== "UN") return -1;
      offset = skipUndefinedSequence(data, view, valueOffset, depth + 1);
      if (offset === -1) return -1;
      continue;
    }
    if (length > data.length - valueOffset) return -1;
    offset = valueOffset + length;
  }
  return -1;
}

/** Linear trailing-NUL strip (a /\0+$/ regex is quadratic on long NUL runs). */
function stripTrailingNuls(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}
