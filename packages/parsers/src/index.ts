import {
  AutoDetectParser,
  CompositeParser,
  Ripstream,
  RipstreamConfigError,
  type MediaTypeRegistry,
  type Parser,
  type RipstreamConfig,
} from "@spikedpunch/ripstream-core";
import { DefaultDetector, MimeTypes } from "@spikedpunch/ripstream-mime";
import { TextParser } from "./text.ts";
import { HtmlDocumentParser } from "./html.ts";
import { XmlParser } from "./xml.ts";
import { CsvParser, type CsvParserOptions } from "./csv.ts";
import { AppleSingleParser, ArchiveMetadataParser, ArParser, Bzip2Parser, BrotliParser, CpioParser, GzipParser, Iso9660Parser, Lz4Parser, PlistParser, SnappyParser, TarParser, UnixCompressParser, XzParser, ZipParser } from "@spikedpunch/ripstream-parser-archive";
import { PdfParser } from "@spikedpunch/ripstream-parser-pdf";
import { AsfParser, AudioParser, AviParser, FlvParser, FontParser, ImageParser, MatroskaParser, Mp4Parser, WmfEmfParser } from "@spikedpunch/ripstream-parser-media";
import { ColumnarParser, OpenPgpParser, SqliteParser } from "@spikedpunch/ripstream-parser-db";
import { EpubParser, ExcelBinaryParser, IWork09Parser, IWork13Parser, LegacyFormatParser, LegacyOfficeParser, MsgParser, OoxmlParser, OpenDocumentParser, PowerPointBinaryParser, PstParser, WordBinaryParser } from "@spikedpunch/ripstream-parser-office";
import { FeedParser } from "./feed.ts";
import { MarkdownParser } from "./markdown.ts";
import { TmxParser, WarcParser, XliffParser } from "./web.ts";
import { MailParser } from "./mail.ts";
import { MboxParser } from "./mbox.ts";
import { JavaClassParser } from "./java-class.ts";
import { RdfParser } from "./rdf.ts";
import { ExecutableParser } from "./executable.ts";
import { DbfParser } from "./dbf.ts";
import { DicomParser } from "./dicom.ts";
import { DxfParser } from "./dxf.ts";
import { TnefParser } from "./tnef.ts";
import { X509Parser } from "./x509.ts";
import { ShapefileParser } from "./shapefile.ts";
import { FitsParser } from "./fits.ts";
import { Asn1Parser } from "./asn1.ts";
import { MidiParser } from "./midi.ts";
import { IccParser } from "./icc.ts";
import { AnpaParser } from "./anpa.ts";
import { ScienceMetadataParser } from "./science.ts";
import { RtfParser } from "./rtf.ts";
import { applyParserConfig } from "./parser-config.ts";

export { TextParser } from "./text.ts";
export { HtmlDocumentParser, DEFAULT_MAX_HTML_DEPTH, type HtmlParserOptions } from "./html.ts";
export { XmlParser } from "./xml.ts";
export {
  CsvParser,
  DEFAULT_MAX_CSV_CELLS_PER_ROW,
  DEFAULT_MAX_CSV_ROW_CHARS,
  type CsvParserOptions,
} from "./csv.ts";
export { FeedParser } from "./feed.ts";
export { MarkdownParser } from "./markdown.ts";
export { TmxParser, WarcParser, XliffParser } from "./web.ts";
export { MailParser } from "./mail.ts";
export { MboxParser } from "./mbox.ts";
export { JavaClassParser } from "./java-class.ts";
export { RdfParser } from "./rdf.ts";
export { ExecutableParser } from "./executable.ts";
export { DbfParser } from "./dbf.ts";
export { DicomParser } from "./dicom.ts";
export { DxfParser } from "./dxf.ts";
export { TnefParser } from "./tnef.ts";
export { X509Parser } from "./x509.ts";
export { ShapefileParser } from "./shapefile.ts";
export { FitsParser } from "./fits.ts";
export { Asn1Parser } from "./asn1.ts";
export { MidiParser } from "./midi.ts";
export { IccParser } from "./icc.ts";
export { AnpaParser } from "./anpa.ts";
export { ScienceMetadataParser } from "./science.ts";
export { RtfParser } from "./rtf.ts";

