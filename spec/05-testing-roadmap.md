# 05 — Testing, Performance, Roadmap, Risks

## 1. Differential parity harness (the core quality gate)

```
corpus ──► tika-java container ──► golden JSON ──┐
   │                                             ├──► comparator ──► report
   └─────► ripstream (same config) ──► actual JSON ─┘
```

### 1.1 Upstream oracle

- Containers: `apache/tika:4.2.0` (primary) and `apache/tika:3.3.3` (compat mode).
- Same request shape for both: `PUT /rmeta` with `Accept: application/json`, handler selected per config.
- Oracle output is captured once per fixture+config and stored as compressed golden files, so normal CI does not require Docker. A nightly job re-validates against a live container.
- `@spikedpunch/ripstream-parity` implements the golden format (`formatVersion`, oracle version/config hash, fixture SHA-256), capture, comparison, and regeneration. Regeneration is an explicit reviewed run; `needsRegeneration` flags oracle version/config changes.
- Oracle version and config hash are stored in every golden file header. Regeneration is an explicit, reviewed commit.

### 1.2 Corpus

| Source | Use | License check |
|---|---|---|
| Hand-built minimal fixtures per format | Every parser; fast unit tests | project-owned |
| Public sample sets (Govdocs1 subset, Common Crawl tiny slice, public format samples) | Real-world structures | per-dataset, recorded |
| Upstream Tika test resources | Direct behavioral comparison | Apache-2.0, NOTICE preserved |
| OSS-Fuzz Tika corpus | Crash/malformed robustness | per upstream |
| Synthetic adversarial set | Zip bombs, XXE, billion laughs, truncations, huge nesting, unicode edge cases | project-owned |
| [PDF Association corpora index](https://github.com/pdf-association/pdf-corpora) | PDF well-formed/malformed/adversarial selection; points at SafeDocs, GovDocs1, issue-tracker and format-corpus sets | index CC-BY-4.0; each dataset checked before use |

Corpus is content-addressed, with a manifest mapping fixture → expected type → parser → oracle file. No binary blobs in git; use a content-addressed store or Git LFS with checksums. PDF corpora can contain malicious files: fetch into an isolated directory, pin by SHA-256, and never execute or preview them during corpus builds.

### 1.3 Comparator rules

- Media type: exact match on type/subtype; charset compared when upstream reports it.
- Metadata: upstream keys must all be present; extra keys allowed only if listed in `documented-additions.txt`. Values compared exactly for scalars, setwise for multi-valued. Known-noise keys (`tk:parse-time-millis`, digests) excluded.
- Content: Unicode normalize (NFKC), strip zero-width, collapse whitespace runs, trim, lowercase optional. Similarity ≥ 0.98; plain text/CSV/XML require ≥ 0.995. Diff artifacts stored for every failure.
- Embedded tree: paths, depth, media types compared as multisets; ordering differences reported separately.
- Errors: mapped class compared (unsupported/encrypted/malformed/timeout/limit), not message text.
- Limits: our behavior must be at least as strict; a case where upstream truncates and we throw is acceptable only if the default is configured to match.

### 1.4 Triage workflow

1. Failure report includes fixture hash, upstream/actual JSON, first diverging text window, metadata diff, detection trace.
2. Classify: `bug` (fix), `upstream-version-drift` (regenerate/decide), `documented-difference` (record), `unsupported` (declare gap).
3. Every documented difference lives in a machine-readable file and appears in the public parity report per release.

### 1.5 Other test layers

- **Unit/contract**: per parser, per detector, per handler. No network, no real time.
- **Property-based**: magic rules (random prefixes must not crash; truncation invariants), metadata round-trip, handler XML well-formedness.
- **Fuzz**: replay OSS-Fuzz corpora; mutational fuzzing of each container header; assert no crash, no unbounded allocation, no unhandled rejection, cleanup completed.
- **Memory**: streaming parsers must parse a 100× buffer-sized document with peak RSS growth < 2× buffer; assert no full-file `collect` in parser code paths.
- **Abort/leak**: cancel at randomized points; assert temp files removed, workers terminated, no dangling handles.
- **Concurrency**: N parallel parses share no mutable state; parser instances with `stateful` reset correctly.
- **Platform matrix**: Node 20/22/24, Bun, Deno; browser subset (Chromium, WebKit) via Playwright for core + text/HTML/XML/ZIP.
- **Types**: `tsd`/`expect-type` for public contracts; `@microsoft/api-extractor` report diff.
- **Bundle**: size budget per package; tree-shaking test importing one parser must not pull others; no side effects on import.
- **Security suite**: XXE, SSRF, zip bomb, path traversal, symlink archive, oversized metadata, regex DoS, credential leakage scan.

---

## 2. Performance targets

| Metric | Target |
|---|---|
| Detection, 1 KiB input | ≥ 50k ops/s/core; no allocation per rule beyond prefix buffer |
| Text/HTML parsing | ≥ 100 MB/s throughput; constant memory |
| CSV parsing | ≥ 50 MB/s; bounded table rendering overhead |
| OOXML (docx) | ≥ 20 MB/s uncompressed; shared-string memory capped |
| PDF | ≥ 5 MB/s text extraction on text-heavy PDFs; page-level streaming |
| ZIP recursion | Bounded memory; no extraction of unneeded entries |
| Cold start (core + text only) | < 50 ms |
| Worker startup | < 300 ms (child), < 100 ms (thread) |
| Memory ceiling | Streaming parse peak scales with configured buffers, not document size |
| Regression gate | > 10% throughput or > 15% memory regression fails CI |

Benchmarks run on fixed hardware profiles with fixtures checked in by hash; results stored per commit for trend charts.

---

## 3. Dependency and license register

Verify every license at adoption; this table is the intended set, not a waiver.

| Capability | Candidate | License | Shipping |
|---|---|---|---|
| XML parsing | `saxes` | ISC | core dependency |
| HTML parsing | `htmlparser2` | MIT | parser-text |
| ZIP | `fflate` | MIT | core parser |
| TAR | `tar-stream` | MIT | parser-archive |
| BZIP2 | `seek-bzip` | MIT | parser-archive |
| XZ | `xz-decompress` | MIT/Apache | parser-archive |
| LZ4 | `lz4js` | MIT | parser-archive |
| Snappy | `snappyjs` | MIT | parser-archive |
| PDF | `pdfjs-dist` | Apache-2.0 | parser-pdf |
| OLE2/CFB | SheetJS `cfb` | Apache-2.0 | parser-office |
| XLS/XLSX helpers | SheetJS `xlsx` | Apache-2.0 | optional, audit |
| DOC legacy | `word-extractor` | MIT | optional, audit |
| OOXML crypto | `officecrypto-tool`-class | MIT | optional |
| Mail | `mailparser` | MIT | parser-document |
| Charset | `chardet` + `iconv-lite` | MIT | core/mime |
| Markdown | `mdast-util-from-markdown` | MIT | parser-text |
| Plist | `bplist-parser` | MIT | parser-archive |
| Image metadata | `exifr` | MIT | parser-media |
| Audio/video metadata | `music-metadata` | MIT | parser-media |
| DICOM | `dicom-parser` | MIT | parser-science |
| Fonts | `fontkit` | MIT | parser-media (optional) |
| HDF5 | `h5wasm` | BSD-2/3? verify | parser-science (optional) |
| NetCDF3 | `netcdfjs` | MIT | parser-science |
| SQLite | `sql.js` | MIT | parser-code (optional) |
| X.509/ASN.1 | `@peculiar/x509`, `asn1js` | MIT/BSD | parser-code (optional) |
| OCR | `tesseract.js` | Apache-2.0 | ocr (optional peer) |
| Image decode/preprocess | `sharp` | Apache-2.0 | optional peer |
| 7z | `7z-wasm` | LGPL-2.1+ | optional, not bundled |
| RAR | `node-unrar-js` (unrar) | restrictive | optional external only |
| PGP | OpenPGP.js | LGPL-3.0 | optional, not bundled |
| Language ID | `franc`, `tinyld` | MIT | langdetect |
| Translation | provider HTTP APIs | n/a | translate |

Rules: no GPL/AGPL in the default install; LGPL only optional and dynamically loaded; every optional peer has a clear install hint and a typed `MissingDependencyError`; license scan runs in CI.

---

## 4. Roadmap

### Stage 1 — Foundation and parity harness

**Goal**: Core contracts, generated detection data, streaming handlers, and the first vertical slice (text/HTML/XML/CSV/ZIP/GZIP) proven against upstream.

**Deliverables**

- `@spikedpunch/ripstream-core`: MediaType, Metadata, ContentHandler, RipstreamInputStream, ParseContext, Parser/Detector, error taxonomy, Runtime, events.
- `@spikedpunch/ripstream-mime`: registry generator from `tika-mimetypes.xml`, magic engine, name/XML-root/text detection, container sniffing.
- `@spikedpunch/ripstream-handlers`: text, xhtml, html, xml, markdown, json, write limits.
- `@spikedpunch/ripstream-parsers` first slice: text/CSV, HTML, XML, ZIP, GZIP, TAR.
- `@spikedpunch/ripstream-test-corpus` + differential harness with 100+ fixtures.
- CI: type checks, unit, differential, bundle, Node 20/22/24.

**Success criteria**

- All core interfaces frozen for 1.0 semver.
- Detection parity ≥ 99% on the fixture corpus; zero false `octet-stream` on text formats.
- Text/HTML/XML/CSV/ZIP/GZIP/TAR golden parity at thresholds.
- Streaming memory test passes for a 1 GB text/zip input.
- API Extractor report reviewed.

### Stage 2 — Office and document core

**Goal**: The formats that make the library useful for real document pipelines.

**Deliverables**

- PDF: text, metadata, XMP, forms, annotations, attachments, encryption, OCR hook; range-based reading.
- OOXML: docx, xlsx, pptx, templates, embedded objects, encryption detection.
- OLE2: doc, xls, ppt, MSG, property sets; encrypted detection.
- ODF (odt/ods/odp), EPUB, RTF, EML/MIME, mbox.
- RecursiveParserWrapper, rmeta serialization, embedded resource handlers.
- Markdown handler parity with Tika 4 defaults.

**Success criteria**

- P0 formats at parity thresholds; embedded trees match.
- 10k-document corpus run with < 0.5% unexplained differences and zero crashes.
- Peak memory bounded for 500 MB PDF and 1 GB zip.
- Security suite green (bombs, XXE, traversal).

### Stage 3 — Containers and rich media

**Goal**: Archive breadth, web/document formats, and media metadata.

**Deliverables**

- BZIP2, XZ, Brotli, LZ4, Snappy, 7z/RAR (optional), AR/CPIO, ISO, plist, AppleSingle.
- WARC/ARC/WACZ, feeds, XLIFF/TMX, vCard/iCal, CHM, FB2, iWork (09/13/18 limits), Visio/Publisher best-effort.
- Image metadata (JPEG/TIFF/PNG/GIF/WebP/HEIF/PSD/ICC), SVG.
- Audio/video metadata (MP3/FLAC/OGG/WAV/AIFF/M4A/MP4/FLV/MKV), fonts.
- Browser-capable core subset.

**Success criteria**

- P1 formats at parity; P2 gaps explicitly listed in the parity report.
- Optional dependency errors are actionable; default install stays lean (< 5 MB excluding parsers? measure and set the budget).
- Browser bundle runs detection + text/HTML/XML/ZIP with no Node shims.

### Stage 4 — Advanced formats and NLP

**Goal**: Long-tail parity and opt-in intelligence features.

**Deliverables**

- OCR (tesseract.js) with upstream-compatible config, worker pool, PDF/image integration.
- VLM provider SPI (no default network), with page/image routing.
- Scientific: MAT, NetCDF, HDF5, FITS, DICOM, GRIB best-effort, CAD best-effort.
- Executables, class files, X.509/PKCS, PGP, DBF, SQLite.
- Language detection SPI, translation SPI with provider adapters.

**Success criteria**

- OCR quality and throughput documented; no OCR by default.
- Advanced parsers degrade to metadata or declared errors, never silent success.
- Optional dependencies isolated; no LGPL/GPL in default bundle.

### Stage 5 — Pipes, services, hardening, 1.0

**Goal**: Operational completeness and release.

**Deliverables**

- Pipes engine: worker pool, fetchers/emitters/iterators/reporters, config parity, retries, checkpoints, observability.
- Optional server with endpoint parity and gating; optional CLI; optional eval harness.
- Full security review, SBOM, provenance, license audit.
- Documentation: API reference, migration guide from Ripstream, parity report per format.
- Performance tuning and regression baselines.

**Success criteria**

- P0/P1 parity report published; every gap listed.
- Server endpoint conformance suite green against the 4.2 protocol fixtures (and 3.3 compat mode).
- 24-hour soak test of pipes with zero leaks and stable memory.
- 1.0 release with API report frozen.

---

## 5. Upstream module mapping

| Tika module | Our package | Parity scope |
|---|---|---|
| `tika-core` | `@spikedpunch/ripstream-core`, `@spikedpunch/ripstream-mime`, `@spikedpunch/ripstream-handlers` | full contracts and detection |
| `tika-parsers` | `@spikedpunch/ripstream-parser-*` | tiered, documented |
| `tika-detectors` | `@spikedpunch/ripstream-mime` | full |
| `tika-metadata-schema` | generated into core | full key/type schema |
| `tika-serialization` | handlers + serializers | JSON/XML/CSV |
| `tika-langdetect` | `@spikedpunch/ripstream-langdetect` | SPI + backends, scores differ |
| `tika-translate` | `@spikedpunch/ripstream-translate` | SPI + provider adapters |
| `tika-pipes` | `@spikedpunch/ripstream-pipes` | engine + core components; cloud components optional |
| `tika-server` | `@spikedpunch/ripstream-server` | endpoint parity, 4.x primary |
| `tika-app` | `@spikedpunch/ripstream-cli` | CLI parity |
| `tika-grpc` | not planned initially | optional later |
| `tika-eval` | `@spikedpunch/ripstream-eval` | optional, later |
| `tika-batch` | superseded by pipes | n/a |
| `tika-ml` / `tika-image-processing` / `tika-plugins-core` | design influence only | plugin model adopted; ML not planned |
| `tika-xmp` | in core metadata | XMP parse/serialize |

---

## 6. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Upstream parity drift between releases | Diverging behavior | Generated registry + nightly differential job + pinned oracle version |
| Binary Office parsers (doc/xls/ppt) are deep | Schedule/quality | Prioritize text extraction paths; differential fixtures early; fallback to well-audited libs where license allows |
| PDF text order differs from PDFBox | Content parity failures | Layout heuristics + normalization thresholds; document known ordering differences |
| Tika 4 Markdown handler semantics are under-specified | Golden mismatches | Reverse-engineer with fixtures; treat as pinned contract; allow `handler: 'text'` |
| 7z/RAR/PGP licensing | Cannot bundle | Optional peers, external process guidance, excluded from default |
| wasm memory and cold-start for HDF5/CAD/OCR | Performance | Lazy load, worker reuse, size budgets, capability detection |
| Browser runtime cannot seek or spawn workers | Reduced parity | Declare subset; explicit errors; test both runtimes |
| Large metadata schema and MIME table | Bundle size | Compact generated tables, per-format split, tree-shaking, measure budget |
| OneNote/CHM/iWork body extraction effort | Low ROI | P3, explicit gaps; metadata/preview where upstream does the same |
| Locale/date/timezone differences | Metadata mismatches | Pin formatting, UTC default, documented zones, fixtures |
| Security regression in a parser | Critical | Fuzz corpora, worker isolation, limit enforcement, security suite in CI |

---

## 7. Open decisions

1. **Runtime scope**: recommend Node-first with a universal core; browser supported for detection + text/HTML/XML/ZIP only. Confirm.
2. **Default handler**: recommend Tika 4 Markdown for API parity, with `text` one option away. Confirm whether 3.x text should be the default in compat mode.
3. **Format cut line**: confirm that P3 items (OneNote, CHM, CAD, GRIB, PGP, cloud fetchers) can ship after 2.0.
4. **Optional dependency policy**: confirm that OCR (tesseract.js, ~10 MB wasm) and cloud SDKs are peer deps, not bundled.
5. **License policy**: confirm no LGPL in default install; 7z/RAR/PGP optional only.
6. **Server auth**: confirm auth is delegated to a reverse proxy; the in-process server exposes hooks only.
7. **Corpus licensing**: confirm which public corpora can be vendored by hash versus downloaded in CI.
