# 03 — Parser Inventory and Coverage

## 0. Coverage policy

| Tier | Meaning | Gate |
|---|---|---|
| **P0** | Real-world document types most deployments need | Must ship before 1.0; differential parity required |
| **P1** | Common but secondary formats | Ship in 1.x; parity required |
| **P2** | Long tail; metadata or partial text acceptable | Parity where feasible; declared gaps documented |
| **P3** | Best-effort, wasm/native/licensing risk, or upstream itself is partial | Explicit opt-in; no parity promise |

Each parser must deliver: correct detection registration, text extraction, metadata, embedded-resource handling, error taxonomy, limit behavior, fixtures, and docs. "Parses the format" without metadata and embedded handling is not done.

Dependency rule: pure JS/TS first; wasm second; native binaries never bundled (optional peer or external process). Every dependency passes a license gate (no GPL/AGPL in default install; LGPL only as optional, dynamically loaded).

---

## 1. Text, web, and source

| Formats | Upstream parser | TS approach | Stream | Prio |
|---|---|---|---|---|
| `text/plain`, unknown text | `TextAndCSVParser` | Native decoder; charset pipeline | ✅ | P0 |
| `text/csv`, `text/tab-separated-values` | `TextAndCSVParser` | Streaming RFC 4180 parser; delimiter sniffing; quoted newlines; XHTML `<table>` + text rendering | ✅ | P0 |
| HTML, XHTML | `HTMLParser` | `htmlparser2` SAX mode; drop `script`/`style`; title → metadata; charset from `<meta>`; links collected; images as embedded references (never fetched) | ✅ | P0 |
| Generic XML | `XMLParser`, `DcXMLParser` | `saxes` streaming; DTD/external entities off; DC elements → metadata; root recorded | ✅ | P0 |
| Markdown | `MarkdownParser` | `mdast` parse → blocks → text/XHTML; preserve headings/lists/code/links | ✅ | P1 |
| RSS 0.9x/1.0/2.0, Atom | `FeedParser` | `saxes`; item titles/descriptions/content as XHTML; feed metadata | ✅ | P1 |
| JSON / YAML / TOML | (none upstream) | Text passthrough for parity; optional structural summary behind config | ✅ | P2 |
| Source code (C, C++, Java, JS, TS, Python, Go, Rust, shell, etc.) | `SourceCodeParser` | Extension→language map generated from linguist data; `<pre>` output; license-file sniffing optional | ✅ | P2 |
| LaTeX, BibTeX, R, SQL dumps | none | Text passthrough | ✅ | P3 |

Notes:

- HTML must not execute scripts, resolve external DTDs, or fetch resources.
- XML parser must cap nesting (default 1000) and character events; entity expansion stays disabled.
- CSV: cap columns/rows for XHTML rendering but never truncate text output solely due to table shape.

---

## 2. PDF

| Capability | Detail |
|---|---|
| Engine | `pdfjs-dist` (Apache-2.0), legacy build for Node, worker disabled or dedicated worker |
| Input | `RipstreamInputStream` spooled file; `PDFDataRangeTransport` over a file handle so multi-GB PDFs are not fully loaded |
| Text | Per page `getTextContent`; reconstruct lines using transform matrices; insert page boundary as `<div class="page">`; preserve reading order; handle RTL runs |
| Metadata | Info dictionary, XMP packet, `pdf:PDFVersion`, producer, creator, dates, page count, encryption/permission flags |
| Annotations | Text annotations, links (URI metadata), highlights; widget field names/values; optional `pdf.extractAnnotationText` |
| Forms | AcroForm field names, values, types; XFA XML text when present |
| Attachments | Embedded files (portfolio) parsed recursively; filenames and MIME preserved |
| Inline images | Extract per page above `minImageSize`; feed OCR or `EmbeddedDocumentBytesHandler` |
| Encryption | Empty-password attempt first; then `PasswordProvider`; AES-128/256 and RC4; never brute-force; `EncryptedDocumentError` when unavailable |
| OCR | Strategy `AUTO` (text layer if present, else OCR), `OCR_ONLY`, `NO_OCR`, `OCR_AND_TEXT_EXTRACTION`; page DPI, language, timeout |
| Limits | Page cap, chars cap, per-page timeout, image byte cap |
| Failure | Damaged xref → recover mode; unreadable page records a warning and continues; no silent empty output |

