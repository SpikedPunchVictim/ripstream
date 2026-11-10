# 02 — Detection, Encoding, Metadata

## 1. Detection pipeline

`DefaultDetector` order (first confident answer wins):

```
1. OverridingTypeDetector        config / server header / explicit hint
2. NameDetector                  resourceName → glob → media type
3. ContainerAwareDetector        read prefix, dispatch:
     3a. ZIP central directory  → OOXML / ODF / EPUB / JAR / APK / plain zip
     3b. OLE2 directory         → doc / xls / ppt / msg / vsd / encrypted OLE2
     3c. 7z / RAR / gzip / bzip2 / xz / tar magic
4. MagicDetector                 compiled byte rules, ordered by priority
5. XMLRootExtractor              root element + namespace (when magic says XML)
6. TextDetector                  charset analysis → text/plain or text/html-ish
7. Default                       application/octet-stream
```

Rules:

- Every stage may decline; no stage may throw for malformed input. Malformed container metadata raises only when the container parser runs.
- Detection reads the smallest possible prefix: name first, then 64 KiB by default, escalating to the ZIP central directory tail / OLE2 header only when the prefix says container.
- Bytes consumed by detection are memoized and rewound; parsers always receive the stream at position 0.
- Metadata hints (`Content-Type`, `Content-Disposition filename`) are parsed into `resourceName` before detection. Header trust is configurable and off by default for server input.
- `detect()` returns `MediaType` with parameters. Detected type is written to `Metadata[CONTENT_TYPE]`; `Metadata[DETECTED_CONTENT_TYPE]` records the raw detector output when an override changed it.
- Empty input → `application/x-tika-empty`? No: upstream returns `application/octet-stream`; we do the same, with a warning event.

## 2. Magic rule engine

Data model compiled from `tika-mimetypes.xml`:

```ts
interface MagicRule {
  kind: 'bytes' | 'string' | 'regex' | 'unicodeLE' | 'unicodeBE';
  offset: number;                  // absolute
  range: number;                   // 0 = fixed offset; >0 = search window length
  value: Uint8Array | string;
  mask: Uint8Array | null;         // bitwise AND before compare
  minLength: number;               // minimum bytes needed to evaluate
  priority: number;                // higher wins; ties broken by specificity then registration order
  submatcher?: MagicRule[];        // nested rules (e.g. container sub-formats)
}
```

Matcher semantics:

- `offset` is 0-based from the start of the stream (or of the enclosing submatcher window).
- `range > 0` means "search anywhere in `[offset, offset+range]`"; earliest match wins.
- `string` rules match both ASCII and UTF-16LE/BE byte encodings when the registry declares them; upstream's `unicodeLE/unicodeBE` types are preserved.
- `mask` applies byte-wise: `(input[i] & mask[i]) === value[i]`.
- Submatchers evaluate only after the parent matches, using the same byte window plus declared relative offsets (e.g. RIFF/AVI vs WAV).
- Evaluation is single-pass over the buffered prefix. Required prefix length = max over candidate rules of `minLength`; if EOF arrives first, remaining rules decline rather than fail.
- Performance: compile rules into a flat list grouped by first-byte sets; avoid regex compilation per document; precompile literal matchers into typed arrays. Target: 100k detections/second for 1 KiB inputs on commodity hardware.

Generated registry contents:

- Every `MimeType`: media type, description, aliases, extensions, globs, magic rules, XML root, supertype.
- Media type hierarchy table from `tika-mimetypes.xml` plus `MediaTypeRegistry` defaults.
- A checksum of the upstream source in the package metadata; a CI job regenerates and diffs when Tika releases.

Do not hand-edit generated files. Custom entries merge via config and are marked `source: 'custom'`.

## 3. Name detection

- `FilenameUtils` semantics: case-insensitive, `*`, `?`, `[...]`, literal dots.
- Longest/most-specific glob wins; exact extension lookup is a fast path.
- `.tar.gz`, `.tar.bz2` compound suffixes handled as one match before generic `.gz`/`.bz2`.
- Names with no extension still detect via magic.
- `Content-Disposition` filename extraction (RFC 2231/5987, quoted) is supported for server parity.
- `MimeTypes.forName` and `getGlobs` are public and parity-tested against upstream for every registered filename pattern.

## 4. Container sniffing

### ZIP

Read the end-of-central-directory record and central directory, not the whole archive.

Decision table:

