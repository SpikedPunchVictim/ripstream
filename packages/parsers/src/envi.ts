import { createDecoder, recordDetectedEncoding } from "./charset.ts";
import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";
import { javaDoubleString, javaIsBlank, javaSplit, javaTrim, parseJavaDouble, parseJavaInt } from "./java-compat.ts";
import { KeyPrefixWriter } from "./key-prefix.ts";
import { LineSplitter } from "./line-splitter.ts";

/** Real ENVI headers are a few kilobytes to tens of kilobytes (one number per band); this bounds one that never ends. */
export const DEFAULT_MAX_ENVI_HEADER_BYTES = 4 * 1024 * 1024;

const ENVI_MIME_TYPE = "application/envi.hdr";
/** EnviHeaderParser.ENVI: `KeyPrefix.file("envi:", "ENVI header field names")`. */
const ENVI_PREFIX = "envi:";
/** A line this long or longer is written as text but never becomes metadata. */
const MAX_METADATA_LINE_CHARS = 300;

export interface EnviHeaderParserOptions {
  /** Maximum size of the header in bytes (default {@link DEFAULT_MAX_ENVI_HEADER_BYTES}); a larger one is a LimitExceededError. */
  readonly maxHeaderBytes?: number;
}

/**
 * Port of Tika's EnviHeaderParser (tika-parser-scientific-module) for ENVI image headers (`application/envi.hdr`), the
 * `key = value` text that sits beside a raster file.
 *
 * Every line is written as a paragraph. A line that has an `=` and is under 300 characters also becomes metadata under
 * `envi:` + the name before the first `=` (trimmed, every space turned into a dot) with the trimmed value after it. A value in
 * braces may run over several lines: from a line that holds `{` and does not end in `}`, or from a line that starts with a
 * space, the lines are joined with nothing between them until one ends in `}`. A `map info` in UTM also gets `envi:lat/lon`,
 * the latitude and longitude of the map point, written as a paragraph `lat/lon = { lat, lon }` before the line itself.
 *
 * Differences from Tika, all read from the source and not run against a Tika:
 *  - A header over `maxHeaderBytes` is a LimitExceededError. Tika reads it all.
 *  - A UTM `map info` that has fewer than eight values or a value that is not a number is a MalformedDocumentError. In Tika
 *    it is an ArrayIndexOutOfBoundsException or a NumberFormatException, which no `catch` in the parser stops.
 *  - The character set comes from ripstream's detector, as for the other text parsers, not Tika's AutoDetectReader.
 *  - A multi-line value still open at the end of the header is dropped, as in Tika (the joined lines are only written when
 *    one ends in `}`); it is not an error.
 */
export class EnviHeaderParser implements Parser {
  readonly name = "EnviHeaderParser";
  readonly #maxHeaderBytes: number;

  constructor(options: EnviHeaderParserOptions = {}) {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_ENVI_HEADER_BYTES;
    if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
      throw new RangeError(`maxHeaderBytes must be a positive integer, got ${maxHeaderBytes}`);
    }
    this.#maxHeaderBytes = maxHeaderBytes;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(ENVI_MIME_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const tick = signalCheckpoint(ctx);
    metadata.set("Content-Type", ENVI_MIME_TYPE);
    const bytes = await stream.readFully(this.#maxHeaderBytes);
    const { decoder, charset } = createDecoder(detectEncoding(bytes.subarray(0, 64 * 1024)).charset);
    metadata.set("Content-Encoding", charset);
    recordDetectedEncoding(metadata, charset);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const lines = new EnviLines(xhtml, new KeyPrefixWriter(metadata, ENVI_PREFIX));
    // The header is already capped in bytes, so a line (at most that many characters) never trips the splitter's own cap.
    const splitter = new LineSplitter(this.#maxHeaderBytes, "an ENVI header line");
    const found = [...splitter.push(decoder.decode(bytes)), ...splitter.finish()];
    for (const line of found) {
      tick();
      await lines.read(line);
    }
    await xhtml.endDocument();
  }
}

/** EnviHeaderParser.readLines and writeParagraphAndSetMetadata. */
class EnviLines {
  readonly #xhtml: XHTMLContentHandler;
  readonly #keys: KeyPrefixWriter;
  /** The lines of the multi-line value being read. Per parse: it never carries over to another header. */
  #pending: string[] = [];