Dependencies: `pdfjs-dist`. Optional rendering backend for OCR: `@napi-rs/canvas` (Node) or browser canvas.

---

## 3. Microsoft Office

### 3.1 OOXML (docx, xlsx, pptx, docm, xlsm, pptm, templates)

| Capability | Detail |
|---|---|
| Container | Streaming ZIP via `fflate`; read only required parts; central-directory-driven; zip-bomb guards |
| XML | `saxes` pull parser per part; no DOM |
| WordprocessingML | Paragraphs/runs, tabs/breaks, tables incl. nested, headers/footers, footnotes/endnotes, comments, hyperlinks, text boxes, tracked changes (accepted view), numbering → list markers, field results |
| SpreadsheetML | Sheets in workbook order; shared strings streamed (in-memory cap, then two-pass over spooled entry); formulas emit cached values; dates via number formats; merged cells; hidden sheets flagged; defined names |
| PresentationML | Slides in order, `<div class="slide">`; titles as headings; speaker notes; tables; images; grouped shapes; SmartArt text from data model |
| Metadata | core.xml, app.xml, custom.xml; `office:`, `extended-properties:`, `custom-properties:`; slide/page/word counts; application/company/template |
| Embedded | Images, charts (cached data), embedded workbooks, OLE objects, media; recursive parse of nested documents; `embedded:` URIs |
| Encrypted OOXML | `EncryptedPackage` + `EncryptionInfo`; Agile/Standard encryption; password provider; optional `officecrypto`-class dependency |
| Macros | Not executed; presence recorded in metadata; optional VBA stream extraction behind config |
| Limits | max parts, per-entry bytes, total uncompressed bytes, ratio |

Upstream: `OOXMLParser`, `XWPFWordExtractor`, `XSSFExcelExtractor`, `XSLFPowerPointExtractor`.

### 3.2 OLE2 / legacy binary Office

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| DOC (Word 6/95/97-2003) | `OfficeParser` / `WordExtractor` | `cfb` CFB reader + FIB/piece-table text extraction; fast-save handling; fields; footnotes; headers | P0 |
| XLS (BIFF5/8) | `OfficeParser` / `ExcelExtractor` | `cfb` + BIFF record parser (SST, LABELSST, NUMBER, RK, MULRK, FORMULA cached values, merged cells); date formats | P0 |
| PPT (97-2003) | `OfficeParser` / `PowerPointExtractor` | `cfb` + PowerPoint binary record parser (SlideListWithText, TextCharsAtom/TextBytesAtom, notes) | P0/P1 |
| MSG (Outlook) | `OutlookParser` / `MsgParser` | `cfb` property sets; headers, body (plain/RTF/HTML), attachments recursive | P1 |
| TNEF (winmail.dat) | `TNEFParser` | Custom attribute parser; body + attachments; nested MIME | P2 |
| Visio (vsd) | `VisioParser` | `cfb` + Visio stream text; metadata; best-effort shapes | P3 |
| Publisher (pub) | `PublisherParser` | `cfb` + Publisher text records; best-effort | P3 |
| OneNote (one) | `OneNoteParser` | MS-ONESTORE parser; note text; P3 risk (large effort) | P3 |
| Access (mdb/accdb) | `MDBParser` if present | Jackcess-equivalent is Java; TS gap. Detect + `UnsupportedFormatError` | P3 gap |
| Project (mpp) | — | Detect; unsupported error | P3 gap |
| Owner/lock files (`~$…`) | `OwnerFileParser` | Tiny CFB/OPC probe; emit owner metadata | P3 |

