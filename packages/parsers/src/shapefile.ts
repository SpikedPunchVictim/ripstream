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

const SHAPE_NAMES: Record<number, string> = {
  0: "Null", 1: "Point", 3: "PolyLine", 5: "Polygon", 8: "MultiPoint",
  11: "PointZ", 13: "PolyLineZ", 15: "PolygonZ", 18: "MultiPointZ",
  21: "PointM", 23: "PolyLineM", 25: "PolygonM", 28: "MultiPointM",
  31: "MultiPatch",
};

/** ESRI shapefile header metadata. */
export class ShapefileParser implements Parser {
  readonly name = "ShapefileParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/x-shapefile")!]);
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
    if (data.length < 100) throw new MalformedDocumentError("Truncated shapefile");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, false) !== 9994) {
      throw new MalformedDocumentError("Invalid shapefile header");
    }
    const shapeType = view.getUint32(32, true);
    const shape = SHAPE_NAMES[shapeType] ?? `Unknown(${shapeType})`;
    const bounds = [36, 44, 52, 60].map((position) => view.getFloat64(position, true));
    metadata.set("shapefile:shape-type", shape);
    metadata.set("shapefile:min-x", String(bounds[0]));
    metadata.set("shapefile:min-y", String(bounds[1]));
    metadata.set("shapefile:max-x", String(bounds[2]));
    metadata.set("shapefile:max-y", String(bounds[3]));

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("p", `Shape type: ${shape}`);
    await xhtml.element(
      "p",
      `Bounds: (${bounds[0]}, ${bounds[1]}) - (${bounds[2]}, ${bounds[3]})`,
    );
    await xhtml.endDocument();
  }
}