  constructor(xhtml: XHTMLContentHandler, keys: KeyPrefixWriter) {
    this.#xhtml = xhtml;
    this.#keys = keys;
  }

  async read(line: string): Promise<void> {
    if ((line.includes("{") && !line.endsWith("}")) || line.startsWith(" ")) {
      this.#pending.push(line);
      if (line.endsWith("}")) {
        const complete = this.#pending.join("");
        this.#pending = [];
        await this.#write(complete);
      }
    } else {
      await this.#write(line);
    }
  }

  async #write(line: string): Promise<void> {
    if (line.length < MAX_METADATA_LINE_CHARS) {
      const equals = line.indexOf("=");
      if (equals !== -1) {
        const name = javaTrim(line.slice(0, equals)).replaceAll(" ", ".");
        const value = javaTrim(line.slice(equals + 1));
        if (javaTrim(line.slice(0, equals)) === "map info") {
          await this.#writeMapInfo(name, value, line.slice(equals + 1));
        } else {
          this.#keys.add(name, value);
        }
      }
    }
    await this.#paragraph(line);
  }

  async #writeMapInfo(name: string, value: string, rawValue: string): Promise<void> {
    const values = mapInfoValues(rawValue);
    // Tika reads values[0] before it adds anything: a value that is only commas has none.
    if (values.length === 0) throw malformedMapInfo("the value has no fields");
    this.#keys.add(name, value);
    if (values[0] !== "UTM") return;
    const { latitude, longitude } = utmToLatLon(values);
    this.#keys.add("lat/lon", `${latitude}, ${longitude}`);
    await this.#paragraph(`lat/lon = { ${latitude}, ${longitude} }`);
  }

  async #paragraph(text: string): Promise<void> {
    await this.#xhtml.startElement("p");
    await this.#xhtml.characters(text);
    await this.#xhtml.endElement("p");
  }
}

/** parseMapInfoContents: the value without its braces and spaces, split at the commas. Java's split drops trailing empty strings. */
function mapInfoValues(value: string): string[] {
  return javaSplit(value.replace(/[{} ]/g, ""), ",");
}

function malformedMapInfo(why: string): MalformedDocumentError {
  return new MalformedDocumentError(`ENVI map info in UTM: ${why}`);
}

function numberAt(values: readonly string[], index: number): number {
  const text = values[index];
  if (text === undefined) throw malformedMapInfo(`value ${index + 1} is missing`);
  const parsed = parseJavaDouble(text);
  if (parsed === null) throw malformedMapInfo(`value ${index + 1} is not a number: ${JSON.stringify(text.slice(0, 40))}`);
  return parsed;
}

/**
 * The zone is value 8, and a blank one means zone 0 (a central meridian of 3 degrees). Tika tests `isBlank()` on the value and
 * then calls `Integer.parseInt(value.trim())`, so a value of only control characters below U+0020 that are not whitespace
 * (U+0001) is not blank and the parse fails.
 */
function zoneAt(values: readonly string[]): number {
  const text = values[7];
  if (text === undefined) throw malformedMapInfo("value 8 is missing");
  if (javaIsBlank(text)) return 0;
  const zone = parseJavaInt(javaTrim(text));
  if (zone === null) throw malformedMapInfo(`the zone is not an integer: ${JSON.stringify(text.slice(0, 40))}`);
  return zone;
}