Shared: OLE2 property sets (`\x05SummaryInformation`, `\x05DocumentSummaryInformation`) → `cp:`, `extended-properties:`, custom properties. Encryption detection → password provider.

### 3.3 Legacy XML Office

| Format | Upstream | TS | Prio |
|---|---|---|---|
| Word 2003 XML (WordML) | `WordMLParser` | `saxes`; `<w:t>`, tables, properties | P2 |
| Excel 2003 XML (SpreadsheetML) | `SpreadsheetMLParser` | `saxes`; rows/cells; formulas/cached values | P2 |
| Word 2006 ML | `Word2006MLParser` | Same | P3 |
| Old Excel (BIFF2-4, pre-OLE) | `OldExcelParser` | Custom record reader | P2 |

### 3.4 RTF and WordPerfect

| Format | Upstream | TS | Prio |
|---|---|---|---|
| RTF | `RTFParser` | Streaming tokenizer: groups, control words, `\uN` escapes, code pages, font/color tables, `\bin` skipping, embedded objects, pictures (`\pict`) as embedded | P1 |
| WordPerfect 5-6, 7-8 | `WordPerfectParser` | Custom WPD prefix/stream parser; text + metadata | P3 |

---

## 4. OpenDocument, iWork, other office

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| ODT, ODS, ODP, ODG, ODF templates, flat XML (`fodt`/`fods`/`fodp`) | `OpenDocumentParser`, `FlatOpenDocumentParser` | ZIP + `content.xml`, `styles.xml`, `meta.xml`; tables/slides/pages; embedded objects; flat variants via XML. Also `vnd.sun.xml.writer` and the chart, image, formula, text-master and text-web types and templates (the `x-vnd.oasis.*` spellings are aliases); a chart gives its titles and data table | P0 (ODT), P1 (rest) |
| GeoGebra (`.ggb`, `.ggs`, `.ggt`), InDesign IDML | `GeoGebraParser`, `IDMLParser` | `boundedUnzip` + saxes. GeoGebra: text objects, `geogebra:*` and `dc:*` metadata, tool names, slides ordered by `structure.json`, thumbnail, scripts and pictures as embedded documents. IDML: `Content` text, `idml:*` and `meta:page-count`; XMP is a narrow port of `XmpExtractor` limited to `xmp:CreateDate`, `ModifyDate`, `MetadataDate` and `CreatorTool` (the full extractor is `tikajs-68os.44`) | P3 |
| StarOffice 5-7 | `OpenOfficeParser` | Legacy binary probe; text best-effort | P3 |
| iWork 09 (Pages/Numbers/Keynote) | `IWorkPackageParser` | ZIP + XML index; text | P2 |
| iWork 13+ / 18+ (IWA) | `IWork13PackageParser`, `IWork18PackageParser` | Snappy-decompressed protobuf; metadata + preview images only, matching upstream's documented limitation | P3 |
| EPUB 2/3 | `EpubParser` | ZIP + OPF spine order; XHTML chapters; NCX/nav; cover image; metadata | P0 |
| FictionBook 2 (FB2) | `FictionBookParser` | XML; sections, titles, poems, notes | P2 |
| CHM | `CHMParser` | ITSF/ITSP + LZX decompression; HTML entries; index/toc | P3 (wasm or port) |
| WinHelp (HLP) | `WinHelpParser` if present | Detect; unsupported error acceptable | P3 gap |

---

## 5. Archives and compression

