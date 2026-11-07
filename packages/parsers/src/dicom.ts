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
    if (length === 0xffffffff || valueOffset + length > data.length) break;
    if (group === 0x7fe0 && element === 0x0010) break;
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

/** Linear trailing-NUL strip (a /\0+$/ regex is quadratic on long NUL runs). */
function stripTrailingNuls(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}