export interface DefaultParserOptions {
  readonly parsers?: readonly Parser[];
  /** Product limits for the default CsvParser (ignored when `parsers` is supplied). */
  readonly csv?: CsvParserOptions;
  readonly pdfPassword?: string | import("@spikedpunch/ripstream-core").PasswordProvider;
  /**
   * Aliases and supertypes used to pick a parser, as in Tika's CompositeParser.
   * Defaults to the bundled Tika registry; pass the detector's own when it was
   * built with custom types.
   */
  readonly registry?: MediaTypeRegistry;
  /**
   * The `parsers` section of a loaded configuration, applied to the default parsers by Tika's component names
   * (`default-parser`, its `exclude` list, `_mime-include` / `_mime-exclude`). It names Tika's parsers, so it cannot be
   * combined with `parsers`, a list of parser objects.
   */
  readonly config?: RipstreamConfig;
}

let bundledRegistry: MediaTypeRegistry | undefined;

export function createDefaultParser(options: DefaultParserOptions = {}): CompositeParser {
  bundledRegistry ??= new MimeTypes().getMediaTypeRegistry();
  const registry = options.registry ?? bundledRegistry;
  const section = options.config?.parsers ?? null;
  if (section !== null && options.parsers !== undefined) {
    throw new RipstreamConfigError([
      "the configuration's `parsers` section cannot be combined with `parsers`, a list of parser objects: " +
        "its names refer to the default parsers",
    ]);
  }
  const parsers = options.parsers ?? [
      new TextParser(),
      new CsvParser(options.csv),
      new HtmlDocumentParser(),
      new XmlParser(),
      new ZipParser(),
      new GzipParser(),
      new Bzip2Parser(),
      new BrotliParser(),
      new XzParser(),
      new Lz4Parser(),
      new SnappyParser(),
      new UnixCompressParser(),
      new Iso9660Parser(),
      new CpioParser(),
      new ArParser(),
      new ArchiveMetadataParser(),
      new PlistParser(),
      new AppleSingleParser(),
      new TarParser(),
      new PdfParser({
        ...(options.pdfPassword === undefined ? {} : { password: options.pdfPassword }),
      }),
      new ImageParser(),
      new Mp4Parser(),
      new AudioParser(),
      new WmfEmfParser(),
      new FlvParser(),
      new AviParser(),
      new MatroskaParser(),
      new AsfParser(),
      new FontParser(),
      new SqliteParser(),
      new OpenPgpParser(),
      new ColumnarParser(),
      new OoxmlParser(),
      new WordBinaryParser(),
      new ExcelBinaryParser(),
      new PowerPointBinaryParser(),
      new MsgParser(),
      new IWork09Parser(),
      new IWork13Parser(),
      new LegacyOfficeParser(),
      new LegacyFormatParser(),
      new PstParser(),
      new OpenDocumentParser(),
      new EpubParser(),
      new FeedParser(),
      new MarkdownParser(),
      new WarcParser(),
      new XliffParser(),
      new TmxParser(),
      new MailParser(),
      new MboxParser(),
      new JavaClassParser(),
      new RdfParser(),
      new ExecutableParser(),
      new DbfParser(),
      new DicomParser(),
      new DxfParser(),
      new TnefParser(),
      new X509Parser(),
      new ShapefileParser(),
      new FitsParser(),
      new Asn1Parser(),
      new MidiParser(),
      new IccParser(),
      new AnpaParser(),
      new ScienceMetadataParser(),
      new RtfParser(),
    ];
  return new CompositeParser({ registry, parsers: section === null ? parsers : applyParserConfig(parsers, section, registry) });
}

export interface CreateRipstreamOptions extends DefaultParserOptions {
  readonly detector?: DefaultDetector;
}

/** Wires the default detector and parser registry into the Ripstream facade. */
export function createRipstream(options: CreateRipstreamOptions = {}): Ripstream {
  const detector = options.detector ?? new DefaultDetector();
  const parser = new AutoDetectParser({
    detector,
    parser: createDefaultParser({ ...options, registry: options.registry ?? detector.getMediaTypeRegistry() }),
  });
  return new Ripstream({ detector, parser });
}