| Formats | Upstream | TS approach | Stream | Prio |
|---|---|---|---|---|
| ZIP, JAR, WAR, EAR, APK | `PackageParser` | `fflate` streaming unzip; entry list; recursion; `package-entry` XHTML | ✅ | P0 |
| GZIP | `CompressorParser` | `node:zlib` / DecompressionStream | ✅ | P0 |
| TAR | `PackageParser` | `tar-stream`; PAX/GNU long names; symlinks not followed | ✅ | P0 |
| BZIP2 | `CompressorParser` | `seek-bzip` streaming | ✅ | P1 |
| XZ | `CompressorParser` | `xz-decompress` | ✅ | P1 |
| LZMA (`.lzma`, LZMA-alone) | `CompressorParser` | Hand-written range decoder, bounded; xz-java's dictionary rounding and 100,000 KiB memory limit (over it is a `LimitExceededError`, where Tika throws `TikaMemoryLimitException`) | ✅ | P1 |
| zlib | `CompressorParser` | `node:zlib` through the bounded inflate | ✅ | P2 |
| Deflate64 | `CompressorParser` | Hand-written decoder after `puff.c` (64 KiB window, 16-bit length for code 285, distance codes 30 and 31); reached by an explicit content type only; not checked against a real encoder; ZIP method 9 does not use it | ✅ | P3 |
| Brotli | `CompressorParser` | `node:zlib` / `DecompressionStream('deflate')` where brotli absent → wasm | ✅ | P1 |
| Unix compress (`.Z`) | `CompressorParser` | LZW decoder | ✅ | P2 |
| LZ4 frame | `CompressorParser` | `lz4js` | ✅ | P2 |
| Snappy framed/raw | `CompressorParser` | `snappyjs` (also used by iWork); claims `application/x-snappy` as Tika does, and the registry's `x-snappy-framed` | ✅ | P2 |
| 7z | `SevenZipParser` | Optional `7z-wasm`; LGPL path, optional peer; not in default bundle | ⚠️ | P2 |
| RAR / RAR5 | `RarParser` | Optional wasm; unrar licensing restricts redistribution — document as external/optional | ⚠️ | P2 |
| AR, ARJ, CPIO | `PackageParser` | Custom readers | ✅ | P3 |
| Unix dump | `PackageParser` | Detected as `application/x-tika-unix-dump`; no reader yet (`tikajs-68os.47`) | ❌ | P3 |
| ISO 9660 | `Iso9660Parser` | Directory record walker | ⚠️ | P3 |
| AppleSingle / AppleDouble | `AppleSingleFileParser` | Header + entry parser | ⚠️ | P3 |
| Apple plist (XML/binary) | `PListParser` | `bplist-parser` + XML plist; nested dict/array rendering | ✅ | P1 |

Archive rules:

- Never follow symlinks, device nodes, or absolute/`..` paths.
- Reject entries above per-entry bytes; stop at total-uncompressed and ratio limits.
- Entry names become embedded resource paths exactly as stored (normalized to `/`), parity-tested.
- Nested archives recurse under the global depth/count/byte budget.
- Each entry's type is detected before parsing; unknown binaries emit metadata only.

---

## 6. Mail, feeds, web archives, localization

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| EML / RFC 822 / MIME | `RFC822Parser` | `mailparser` (or custom MIME parser) with streaming multipart; headers → metadata; preferred HTML body, fallback text; attachments recursive; nested `message/rfc822` | P0 |
| mbox / Maildir | `MailboxParser` (3.x+) | Streaming envelope splitter; per-message RFC 822 parse | P1 |
| vCard | `VCardParser` if present | Streaming/line parser; contact fields as metadata | P2 |
| iCalendar / ICS | `ICalParser` if present | `ical.js`; events/tasks as text + metadata | P2 |
| WARC, ARC | `WARCParser` | Custom record reader; HTTP payload detection; embedded records. Claims `warc`, `warc+gz`, `arc+gz` and `x-internet-archive`: a gzip of any number of members is inflated first (bounded), data opening with `filedesc://` is read as ARC, and only an ARC record whose body is an HTTP response becomes a document. The ARC reader follows the published format, not jwarc | P1 |
| WACZ | `WACZParser` | ZIP; each entry under `archive/` is an embedded document, a gzip one inflated first (first member only, bounded; the total counts); `datapackage.json`, pages and indexes are not read, as in Tika | P3 |
| XLIFF 1.2/2.0 | `XLIFFParser` | `saxes`; trans-unit source/target, notes, state; XLIFF inline tags stripped | P2 |
| TMX | `TMXParser` | `saxes`; translation units, languages | P2 |
| XLZ | `XLZParser` | ZIP of XLIFF 1.2 files (every entry named `.xlf`); a `div` per file and trans-unit, `p` per source/target, `file-count`, `tu-count` and the languages | P3 |
| DIF, MIF, HTTP response, emlx | `DIFParser`, `MIFParser`, `HttpParser`, `RFC822Parser` | DIF: `dif:` element-path keys, title and spatial text. MIF: text, page counts, typed `application/x-mif`. HTTP: the `Content-Length` payload as an embedded document; header reading follows jwarc's leniency, not its source. emlx: count line and plist dropped. XUL, WAP XHTML and x-asp go to the HTML parser, as `JSoupParser` | P3 |
| IPTC ANPA | `IPTCANPAParser` | Line-based wire format | P3 |

