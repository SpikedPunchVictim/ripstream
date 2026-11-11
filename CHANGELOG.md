# Changelog

All notable changes. The project has no tagged release yet, so everything is under Unreleased.

## Unreleased

### Ogg family, AU and the media claims (`tikajs-68os.15`)

Added, in `@spikedpunch/ripstream-parser-media`: an Ogg demuxer (RFC 3533 pages and lacing, one pass, bounded memory) and
`OggParser`, `VorbisParser`, `OpusParser`, `SpeexParser`, `FlacParser` (Ogg FLAC) and `TheoraParser`, which read the first packet of
each stream and the Vorbis comment block (`vorbis:*` keys, `xmpDM:*` typed keys, track and disc numbers and totals, cover
art from `METADATA_BLOCK_PICTURE` with its MIME Base64, thumbnail pick by ID3 picture type) and the duration from the last
granule position. `AudioParser` now also claims `audio/basic` (the AU header: rate, channels, encoding) and no longer claims
`audio/ogg`. `MP4Parser` also claims `application/mp4`, `HeifParser` claims the `heic`/`heif` sequence types, and
`MidiParser` claims `application/x-midi`.

- Caps: 1000 open streams, 32 MiB of held packets (both `LimitExceededError`); a page cut short by the end of the input
  ends the read and keeps what came before.
- A stream whose beginning page was not seen is passed over, and a chained stream that reuses the serial number of an ended
  codec stream is not read as part of it (a mutation-testing find).
- AU now writes its (empty) document, so the metadata and the warning reach the head, as `AudioParser` does in Tika; the rate
  is cast the way Java casts a float rate to int.

Read from Tika source, not run against a Tika. The Ogg codec header offsets, the Opus duration (pre-skip) and the AU reader's
acceptance rules are from memory of vorbis-java and the JDK, not from source in the tree. Not done: native FLAC files
(`tikajs-68os.61`), the OGM and Ogg RGB signatures in the MIME table. Known and not fixed here: the non-AU branch of
`AudioParser` also omits the empty document (`tikajs-68os.68`).

### Old Excel, OLE containers and iWork (`tikajs-68os.18`, `.19`)

Added, in `@spikedpunch/ripstream-parser-office`:

- `OldExcelParser` for BIFF2, BIFF3 and BIFF4 worksheets and workspaces (`application/vnd.ms-excel.sheet.2|3|4`, `workspace.3|4`):
  one `<p>` per cell, Java `Double.toString` text for numbers, the codepage record, a formula's string result from the
  STRING record after it; record and cell caps as for `.xls`.
- `OleContainerParser` (named `OfficeParser`): the generic OLE2 containers (`x-tika-msoffice`, `x-tika-msoffice-embedded`,
  Ole10Native, SolidWorks) give the SummaryInformation and DocumentSummaryInformation metadata and no text; the DRM type and
  an `EncryptedPackage` entry are `EncryptedDocumentError`.
- A shared plist reader and `IWork13PackageParser` / `IWork18PackageParser` (Keynote, Pages, Numbers): the package type
  comes from the entries, the version history and properties go to the metadata, and previews and thumbnails are handed to
  the embedded extractor. The old IWA scan and the '09 fallback claims are gone, so the `iwork:iwa-parts` and
  `iwork:preview` metadata keys are no longer written; the `snappyjs` dependency of the package is now unused.

Changed from the previous behaviour: a "PK" prefix without a ZIP structure is no longer an empty iWork package (Tika refuses it
as not a ZIP archive), the document identifier is read as ISO-8859-1 bytes (bytes 0x80-0x9F were mapped to windows-1252),
and `application/x-tika-ooxml-protected` is refused as encrypted where Tika decrypts it with the default password
(`tikajs-68os.56`).

Written from the published BIFF2-4 layouts with Tika's tests as the check: which records `OldExcelExtractor` leaves out is
inferred. Read from Tika source, not run against a Tika. Open follow-ups: `tikajs-68os.56`, `.57` (the unused `snappyjs` dependency) and `.59`.

### TSD, BER, Quattro Pro, DGN8, SAS7BDAT, bplist variants, TNEF alias (`tikajs-68os.21`)

