# Tikajs — Library-First TypeScript Port of Apache Tika

## Parity target

- Primary: **Apache Tika 4.2.0** (released 2026-10-28) semantics, config shape, output conventions.
- Compatibility mode: **3.3.3** server/CLI behavior where 4.x changed defaults (handler selection, endpoint gating).
- Deliverable: a **library**, not a service. Server/CLI/eval are thin optional packages built on the same public API.
- License: Apache-2.0 derivative. Ship `NOTICE` with Tika attribution; ported algorithms keep upstream headers.

Authoritative sources at build time, not hand-maintained lists:

| Thing | Source |
|---|---|
| MIME table, magic, globs, XML roots | `tika-core/src/main/resources/org/apache/tika/mime/tika-mimetypes.xml` |
| Parser registry | `tika-parsers/*/src/main/resources/META-INF/services/org.apache.tika.parser.Parser` |
| Detector registry | `META-INF/services/org.apache.tika.detect.Detector` |
| Metadata keys | `tika-metadata-schema` |
| Pipes component IDs | `tika-pipes` service files + docs |
| Behavior | differential tests against a real Tika container, not prose |

Parser class names in `03-parsers.md` are upstream identifiers used for mapping. The generated registry is the source of truth.

## Decision policy

Every behavior decision starts from the upstream implementation: read the Java source for the class being ported, encode its constants and edge cases, and only then choose a TypeScript-idiomatic shape. Modern practice is allowed for the *shape* of the API (streams, abort signals, typed errors, worker isolation), never for silently changing upstream semantics. When we deliberately deviate, the deviation is recorded in the relevant spec section and covered by a test.

Upstream sources are pinned to Tika 4.2.0. Class-level ports cite their Java source in the task comment or module header.

## Non-goals

- JVM byte-compatibility, Java API emulation, `java.*` package mirroring.
- Reimplementing Apache POI/PDFBox/Tika internals line-for-line. Behavioral parity only.
- 100% of 1000+ registered formats. Tiered coverage; every gap is declared and detectable (`UnsupportedFormatError`, never silent empty output).
- Running untrusted documents in-process by default. Heavy/unsafe parsers run in workers.

## Package topology

```
@spikedpunch/ripstream-core              contracts only: Parser, Detector, Metadata, ContentHandler,
                          ParseContext, RipstreamInputStream, MediaType, errors, limits
@spikedpunch/ripstream-mime              generated MIME registry + magic/glob/XML-root engine
@spikedpunch/ripstream-handlers          text | html | xhtml | xml | markdown | json handlers, streaming
@spikedpunch/ripstream-parsers           meta-package, registers P0/P1 parsers (tree-shakeable)
@spikedpunch/ripstream-parser-text       text, csv, html, xml, markdown, source code, json/yaml passthrough
@spikedpunch/ripstream-parser-pdf        pdfjs-dist adapter, PDF attachments, forms, XMP, OCR hook
@spikedpunch/ripstream-parser-office     OOXML, OLE2 (doc/xls/ppt), RTF, MSG, TNEF, ODF, iWork, Visio, Publisher
@spikedpunch/ripstream-parser-archive    zip, tar, gzip, bzip2, xz, brotli, lz4, snappy, 7z, rar, ar, cpio, plist
@spikedpunch/ripstream-parser-document   EPUB, FB2, CHM, WARC, feed, XLIFF, TMX, vCard, iCal
@spikedpunch/ripstream-parser-media      image, audio, video, DICOM, fonts
@spikedpunch/ripstream-parser-science    MAT, NetCDF, HDF5, FITS, GRIB, CAD
@spikedpunch/ripstream-parser-code       class files, executables, crypto, DBF, SQLite
@spikedpunch/ripstream-ocr               tesseract.js + pluggable VLM providers
@spikedpunch/ripstream-langdetect        language detection SPI
@spikedpunch/ripstream-translate         translation SPI
@spikedpunch/ripstream-pipes             fetcher/emitter/iterator/reporter engine + worker pool
@spikedpunch/ripstream-config            JSON/XML config, plugin loader, self-configuring components
@spikedpunch/ripstream-node              Node runtime: temp files, worker_threads, fs, streams adapters
@spikedpunch/ripstream-server            optional HTTP server (parity endpoints)
@spikedpunch/ripstream-cli               optional CLI (tika-app parity)
@spikedpunch/ripstream-eval              optional eval harness
@spikedpunch/ripstream-test-corpus       differential fixtures + golden outputs
```