Mail details:

- Required metadata: `Message-ID`, `From`, `To`, `Cc`, `Bcc`, `Subject`, `Date`, `Content-Type`, `MIME-Version`, attachment filenames.
- Encrypted S/MIME and PGP/MIME: detect; no decryption (no keys); record `EncryptedDocumentError` per part.
- HTML bodies render through `HTMLParser` so links and structure match other HTML output.

---

## 7. Images, OCR, video, audio

### 7.1 Image metadata and OCR

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| JPEG | `JpegParser`, `ImageParser` | `exifr` (EXIF, GPS, IPTC, XMP), marker scan, JPEG comment, dimensions; JFIF/EXIF orientation | P0 |
| TIFF | `TiffParser` | IFD walker; EXIF; multi-page pages | P1 |
| PNG | `PngParser` | Chunk walker: IHDR, pHYs, tEXt/zTXt/iTXt, eXIf, XMP | P1 |
| GIF | `ImageParser` | Header, frames, comment, XMP | P1 |
| BMP, ICO/CUR, WebP, HEIF/HEIC, AVIF, JPEG 2000, BPG | `ImageParser` family | Header/metadata readers; HEIF via `heic-decode`-class optional dep | P2 |
| ICNS, WBMP, PPM/PNM, JBIG2, XCF | `ICNSParser`, `ImageParser` | Header readers, never the pixels. ICNS and ICO/CUR follow Tika's source; WBMP, PPM and JBIG2 follow the public headers (Tika has no source for them); XCF is typed only, as Tika. JPEG XL needs an XMP extractor and is not ported (`tikajs-68os.44`) | P3 |
| SVG | via XML | XML parse; text content + metadata | P1 |
| PSD | `PSDParser` | Header, image resources, XMP | P3 |
| ICC profiles | `IccParser` | Header/tag reader | P3 |
| Raw camera (CR2/NEF/ARW/DNG) | via TIFF/EXIF | Metadata only | P2 |
| OCR | `TesseractOCRParser` | `tesseract.js` optional peer, worker pool; languages, DPI, timeout, preprocessing (`sharp` optional) | P2 |
| VLM OCR | Tika 4 VLM parser | Provider interface (Anthropic/OpenAI/Google/local); image/page → text; no default network | P3 |

OCR config (upstream-compatible keys):

```ts
interface OcrConfig {
  strategy: 'AUTO' | 'NO_OCR' | 'OCR_ONLY' | 'OCR_AND_TEXT_EXTRACTION';
  language: string;              // "eng", "deu+eng"
  timeoutMillis: number;
  dpi: number;                   // default 300
  pageSeparator: string;         // default "\n\n"
  enableImagePreprocessing: boolean;
  minImageSize: number;          // pixels, default 0
  outputType: 'txt' | 'hocr' | 'tsv';
}
```

