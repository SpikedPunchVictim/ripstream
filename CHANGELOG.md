# Changelog

All notable changes. The project has no tagged release yet, so everything is under Unreleased.

## Unreleased

### Configuration (`tikajs-68os.8.1`, `tikajs-68os.8.2`, `tikajs-68os.8.3`)

Changed: configuration no longer accepts what it would ignore. Only `version` and `isolation` are read.

- `loadConfig` and `validateConfig` refuse `parsers`, `detectors`, `contentHandlers`, `metadataFilters` and
  `encodingDetector` by name (`"parsers" is not supported: ripstream would ignore it`). They used to be validated and
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
