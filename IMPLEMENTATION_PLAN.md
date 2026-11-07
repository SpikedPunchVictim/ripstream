# Implementation Plan — ripstream

Parity target: Apache Tika 4.2.0 (3.3.3 compatibility mode). Library-first; server/CLI/pipes are optional packages. Full feature set: `spec/`.

## Stage 1: Foundation and parity harness
**Goal**: Core contracts, generated MIME/detection data, streaming handlers, text/HTML/XML/CSV/ZIP/GZIP/TAR slice, differential harness.
**Success Criteria**: Core API frozen; detection ≥99% fixture parity; P0 slice golden parity; 1 GB streaming memory test passes; API report reviewed.
**Tests**: unit per contract; magic-rule property tests; 100+ differential fixtures vs Tika 4.2; bundle/tree-shaking; Node 20/22/24.
**Status**: Complete for the P0 slice — detection, handlers, facade/streaming/recursive/rmeta JSON, text/CSV/HTML/XML/Markdown/feeds, ZIP/TAR/GZIP/BZIP2/Brotli/plist, PDF (worker isolation, info/XMP), images, OOXML/ODF/EPUB, OLE2 CFB + legacy DOC/XLS, RTF, EML, WARC/XLIFF/TMX, metadata schema (803 upstream keys) and upstream parser/detector service registry, JSON config, archive safety and decompression limits, global output/time/embedded caps, charset detection across text/XML/feeds. CBD coverage-based test selection is wired into the test suite. 347 tests passing; 294 beads issues closed, 13 external-dependency tasks deferred. External corpus validation covered 4,273 PDFs from pdf.js, veraPDF, BFO, iText, NICAR and openpreserve; see `docs/corpus-validation.md`. Parity harness, corpus, Tika 4.2 detection/OOXML goldens, parser coverage gate, regex magic parity fix, OLE2 custom props, binary PPT and Outlook MSG are in place. Streaming OPC and PDF range transport, SSRF/temp/worker hardening, API/type gates, CI, license/SBOM/provenance are done. Next queue: packaging/publishing, mbox, XZ/7z/RAR, image/audio breadth, OCR, pipes/server.

## Stage 2: Office and document core
**Goal**: PDF, OOXML, OLE2, ODF, EPUB, RTF, mail; recursive parsing and rmeta.
**Success Criteria**: All P0 formats at parity; embedded trees match; 10k corpus <0.5% unexplained diffs; zero crashes; security suite green.
**Tests**: per-format golden text/metadata/embedded; 500 MB PDF and 1 GB zip memory ceilings; encryption and malformed fixtures; abort/leak tests.
**Status**: In Progress — PDF, OOXML, ODF, EPUB, RTF, EML, DOC/XLS and OLE2 property sets implemented; OLE2 legacy remainder (PPT/MSG/TNEF/Visio/Publisher) and golden parity remain.

## Stage 3: Containers and rich media
**Goal**: Remaining archives, WARC, feeds, localization, iWork/CHM/FB2, image/audio/video/font metadata, browser subset.
**Success Criteria**: P1 formats at parity; P2 gaps published; default install lean; browser build runs core subset without Node shims.
**Tests**: archive bomb/traversal matrix; media metadata fixtures; Playwright browser suite; optional-dependency error tests.
**Status**: Not Started

## Stage 4: Advanced formats and NLP
**Goal**: OCR/VLM adapters, scientific/CAD/DICOM, executables/crypto/databases, language detection, translation.
**Success Criteria**: OCR config parity and no default OCR; advanced parsers degrade to metadata or declared errors; no copyleft in default bundle.
**Tests**: OCR golden pages; scientific fixture headers; crypto certificate fixtures; provider mocks; license scan.
**Status**: Not Started

## Stage 5: Pipes, services, hardening, 1.0
**Goal**: Pipes engine, optional server/CLI/eval, security review, SBOM/provenance, docs, performance baselines.
**Success Criteria**: P0/P1 parity report published; server conformance suite green (4.2 + 3.3 compat); 24-hour pipes soak with stable memory; 1.0 API frozen.
**Tests**: endpoint conformance; worker crash/recycle; retry/checkpoint; soak/leak; supply-chain audit.
**Status**: Not Started

## Open decisions
See `spec/05-testing-roadmap.md` §7: runtime scope, default handler, P3 cut line, optional-dependency policy, license policy, server auth, corpus licensing.