### 7.2 Audio

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| MP3 (ID3v1/v2), M4A/AAC, FLAC, OGG/Vorbis/Opus, WAV, AIFF, AMR, WMA/ASF | `Mp3Parser`, `AudioParser` | `music-metadata` streaming: tags, duration, bitrate, sample rate, channels, codec | P1 |
| MIDI | `MidiParser` | Header, tracks, tempo, instrument names | P3 |
| Audible/AA, APE, WavPack | — | Metadata only or unsupported | P3 |

### 7.3 Video

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| MP4 / MOV / M4V / 3GP | `MP4Parser` | Atom walker or `music-metadata`; tracks, codecs, duration, dimensions, creation date; `mp4:` metadata | P1 |
| FLV | `FLVParser` | Header + tag scan; codecs, duration | P2 |
| AVI, MKV/WebM, ASF/WMV | partial upstream | `music-metadata`/EBML reader; metadata only | P2 |
| MPEG-TS/PS, Ogg video | — | Metadata/unsupported | P3 |

No audio/video transcription in core. ASR is an optional adapter package, not parity.

---

## 8. Scientific, CAD, DICOM

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| MATLAB MAT v4/v5 | `MatParser` | Custom parser; variables, types, dimensions, values for numeric/text | P2 |
| MAT v7.3 (HDF5) | `MatParser` | `h5wasm` optional; dataset listing | P2 |
| NetCDF 3 (classic) | `NetCDFParser` | `netcdfjs`; dimensions/variables/attributes | P2 |
| NetCDF 4 (HDF5) | `NetCDFParser` | `h5wasm` | P3 |
| HDF4 / HDF5 | `HDFParser` | HDF5 via `h5wasm`; HDF4 gap | P2/P3 |
| FITS | `FitsParser` | Header cards + table rows; primary/HDU | P2 |
| GRIB 1/2 | `GribParser` | Custom/wasm decoder; metadata + grid summary | P3 |
| DICOM | `DicomParser` | `dicom-parser`; patient/study/series metadata; pixel data not dumped | P2 |
| ISO 19115 / GeoTopic | `GeoTopicParser` | Metadata parse; geo enrichment via optional NLP (place names) | P3 |
| DWG | `DWGParser` | Optional `libredwg` wasm; text entities + layers | P3 |
| DXF | `DxfParser` maybe | Text/group-code parse; text entities | P2 |
| DGN | — | Detect; unsupported error | P3 gap |
| Shapefile | — | DBF + geometry metadata | P3 |

---

## 9. Executables, crypto, databases

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| PE/COFF (.exe/.dll/.sys) | `ExecutableParser` | The first 4 KiB only, metadata only, no text: `machine:architectureBits`, `machine:platform`, `machine:machineType`, `machine:endian`, `Content-Type`, and the PE `dcterms:created`; an unknown magic gives an empty document. `PEIconExtractor` and `ExecutableParserConfig` are not ported | P2 |
| ELF (executable, object, shared library, core) | `ExecutableParser` | Same header read, dispatched on the first 4 bytes; claims all 18 of Tika's executable types | P2 |
| Mach-O (thin: object, dylib, dylib stub, dylinker, fvmlib, kext, preload, core, dsym) | `ExecutableParser` | Same header read; reproduces Tika's quirks (Mach-O sets 64 bits only, an ELF byte order other than 1 reads big-endian) | P2 |
| Mach-O universal (fat) | `UniversalExecutableParser` | 32- and 64-bit tables, either byte order; each architecture is streamed to the embedded document extractor in offset order, with `Content-Length` as its only metadata; over 1000 architectures, a bad offset, a size over 500,000,000, an overlap or a short file is a `MalformedDocumentError` | P2 |
| Java `.class` | `ClassParser` | Constant pool, access flags, class/super, methods/fields counts | P1 |
| PGP messages/keys | `PGPParser` | Packet parser; literal data; signatures; key IDs. No decryption without keys | P3 |
| X.509 certificates | `CryptoParser` | `@peculiar/x509` + `asn1js`: subject, issuer, serial, validity, SANs, key usage, fingerprints | P2 |
| PKCS#7/CMS, PKCS#12 | `CryptoParser` | Signer certs, encrypted content detection | P3 |
| ASN.1/DER fallback | `CryptoParser` | Structure dump with depth limit | P3 |
| DBF (dBASE) | `DBFParser` | Header, field descriptors, records; render as table/text | P2 |
| SQLite | (none upstream) | Optional `sql.js`; schema + row dump bounded | P3 |
| Parquet / ORC / Avro | — | Detect; unsupported error | P3 gap |
| MSI | — | Detect; unsupported | P3 gap |