/**
 * convertMapInfoValuesToLatLngAndSetMetadata's arithmetic (its comment names a Stack Overflow answer for UTM to latitude and
 * longitude on the WGS-84 ellipsoid). The map point is value 4 (easting) and 5 (northing); the order of operations and every
 * constant are Tika's, so the digits of the result are too. The result is as text, as Double.toString writes it.
 */
function utmToLatLon(values: readonly string[]): { latitude: string; longitude: string } {
  const pixelEasting = numberAt(values, 3);
  const pixelNorthing = numberAt(values, 4);
  const zone = zoneAt(values);

  const a = 6378137.0;
  const e = 0.081819191;
  const e1sq = 0.006739497;
  const k0 = 0.9996;

  const arc = pixelNorthing / k0;
  const mu = arc / (a * (1.0 - Math.pow(e, 2.0) / 4.0 - (3.0 * Math.pow(e, 4.0)) / 64.0 - (5.0 * Math.pow(e, 6.0)) / 256.0));

  const ei = (1.0 - Math.pow(1.0 - e * e, 1.0 / 2.0)) / (1.0 + Math.pow(1.0 - e * e, 1.0 / 2.0));

  const ca = (3.0 * ei) / 2.0 - (27.0 * Math.pow(ei, 3.0)) / 32.0;

  const cb = (21.0 * Math.pow(ei, 2.0)) / 16.0 - (55.0 * Math.pow(ei, 4.0)) / 32.0;
  const cc = (151.0 * Math.pow(ei, 3.0)) / 96.0;
  const cd = (1097.0 * Math.pow(ei, 4.0)) / 512.0;
  const phi1 = mu + ca * Math.sin(2.0 * mu) + cb * Math.sin(4.0 * mu) + cc * Math.sin(6.0 * mu) + cd * Math.sin(8.0 * mu);

  const n0 = a / Math.pow(1.0 - Math.pow(e * Math.sin(phi1), 2.0), 1.0 / 2.0);

  const r0 = (a * (1.0 - e * e)) / Math.pow(1.0 - Math.pow(e * Math.sin(phi1), 2.0), 3.0 / 2.0);
  const fact1 = (n0 * Math.tan(phi1)) / r0;

  const a1 = 500000.0 - pixelEasting;
  const dd0 = a1 / (n0 * k0);
  const fact2 = (dd0 * dd0) / 2.0;
  const t0 = Math.pow(Math.tan(phi1), 2.0);
  const q0 = e1sq * Math.pow(Math.cos(phi1), 2.0);
  const fact3 = ((5.0 + 3.0 * t0 + 10.0 * q0 - 4.0 * q0 * q0 - 9.0 * e1sq) * Math.pow(dd0, 4.0)) / 24.0;
  const fact4 =
    ((61.0 + 90.0 * t0 + 298.0 * q0 + 45.0 * t0 * t0 - 252.0 * e1sq - 3.0 * q0 * q0) * Math.pow(dd0, 6.0)) / 720.0;
  const lof1 = a1 / (n0 * k0);
  const lof2 = ((1.0 + 2.0 * t0 + q0) * Math.pow(dd0, 3.0)) / 6.0;
  const lof3 = ((5.0 - 2.0 * q0 + 28.0 * t0 - 3.0 * Math.pow(q0, 2.0) + 8.0 * e1sq + 24.0 * Math.pow(t0, 2.0)) * Math.pow(dd0, 5.0)) / 120.0;
  const a2 = (lof1 - lof2 + lof3) / Math.cos(phi1);
  const a3 = (a2 * 180.0) / Math.PI;
  const zoneCentralMeridian = zone > 0 ? 6 * zone - 183.0 : 3.0;
  const latitude = (180.0 * (phi1 - fact1 * (fact2 + fact3 + fact4))) / Math.PI;
  const longitude = zoneCentralMeridian - a3;
  return { latitude: javaDoubleString(latitude), longitude: javaDoubleString(longitude) };
}