| Evidence | Result |
|---|---|
| `mimetype` entry, first and stored, `application/vnd.oasis.opendocument.*` | ODF type |
| `mimetype` entry = `application/epub+zip` | EPUB |
| `[Content_Types].xml` | OOXML; refine by overrides / parts (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`) |
| `_rels/.rels` with officeDocument relationship | OOXML refinement |
| `META-INF/MANIFEST.MF` | `application/java-archive` |
| `AndroidManifest.xml` + `classes.dex` | `application/vnd.android.package-archive` |
| `index.apxl` / `Index/Document.iwa` / `Index.zip` | iWork generation (13+/18+/09) |
| `content.xml` + `styles.xml` without mimetype | ODF fallback |
| otherwise | `application/zip` |

- Encrypted OOXML (`EncryptedPackage` + `EncryptionInfo`) → `application/x-tika-ooxml` encrypted; parser raises `EncryptedDocumentError` or asks `PasswordProvider`.
- ZIP64, data descriptors, and split archives must not break detection. Central directory parsing is chunked and bounded by `maxZipEntries`.
- A corrupt central directory declines to magic/extension detection, not an exception.

### OLE2 / CFB

Parse the header and root directory entries only.

| Root entry | Result |
|---|---|
| `WordDocument` | `application/msword` |
| `Workbook` or `Book` | `application/vnd.ms-excel` |
| `PowerPoint Document` | `application/vnd.ms-powerpoint` |
| `__properties_version1.0` | `application/vnd.ms-outlook` |
| `VisioDocument` | `application/vnd.visio` |
| `EncryptedPackage` | encrypted OOXML |
| `\x05SummaryInformation` only | generic OLE2 |

Stream names also distinguish Word 6/95 from 97+, and encrypted OLE2 documents.

### Other containers

- 7z / RAR: magic + header parse; archive listing through wasm decoders at parse time.
- gzip / bzip2 / xz / lzma / z / brotli / lz4 / snappy: compressor magic; inner type detected after decompressing a bounded prefix.
- tar: `ustar` at offset 257; compressed tar detected after decompression.
- WARC: `WARC/1.x` line plus record headers.
- PDF: `%PDF-` within first 1024 bytes; version recorded.
- ISO 9660 / AppleSingle / AppleDouble / plist: magic-based.
- Mail: `From ` envelope (mbox), RFC 822 headers heuristic, TNEF signature (`0x9E 0x78 0x7E 0x9A`? verify), CFB MSG covered above.

## 5. XML root detection

- Secure, non-validating pull parse of the first start element only.
- No DTD processing, no external entities, no network access. Anything requiring a DTD declines.
- Maps `(namespaceURI, localName)` to a media type through generated XML-root entries: RSS, Atom, KML, GPX, XLIFF, TMX, ODF flat, WordML, SpreadsheetML, FB2, SVG, SMIL, XHTML, RDF, XMP packets, etc.
- Handles XML declaration, BOM, comments, processing instructions, and namespace prefixes.
- If the root is unknown, returns `application/xml` (not `text/xml`).

## 6. Text and encoding detection

```ts
interface EncodingResult {
  charset: string;            // canonical WHATWG/ICU alias, e.g. "windows-1252"
  confidence: number;         // 0..1
  bom: boolean;
  binary: boolean;
}
```

Order:

1. BOM: UTF-8, UTF-16LE, UTF-16BE, UTF-32LE/BE.
2. Null-byte density and control-character ratio → binary if above threshold.
3. UTF-8 validity check on the prefix; valid multi-byte sequences raise confidence.
4. Statistical detector (`@spikedpunch/ripstream-mime` bundles a port of the upstream juniversalchardet models, or an equivalent MIT detector) for legacy encodings.
5. Fallback: `windows-1252` with low confidence, matching upstream behavior for Latin-1-ish bytes.
6. HTML: `meta charset`, then BOM, then statistical; XML: declaration encoding.

Decoding uses WHATWG `TextDecoder` where supported, `iconv-lite`-style tables for the remainder. Invalid sequences → U+FFFD, never throw. Detected charset is written to `Metadata['Content-Encoding']` and `Metadata[CHARSET]`.

Text detection thresholds are parity-tested; the exact binary heuristic is pinned by fixtures because it changes upstream between versions.

## 7. Metadata schema

Namespaces shipped and generated from `tika-metadata-schema`:

| Prefix | Namespace URI | Examples |
|---|---|---|
| `tk` | internal (Tika 4.x; was `X-TIKA` in 3.x) | `tk:content`, `tk:embedded-resource-path`, `tk:embedded-depth`, `tk:parse-time-millis`, `tk:exception:*` |
| `dc` | `http://purl.org/dc/elements/1.1/` | title, creator, description, subject, language |
| `dcterms` | `http://purl.org/dc/terms/` | modified, created, issuer |
| `xmp` | `http://ns.adobe.com/xap/1.0/` | CreateDate, ModifyDate, CreatorTool |
| `xmpMM` | `http://ns.adobe.com/xap/1.0/mm/` | DocumentID, InstanceID, History |
| `pdf` | `http://ns.adobe.com/pdf/1.3/` | PDFVersion, Producer, Keywords |
| `pdfx` | `http://ns.adobe.com/pdfx/1.3/` | GTS_PDFXVersion |
| `office` | `urn:oasis:names:tc:opendocument:xmlns:office:1.0` | page count, author, last modified |
| `meta` | `urn:oasis:names:tc:opendocument:xmlns:meta:1.0` | generator, editing cycles |
| `cp` | OLE2 property sets | revision, last saved by, category |
| `extended-properties` | OOXML app.xml | Application, Company, Template |
| `custom-properties` | OOXML custom.xml | user-defined |
| `microsoft` | MS-specific | `microsoft:slide-count`, `microsoft:word-count` |
| `photoshop` | `http://ns.adobe.com/photoshop/1.0/` | ColorMode, History |
| `tiff` | `http://ns.adobe.com/tiff/1.0/` | ImageWidth, Make, Model |
| `exif` | `http://ns.adobe.com/exif/1.0/` | ExposureTime, FNumber, DateTimeOriginal |
| `iptc` | IPTC IIM | By-line, Caption-Abstract |
| `jpeg` | JPEG markers | comment, component count |
| `png` | PNG chunks | bit depth, gamma, sRGB |
| `gif` | GIF | version, frame count |
| `mp4` | MP4 atoms | duration, video codec, audio codec |
| `flac`, `ogg` | audio | sample rate, channels, vendor |
| `warc` | WARC | record type, target URI, payload digest |
| `dicom` | DICOM | patient ID, modality, study date |

Metadata rules:

- Unknown keys are preserved verbatim (upstream does this). They are not dropped for not being in the schema.
- Property value types control serialization (`integer` → JSON number, `date` → ISO-8601 string), but internal storage stays string-backed for lossless round-tripping.
- Keys are case-preserving and case-sensitive. Upstream uses a plain `HashMap`; there is no normalization on write or lookup. Generated property constants know the canonical case, but arbitrary keys are matched exactly.
- Upstream key iteration order is unspecified. Output serializers must not promise metadata ordering; parity tests compare key sets, and values per key in upstream array order.
- Namespaced key formatting is `prefix:name`; raw keys containing `:` but no known prefix are preserved.
- Metadata values are truncated at `maxMetadataValueChars` with an event; lists are capped independently.

## 8. Metadata write limits and filters

```ts
interface MetadataWriteLimits {
  maxKeyChars: number;
  maxValueChars: number;
  maxValuesPerKey: number;
  maxTotalChars: number;
  include?: RegExp[];
  exclude?: RegExp[];
}
```

Applied at serialization and at the server boundary, never inside parsers, so parse behavior stays inspectable. Upstream parity: `--config` metadata filters map here.

## 9. Serialization

### JSON (rmeta)

```json
[
  {
    "Content-Type": "application/pdf",
    "tk:content": "…",
    "tk:embedded-resource-path": "/doc.pdf",
    "tk:embedded-depth": "0",
    "pdf:PDFVersion": "1.7"
  }
]
```

- Numbers/dates may be emitted as strings exactly like upstream; `typedMetadata: true` opts into native JSON types.
- `tk:content` is the handler output for that record.
- Embedded records follow depth-first, pre-order.
- Exception records carry `X-TIKA:EXCEPTION:<simple class>` and `X-TIKA:EXCEPTION_MESSAGE`.

### JSON (single document)

- `/tika/json` and `handler: 'json'` shapes are pinned by differential tests against 4.2.
- Compatibility switch `jsonShape: 'tika-4' | 'rmeta'`; defaults to whatever upstream 4.2 emits.

### XML

```xml
<metadata>
  <property name="Content-Type" value="application/pdf"/>
  <property name="dc:title" value="…"/>
</metadata>
```

`<property>` may repeat for multi-valued keys. Encoding always declared. Keys/values XML-escaped; invalid XML characters replaced.

### CSV

`/meta` default in 3.x: one `key,value` row per property, quoted per RFC 4180, header row optional (`csvHeader: boolean`).

### XMP

`XMPContentHandler` serializes a metadata subset to an XMP packet. PDF XMP packets are parsed back into metadata; round-trip tests cover the common Dublin Core and PDF namespaces.

## 10. Metadata provenance

Three distinct values are tracked and available in events:

- `Content-Type` — final type after overrides (what parsers used).
- `X-TIKA:detected_content_type` — raw detector result.
- `Content-Encoding` — detected charset for text.

Server parity headers (`Content-Disposition` filename, request `Content-Type`) are copied into metadata only when `trustRequestHeaders` is enabled. They never influence detection unless configured.

## 11. Detection test matrix

- Every MIME type in the registry has at least three fixtures: magic-only, extension-only, wrong-extension (magic must win unless name override is enabled).
- Prefix truncation tests at 8, 16, 32, 64 KiB to prove no rule needs more than its declared `minLength`.
- Container tests use hand-built minimal archives plus real documents.
- Differential tests compare `(type, subtype, charset)` against a live Tika 4.2 container over the full corpus.
- Fuzz corpus from upstream OSS-Fuzz is replayed through the detector; no crashes, no unbounded memory, no reads past declared prefix.
