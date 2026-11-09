# Changelog

All notable changes. The project has no tagged release yet, so everything is under Unreleased.

## Unreleased

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