---

## 10. Fonts

| Formats | Upstream | TS approach | Prio |
|---|---|---|---|
| TTF / OTF / TTC | `TrueTypeParser` | `fontkit` optional peer: name table, family/style, version, metrics, glyph count | P2 |
| WOFF / WOFF2 | `TrueTypeParser` | `fontkit` handles WOFF; WOFF2 needs brotli path | P3 |
| AFM / PFM | `AdobeFontMetricParser` | Plain-text AFM parse; PFM binary header | P3 |
| EOT | — | Detect; metadata | P3 |

---

## 11. Cross-cutting parser behavior

### Encrypted documents

- Detect encryption before parsing (PDF trailer encrypt dict; OOXML encryption parts; OLE2 `EncryptionInfo`; S/MIME; PGP/MIME).
- Try empty password; then `PasswordProvider`; never prompt interactively in a library.
- Unrecoverable encryption → `EncryptedDocumentError`; embedded encrypted documents record the error and continue.

### Embedded resources

- Every container parser declares its entries and their MIME types; `RecursiveParserWrapper` builds paths.
- Default policy: text-bearing entries parsed; media entries metadata-only; raw bytes only when a handler is configured.
- Images inside documents: emit `embedded:` references in XHTML/Markdown; optionally stream bytes.
- Nested depth, count, byte, and time budgets are global to the top-level parse.

### Metadata-only mode

- `PARSING_INTENT = 'METADATA_ONLY'` skips text extraction where the parser supports it; parsers must still emit metadata and warnings.
- `ParserCapabilities.metadataOnly` marks parsers that are cheap in this mode.

### Streaming obligations

- No parser may buffer an entire document unless the format requires random access; those parsers declare `requiresRandomAccess` and use the spooled file.
- XML/ZIP/HTML/CSV/RTF/mail/archive parsers stream by construction.
- Spreadsheet shared-string tables and OLE2 property sets may use bounded in-memory indexes; document the cap.

### Error handling

- Recoverable structural damage → warning event + partial output.
- Unsupported version → `UnsupportedFormatError` with format detail.
- Corrupt header → `MalformedDocumentError`.
- Limit hit → `LimitExceededError` (or `WriteLimitReachedError` for output).
- Every embedded failure is recorded on that record's metadata; top-level failure only when no content could be produced.

### Per-parser acceptance tests

1. Fixture set: minimal, real-world, malformed/truncated, encrypted, zip-bomb/macro-sized, wrong-extension.
2. Text output compared to upstream Tika golden output.
3. Metadata diff (exact keys, values; allow documented additions).
4. Embedded tree diff.
5. Memory ceiling: parse a file 100× larger than the buffer without memory growth proportional to size (for streaming parsers).
6. Abort test: cancel mid-parse; temp files removed; no unhandled rejection.

---

## 12. Explicit gaps (declared, not hidden)

- Microsoft Access, Project (MPP), and some legacy/enterprise formats: detect + `UnsupportedFormatError`.
- iWork 13+/18+ body text: upstream itself does not extract it; we match (metadata + previews only).
- DGN, WinHelp, HDF4, NetCDF-4: unsupported until a suitable permissive decoder exists.
- RAR and 7z: optional wasm, licensing/redistribution caveats; excluded from default bundle.
- Parquet/ORC/Avro, MSI: unsupported.
- Audio/video transcription: not part of Tika parity.
- Macro execution, script execution, network fetches from documents: never.
