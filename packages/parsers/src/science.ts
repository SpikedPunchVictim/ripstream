import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

const TYPES = [
  "application/x-matlab-data",
  "application/x-netcdf",
  "application/x-hdf",
  "application/x-hdf5",
  "application/x-grib",
  "application/x-dgn",
  "image/vnd.dwg",
  "image/x-dwg",
];

/** Metadata-level support for scientific/CAD formats. */
export class ScienceMetadataParser implements Parser {
  readonly name = "ScienceMetadataParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(TYPES.map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const info = describe(data);
    metadata.set("science:format", info.format);
    for (const [key, value] of Object.entries(info.fields)) {
      metadata.set(`science:${key}`, value);
    }
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("p", info.format);
    for (const [key, value] of Object.entries(info.fields)) {
      await xhtml.element("p", `${key}: ${value}`);
    }
    await xhtml.endDocument();
  }
}

interface Description {
  readonly format: string;
  readonly fields: Record<string, string>;
}

function describe(data: Uint8Array): Description {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (start: number, length: number): string =>
    String.fromCharCode(...data.subarray(start, start + length));
  if (ascii(0, 6) === "MATLAB") {
    if (data.length < 128) throw new MalformedDocumentError("Truncated MAT-file header");
    return {
      format: "MAT-file",
      fields: {
        version: String(view.getUint16(124, true)),
        endian: ascii(126, 2).trim(),
      },
    };
  }
  if (ascii(0, 3) === "CDF") {
    if (data.length < 8) throw new MalformedDocumentError("Truncated NetCDF header");
    return {
      format: "NetCDF",
      fields: { version: String(data[3]), numrecs: String(view.getUint32(4, false)) },
    };
  }
  if (ascii(0, 8) === "\u0089HDF\r\n\u001a\n") {
    return { format: "HDF5", fields: { superblock: String(data[8]) } };
  }
  if (data[0] === 0x0e && data[1] === 0x03 && data[2] === 0x13 && data[3] === 0x01) {
    return { format: "HDF4", fields: {} };
  }
  if (ascii(0, 4) === "GRIB") {
    return { format: "GRIB", fields: { edition: String(data[7]) } };
  }
  if (data[0] === 0x08 && (data[1] === 0x09 || data[1] === 0x05)) {
    return { format: "DGN", fields: { version: data[1] === 0x09 ? "7" : "8" } };
  }
  if (ascii(0, 4) === "AC10") {
    return { format: "DWG", fields: { version: ascii(0, 6) } };
  }
  throw new MalformedDocumentError("Unknown scientific/CAD format");
}