Added, in `@spikedpunch/ripstream-parsers`: `TsdParser` (RFC 3161 time-stamped data: the TSTInfo fields as
`Time-Stamp-n.<i> - <field>` metadata, the embedded document handed on; a bounded BER reader and the general-name text),
`Dgn8Parser` and `QuattroProParser` (OLE streams; `exact-version.ts` guards the parameterised claims, since core selection
keys a claim by its base type), and `Sas7bdatParser`. The bplist variants (`application/x-bplist-*`) are claimed by the plist
parser, `base64` data in an XML plist is decoded, and the CHM parser also claims `application/chm` and `application/x-chm` and
reports `application/vnd.ms-htmlhelp`, and the TNEF parser also claims `application/ms-tnef` and `application/x-tnef` (the
latter two are not in the MIME database, so only a caller's Content-Type reaches them).

- **SAS7BDAT is partial.** 32-bit little-endian uncompressed files are read; 64-bit, big-endian and compressed files are
  refused as `UnsupportedFormatError` (they are the common case in the wild). Cell text and the encoding table are this
  port's own choices where parso's source was not at hand: it is not claimed as parity (`tikajs-68os.69`).
- TSD differs from Tika where Tika has a bug or a loose end: input that is not TSD is a `MalformedDocumentError` (Tika
  returns an empty success), more than 1000 tokens is a `LimitExceededError`, and `MANIFEST.XML.TSD` gives 2 records, Tika 3
  (BER indefinite lengths, `tikajs-68os.70`).
- A Quattro Pro 7-8 file now routes through the supertype to the OLE container parser (metadata only), as it probably does in
  Tika; not checked.

Read from Tika source and real fixtures (`testQUATTRO.qpw`, `testDGN8.dgn`, `testSAS.sas7bdat`, `testBPList.bplist`), not run
against a Tika.

### ENVI, ISA-Tab, ISO 19139 and GeoPackage (`tikajs-68os.22`)

Added: `EnviHeaderParser` (the `.hdr` text with its `{ }` multi-line values and the `envi:` keys), `ISArchiveParser` (the
study file `s_*.txt` as a table; other files of the archive are not read), `GeographicInformationParser` (ISO 19139
metadata mapped to `dc:*` and prefixed keys through `KeyPrefixWriter`, and the text as headings, paragraphs and tables) in `@spikedpunch/ripstream-parsers`, and `GeoPkgParser` in
`@spikedpunch/ripstream-parser-db` (the `gpkg_*` header integers, then every table, with typed cell text as Java writes it).
`SqliteParser` and `GeoPkgParser` now share one sql.js loader. Number text follows Java (`Double.toString`,
`Float.toString`) through `java-compat.ts` and `java-number.ts`.

- ENVI is reached by a direct call: the registry gives only the glob `*.hdr`, not content detection.
- Mutation testing found and fixed: a blank ENVI zone (Java `isBlank`, not `trim`), `parseInt("-0")`, and
  `Float.MIN_VALUE` text.

Not done: **GRIB2** (`GribParser`): the netcdf-java model is not portable and the type is undetectable in Tika too (owner
decision, `tikajs-68os.66`). The ISO 19139 mapping follows Apache SIS from memory of the XML elements, not from SIS source
(`tikajs-68os.55`); the GeoPackage fixture `synthetic-features.gpkg` is made here, not Tika's.

### Compression streams: zlib, LZMA, Deflate64, snappy, gzipped WARC and ARC (`tikajs-68os.20`)

Added, in `@spikedpunch/ripstream-parser-archive`: `ZlibParser` (`application/zlib`), `LzmaParser` (`application/x-lzma`) and
`Deflate64Parser` (`application/deflate64`). `SnappyParser` now also claims `application/x-snappy`, which is the type Tika
claims (it had only the registry's `x-snappy-framed`). In `@spikedpunch/ripstream-parsers`, `WarcParser` now also claims
`application/warc+gz`, `application/arc+gz` and `application/x-internet-archive`: it inflates every gzip member (crawlers
write one per record) and reads ARC records as well as WARC ones; only an ARC record whose body is an HTTP response becomes
a document, as in Tika's `testARC`.

- **zlib** is `node:zlib` through the bounded inflate. **LZMA** (LZMA-alone, `.lzma`) is a hand-written range decoder,
  checked against output of a real encoder (Python's `lzma`), with Tika's 100,000 KiB memory limit (over it is a
  `LimitExceededError`, where Tika throws `TikaMemoryLimitException`). **Deflate64** is a hand-written decoder.
- Every decoder counts each byte against the output budget before it stores it, so a bomb stops at the cap, and every
  prefix of a valid input parses or is a `MalformedDocumentError`.
- The `.lzma` extension is not stripped from the entry name, because Tika's `setName` does not know it.

Not from Tika source: **Deflate64**, which Tika claims but cannot open (its `CompressorParserTest` lists the type as not
covered), so this goes beyond it. The decoder is written from the PKWARE appnote and zlib's `puff.c`, and has not been checked
against a real Deflate64 encoder (none was at hand): its tests use an encoder written here, so a misreading shared by both
would pass. Nothing detects a raw Deflate64 stream, so it is reached by an explicit content type only, and ZIP method 9 does
not use it. The **ARC** reader and the **LZMA** decoder's internals follow the published formats, not commons-compress, xz-java
or jwarc, whose source is not in Tika's tree. Not done: the Unix dump (`application/x-tika-unix-dump`) stays detected but
unparsed (`tikajs-68os.47`), and Pack200 is a declared non-goal.

### Executables: Mach-O variants and universal binaries (`tikajs-68os.17`)

Changed: `ExecutableParser` now follows Tika 4.2.0's. It reads at most the first 4 KiB, writes no text, and sets
`machine:architectureBits`, `machine:platform`, `machine:machineType` and `machine:endian`, the `Content-Type` of the ELF or
Mach-O header, and the PE `dcterms:created`. An unknown magic gives an empty document, not an error. It claims all 18 of
Tika's executable types, including the eight Mach-O types that had no parser (object, dylib stub, dylinker, fvmlib, kext,
preload, core, dsym). It no longer names ARM64 PE or AArch64 ELF machines, which Tika does not, and it reproduces Tika's
quirks (Mach-O sets 64 bits only, an ELF byte order other than 1 reads big-endian).

Added: `UniversalExecutableParser` (`application/x-mach-o-universal`) reads fat Mach-O files (32- and 64-bit tables, either
byte order) and gives each architecture to the embedded document extractor in offset order, with `Content-Length` as its
only metadata. Architectures are streamed, never allocated from the size the table declares; a table of over 1000
architectures, a bad offset, a size over 500,000,000, an overlap or a file that ends early is a `MalformedDocumentError`.

Read from Tika source, not run against a Tika. Not done: `PEIconExtractor` (the icons of a PE file) and
`ExecutableParserConfig`. Seven of Tika's test binaries are vendored under `packages/parsers/test/fixtures/executable`, with
their Apache 2.0 provenance in a README there.

### ODF types, GeoGebra, IDML, WACZ and XLZ (`tikajs-68os.12`, `.13`)

Added: the rest of Tika 4.2.0's `OpenDocumentParser` types and four ZIP-based formats that resolved no parser. Every package
is read through `boundedUnzip` (entry count, per-entry size and the ratio limit), and a limit is a `LimitExceededError`, never
a record in the metadata; a package that is not a readable ZIP, or a part that is not well-formed XML where Tika fails on it,
is a `MalformedDocumentError`.

- **OpenDocument** now also handles `application/vnd.sun.xml.writer`, chart, image, formula, text-master and text-web (and
  templates), with the `x-vnd.oasis.*` spellings as aliases. Charts give their titles and data table; the rows of a table
  are read through its header, body and group wrappers.
- **GeoGebra** (`GeoGebraParser`: worksheets `.ggb`, Notes/Slides `.ggs`, tools `.ggt`) gives the text objects (literals of
  expressions, captions, the text runs of rich-text `content`), the `geogebra:*` and `dc:*` construction metadata, the tool
  names and help, and each slide as a `div`. `structure.json` orders the slides (ignored over 1 MiB or when it is not JSON);
  thumbnails, scripts and pictures are embedded documents, a tool's icon being its thumbnail.
- **IDML** (`IDMLParser`, `application/vnd.adobe.indesign-idml-package`) gives the `Content` of the stories as paragraphs and
  `idml:spread-page-count`, `idml:master-spread-page-count` and `meta:page-count`. A spread without a `Spread` or
  `MasterSpread` element is a `MalformedDocumentError`, where Tika's `parseInt(null)` throws. Its XMP is read by a narrow
  port of `XmpExtractor` (`xmp-basic.ts`): `xmp:CreateDate`, `ModifyDate`, `MetadataDate` and `CreatorTool` only, with the
  dates normalised as `TikaDates` does and `dcterms:created`/`modified` filled when unset. Every other XMP property is
  dropped, and so are language alternatives. A malformed packet is a `tk:exception:warn` record, not a failure.
- **WACZ** (`WACZParser`, `application/x-wacz`) gives each entry under `archive/` as an embedded document, a gzip one
  inflated first (the first member only, as Tika's reader does, with its header read per RFC 1952). What the gzip entries
  inflate to counts against `maxTotalEmbeddedBytes` in all. `datapackage.json`, the pages and the indexes are not read, as in
  Tika.
- **XLZ** (`XLZParser`, `application/x-xliff+zip`) reads every entry whose name contains `.xlf` as XLIFF 1.2: a `div` per file
  with its `original` as a heading, a `div` per trans-unit and a `p` per source and target, `file-count`, `tu-count`, and the
  languages. Tika adds the source language under `original` as well, and so does this.

Read from Tika source, not run against a Tika, and none of Tika's own fixture files (`testGeoGebra.ggb`, `testIndesign.idml`,
the XLZ and WACZ samples) are in the tests: the archives are built in the tests. Not done: iBooks stays routed to the EPUB
parser, and the XMP of IDML is not the full `XmpExtractor` (`tikajs-68os.44` has the rest).

### Text and XML formats with a parser of their own: DIF, MIF, HTTP responses, emlx, XUL (`tikajs-68os.14`)

Added, in `@spikedpunch/ripstream-parsers`: `DifParser` (`application/dif+xml`, NASA GCMD records), `MifParser`
(`application/vnd.mif`, `application/x-maker`, `application/x-mif`, Adobe FrameMaker) and `HttpParser`
(`application/x-httpresponse`), each ported from Tika 4.2.0's parser of the same name. `MailParser` now also claims
`message/x-emlx`, and the HTML parser claims `application/vnd.mozilla.xul+xml`, `application/vnd.wap.xhtml+xml` and
`application/x-asp`, as Tika's `JSoupParser` does (XUL no longer goes to the XML parser).

- **DIF** writes a `dif:` value per leaf element under the path of element names joined with `-` (`dif:DIF-Entry_ID`), and the
  text is what Tika's handler writes: an `h3` "Title: ..." for `Entry_Title` and a "Geographic Data: " table of the four
  bounds. A name over 1024 characters is skipped and so is a new one after 10,000 distinct names, as `Metadata` does. Nesting
  past 2000 is a `LimitExceededError`. A DOCTYPE's DTD is never read, so a reference to an entity it declares is a malformed
  document.
- **MIF** gives the text of its `String` statements and the counts `meta:page-count`, `mif:master-page-count`,
  `mif:reference-page-count` and `mif:total-page-count`, and types the document `application/x-mif`. A line over 10,000,000
  characters and open-element names over 1,000,000 characters are a `LimitExceededError`. The text is XML-escaped before it
  is written, as Tika does, so a text output holds `&lt;` where the file had `<`.
- **HTTP** parses the `Content-Length` bytes after the headers as an embedded document with a fresh `Metadata`, and sets
  nothing from the headers; a response with no `Content-Length` has no payload, as in Tika. The container keeps the bare
  `application/x-httpresponse` (the text parser used to add a charset). Headers over 1 MiB are a `LimitExceededError`.
- **emlx** drops the byte-count line and, when the count lands on the plist's `<?xml`, the plist; a count that does not is not
  trusted and the message is read whole.

Read from Tika source, not run against a Tika. Not from Tika's source: how the HTTP headers are read (jwarc's source is not in
Tika's tree, so this is a lenient reading of an HTTP response, with a second `Content-Length` refused as malformed) and MIF's
XML escaping (commons-lang3's table, written from memory). Not done: general RFC 822 metadata for emlx (`Message:From-Email`,
UTC-normalised dates, raw headers and the choice between multipart alternatives) differs from Tika's, and the XUL, WAP XHTML and
x-asp types are tokenised by htmlparser2, not jsoup.

### Images: ICNS, ICO/CUR, WBMP, PPM, JBIG2 and XCF (`tikajs-68os.16`)

Added: image types that resolved no parser now have one in `@spikedpunch/ripstream-parser-media`. Each reads the header and
never the pixels, is bounded by the bytes present, and refuses a hostile size with `MalformedDocumentError` or
`LimitExceededError`. The type is dispatched on before the stream is read whole.

- **ICNS** (`image/icns`) and **ICO/CUR** (`image/vnd.microsoft.icon`, `image/x-win-bitmap`) follow Tika 4.2.0's `ICNSParser`
  and `ICOParser`: their keys (`Icon count`, `Icon details`, `Masked icon count`, `Masked icon details`; `icon:images`,
  `icon:image-count`, the cursor hotspot, `tiff:*`), their limits (10 MiB of ICNS, 16 MiB and 65535 px of ICO) and the rule
  that the largest image sets the size. Differences: Tika puts a Java stack trace in `tk:exception:warn`, this a
  `MalformedDocumentError: message` line.
- **WBMP**, **PPM/PNM** (`P1` to `P6`) and **JBIG2** write `tiff:ImageWidth`, `tiff:ImageLength`, `img:width`, `img:height`
  and `tk:num-images` for the first image, as `ImageParser` does for an ImageIO reader. Tika's source holds none of these
  three readers (ImageIO and jai-imageio own them), so they follow the public format headers; the reader's own IIOMetadata
  attributes are not written. A JBIG2 page of unknown height (striped) is typed but not measured.
- **XCF** is typed and nothing more, as in Tika: `ImageParser` has no reader for it.

Not done: **JPEG XL** stays unsupported (it needs Tika's XMP packet scanner and extractor, `tikajs-68os.44`). Read from Tika
source where Tika has the source, not run against a Tika.

### Pipes: GCS, Azure Blob and Solr components and the Elasticsearch and OpenSearch reporters (`tikajs-68os.31` to `.34`)

Added: Tika's `gcs-fetcher`, `gcs-emitter` and `gcs-pipes-iterator`, `az-blob-fetcher`, `az-blob-emitter` and
`az-blob-pipes-iterator`, `solr-emitter` and `solr-pipes-iterator`, and the `es-pipes-reporter` and
`opensearch-pipes-reporter` reporters. Each loads from a Tika-shaped configuration (`fetchers`, `emitters`,
`pipes-iterator`, `pipes-reporters`) and runs through `createEngineFromSettings`. No dependency was added: each speaks its
service's HTTP API with `fetch` (GCS also uses `node:crypto` to sign the service-account JWT).

- **GCS.** Objects are read, written and listed through the JSON API. Credentials are Google's application default
  credentials as Tika's client finds them, two of the sources: the service account key file `GOOGLE_APPLICATION_CREDENTIALS`
  names, and the metadata server of a Google Cloud VM (`GCE_METADATA_HOST` is honoured). The gcloud user credentials file is
  not read, and a key file of another type (`authorized_user`, `external_account`) is refused. The fetcher asks for the read-only scope. The emitter writes `prefix/emitKey.fileExtension`
  and puts the extension on bytes too, as Tika does. The iterator leaves out objects of 0 bytes.
- **Azure Blob.** SAS token only (`sasToken`, `endpoint`, `container`); Tika's connection-string mode, with the fetch key as
  the connection string, is refused. A blob name that is empty or has a `.` or `..` segment is refused, since a URL cannot
  carry it. `overwriteExisting` is false unless set, as Tika's: an existing blob is a 409. One trailing `/` of the iterator's
  prefix is dropped, as Tika drops it.
- **Solr.** `solrUrls` only; the first URL that a connection can be made to takes the request. `solrZkHosts`, a proxy and
  `verifySsl: false` are refused. Documents go to the JSON update handler, one request for each emitted document, where Tika's
  SolrJ sends javabin. A failure of the iterator's `/select` throws, where Tika logs it and ends the enumeration as complete.
- **Elasticsearch and OpenSearch reporters.** Each result is upserted as `<keyPrefix>parse_status` and
  `<keyPrefix>parse_time_ms`. `exit_value` is never written. A report that fails ends the run, where Tika logs and goes on.
  A `keyPrefix` that starts with `tk:` or `X-TIKA:` is refused (Tika's `Metadata` refuses it too). They refuse a proxy,
  `verifySsl: false` and, for Elasticsearch, any `authScheme` but basic, as the emitters do.

Every request sets `redirect: "error"`, so a credential never follows a redirect to another host. New run options `gcs`,
`azBlob` and `solr` replace the network, the clock, the environment or the token (a test's fake, or an emulator's address),
and `search` now serves the reporters too. Changed (types): `PipesReporterSettings` is now the union
`JsonlReporterSettings | SearchReporterSettings`; `JsonlReporterSettings` is the old shape, so code that read `.path` without
narrowing no longer compiles. `PipesFetcherSettings`, `PipesEmitterSettings` and `PipesIteratorSettings` are wider. The pipes
engine's dispatch is now an exhaustive `switch`, so a settings type that is not wired fails `tsc`. The refusal message lists
what is still missing: the jdbc and kafka components, the atlassian-jwt, google-drive and microsoft-graph fetchers, and the
csv and json iterators.

Not run against Google Cloud Storage, Azure Blob Storage, Solr, Elasticsearch or OpenSearch: the requests are read from
Tika's source and checked against fakes. Items that do not come from Tika's source: the GCS OAuth scopes, the Azure
`x-ms-version` (`2021-08-06`), reading a base64 `Name` in a blob listing, tolerating a leading `?` on a SAS token, and Solr's
JSON update format. See `docs/migration.md`.

### XML documents write a space per element and accept a DOCTYPE (`tikajs-68os.10.4`)

Changed: the XML parser puts one space at every start tag, as Tika's `XMLParser` does (its `TextContentHandler` adds space between elements),
so adjacent elements no longer run together; CDATA text is now kept and counts for the Dublin Core elements. A DOCTYPE is accepted, as in
Tika: its DTD is never read, nothing is fetched, and only the five predefined entities expand, so the billion-laughs and file-leak
documents are still refused as malformed. Limit: a reference to an entity the DTD declares (an Illustrator SVG's `&ns_extend;`) is still
malformed XML, where Tika expands it within JAXP limits. Read from Tika source, not run against a Tika.

### ZIP ratio limit and xlsx empty cells (`tikajs-68os.10.9`)

Changed: `maxDecompressionRatio` applies to a ZIP entry only above 1,000,000 uncompressed bytes (Tika's `zipBombThreshold`), so a blank bitmap no
longer trips it. The xlsx renderer writes a cell only when it has a value, as Tika's `TikaSheetXMLHandler` does, so styled empty cells no longer fill
the output cap (the bead's other claim, that Tika's cap ignores whitespace, is wrong: it counts it). Limit: a real file over 1,000,000 bytes
that compresses past the ratio is still refused. The same per-entry check is in the OPC reader, the bounded unzip and `util.ts`, unchanged.

### Metadata keys match Tika's for PDF, OOXML and MP4 (`tikajs-68os.10.5`)

Changed: PDF writes `xmpTPg:NPages` (was `pdf:PageCount`). OOXML `docProps/app.xml` writes Tika's `xmpTPg:NPages`, `meta:*-count`,
`extended-properties:*`, `doc-security-string` and `dc:publisher` keys; `extended-properties:Pages`, `Words`, `Characters` and `Slides` are gone.
MP4/MOV writes `xmpDM:duration`, `dcterms:created`, `dcterms:modified` and `tiff:ImageWidth`/`ImageLength` in place of `audio:spi-duration`.
There is no alias for a removed key: the project has no release. A client that read `pdf:PageCount` now reads `xmpTPg:NPages`.

Not done: audio sample rate, channels, frame rate and codec keys, geo keys and the brand-derived `Content-Type` for MP4/MOV; AVI, ASF and MKV
still write `audio:spi-duration` and were not checked against Tika; the 90% key-equality criterion needs a corpus comparison, and no corpus is
here. The MP4 creation time of 0 (1904-01-01) and the video size offsets are from the ISO layout, not from Tika's metadata-extractor
library, which is not in the source cache. ripstream reads `docProps/app.xml` by its fixed path where Tika follows the relationship, and a
malformed `app.xml` still fails where Tika ignores it. Read from Tika source, not run against a Tika.

### Unix dump and ZIP Unicode Path names; parity-gap type strings pinned (`tikajs-68os.20`, `.26`, `.15`, `.17`, `.18`, `.19`)

Added: a Unix dump header (a little-endian 60012 at offset 24 of at least 32 bytes) is detected as `application/x-tika-unix-dump`, checked
before the compressor signatures as `DefaultZipContainerDetector` does, so it beats a bzip2 signature. An Info-ZIP Unicode Path extra field
(`0x7075`) now names a ZIP member whose general-purpose bit 11 is clear, when its CRC32 is that of the name in the header; the last field
wins and a malformed one is ignored. Member names were already read as UTF-8 whatever bit 11 says, which is what Tika does, so `.26`'s premise
(CP437 without the flag) was wrong and there was no such difference to fix.

No behaviour change: tests now pin detection of the legacy Office (BIFF2-4 sheets, charts, macros, workspaces), iWork (`.13` and `.18`),
Mach-O (eleven file types and the universal binary) and ELF, Ogg, au, MIDI, M4V and HEIF-sequence type strings. Detection for those was
already complete. Their parsers and parser claims are still open (`.15`, `.17`, `.18`, `.19`), as are the deflate64, zlib, lzma and snappy
decoders, a dump parser and the WARC gz variants (`.20`).

Read from Tika source, not run against a Tika. The dump magic and the `0x7075` rule are commons-compress behaviour, which is not in the Tika
tree: they are from memory of that library and not measured.

### `ripstream serve` sets the `/unpack` byte budget (`tikajs-68os.28`)

Added: `server.maxUnpackBytes` in the configuration's `server` section is the most embedded-document bytes `/unpack` keeps for one request (the
server's `maxUnpackBytes` option, default 100 MiB). It is whole bytes, 0 or more; a value over 2 GiB, or over what an isolation's children can
hold, stops `serve` with exit 2 naming it. It is not a Tika key (Tika bounds `/unpack` by a 10 GiB constant), so a configuration that has it is
one Tika's own loader refuses. Config key only: there is no flag or environment variable.

### `${env:NAME}` in configuration (`tikajs-68os.30`)

Changed: a string value in the `--config` file may name an environment variable as `${env:NAME}`, alone or inside a longer string, in every
section, as Tika 4.2.0's `TikaJsonConfig.load` does (`EnvInterpolator`). Only that form is replaced: `${NAME}`, `$NAME` and keys are not, a
value is not expanded again, and a variable that is not set stops the command with exit 2, naming the variable and the JSON path and never a
value. `loadConfig(source, { env })` does the same for a library caller; without `env` nothing is replaced. Read from Tika source, not run
against a Tika.

Limits: the value is always a string, so a numeric setting such as `server.port` cannot be set from a variable. A reference reads the
server's environment, so load only a configuration the operator wrote (`docs/security.md`); a validation message may quote a value that was
already interpolated.

### Text and CSV: the sniffer decides (`tikajs-68os.36`)

Changed: `CsvParser` now serves `text/plain`, `text/csv` and `text/tsv`, as Tika 4.2.0's `TextAndCSVParser` does, and sniffs the first 20,000
characters (Tika's `CSVSniffer`: comma, tab, pipe and semicolon, each scored by how regular its row widths are, with a bonus for quoted
cells; a delimiter needs a confidence of 0.50). A table now carries `Content-Type: text/csv; charset=X; delimiter=comma` (`semicolon`, `pipe`;
`text/tsv` and `delimiter=tab` for tabs), `csv:delimiter`, `csv:num-columns` (the first row's cells), `csv:num-rows` and `Content-Encoding`.
A document the sniffer does not take for a table is `text/plain; charset=X`, even when it came in as `text/csv`, and has no `csv:*` keys.

What a client will see, at the default confidence (computed from the formula, not run against a Tika):
- A small CSV is text. Ten regular rows score 0.499 and eleven 0.513, so a table with no quoted cells needs eleven rows; three score 0.281.
  Quoted cells lift a short table over the line (three rows of two quoted cells score 0.582). A table whose rows are so wide that
  fewer than eleven fit in 20,000 characters is text.
- A `.tsv` is text: Tika's text parser does not sniff `text/tab-separated-values`, which keeps that type and gains the charset.
- A `text/plain` document with regular columns, whatever its name, is a table.
- Any other text subtype (`text/x-python`, `application/json`) is read as text and keeps its type, as before.

Added, ripstream's own: `csv: { markLimit, minConfidence, delimiter }`. `markLimit` and `minConfidence` are Tika's `TextAndCSVConfig`
(Tika's own tests lower the confidence to 0.2); `delimiter` is one character that reads every document of those types as a table and sniffs
nothing. A delimiter Tika has no name for is written in `Content-Type` as its character code, with no `csv:delimiter`.

Differences, read from Tika source and not run against a Tika: Tika's per-request `tk:content-type-override` path, custom delimiters and
its colon rule are not ported. `csv:num-rows` counts the rows ripstream's scanner emits, which skips blank lines; Tika's commons-csv
may count them, and that was not measured. A hostile table is still bounded by `maxRowChars` and `maxCellsPerRow`.

### `/language` keeps only the start of the body (`tikajs-68os.9.5`)

Changed: `/language` reads the first 100,000 characters of a body and ignores the rest, as Tika does. It now keeps only the first
400,000 bytes (enough for 100,000 characters at up to four bytes each) and drops the rest as it arrives, where it held the whole
body until the request ended. The answer is the same, and a body over `maxBodyBytes` is still refused with 413 on a connection
that lives on. Body reading moved from `index.ts` to `request-body.ts` (`readBody`, `readBodyPrefix`, `readRawBody`), unchanged
for every other route.

Measured, a `PUT /language` of 100 MiB to a server in its own process, peak RSS (the process starts at about 117 MB): 413 MB before
and 204 MB after for English text, 437 and 211 MB for random bytes, 408 and 220 MB for a repeated trigram. A plain Node server that
reads the same 100 MiB and drops it peaks at 147 MB from a 79 MB start, so most of what is left is Node's own read buffers, not the
route. 10 MiB: 163 to 149 MB. The answers (`en`, `wa`, `vi`) did not change at any size.

Limit: a body sent with `Content-Encoding: gzip` is still inflated whole, bounded by `maxBodyBytes`, because its start cannot be had
without the rest. The memory result is the measurement above; no unit test fails if the route goes back to reading the whole body.

### XML and feed documents carry no `Content-Encoding` (`tikajs-68os.37`)

Changed: the XML parser (XML, SVG and the types it serves) and the feed parser no longer write `Content-Encoding`. Tika 4.2.0's
`XMLParser` and news parsers never set it; of Tika's parsers only the text, HTML, Markdown, CSV, source-code, mail, mbox,
PDF, DBF, MIF, SAS7BDAT and ENVI parsers do. The charset is still detected and used to decode; it is not reported. A client
that read `Content-Encoding` from an XML or RSS record gets none, as it would from Tika. Read from Tika source, not run against
a Tika: no saved Tika response of an XML document is in the repository to compare with.

### The text parsers write the charset into `Content-Type` (`tikajs-68os.29`)

Changed: a text document's `Content-Type` is now `<type>; charset=<charset>`, as Tika's text parsers write it. That covers plain
text and its subtypes (`text/plain`, `application/json`, `text/x-python`, ...), HTML (`text/html`, `application/xhtml+xml`),
Markdown (`text/markdown`) and CSV and TSV. Java and C++ source keep the bare type, as Tika's `SourceCodeParser` leaves it. An
ASCII-only document, or one under two bytes, now detects as `windows-1252` (what Tika 4.2.0's `MojibusterEncodingDetector`
answers) where it detected as `UTF-8`: `Content-Encoding` says so too. The text decodes the same, since ASCII is ASCII in both.
Valid UTF-8 with a byte over 0x7f is still `UTF-8`, and a BOM, a `meta` charset or an XML declaration still wins.

Visible: the `Content-Type` and `Content-Encoding` of every text-family record from `/rmeta`, `/meta`, `/tika` and the pipes
emitters. `/unpack` and pipes UNPACK with `suffixStrategy: DETECTED` name a text, HTML or Markdown file `.bin`, as Tika does, because
its registry has no extension for a type with parameters; this was `tikajs-68os.7.4`'s difference (1). A client that compared
`metadata.get("Content-Type") === "text/plain"` must now read the base type (`MediaType.parse(value).getBaseType()`).
`ParseRecord.mediaType` and `MetricsCollector.byMediaType` stay the bare type (`text/plain`), so neither splits by charset.

Differences, read from Tika 4.2.0 source and not run against a Tika; the first four are `tikajs-68os.38`:
- There is no Mojibuster port. Non-ASCII text that is not valid UTF-8 is still detected by chardet, so legacy-charset text can
  report another charset name, and decode differently, than Tika's.
- An incoming charset (a request's `Content-Type: text/plain; charset=x`) is not read. Tika reads it before it detects.
- Tika probes 16 KiB of content (up to 512 KiB of raw bytes for markup); ripstream probes 64 KiB. A file whose first byte over
  0x7f falls between the two is `windows-1252` in Tika and `UTF-8` here. A file that is ASCII for the whole 64 KiB and then holds
  UTF-8 is decoded as `windows-1252`, as Tika would decode it: the later text comes out as mojibake.
- 7-bit ISO-2022-JP, -KR and -CN text is detected structurally by Tika, not here.
- CSV: Tika's parser for text/plain and text/csv sniffs the delimiter and decides whether a `.txt` is a table, and reads a
  `.tsv` as text. Fixed by `tikajs-68os.36`, above.

### `tk:embedded-resource-type` (`tikajs-68os.35`)

Added: the parsers that hand embedded documents on now write `tk:embedded-resource-type`, with Tika's values
(`TikaCoreProperties.EmbeddedResourceType`). A mail part is `INLINE` when its `Content-Disposition` is `inline` (any case) and
`ATTACHMENT` otherwise, with none or another disposition, as `MailContentHandler` does. An OOXML part (docx, xlsx, pptx) is typed by
the relationship that reaches it, as `AbstractOOXMLExtractor` does: image is `INLINE`; audio, video, media, package and oleObject
are `ATTACHMENT`. A PDF's embedded file is `ATTACHMENT`. `clear-by-attachment-type-metadata-filter` now has something to match:
on Tika's own `test_recursive_embedded.docx` it empties the EMF picture (`INLINE`) or the OLE object (`ATTACHMENT`) and keeps the other.

Differences: ripstream's OOXML parser extracts the parts under `embeddings/` and `media/` whether or not a relationship reaches
them, where Tika extracts what relationships reach; a part no relationship reaches is extracted without a type, and one reached
by relationships of different types takes the first relationships file by name (Tika's order is POI's). Archive entries have no
type, as in Tika. Not typed because ripstream does not extract them: thumbnails, macros, XMP and XFA, PDF JavaScript, incremental
updates and page renderings, alternate-format chunks, and the embedded documents of ODF, iWork, HTML, EPUB, images, audio and
video, which Tika types (`EMBEDDED_DOCUMENT_EXTRACTOR` is read only by the archive, OOXML, PDF and mail parsers). Read from Tika
source, not run against a Tika.

### Language detection: Tika's CharSoup detector, and the filter that writes `tk:detected-language*` (`tikajs-68os.9.3`)

Added: `CharSoupLanguageDetector` in `@spikedpunch/ripstream-language`, a port of Tika 4.2.0's `CharSoupLanguageDetector`
(`tika-langdetect-charsoup`) that runs Tika's own model, `langdetect-20260320.bin` (204 languages, 6,687,361 bytes, shipped
in the package's `data/`; `NOTICE` carries the attribution). `identify(text, { maxLength })` answers as Tika's `detect` does
(`language` as ISO 639-3, or `""`; `confidence` `HIGH`, `MEDIUM`, `LOW` or `NONE`; `rawScore`, a 32-bit float), and `detect(text)`
is the `LanguageDetector` answer (`und` when there is none, the raw score as the confidence, `isReasonablyCertain` for `HIGH`).
`charsoup-metadata-filter` is accepted in `metadata-filters` (and under `parse-context`): from `tk:content` it writes
`tk:detected-language`, `tk:detected-language-confidence` (the confidence's name) and `tk:detected-language-confidence-raw` (the
score as Java's `Double.toString` writes it, `0.0` for `NONE`), replacing what the document had, and leaves a document with no
or empty content alone. Its one setting, `maxLength` (a whole number from 1 to 2147483647), is how many characters it reads;
Tika reads 100,000 by default. Measured here, on one core: the first call, which reads the model, takes 5 ms; a text of 100
characters takes 0.14 ms and of 100,000 characters 4.1 ms.

Core has no dependencies, so the filter is built with a detector that whoever builds the chain hands in:
`createMetadataFilter(entries, services)` and `metadataFiltersOf(config, services)` take `MetadataFilterServices`
(`languageIdentifier`), `PipesSettingsRunOptions` and `AsyncProcessorOptions` take `metadataFilterServices`, and
`createRipstreamServer` takes `metadataFilterServices` and defaults to CharSoup. `ripstream --recursive`, `pipes` and `serve` use
CharSoup. A chain that names the filter and has no identifier fails when it is built (a server, when it starts), never on the
first document. New core exports: `LanguageDetectionMetadataFilter`, `MetadataFilterServices`, `LanguageIdentifier`,
`LanguageIdentification`, `LanguageConfidenceName` and `TIKA_KEYS.DETECTED_LANGUAGE`, `DETECTED_LANGUAGE_CONFIDENCE` and
`DETECTED_LANGUAGE_CONFIDENCE_RAW`.

Changed (breaking): `PUT /language`, `POST /language` and `ripstream language` detect with CharSoup, not franc. The answer for the
same text can differ, and a short text gets the detector's best guess, as Tika's `/language` gives it, where franc said `und`
below 10 characters (`Bonjour` is `fr`, with a raw score of 0.75 and `LOW`; an empty or blank body is still an empty answer, and
`und` as JSON). The JSON `confidence` is the raw score, a number above 0.5, where franc's was a constant 0.9, and
`isReasonablyCertain` is true for `HIGH` only, a score above 0.9. `FrancLanguageDetector` and `Cld3LanguageDetector` are still
exported.

Not the same as Tika, and not checked against it: there is no JDK here and the probe of a running Tika was declined, so the
detector is checked against Tika's own tests (the 20 sentences of `LangIdRegressionTest`, the cases of
`CharSoupFeatureExtractorTest`) and by mutation, not by running both on the same texts. The letter, mark and script tables
are Node's (Unicode 17 on Node 24) where Java 17's are Unicode 13, and a Tika on a later JDK has that JDK's: a character
assigned since can be a letter here and not there, which changes that text's features. `Double.toString` is the shortest-digits form of JDK 19 and later; JDK 17 gives a
few doubles an extra digit, which no score here is. `maxLength` below 1 is refused when the configuration loads, where Tika
accepts it and writes `NONE` for every document. Script gating, which Tika's detector leaves a no-op, and its
charset-comparison helpers are not ported. See `docs/migration.md`.

### Metadata filters: the `metadata-filters` section is read and run (`tikajs-68os.9.2`)

Added: `metadata-filters` (and `metadata-filters` under `parse-context`) in a Tika configuration builds a chain of Tika's filters
(`include-field-metadata-filter`, `exclude-field-metadata-filter`, `field-name-mapping-filter`,
`capture-group-metadata-filter`, `clear-by-attachment-type-metadata-filter`, `remove-by-mime-metadata-filter`,
`date-normalizing-metadata-filter`, `geo-point-metadata-filter`, `legacy-key-migration-filter`, `no-op-filter`) that runs on the
metadata list as it is written, with `tk:content`, the depth and the embedded paths already in it. It runs where Tika's emit
runs it: `serializeRmeta` and `rmetaObjects` (`metadataFilter`), every `pipes` mode (the parse-context chain, else for
`CONTENT_ONLY` the content and the container exception, else the configured chain), `ripstream --recursive` (the configured
chain, as `TikaCLI` does, and no other command), and `ripstream serve` (`/rmeta`, `/meta`, `/meta/{field}`, `/unpack`'s
`rmeta.json`, `/tika/json`, `?handler=meta|json`; the text routes run the parse-context chain alone; `/pipes` and `/async` run
their settings'). No section, or an empty one, runs nothing and every output is what it was. A configuration is checked when it
loads and every problem is reported at once. New core exports: `createMetadataFilter`, `emitMetadataFilter`,
`metadataFiltersOf`, `filterDocument`, `filterRmetaObjects`, `MetadataFilterBase`, `CompositeMetadataFilter`, `NoOpFilter`,
the nine filters and their option types, `LegacyKeyMigrationFilter`, `parseTikaDate`, `normalizeTikaDate` and the
`EmitMetadataFilters`, `MetadataFilterEntry` and `FilteredDocument` types. `createRipstreamServer` takes `metadataFilters`,
`PipesEngineOptions` takes `metadataFilters`, `EmittedDocument` has `objects` (the list as it is written, filtered) and
`PipesSettings` has `metadataFilters` and `parseContextMetadataFilters`.

Breaking: `MetadataFilter` is Tika's, `filter(list, context): void` over the whole list, where it was `filter(metadata): Metadata`;
`IncludeExcludeFilter` and `IncludeExcludeOptions` are removed (globs, case-insensitive) for `IncludeFieldMetadataFilter` and
`ExcludeFieldMetadataFilter` (exact, case-sensitive names, as Tika's). Typed `rmetaObjects` output has `tk:embedded-depth` as a
number, as it has every other integer key. The camelCase `metadataFilters` key is still refused, now as an unknown key. Fixed on
the way: a type error in the CLI (`emitter.onExists` read from the union of all emitters, which the S3 and search emitters made) that stopped
`tsc -b`; the warning it belongs to is for file-system emitters, the ones with that setting.

Refused by name: `optimaize-metadata-filter`, `open-nlp-metadata-filter` and `tika-eval-metadata-filter` (proposed non-goals,
`tikajs-68os.24`); `charsoup-metadata-filter` was refused until `tikajs-68os.9.3`, see Language detection above. Not the same as Tika, read from
its source (there is no Java here to run it): a request cannot name filters (`NG-5`); a filter that throws fails the input where
Tika logs and goes on; a regex with no capture group is refused at load; a value that is not a date is left without the warning;
region zone ids use the runtime's time zone data; `legacy-key-migration-filter`'s `table` is accepted only as Tika's own default
(a library caller passes `rows`); enum values are exact-case and settings are strictly typed (`NG-6`). `clear-by-attachment-type-metadata-filter`
matches `tk:embedded-resource-type`, which the mail, OOXML and PDF parsers write (`tikajs-68os.35`). See `docs/migration.md`.

### Digesters: the `parse-context` digester factories make `tk:digest:*` (`tikajs-68os.9.1`)

Added: `commons-digester-factory` and `bouncy-castle-digester-factory` are read from `parse-context` (`digests` of
`{algorithm, encoding}` and `skipContainerDocumentDigest`; Tika's names and defaults, MD5 in hex when none is named) and every
document, the container and each embedded one, gets the digests under Tika's keys (`tk:digest:MD5`,
`tk:digest:SHA-256:BASE32`, ...), made in `AutoDetectParser` before the type is detected, with `Content-Length` where nothing
set it. All nine algorithms and the three encodings are there: MD2 is ripstream's own (RFC 1319, since OpenSSL 3 has none;
about 5 MiB/s against MD5's 600), the rest are `node:crypto`'s. The settings reach the isolation child
(`IsolatedComponents.digest`, checked in the request header) and the in-process side of `createStandardIsolation`;
`createRipstream` takes a `digest` option for a ripstream built beside a `detector`; `pipes` `NO_PARSE` digests and detects, as
Tika's `ParseHandler.detectOnly` does (`PipesSettings.digest`, set by `loadConfig` as `unpack` is), and now also writes
`tk:resource-name`, `Content-Length` and `tk:content-type-parser-override`; a pipes engine made from settings digests in every mode
with the ripstream it builds from them. A plain `parse` no longer digests the embedded documents whose metadata it drops.
`new Ripstream({ digest })` checks hand-built settings when it is made. New core exports: `DIGEST_ALGORITHMS`, `DIGEST_ENCODINGS`, `digestKey`, `digestBytes` and the
`DigestDef`, `DigestSettings`, `DigestAlgorithm` and `DigestEncoding` types.

Refused at load, as Tika's mapper refuses them: an unknown setting, an unknown algorithm or encoding, and both factories at
once; and SHA3 under the Commons factory (the message names the other one), which Tika refuses later, on the first parse. Jackson's
leniencies (a string or number for the boolean, a null encoding) are not reproduced, and Tika's example configurations carry an
`auto-detect-parser` section that is refused here (`tikajs-68os.8.13`): drop it. See `docs/migration.md`.

Verified against Tika's own `DigestConfigTest`: its `test_recursive_embedded.docx` (vendored unmodified, in `NOTICE`) gives the
MD2, MD5, SHA1, SHA256, SHA384, SHA512, SHA3-512 and SHA1 BASE32 digests that test hard-codes, in-process and, for the CLI, under
strict isolation (`packages/cli/test/digest.test.ts`). Not the same: Tika digests an embedded OLE2/`oleObject` document after POI
re-writes it, so those embedded digests can differ; and an email in a PST gets no digest and no `Content-Length` in Tika (the
translator writes nothing and nothing is published), where ripstream digests the bytes it extracted (read from source: there is
no Java here to run Tika). `DigestSink` is not built. See `docs/migration.md`.

### Pipes: S3, Elasticsearch and OpenSearch components, with no cloud or search SDK (`tikajs-68os.6.6`)

Added: the Tika component settings `s3-fetcher`, `s3-emitter`, `s3-pipes-iterator`, `es-emitter` and `opensearch-emitter` are
read from `fetchers`, `emitters` and `pipes-iterator` and built by `createEngineFromSettings`. S3 is signed with SigV4 over
`fetch` (`signV4`, `S3Client`, `S3Fetcher`, `S3Emitter`, `S3PipesIterator`; the credentials come from `key_secret`, a `profile`
in the AWS files or the EC2 instance role) and works against an `endpointConfigurationService` such as MinIO, in path style
or virtual-hosted style as the AWS SDK for Java chooses. Elasticsearch and OpenSearch share `BulkSearchEmitter`, which sends
the `_bulk` request Tika's clients build (`OVERWRITE`/`UPSERT`, `PARENT_CHILD`/`SEPARATE_DOCUMENTS`, basic authentication or an
Elasticsearch `apiKey`). No dependency was added. `documentObjects` is exported from the file-system emitter's module for
the emitters that index the metadata list. The new `PipesSettingsRunOptions` fields `s3` and `search` replace the network
(a test's fake).

Refused by name, with the reason: S3 `throttleSeconds` and the `role_arn`/`sso`/`credential_process` credential flows; search
`chunkStrategy: DOCUMENTS`, a proxy, `verifySsl: false` and `authScheme`s but basic. Accepted and said to change nothing:
`spoolToTemp`, `maxConnections`, `countTotal`, `commitWithin`, `idField` and, for the S3 fetcher, `extractUserMetadata`.

Not run against AWS, an S3-compatible service, Elasticsearch or OpenSearch; the requests are checked against fakes (a fake S3
that recomputes the SigV4 signature from the wire, and a `_bulk` endpoint that records the body). GCS, Azure Blob, Solr and the
search reporters are tracked in `tikajs-68os.31` to `.34`; the JDBC components are a proposed non-goal. See `docs/migration.md`.

### Pipes: UNPACK emits Tika's Frictionless package, and `parse-context` `unpack-config` (`tikajs-68os.6.7`)

Changed (breaking): pipes' `UNPACK` mode emits what Tika's `PipesWorker` does by default, one zip per input at
`<emitKey>-frictionless.zip` holding `datapackage.json`, `rmeta.json` and `unpacked/<id>` (no suffix: Tika's
`suffixStrategy` is `NONE`). The metadata list is `rmeta.json`, so nothing is emitted at `<emitKey>` any more, and the
zip is written as it is: no `fileExtension` and no compression. An input with nothing embedded still gets a package. The
old output (the `RMETA` list at the emit key and each embedded document at `<emitKey>-embed/<id>`) is `outputFormat:
"REGULAR"`; the engine's `createEngine` shorthand keeps it. The engine option `unpack` is new (`PipesEngineOptions`,
`PipesRunOptions`), as is `extensionOf` (the media type to extension lookup that `suffixStrategy: DETECTED` needs; `.bin`
when none is given).

Added: the `parse-context` component `unpack-config` is read: `outputFormat`, `outputMode` (`ZIPPED`, or `DIRECTORY` to emit
each file of the package under `packageRoot`), `suffixStrategy`, `zeroPadName`, `embeddedIdPrefix`, `keyBaseStrategy`,
`emitKeyBase`, `includeOriginal`, `includeMetadata`, `packageRoot`, `packageName` and `maxUnpackBytes`. `emitter`,
`zipEmbeddedFiles`, `emptyPackage`, `includeMetadataInZip` and `includeFullMetadata` are refused by name with the reason, a
key that is not UnpackConfig's is unknown, and `maxUnpackBytes: -1` is refused (the bytes are held in memory). The result is
`PipesSettings.unpack` (`UnpackSettings`, `parseUnpackConfig` and the `UNPACK_*` name lists are exported from core). A
configuration with an `unpack-config` and no pipes sections is told it changes nothing.

Changed: the Frictionless writer (`buildUnpackPackage`, `zipChunks`, `packageName`) moved from `@spikedpunch/ripstream-server`
to `@spikedpunch/ripstream-pipes`, which `PUT /unpack` and pipes now share; the server's `extensionFor` is exported, and now
reads `image/ocr-X` as `image/X` as Tika's `calculateExtension` does. `AsyncProcessorOptions`, `TikaPipesOptions` take
`extensionOf`; `createRipstreamServer` gives its `mimeTypes` to `/pipes` and `/async`, and `ripstream pipes` builds the registry the server uses.

Not done: nothing was run against a live Tika, so the manifest and `rmeta.json` bytes are those of the source reading. The
package is built in memory beside the bytes already held. `unpackBytes` stays 100 MiB (Tika's 10 GiB).

### Pipes: `ripstream pipes`, and Tika's `/pipes` and `/async` (`tikajs-68os.6.5`)

Added: `ripstream pipes --config=FILE [--checkpoint FILE] [--retry-attempts N]` runs the configuration's pipes sections: the
`pipes-iterator` lists tuples, fetchers read them, each document is parsed, emitters write it and reporters hear every result.
A failed input does not stop the run; up to 100 are named on stderr and the exit code is 3 when there was one (2 for a
configuration without pipes sections or a checkpoint file that cannot be used). `-j` prints the counts as one JSON line.
Isolation is off unless `--isolation` is given. `@spikedpunch/ripstream-cli` now depends on `@spikedpunch/ripstream-pipes`.

Added: `createRipstreamServer({ pipes: { settings, authenticate, asyncMaxWaitMs? } })` serves Tika's tuples. `POST /pipes`
without a `source` takes one `FetchEmitTuple` and answers `{status, message?}` with Tika's HTTP status: 200 for every success
category, 400 for a fetcher, emitter or preset that is not there, 413 `PAYLOAD_LIMIT_EXCEEDED`, 429 with `Retry-After`, 503 with
`Retry-After: 5` for a timeout or a crash, 500 otherwise. `POST /async` with `{"tuples": [...]}` checks the whole batch against
the configured components (400 `can't find fetcher for X`), queues it and answers `200 {status: "ok", added}`; a queue that
stays full for `asyncMaxWaitMs` (5 s; Tika's is 60 s) is `429 {status: "throttled", message, capacity}` with `Retry-After`, a
batch larger than `pipes.queueSize` is a 400, and `close()` finishes every tuple that was accepted. Fetcher and emitter ids
that start with `__` and the tuple fields `parseContext`, `preset`, `metadata` and the byte range are a 400. The batch job
(`{source, sink}`, `sourceRoot` now optional) and the raw-document `/async` job still work beside it. `ripstream serve` does not
turn the routes on: `authenticate` is code (follow-up bead). Both routes need `authenticate`, as `/pipes` always did.

Added (`@spikedpunch/ripstream-pipes`): `AsyncProcessor` (a bounded queue of tuples run in the background with `offer`,
`capacity` and `close`), `OfferLargerThanQueueSize`, `DEFAULT_ASYNC_QUEUE_SIZE`, `httpResponseFor(status, retryAfterSeconds)`
(Tika's PipesResult to HTTP mapping; `Retry-After` for 429 is whole seconds, at least 1) and `PipesHttpResponse`.
`createEngineFromSettings` takes `retry` and `checkpoint`.

Fixed: an iterator that fails while every worker is busy with an earlier tuple now ends the run with its error; a failure of
the engine's own fetch-ahead is recorded and no longer left unhandled.

Not done, on purpose: `/pipes` runs no settings reporter (its answer is the report) and takes no checkpoint or retry (an
engine is built for each request); `PASSBACK_ALL` is refused as Tika refuses it on `/pipes` (`CFG-128`, a non-goal: use a
reporter or `MemoryEmitter` in code). The CLI's `--retry-attempts` reaches the engine through `createEngineFromSettings`, which a
library test proves; no CLI test can see it.

### Pipes: resume a stopped run, retry a transient failure (`tikajs-68os.6.4`)

Added: engine option `checkpoint` (`CheckpointStore`, or anything with `has(id)` and `mark(id)`). An input an earlier run
finished is not fetched, parsed or emitted, and is counted in the new `stats.resumed` (`stats.fetched` now counts what the
run went on with). An input is recorded after it succeeded and its result was reported, never before; one that failed is done
again. A checkpoint that cannot record ends the run with its error. Tested with `kill -9` in the middle of a run and a second
run that finishes it. A run killed between an emit and the record emits that input again, so the emitter must take a second
write (`onExists` `REPLACE` or `SKIP`; with `EXCEPTION` that one input is `EMIT_EXCEPTION`).

Added: engine option `retry` (`attempts`, `baseDelayMs`, `maxDelayMs`, `retryIf`) tries a fetch or an emit again when it failed in
a way that may not repeat (`isTransientError`: connection reset, refused or timed out, `EAI_AGAIN`, `EBUSY`, HTTP 408, 425,
429, 500, 502, 503, 504), with a doubling wait with jitter that an abort ends. Each emitted document is tried on its own.
`withRetry` takes `retryIf` and `signal`, and its waits now carry jitter. `HttpFetcher` throws `HttpStatusError` (same message,
with `status`) and takes `fetchImpl` and `lookupImpl`.

Changed (breaking): `CheckpointStore` writes a journal (one JSON string a line, appended) where it rewrote one JSON array on
every `mark`, which took 1.1 ms an id at 16 000 ids and grew with them (17.4 s for 16 000 marks; now 1.0 s, and 5.5 s for
100 000). A file in the array format is refused with a message that says so. `mark` calls are appended one at a time in call
order and `has(id)` is true only once the append is done. `PipesStats` has `resumed`.

### Pipes: Tika's file-system emitter and parse modes (`tikajs-68os.6.3`)

Changed (breaking): `FileSystemEmitter` is Tika's emitter and takes an options object, `new FileSystemEmitter({ basePath,
allowAbsolutePaths?, fileExtension?, onExists?, atomicWrites?, compression?, prettyPrint? })`. The output is
`basePath/emitKey` with nested directories (a key that leaves `basePath` is `path traversal?!`); `onExists` is `EXCEPTION`
by default, so a second write to a file is an `EMIT_EXCEPTION` for that input and leaves the file as it was (`SKIP` and
`REPLACE` are the others); a write goes to a temporary file in the same directory and is published in one step unless
`atomicWrites` is false; `compression: "GZIP"` adds `.gz`. The class that wrote one flat directory (`.txt` / `.bin`,
overwriting) is `FlatFileEmitter`, which the shorthand config's `sink` uses, so `sink` output does not change.
`PipesRipstream` also needs `detect` (a core or isolated ripstream has it).

Changed (breaking): the parse modes follow Tika's, per input. CONCATENATE emits one document for each input (it joined the
run into one `concatenated` document, and `concatenated` is no longer a result id). NO_PARSE emits what detection finds
(`Content-Type`), no content and no copy of the bytes. UNPACK emits the RMETA list at the emit key and each embedded
document's bytes at `<emitKey>-embed/<embedded id>`, up to the new `unpackBytes` engine option (default 100 MiB), where it
emitted text for each record. `EmittedDocument.mode` says which mode made a document; `Reporter.report`'s tuple is
always given. With `ordered`, CONCATENATE is delivered in fetch order like the other modes.

Added: the file-system emitter's seven settings are read from a Tika configuration (`fileExtension`, `onExists`,
`atomicWrites`, `compression`, `prettyPrint`, `allowAbsolutePaths`, `basePath`, with Tika's defaults and enum names) and
applied by `createEngineFromSettings`; the refusals that pointed here are gone. Of Tika's own 103 configurations with a pipes
section, 6 now load (3 before); the rest ask for something else as well (tasks/parity/audits/pipes-model-spike.md). The one
Tika UNPACK piece left was its default Frictionless zip (done in `tikajs-68os.6.7`).

### Pipes: tuples, fetchers and emitters by id, and Tika's pipes configuration (`tikajs-68os.6.2`)

Changed (breaking): the engine's unit of work is a `FetchEmitTuple` (`{ id, fetcher, fetchKey, emitter?, emitKey?,
onParseException? }`), read inside the worker that takes it. `Fetcher` is now `fetch(key, { signal }) -> bytes`, registered by
id in `PipesEngineOptions.fetchers`, with emitters in `emitters` and tuples from `iterator`. The old iterator of documents
is `DocumentSource`, given as `source`, which the engine bridges with an `__inline` fetcher; `PipesEngineOptions.fetcher`
is removed (an engine takes an `iterator` or a `source`, not both). `FileSystemFetcher` is keyed (`basePath`,
`allowAbsolutePaths`, `confineSymlinks`) and the listing is `FileSystemPipesIterator`; `HttpFetcher` is keyed and the URL list
is `UrlListPipesIterator`. `CsvFetcher` and `JsonFetcher` are `CsvSource` and `JsonSource`; `ModuleFetcher` loads the
module's `createFetcher` once and gives it keys. `Reporter.report(result, tuple?)` gets the tuple; `JsonlReporter` takes
`{ onExists, maxMessageLength }` and prepares its file when it is made.

Added: Tika's pipes sections load. `loadConfig` reads `fetchers`, `emitters`, `pipes-iterator`, `pipes-reporters` and
`pipes` into `RipstreamConfig.pipes`, and `createEngineFromSettings` builds an engine from them. Tika's defaults hold
(`parseMode` RMETA, `onParseException` EMIT). `plugin-roots`, the JVM process settings and the emit-batching settings are
accepted and `RipstreamConfig.notices` (and `inspectConfig`) says each changes nothing; every other key, and every
component type ripstream lacks, is refused by name with the reason, all at once. `FETCHER_NOT_FOUND` and
`EMITTER_NOT_FOUND` are produced for a tuple that names a component that is not registered. `parseFetchEmitTuple` reads a
tuple from JSON and refuses the fields ripstream cannot act on (`fetchRangeStart`, `fetchRangeEnd`, `metadata`, `preset`,
`parseContext`) by name. `FileSystemFetcher` keeps every key under `basePath` and refuses a symbolic link that leaves it, as
Tika's does. Measured (tasks/parity/audits/pipes-model-spike.md): with 20 ms per fetch and 16 workers the rate is 653 files/s
against 43 when the iterator read the bytes, and 60 files of 20 MB behind a slow emitter hold 240 MB against 1200 MB.

Changed: the shorthand config's `followSymlinks: true` still reads through a link that leaves the root; a file in the tree
that is not a regular file (a FIFO) is now a `FETCH_EXCEPTION` for that input instead of being passed over.

### Pipes: a result per input, and a run that goes on (`tikajs-68os.6.1`)

Changed (breaking): `PipesEngine.run()` no longer rejects at the first input that fails. Every input ends in a
`PipesResult` (`{ id, status, category, message?, elapsedMs }`) with one of Tika's 21 statuses (`PIPES_RESULT_STATUSES`
lists them with their category), and the run goes on. It rejects only for what no input can carry: the iterator, the
reporter or `close` throwing, or a source that cannot be listed. `Reporter.report(result)` replaces `report(stats)` and
is called for every input, one at a time, in the order results settle; `LoggingReporter`, `JsonlReporter` and
`CompositeReporter` take it, and the first two take Tika's `includes` / `excludes` status filter (naming both, or a
status that is not one, is refused). `Fetcher` may yield a `PipeFetchFailure` (`isFetchFailure`) for an input it could
not read; `FileSystemFetcher` and `HttpFetcher` do. `createEngine` and `PipesClient` take a `PipesRunOptions` with
`reporter` and `onParseException`. `PipesStats.byStatus` counts the inputs by status, and `stats.failed` counts those
whose category is not SUCCESS, as Tika does.

Tika's defaults: a document that cannot be read (malformed, encrypted) is emitted with its exception
(`EMIT_SUCCESS_PARSE_EXCEPTION`, `tk:exception:container-exception`); `onParseException: "SKIP"` leaves it out
(`PARSE_EXCEPTION_NO_EMIT`). A fetch that fails is `FETCH_EXCEPTION`, an emitter that throws is `EMIT_EXCEPTION`, an
empty parse is `EMPTY_OUTPUT`, a timeout is `TIMEOUT`, a full queue is `CLIENT_UNAVAILABLE_WITHIN_MS`, a document over a
limit is `PAYLOAD_LIMIT_EXCEEDED` (the nearest of Tika's, which means a frame too large to send), and an error that is
not the document's is `UNSPECIFIED_CRASH`. `OOM` is not told apart from a limit.

Server: `POST /pipes` answers `200` when the run finished, with `{ count, stats, failures, failuresOmitted? }`;
`failures` lists up to 1000 inputs whose status is not SUCCESS. It used to answer the status of the first failing
document and stop there.

### Server: /unpack answers Tika's data package (`tikajs-68os.7.4`)

Changed (breaking): `PUT /unpack` and `POST /unpack` (multipart) answer a zip, as Tika's do, where they answered the
`/rmeta` JSON array. The zip holds `datapackage.json` (Frictionless manifest: `name` when the request named the
document, `created`, and per file `name`, `path`, `mediatype`, `bytes`, `hash` as `sha256:<hex>`, `tk:embedded-id`,
`tk:resource-name`), `rmeta.json` (what `/rmeta` answers) and `unpacked/<id><extension>` for each embedded document. A
client that read records from `/unpack` reads `rmeta.json` now. Only `Accept: application/zip` (or `*/*`) is served,
anything else is a 406 with no body, and a raw `POST` is a 415. A document that cannot be opened is a 422 whose body is
the failure; a document inside that cannot be read stays in `rmeta.json` with its failure and the answer is 200.

New: `PUT/POST /unpack/all[/{handler}]` adds the request's own bytes as `unpacked/0<ext>` (id 0, no resource name);
`/unpack/all/bogus` is a 400. Server option `maxUnpackBytes` (default 100 MiB, at most 2 GiB; with isolation never above
the children's `unpackCeiling`, which is refused at construction with both numbers): the most embedded bytes a request
keeps. A document past it is left out of the zip and stays in `rmeta.json`. There is no query parameter for it. The zip
is deflated one file at a time, and a package that could outgrow a zip's 32-bit offsets or 65535 entries is a 422 before
the answer starts.

New (core): `ParseRecord.bytes` and `ParseOptions.unpackBytes` on `parseRecursive` carry each embedded document's bytes
within a budget (default off: a library caller pays nothing). Isolation carries them across the boundary as `bytes`
frames after their record, counted in `maxResultBytes`; the parent reserves twice the budget in the pool
(measured: parent +78 MiB for 64 MiB stored, +82 MiB deflated, +275 MiB for 256 MiB; child RSS about 140 MiB plus twice
the bytes). `DerivedLimits.unpackCeiling` and `ServerIsolationStatus.limits.unpackCeiling` say what a budget may be.

Differences from Tika, measured against the saved 4.2.0 responses (r164-r177, r224, r225): ids, resource names, media
types, byte counts and sha256 match document by document, and so does the manifest layout. A text or HTML document was
`unpacked/N.txt` / `N.html` where Tika's is `N.bin`, because its `Content-Type` carries a charset that its extension
lookup does not find and ours had none (closed by `tikajs-68os.29`, above). A zip entry named `../x` or `/x` is skipped by the archive
parser (Tika unpacks it under its id). A truncated zip is not salvaged (r169). `/unpack/preset/{name}` and the config
routes are not served. The response is not gzipped. `ripstream serve` has no setting for `maxUnpackBytes`
(`tikajs-68os.28`).

### Docs: spec/04 route table matches tika-server 4.2.0 (`tikajs-68os.7.9`)

`spec/04-pipes-server-ops.md` §2.1 listed routes that 4.2.0 does not have. `/tika/form` and `/detect/stream` are marked
absent (404 on Tika and here), `/translate/all/...` is replaced by the ripstream extension `/translate?target=`, and
`/tika/config`, `/tika/preset`, `/rmeta/config`, `/rmeta/preset` and `/unpack/preset` are marked not served. No code change.

### Server: /language, Accept, gzip and the request line (`tikajs-68os.7.8`)

Changed (breaking): `PUT /language` and `POST /language` answer the ISO 639-1 code as `text/plain` (`en`), as Tika's do;
the JSON object with the ISO 639-3 code (`{ language, confidence, isReasonablyCertain }`) is now `Accept: application/json`.
A text too short to tell is an empty answer, not `und`. A route writes one type and an `Accept` that does not name it is a
406 with no body, before the document is read: `Accept: application/json` on `/tika` no longer answers the older
`{ text, metadata }` object (use `?handler=json` for it, or `/tika/json` for Tika's shape), and `/tika/text`, `/detect`,
`GET /version` and the rest refuse an `Accept` they cannot meet. `OPTIONS` is a 200 with an `Allow` list, not a 204.

New: `HEAD` on every GET route; `PUT /` is a 405; a trailing slash is ignored on every route; `//tika/text` is a 400 and a
dot segment is a 404 instead of being folded into another route. Text, JSON and XML responses are gzipped for
`Accept-Encoding: gzip`, and a request with `Content-Encoding: gzip` is inflated, held to the body limit once inflated.
Raw `POST` stays accepted on `/tika`, `/rmeta`, `/meta` and `/detect`, where Tika answers 405. `@spikedpunch/ripstream-language` exports `toIso6391`.

### Server: a refused body keeps the connection; a burst is queued (`tikajs-68os.7.7`)

Fixed: after a 413 the next request on the same keep-alive connection failed with `ECONNRESET`, because the server
destroyed the socket the 413 had just promised to keep. A body up to 16 MiB over `maxBodyBytes` is now read and thrown
away (for at most 5 s) and the 413 comes on a connection that lives on; a body announced as more than that is refused
unread with `Connection: close`. The 100 MiB default of `maxBodyBytes` / `server.maxRequestSizeBytes` stays (Tika's is
1 GiB) and is documented.

Changed: with isolation on, the server now queues requests beyond the pool's slots (`maxQueue`, default 100, waiting
without having read their body, 408 after `requestTimeoutMs`) instead of refusing them at once with 503. A burst of 40
`/rmeta` PDFs on the default CLI gave 21 answers and 19 `503`s; it now gives 40 answers. `maxQueue: 0` restores
refusing at once. What the queue cannot hold is still a 503 with `Retry-After`. spec/04 said 429 and 1 GiB; it now says
what the server does.

### Server: Tika's content handlers and routes (`tikajs-68os.7.6`)

New: a document's content can be written in any of Tika's shapes (`BasicContentHandlerFactory`): `text`, `body`, `html`,
`xml`, `markdown`, `ignore`. The routes of tika-server 4.2.0 that choose one are served; what each answers was read from
Tika's source and its saved responses, **not run against a live Tika**. See *Content shapes and routes* in
docs/migration.md.

- New: `ParseOptions.handlerType`, `HandlerType`, `HANDLER_TYPES`, `parseHandlerType` (Tika's spellings, `txt` and `md`
  included, in any case; an unknown name is a `RangeError` with Tika's message), `handlerTypeName`, `createOutputHandler`
  and `OutputContentHandler`. `RecursiveParserWrapper` and `ParseRecord` carry the type, `IsolatedParseRequest.handlerType`
  carries it across the isolation boundary, and `tk:content-handler-type` is the type that wrote each document's content
  (`TEXT` is no longer the only value).
- New routes: `/tika/text`, `/tika/html`, `/tika/xml`, `/tika/md`, `/tika/json[/{handler}]` (one object: the metadata,
  `tk:content` when not blank, `tk:content-handler-type`), `/rmeta/{handler}`, `/meta/{field}` (JSON, CSV or text; 404
  for a missing field), `POST /meta/form`, `POST /rmeta/form[/{handler}]`, `GET /` (welcome page, HTML or text), `GET
  /tika` (greeting), and `/mime-types[/{type}/{subtype}]` (HTML, JSON or text). A trailing slash names the same route.
- New: `/tika?handler=` and a preset's `handler` take every handler type, not only `meta` and `json`. A route that
  names its handler in the path refuses `?handler=` (400).
- New: `createRipstreamServer({ mimeTypes })` (`ServerMimeType`); until given, `/mime-types` is a 404. `ripstream serve`
  passes the standard registry with the configuration's `custom-mimetypes` merged in. `withCustomMimeTypes` is exported
  from `@spikedpunch/ripstream-mime`. `mime-types` joins the server endpoints, and the default set; `mime` is accepted as
  the same endpoint, as in Tika.
- Changed: `/meta` writes no content (Tika's `ignore` handler), so `maxOutputChars` no longer applies to it and the
  write-limit flag is never set there; it used to run the whole text pipeline and discard the text.
- Changed: `MarkdownContentHandler` no longer joins adjacent paragraphs into one, drops the whitespace the parsers write
  between blocks (as Tika's handler does), and writes the title as its own line with a hard break, as Tika's output has it.
- Not the same as Tika: bare `/tika` is text where Tika's is Markdown; Markdown is best effort, not byte for byte;
  `Accept: application/rdf+xml` (XMP) is a 406; `/tika/preset/...` and `/tika/config/...` are not served; `/meta/{field}`'s
  404 body is `text/plain`. `Accept: application/json` on `/tika` still answers the older `{ text, metadata }` object
  until `tikajs-68os.7.8`.

### Server: reaching the output limit truncates and flags, as Tika's write limit does (`tikajs-68os.7.5`)

Changed: a request whose text reaches `maxOutputChars` (default 100,000, the server ceiling) is no longer a 422. The
text up to the limit is the answer (200), and `tk:exception:write-limit-reached` = `true` is set on the metadata of
the document (for `/rmeta`: of the container, and of the embedded document whose text was cut). `/tika` text has no
metadata, so it carries `X-Ripstream-Write-Limit-Reached: true` instead (Tika has no such header). Every other limit
(embedded count, per-document output, depth, timeout) is still an error. `/async` and `/pipes` keep the hard limit.

- New: `ParseOptions.onOutputLimit: "throw" | "truncate"` on `parse` and `parseRecursive` (default `"throw"`: a
  library caller still gets a `LimitExceededError`, never a quiet partial text). `parseToString`, `parseToHandler` and
  `parseToStream` always throw. A `WriteOutContentHandler` of the caller's is never swallowed.
- New: `RecursiveParserWrapper` takes `truncateOutput`; `IsolatedParseRequest.truncateOutput` (header field
  `truncateOutput`) carries the option across the isolation boundary. The flag rides on the metadata, so nothing else
  crosses.
- New: `TIKA_KEYS.WRITE_LIMIT_REACHED`.
- New: `createRipstreamServer({ onOutputLimit: "truncate" | "throw" })` (default `"truncate"`), and
  `RipstreamConfig.throwOnWriteLimit`, true when the `parse-context` section sets `output-limits.throwOnWriteLimit:
  true`. `ripstream serve` passes `"throw"` when it is, so a file that asks for a failure at the limit still gets a 422.
  A `writeLimit` is still accepted only beside that flag (the one-shot commands and the library fail at the limit);
  the server's truncation is the one place it does not.
- Changed: `parse` counts the text of the body against the limit, as Tika's text handler does (its
  `BodyContentHandler` sits in front of its `WriteOutContentHandler`); it used to count the markup's whitespace and the
  title too, so a document could be refused a few characters early. `parseRecursive` still counts every character a
  parser writes. An embedded document that failed now keeps the text extracted before the failure.
- The limit is one total across the container and everything embedded; Tika's write limit applies to each document's
  handler. The default is a ripstream bound: Tika's server has no write limit, so a larger document is cut here where
  Tika returns it whole. Read from Tika source and its saved responses, **not run against a live Tika**.

### Server: a document that cannot be read is an answer, as in Tika (`tikajs-68os.7.2`)

Changed: the server no longer fails a request because one document is unreadable. Tika's semantics, route by route
(read from the tika-server 4.2.0 source and its saved responses, **not run against a live Tika**):

| Input | `/rmeta`, `/meta`, `/tika` JSON | `/tika` text |
| --- | --- | --- |
| Malformed or encrypted document | 200, `tk:exception:container-exception` in the metadata | 422, the text extracted before the failure |
| Zero bytes | 200, the same key (`ZeroByteFileError: InputStream must have > 0 bytes`) | 422, empty body |
| A format no parser takes | 200, empty content, `tk:parsed-by` is `EmptyParser`, no exception | 200, empty body |

A timeout (408), a limit other than the output limit (422 with its message), a request over the body cap (413), a bad request (400), a full queue
or unavailable isolation (503) and a parser fault (500) are still errors. `/unpack` has no metadata to carry a failure
and still fails (422). Before this, all three rows were 415 or 422 with a message in the body.

- New: `ParseOptions.onDocumentFailure: "throw" | "record"` on `parse` and `parseRecursive` (default `"throw"`, so a
  library caller never gets a quiet success). `"record"` notes the failure on the metadata and resolves with what was
  extracted, the failure on `ParseResult.exception` / `ParseRecord.exception`. `parseToString`, `parseToHandler` and
  `parseToStream` always throw.
- New: `ZeroByteFileError` (a `MalformedDocumentError`, so still 422 and CLI exit 3). `AutoDetectParser` refuses an empty
  input once the type is recorded, as Tika's does; an empty input used to be `UnsupportedFormatError` (415).
- New: `IsolatedParseRequest.recordFailures` and `IsolatedParseResult.exception` carry the option across the isolation
  boundary (header field `recordFailures`, field `exception` on the `meta` frame). A child's failure text is data and
  becomes a plain `Error`. A subclass thrown across the boundary in `"throw"` mode still arrives as its code's class.
- New: a text-route 422 carries `X-Ripstream-Error: Name: message` (printable ASCII, 200 characters at most), since the
  body is now the partial text and no longer says why. Tika has no such header.
- Not done here: an embedded document with no parser still notes an `embedded-exception` (Tika's EmptyParser notes none);
  `Retry-After` on a 503 is 1 or 5 (Tika's is 5); `/pipes` and the CLI keep throwing (`tikajs-68os.6`).

### Metadata keys: Tika 4.x names and shape (`tikajs-68os.7.3`)

Changed: **every key the framework writes is now Tika 4.x's, with no 3.x spelling and no switch** (nothing has been
released). `X-TIKA:content`, `X-TIKA:parse_time_millis`, `X-TIKA:embedded_depth`, `X-TIKA:embedded_resource_path` and
`X-TIKA:EXCEPTION:*` are `tk:content`, `tk:parse-time-millis`, `tk:embedded-depth`, `tk:embedded-resource-path` and
`tk:exception:*`; `resourceName` is `tk:resource-name`, for callers that set it on `Metadata` too. The table is
tika-core's `metadata-migration-3x-4x.json`; see [docs/migration.md](docs/migration.md#metadata-keys).

- `/rmeta`, `/meta`, `/tika` (JSON), the CLI (`-j`, `-r`, `-o jsonl`) and pipes write a key with one value as a string
  and a key with several as an array, as Tika does. They were always arrays. `serializeRmeta` and `rmetaObject` do too.
- A record now carries Tika's embedded keys: no `tk:embedded-resource-path` on the container, an embedded document's path
  below it (`/inner.txt`, was `/box.zip/inner.txt`), `tk:embedded-id`, `tk:embedded-id-path`, and
  `tk:final-embedded-resource-path` from `rmetaObjects`. `tk:content` is omitted when blank and comes with
  `tk:content-handler-type`. `tk:parsed-by` (the parser that handled a document), `tk:parsed-by-full-set` (the
  container), `tk:content-type-parser-override` and `Content-Length` are new.
- A failure is noted on the record's own metadata, `tk:exception:container-exception` for the container and
  `tk:exception:embedded-exception` for an embedded document, as `Name: message` (no stack trace).
- New in core: `TIKA_KEYS`, `metadataJson`, `rmetaObjects` and `RmetaValue`. `ParseRecord.embeddedResourcePath` is
  unchanged (it still starts at the container; pipes ids use it). `ripstream:embedded-resource-uri` replaces the
  invented `X-TIKA:embedded_resource_uri`: `tk:` is Tika's namespace and ripstream does not write keys Tika lacks in it.
- Not done here: per-format keys (`tikajs-68os.10.5`), Markdown content (`tikajs-68os.7.6`), `tk:embedded-resource-type`,
  `tk:internal-path`, `tk:embedded-relationship-id`. Read from Tika source, not run against a Tika.

### Configuration (`tikajs-68os.8.1`, `tikajs-68os.8.2`, `tikajs-68os.8.3`)

Changed: configuration no longer accepts what it would ignore. Only `version`, `isolation` and (since
`tikajs-68os.8.6`, below) `parsers` and `detectors` are read.

- `loadConfig` and `validateConfig` refuse `contentHandlers`, `metadataFilters` and `encodingDetector` by name (and
  refused `parsers` and `detectors` until `tikajs-68os.8.6`) (`"parsers" is not supported: ripstream would ignore it`). They used to be validated and
  dropped, so a config naming a nonexistent class loaded cleanly. Compose parsers and detectors in code with
  `createRipstream`.
- Removed `loadXmlConfig`, `ComponentConfig`, and the `parsers`/`detectors`/`contentHandlers`/`metadataFilters`/
  `encodingDetector` fields of `RipstreamConfig`. The XML loader was a regex scan that turned `<parser-exclude>` and
  commented-out entries into included parsers; Tika 4.x does not read XML configuration at runtime either.

Changed: input that used to be accepted and ignored is refused, naming what was wrong (`tikajs-68os.8.3`).

- `ParseLimits` are checked (`assertValidLimits`, also run by `ParseContext`, `Ripstream.parse*` and the isolated
  ripstream): an unknown limit, NaN, a string, a negative or fractional count, `Infinity`, and a timer over 2^31-1 ms
  (which fired at once) throw a `RangeError`. A limit set to `undefined` keeps its default instead of replacing it.
  `maxParseMillis: 0` still means no parse timer.
- `createEngine`, `PipesClient` and `PipesEngine` refuse an unknown key, a `mode` that is not one of the five, a
  `source.type` or `sink.type` other than the ones implemented (it used to fall back to the filesystem), and a
  `concurrency`, `maxQueue` or `maxBuffered` that is not a positive integer (`validatePipesConfig` lists the
  problems; `createEngine` throws a `RipstreamConfigError`).
- The server answers 400 for an unknown or repeated query parameter, an unknown `?preset=` or `?handler=`, any
  `X-Tika-*` header, a multipart part other than the one file, and an invalid `POST /pipes` body (unknown key, bad
  `mode`, `followSymlinks: true`). A preset with an invalid limit or handler fails `createRipstreamServer`.

Changed: the CLI and `loadConfig` no longer take what they would misread (`tikajs-68os.8.4`).

- A `RIPSTREAM_*` environment variable that is not a setting is a usage error (exit 2) naming it and the nearest real
  one; it used to be ignored, leaving the setting at its default. `detect` and `language` read no setting and still
  ignore them. `RIPSTREAM_PDFJS_CORPUS`, which only the test suite reads, is allowed.
- `-c`/`--config`, `-p`/`--password`, `--port` and `--host` with no value, or with another flag in the value's place,
  are usage errors. They used to mean "no config", "no password", port 9998 and host 127.0.0.1. `--port` takes digits
  only (`--port ""` was port 0).
- `loadConfig` refuses an object with a repeated key (`JSON.parse` kept the last) and nesting deeper than 64 levels.

Fixed: a configuration file saved with a UTF-8 byte order mark loads (`tikajs-68os.8.5`); `JSON.parse` rejected it with
an unhelpful message. One leading mark is skipped, as Jackson skips it.

Added: the `parsers` section of a Tika configuration is applied (`tikajs-68os.8.6`,
[docs/parsing.md](docs/parsing.md#the-parsers-section)).

- `createRipstream({ config })` and `createDefaultParser({ config })` apply it, and so does the CLI's `--config`:
  `default-parser` with its `exclude` list, parsers named by their Tika name (`pdf-parser`), and `_mime-include` /
  `_mime-exclude` on either. A name that is not a Tika parser, or one ripstream has no parser for, is an error
  (`RipstreamConfigError`; exit 2 in the CLI) rather than a parser that quietly does nothing.
- Ripstream's parsers do not line up with Tika's one to one (`ImageParser` serves what Tika splits across eight
  classes), so the section is applied to media types: a ripstream parser keeps the types some enabled Tika parser
  claims. The types come from `packages/parsers/src/generated/tika-parser-types.ts`, generated from the oracle
  inventory by `scripts/parity-matrix.ts` and checked by `parity:matrix:check`.
- Refused, where Tika reads silently: an entry with more than one key (Tika uses the first), a parser setting other
  than the media type filters, an `exclude` item that is not a string, and the retired `image/ocr-*` types.
- `RipstreamConfig.parsers` is the parsed section (`null` when absent); `parseComponentSection` and `ComponentEntry`
  are exported from `@spikedpunch/ripstream-core`.

Added: the `detectors` section is applied too (`tikajs-68os.8.6`, [docs/parsing.md](docs/parsing.md#the-detectors-section)).

- `new DefaultDetector({ config })`, `createRipstream({ config })` and the CLI's `detect`, `parse` and `metadata` apply
  it: `default-detector` with `exclude`, detectors named by their Tika name (`default-zip-container-detector`,
  `poifs-container-detector`, `misc-ole-detector`, `bp-list-detector`, `gzip-specialization-detector`,
  `matroska-detector`, `ogg-detector`, `mime-types`, `no-op-detector`), combined as Tika's `CompositeDetector` does.
  Without `default-detector` only the named ones run, so leaving out `mime-types` leaves out name and magic detection.
- Naming a detector ripstream has no counterpart for (`magika-detector`, `siegfried-detector`, `raw-tiff-detector`,
  `empty-detector`, `file-command-detector`, `magic-detector`, `pkcs-7-detector`) is an error; excluding one is fine.
  Excluding `mime-types` from `default-detector` is refused: Tika's default detector runs it whatever the list says.
  A detector takes no `_mime-include` / `_mime-exclude` (Tika drops them on a named detector and refuses them on the
  marker).
- `createRipstream({ detector, config })` with a `detectors` section is an error (`RipstreamConfigError`).
- With isolation on, both sections cross the boundary (`tikajs-68os.8.7`, below); `detect` never isolates and applies
  `detectors` whatever the isolation settings.

Added: the `parse-context` section sets limits (`tikajs-68os.8.8`, [docs/parsing.md](docs/parsing.md#the-parse-context-section)).

- `embedded-limits.maxDepth` and `maxCount`, `output-limits.writeLimit` and `timeout-limits.totalTaskTimeoutMillis` become
  `maxNodeDepth`, `maxEmbeddedResources`, `maxOutputChars` and `maxParseMillis` in `RipstreamConfig.limits`. A limit is
  accepted only beside its `throwOn*` flag set to `true`, because ripstream fails the parse at a limit where Tika's
  default stops quietly. `maxXmlDepth`, `maxPackageEntryDepth`, `zipBombThreshold`, `zipBombRatio` and
  `progressTimeoutMillis` are refused by name, with the reason.
- `new Ripstream({ limits })` and `createRipstream({ config, limits })` take limits that every parse starts from; a limit
  a call names wins. An invalid one throws when the ripstream is built.
- CLI: `--maxEmbeddedDepth` and `--maxEmbeddedCount` (tika-app's flag names) limit one `parse` or `metadata`. `parse` and
  `metadata` apply the section, in this process or with isolation on (`tikajs-68os.8.7`); `serve` refuses it
  (`tikajs-68os.8.9`).

Added: a configuration crosses the isolation boundary (`tikajs-68os.8.7`, [docs/isolation.md](docs/isolation.md)).

- `createStandardIsolation({ ripstreamConfig, limits })`: the `parsers` and `detectors` sections build the child's
  pipeline (sent in the request header), the routing detector, `detect()` and the in-process parsers, which the
  `parsers` section narrows and never widens. `parse-context` limits, with `limits` laid over them, are the defaults of
  every isolated parse. The CLI passes both, so `--isolation strict|lenient` with `--config` or `--maxEmbeddedDepth` /
  `--maxEmbeddedCount` no longer refuses; `serve` applies `parsers` and `detectors` under isolation.
- `IsolatedParseRequest` takes `maxNodeDepth` and `maxParseMillis`; `createIsolatedRipstream({ limits })` takes defaults;
  `IsolatedComponents` is the section pair a child receives; `applyParserConfig` narrows a parser list by a `parsers`
  section; `runChildMain` takes a function that builds the ripstream from the header's components.
- Refused when the isolation is built, as a usage error: a `maxParseMillis` above what the isolation allows (its
  `maxTaskMillis` less the parent's margin; the message says so) and `maxOutputChars: -1`, which no child can hold.

Added: a `server` section for `ripstream serve`, and Tika's serve flags (`tikajs-68os.8.9`, [docs/parsing.md](docs/parsing.md#the-server-section)).

- `"server": { port, host, endpoints, cors, maxRequestSizeBytes, requestLogLevel, maxRequestReadMillis, idleTimeoutMillis }`
  in the configuration `serve --config` reads. A setting ripstream has no counterpart for (`maxQueuePauseMillis`,
  `maxResponseWriteMillis`, `maxInFlightRequestBytes`, `id`, `tlsConfig`, `metricsPort`, and `allowPipes`,
  `allowPerRequestConfig`, `allowHttp2` when `true`) is refused by name with the reason, as is an unknown one.
- Changed: **`ripstream serve` no longer serves `/status` and `/async` unless `server.endpoints` lists them** (Tika's
  default set; `/health` is unaffected). `createRipstreamServer` keeps serving everything unless given `endpoints`.
- Changed: in `serve`, `-h <host>` and `-p <port>` are Tika's spellings (`-p` used to be the password, which `serve`
  ignored, so `serve -p 8080` listened on 9998). `-?` is help in every command. `serve -h` with no value is a usage error
  that points at `--help`.
- Changed: `serve` applies a `parse-context` section instead of refusing it: its `writeLimit` and `maxCount` are the limits
  of a request that names none (`createRipstreamServer({ defaultLimits })`), under the ceiling. A `writeLimit` above
  `--max-output-chars`, or `-1`, is a usage error.
- `createRipstreamServer` gained `endpoints`, `requestLogLevel`, `maxRequestReadMillis`, `idleTimeoutMillis` and
  `defaultLimits`; its `log` callback may now receive `"debug"`. Core gained `ServerSettings`, `SERVER_ENDPOINTS`,
  `DEFAULT_SERVER_ENDPOINTS`, `parseServerSection` and `RipstreamConfig.server`.
- Read from Tika's source (`TikaServerConfig.java`, `TikaServerProcess.java`, `TikaServerCli.java`), not run against a Tika.

Added: `pdf-parser` settings by Tika's property names (`tikajs-68os.8.10`, [docs/parsing.md](docs/parsing.md#the-parsers-section)).

- A `parsers` entry `{ "pdf-parser": { "sortByPosition": false, "extractAnnotationText": false } }` sets the
  `PDFParserConfig` properties of those names on ripstream's PDF parser. They reach `createRipstream`, the CLI and the
  isolation child (a `settings` field on each entry in the request header). Each must be `true` or `false`; Tika's
  loader would coerce `"false"` or `1`.
- Every other setting of a parser (the rest of `PDFParserConfig`, OCR, HTML) is still refused by name, now listing the
  two that are applied. `ComponentEntry` gained an optional `settings`.
- Fixed: with isolation on, a `parsers` section that named a parser only the child has (`pdf-parser`) made
  `createStandardIsolation` throw ("is not implemented"). The section is now applied to the whole default list and the
  in-process parsers keep what they had, so they agree with the child on what is switched off.
- Not changed: ripstream's `PdfParser` defaults `sortByPosition` to `true`; Tika's `PDFParserConfig` defaults it to `false`.
- Checked against Tika's source (`PDFParserConfig.java`, `PDFParser.java`), not against a running Tika.

Added: custom media types, from Tika's own `custom-mimetypes.xml` (`tikajs-68os.8.11`, [docs/parsing.md](docs/parsing.md#the-custom-mimetypes-key)).

- A configuration's `"custom-mimetypes": "path/to/custom-mimetypes.xml"` (Tika: the `tika.custom-mimetypes` system
  property) adds the file's media types, globs, regex globs, aliases, supertypes, root elements and magic to the
  registry that names, magic, aliases and XML roots are resolved with. The format is Tika's (freedesktop mime-info), so
  an existing file works unchanged. `new DefaultDetector({ customMimeTypes: xmlText })` and `createRipstream({ customMimeTypes })`
  take the text directly. `MimeTypesOptions.custom` (`CustomMimeType`) gained `magic`, `regexGlobs` and `description`,
  and a `custom` type's magic now reaches the magic detector, which it did not before.
- Refused by name, every mistake in one error: a missing file, text that is not XML, a wrong root, an unknown element, a
  missing or invalid `type`/`pattern`/`localName`/`value`/`offset`, a match type Tika does not decode, a magic regex or
  a glob regex ripstream cannot run, and a glob two unrelated types claim (Tika's `Conflicting extension pattern`).
- With isolation on, the text of the file is read once by the parent and crosses in the request header (so the file
  can change or vanish without the child noticing); it counts against the 16 KiB the header leaves for components.
- Read from Tika's source, not checked against a running Tika 4.2.0. Stricter than Tika where Tika would ignore a
  mistake: it ignores a misspelled element and a `<glob>` without a pattern, and fails only at the first detect for a
  match of an unknown type.

Added: the CLI accepts `--name=value` as well as `--name value` for every long option that takes a value
(`--config=ripstream.json`, `--output=json`, `--port=8080`) (`tikajs-68os.8.12`). An empty value (`--config=`), a value on
a flag that takes none (`--json=yes`) and the short form (`-c=x`) are usage errors. The CLI stays ripstream's own
interface: tika-app's other flags are declined (`tikajs-68os.24`, [docs/migration.md](docs/migration.md#command-line)).

### Parse isolation (epic `tikajs-zgg2`)

Added: per-document child-process isolation with a host memory budget (`@spikedpunch/ripstream-isolation-node`,
[docs/isolation.md](docs/isolation.md)).

- `ripstream serve` isolates by default (`strict`): it refuses to start when it cannot isolate. Flags
  `--isolation`, `--max-output-chars` and `RIPSTREAM_ISOLATION_*` configure it. One-shot commands stay in-process
  unless `--isolation` is given.
- `createRipstreamServer()` no longer builds an engine of its own: pass `ripstream`, either an isolated one
  (`createStandardIsolation`) or an in-process `createRipstream()` to accept the risk.
- `/status` reports the isolation mode, pool and gate.
- Each isolated call gets a private temporary directory (the child's `TMPDIR`) that is removed once the child is
  gone, and a parent-enforced disk budget, `isolation.maxDiskMb` / `RIPSTREAM_ISOLATION_MAX_DISK_MB` (default 1024
  MiB): a child that writes past it is killed and the request is a 422.

- `TesseractOcrParser` (optional OCR) now kills the `tesseract` process on abort and after `timeoutMs`
  (default 60 s), and bounds what it reads from the child. It used to leave the process running after the parse
  had been abandoned. New constructor options: `timeoutMs`, `command`.
- The hazard audit also finds hazard parsers reached through another package, inherited or re-exported under another
  name; every parser built on exifr, sql.js, pdf.js, music-metadata or hyparquet now declares
  `capabilities.unsafe`.
- CI: `isolation-chaos` runs the Linux chaos fixtures on native x86_64 and arm64 runners (glibc and musl);
  `isolation-benchmark` runs two pinned public corpora (Apache POI OOXML, pdf.js PDFs) through the real isolator
  and fails on a memory, time or outcome regression.
- The standard isolation child no longer lets pdf.js load the native `@napi-rs/canvas`: it cost about 1.6 GiB of address
  space per child and made PDFs fail "out of memory" under the 6 GiB `ulimit -v` on native arm64 (found by the
  `isolation-benchmark` workflow). Text and metadata are unchanged.
- Hazard probes (`hazard-probes.test.ts`): hostile music-metadata, hyparquet and 10,000-entry-archive inputs through the
  real isolator, with measured numbers in [docs/isolation.md](docs/isolation.md). One macOS-only gap is recorded
  (tikajs-ubpo).

Fixed: embedded document text no longer turns a surrogate pair that a child parser split across two `characters()`
calls into two U+FFFD.

### Removed (breaking)

- `runIsolatedTask`, `IsolatedTaskOptions`, `WorkerTaskError`, `WorkerTimeoutError` (core), and the worker entry
  they ran. **There is no longer a generic worker-thread task runner.** Process isolation (`ParseIsolator`,
  `createIsolatedRipstream`) replaces it for parsing; code that used `runIsolatedTask` for other work needs its own
  runner.
- `WorkerPool` (pipes), which was built on `runIsolatedTask`.
- The PDF parser's worker thread and its options `workerMemoryMb` and `inline`, and `createRipstream({ pdfInline })`.
  `PdfParser` always runs pdf.js on the calling thread. **Every in-process entry point therefore parses PDFs inside
  the caller's process with no containment**: a plain `createRipstream()`, the one-shot CLI (`ripstream file.pdf`,
  isolation off unless `--isolation` is given) and the pipes library's default engine. Route untrusted PDFs through
  the isolation layer. They used to get a worker thread with a memory watchdog and a kill on timeout.
