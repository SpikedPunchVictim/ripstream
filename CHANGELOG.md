# Changelog

All notable changes. The project has no tagged release yet, so everything is under Unreleased.

## Unreleased

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
- With `parsers` or `detectors` set, `parse`, `metadata` and `serve` require isolation off. The isolation child
  builds its own ripstream and cannot yet be given the sections, so `serve` (strict by default) and
  `--isolation strict|lenient` refuse them with a usage error that names `tikajs-68os.8.7`, instead of parsing with
  every parser and detector. `detect` never isolates and applies `detectors` whatever the isolation settings.

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