Rules:

- `core` has **zero runtime dependencies** and no Node/browser globals.
- Platform capabilities (temp dir, workers, fetch, digest) arrive through a `Runtime` interface implemented by `node`, `bun`, `deno`, `browser`.
- Heavy engines (`pdfjs-dist`, `tesseract.js`, `h5wasm`, `fontkit`, `sharp`) are **optional peer dependencies**, dynamically imported only when their parser runs. Missing dependency throws `MissingDependencyError` naming the package and the capability.
- Every parser package is side-effect-free and individually importable. `@spikedpunch/ripstream-parsers` is a convenience barrel with explicit `registerDefaults()` — no auto-registration on import.

## Architecture decisions

1. **SAX-shaped handlers, not DOM.** Tika parsers emit SAX events through `XHTMLContentHandler`. Mirroring `ContentHandler` semantics lets upstream parser logic port mechanically and makes every output handler (Markdown/HTML/text/XML/JSON) a transform over one event stream.
2. **One canonical stream type: `AsyncIterable<Uint8Array>`.** Adapters for Node `Readable`, Web `ReadableStream`, `Blob`, and `Buffer`. No API accepts a whole-file `Buffer` in core.
3. **Random-access parsers spool, disclosed.** OLE2/PDF/zip-central-directory need seeking. `RipstreamInputStream` spools memory → temp file above a threshold (default 1 MiB, configurable). Parsers declare `requiresRandomAccess`; the wrapper enforces the spool.
4. **Backpressure end to end.** Handler writes are synchronous; async output goes through a bounded queue with `AbortSignal`. A slow consumer must not grow memory.
5. **Detection parity is a data problem.** The magic engine is generic; all knowledge lives in a generated registry. Regenerating against a new Tika release is a data-package bump, not a code change.
6. **Untrusted input is hostile.** Zip/XXE/entity expansion/decompression bombs, output limits, parse timeouts, worker isolation, SSRF allowlists in fetchers. See `04-pipes-server-ops.md` security section.
7. **Output stability is contractual.** Metadata key ordering, XHTML shape (`<div class="page">`, `class="package-entry"`, `embedded:` URIs), and Markdown rendering are golden-tested. Breaking them is a major version.

## Parity definition (acceptance)

A format is "in parity" when, against the same input and equivalent config:

- detected media type matches upstream exactly (type, subtype, parameters);
- metadata keys match, and values match for scalar keys; multi-valued keys match as sets (ordering waived unless upstream guarantees it);
- extracted text matches after unicode/whitespace normalization at ≥ 0.98 similarity (0.995 for plain text formats);
- embedded resource tree (paths, depths, media types) matches;
- error cases map to the same status class (unsupported vs encrypted vs malformed vs limit exceeded);
- limits are enforced at least as strictly as upstream.

`05-testing-roadmap.md` defines the harness.

## Reading order

| File | Contents |
|---|---|
| `01-core-api.md` | Public TypeScript contracts, handler/output model, limits, errors, config/plugins |
| `02-detection-metadata.md` | Detection pipeline, magic engine, container sniffing, encoding, metadata schema/serialization |
| `03-parsers.md` | Exhaustive parser inventory by format family, dependencies, streaming strategy, priority |
| `04-pipes-server-ops.md` | Pipes engine, optional server/CLI, OCR/VLM/language/translation, security model |
| `05-testing-roadmap.md` | Differential parity harness, fuzzing, performance gates, staged roadmap, risk register |
