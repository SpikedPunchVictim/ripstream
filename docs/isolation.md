# Parse isolation

Parsers run on hostile input. A parser bug can exhaust memory, spin the CPU or crash the process, and in one
process that takes every other request down with it. **Parse isolation** parses each document in its own short-lived
child process, so a bad document costs one child and one error response.

Isolation is a memory budget as much as a process boundary: the parent admits a document only when the host memory
pool can hold a child for it, so a flood of hostile documents queues or gets a 503 instead of exhausting the host.

## Who isolates by default

| Entry point | Default | Why |
| --- | --- | --- |
| `ripstream serve` (the server product) | **strict** | A long-lived service that takes documents from strangers. |
| `ripstream <file>` / `metadata` (one-shot CLI) | off; opt in with `--isolation` | One user parsing their own file; the process exits afterwards. |
| `createRipstreamServer()` (library) | **no default engine**: it throws without `ripstream` | The server never builds an in-process engine behind your back. Pass `createRipstream()` to accept the risk, or an isolated engine. |
| `PipesClient` (library) | in-process unless given a `ripstream` | Same as `createRipstream()`; pass an isolated engine to contain a run. |
| `createRipstream()` (library) | in-process | A library call is yours to contain. This includes PDFs: the PDF parser runs pdf.js on the calling thread and has no containment of its own. |

`strict` refuses to start when isolation cannot be provided. `lenient` logs a WARN and parses everything in the
server process. `off` parses in-process and says so at startup and, when `/status` is served, on `/status`.

## Configuration

Precedence, highest first: command-line flag, environment variable, `--config` file (`isolation` key), the
command's default. Numeric settings are merged per field. Request parameters never change any of this: isolation is
fixed when the process starts, and a client cannot name a mode, a limit or a pool.

| Setting | Flag | Environment variable | Config key (`isolation.`) |
| --- | --- | --- | --- |
| Mode: `strict`, `lenient`, `off` | `--isolation` | `RIPSTREAM_ISOLATION` | `mode` |
| Refuse platforms without hard memory containment (strict only) | | `RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT` | `requireStrictContainment` |
| Memory shared by all children, MiB | | `RIPSTREAM_ISOLATION_MEMORY_POOL_MB` | `memoryPoolMb` |
| Memory budget of one child, MiB (default 1536) | | `RIPSTREAM_ISOLATION_PER_CHILD_MB` | `perChildMb` |
| Largest input, bytes (default 100 MiB) | | `RIPSTREAM_ISOLATION_MAX_INPUT_BYTES` | `maxInputBytes` |
| Wall-clock budget of one request, ms (default 60,000) | | `RIPSTREAM_ISOLATION_MAX_TASK_MILLIS` | `maxTaskMillis` |
| V8 heap of one child, MiB (default derived, 384 to 512) | | `RIPSTREAM_ISOLATION_HEAP_MB` | `heapMb` |
| Requests allowed to wait for memory (default 16) | | `RIPSTREAM_ISOLATION_MAX_QUEUE` | `maxQueue` |
| Temporary disk budget of one child, MiB (default 1024) | | `RIPSTREAM_ISOLATION_MAX_DISK_MB` | `maxDiskMb` |
| Server ceiling on extracted characters per request (default 100,000; `serve` only) | `--max-output-chars` | `RIPSTREAM_MAX_OUTPUT_CHARS` | |

A bad value is a usage error (exit 2) that names the flag or variable. The merged settings are validated with the
same rules as a config file, so `perChildMb` above `memoryPoolMb` is rejected wherever it came from. The exception is
`requireStrictContainment`: it refines `strict`, so when the flag or `RIPSTREAM_ISOLATION` lowers the mode it is
dropped instead of failing.

A `RIPSTREAM_*` variable that is not in the table is also a usage error, with the nearest setting offered
(`RIPSTREAM_ISOLATION_MAXQUEUE` → did you mean `RIPSTREAM_ISOLATION_MAX_QUEUE`?). Left alone, a misspelled name would
have no effect and the setting would keep its default. A config file with a repeated key, or nested more than 64
levels, is refused the same way, and so is a flag that takes a value (`-c`, `-p`, `--port`, `--host`, and `-h` in `serve`) when the value
is missing or is another flag.

A config file with a `parsers`, `detectors`, `parse-context` or `custom-mimetypes` entry
([parsing.md](parsing.md#the-parsers-section)), and the `--maxEmbeddedDepth` / `--maxEmbeddedCount` flags, apply with
isolation on as they do with it off (`tikajs-68os.8.7`, `tikajs-68os.8.11`). The `parsers` and `detectors` sections, and
the text of the custom-mimetypes file (read once by the parent), reach the child in the header of each request, and the
routing detector, `detect()` and the parsers that stay in this process are built from them too, so all of them agree on
what a document is and what parses it; the in-process parsers are narrowed by the section and never widened. Limits are
the defaults of every isolated parse. Two things the isolation cannot carry are refused when it starts, as usage errors:
a parse timer above `maxTaskMillis` less the parent's margin, and an unlimited output (`writeLimit: -1`). `serve`
isolates by default and applies `parsers` and `detectors` the same way; it refuses `parse-context` always
(`tikajs-68os.8.9`).

`detect` and `language` run in this process whatever is set, so they do not read these settings and a bad value cannot
make them fail. `--max-output-chars` and `RIPSTREAM_MAX_OUTPUT_CHARS` belong to `serve`; one-shot commands ignore them.

`--max-output-chars` is the server's ceiling and also its default: a request that sends no `maxOutputChars`, or asks
for more, gets the ceiling. With isolation on the ceiling is required, because the child's result cap and memory are
derived from it, so `serve` builds the isolation for that cap (`defaultMaxOutputChars`). The pool check, `/status` and
the reservations all describe a request at the ceiling. A ceiling no child could hold is a usage error. A library
caller that builds its own isolation passes `defaultMaxOutputChars` the same way; the server warns when its ceiling is
above what the isolation was built for.

## What gets isolated

The parent detects the media type from the first 64 KiB. Documents of these twelve types, up to 8 MiB, are parsed
in the parent by a ripstream that holds only the text parsers: `text/plain`, `text/csv`,
`text/tab-separated-values`, `text/html`, `application/xhtml+xml`, `text/markdown`, `application/json`,
`application/ld+json`, `application/manifest+json`, `text/x-yaml`, `text/xml`, `application/xml`. Everything else, and
anything larger, goes to a child. The parent's restricted ripstream owns no container, image, audio, database or PDF
parser, so a file whose first 64 KiB look like text can never reach one inside the server process.

(`application/ld+json` and `text/xml` are never produced by the detector today: a JSON-LD file detects as
`text/plain` and `text/xml` is normalised to `application/xml`. Those two entries are inert.)

`/detect` is answered in the parent. Detection looks at a bounded prefix, except that a ZIP's central directory is
read from the end of the file; that walk is capped at 10,000 entries and 8 MiB (before the cap, a crafted directory
cost 20 s of CPU, now 138 ms). Detection cost on other adversarial inputs has not been measured.

## Containment layers

| Layer | What it bounds | Linux | macOS |
| --- | --- | --- | --- |
| L1 `--max-old-space-size` | The child's V8 heap | yes | yes |
| L2 wall-clock SIGKILL of the process group | A parse that never ends | yes | yes |
| L3 RSS poll | Memory outside the heap | `/proc`, 20 ms | `ps`, 250 ms or slower |
| L4 `ulimit -v` | Address space | yes | **no** (RLIMIT_AS is unsupported) |
| L5 `ulimit -t` | CPU seconds, also after the parent is gone | yes | yes |
| L6 disk budget poll | Bytes the child writes to its private temp directory | yes | yes |

`requireStrictContainment` makes the mode refuse a platform that lacks L3 or, on Linux, L4 and L5. macOS passes
`strict` with the weaker memory containment shown above; set the option to refuse it. `/status` shows what the
running platform enforces under `isolation.containment`.

If the server is killed with `SIGKILL`, its children do not outlive it for long. Measured on macOS with
`maxTaskMillis` 8000, killing the parent 2.5 s into the parse: a child waiting on a parse that never settles was gone
5.1 s later (its own parse timer), and a child spinning the CPU in a loop was gone 10.6 s later (the L5 CPU limit,
`maxTaskMillis` plus 5 s). With the default `maxTaskMillis` of 60 s the bound is about a minute. Linux behaviour
under a killed parent is covered by the chaos fixtures (case h in `packages/isolation-node/test/chaos`).

**Disk.** A parser can write to disk: a stream above 1 MiB is spooled to the temp directory, and the OCR parser
writes its image there too. A 90 MiB stored ZIP entry that looks like a PDF made one child write 270 MiB (three
copies of it), and a wall-clock kill used to leave them behind. So each call gets a private directory
(`ripstream-call-*`, mode 0700, under `os.tmpdir()`) that the child receives as `TMPDIR`; its working directory is
unchanged. While the child runs, the parent measures the directory's allocated bytes every 100 ms (a sparse file
counts what it occupies, not its length) and kills the process group when they pass `maxDiskMb`, default 1024 MiB.
The request is then a 422 like a heap or RSS kill, and its message names the budget ("temporary disk budget of N MiB
exceeded"). The default leaves room for the measured 3x amplification of an input at the 100 MiB cap and for the OCR
image. The walk is bounded: more than 10,000 files and directories, or directories nested deeper than 8 levels,
counts as over budget however small they are.

The directory is removed after the child's process group has been reaped, whatever the outcome: a result, an error
frame, a crash, a timeout, an abort, a memory or disk kill, `dispose()`. The caller is answered after the removal, and
a removal that fails is logged as a warning and does not change the answer. Library callers can place the
directories with the `tempDir` option of `createNodeIsolator` (an absolute path to an existing directory); the CLI and
the server have no flag or variable for it. Limits of this layer:

- The poll is the only enforcement, so a child can write about the poll interval times its write rate beyond the
  budget before it is stopped (there is no `RLIMIT_FSIZE`), and one that finishes within a single interval is never
  measured. The overshoot is documented, not prevented.
- Only `TMPDIR` is measured. Parser code is trusted, and a path it names elsewhere is not covered.
- If the **parent** is killed with `SIGKILL`, the directories of the calls in flight at that moment stay behind:
  nothing sweeps them. This is documented, not fixed.

## Measured defaults

The defaults were checked against two public corpora, one child per file, sequentially, on Linux (arm64, glibc,
Node 24.22, `MALLOC_ARENA_MAX=1`): the Apache POI test-data OOXML files (599 docx/xlsx/pptx, revision `545dca7`) and
the pdf.js test PDFs (1,089 files, revision `6619bf0`). `packages/isolation-node/test/bench/profile.mjs` reruns it;
CI does so on every relevant change (`isolation-benchmark`).

| | OOXML (599) | PDF (1,089) | Default budget |
| --- | --- | --- | --- |
| Peak child RSS, p50 / p99 / max | 112 / 285 / 595 MiB | 135 / 208 / 519 MiB | `perChildMb` 1536 |
| Wall time, p50 / p99 / max | 0.35 / 1.1 / 2.5 s | 0.62 / 1.8 / 3.2 s | `maxTaskMillis` 60 s |
| Killed for memory or time | 0 | 1 (`issue_cmap12.pdf`, below) | |
| Not parsed (malformed, encrypted, output cap; OOXML: includes 2 internal failures below; PDF: includes the kill above) | 53 | 25 | |

The RSS maxima are below half of `perChildMb`, and the slowest file takes 5% of `maxTaskMillis`. The default heap
(`heapMb` derived, 385 MiB at the default output cap) is never the limit: every PDF but one parses in a 128 MiB heap.
The exception, `issue_cmap12.pdf` (2 KB), makes pdf.js allocate without bound: it runs out of heap at 384, 512 and
768 MiB and at the CPU limit at 1024 MiB. It is refused with a 422 in every configuration, which is the containment
working, not a sizing problem. Larger `perChildMb` and `heapMb` buy nothing on these corpora.

A PDF flate bomb is stopped by the RSS poll (L3), not by the heap cap: the inflated bytes live outside the V8 heap.
At the default sizing a 2 GiB inflated bomb (2 MB on the wire) parsed to empty text in 13 s at 1.4 GiB RSS, under
`perChildMb`; larger ones end at the RSS limit or the wall clock.

### Hazard probes: music-metadata, hyparquet, large archives

Hostile inputs built in memory (`packages/bundle-standard/test/hazard-probes.test.ts`, about 30 s) go through the real
isolator on macOS and Linux (arm64). Each is a typed failure or a clean success, in one child that is reaped before the
caller is answered, with the pool whole and the next request served.

- **music-metadata** caps its own allocations (64 MiB) and metadata entries (100,000), so lying length fields are cheap
  `MALFORMED_DOCUMENT`s. The cost is the MPEG sync scan on 0xFF-heavy data: about 3 s of CPU and 70 bytes of heap per
  input byte, linear. 8 MiB of 0xFF holds a child for the whole `maxTaskMillis`.
- **hyparquet** has no limits. A 118-byte file (delta page, bit width 0) pins a child for the whole budget; a 757 KB
  file with 20,000 columns costs more than 10 s of CPU (schema lookup is quadratic). Dictionary, RLE and delta pages
  that claim 2^31-1 values allocate GiBs from about 120 bytes. All end at the heap cap, the RSS poll, the CPU limit or
  the clock.
- **Archives.** A ZIP of 10,000 entries parses in 2-3 s (0.2 ms per flat entry, 1.4 ms per nested archive), not the
  minute that extrapolating from the central-directory walk suggested. Within the caps the worst case measured is
  13-14 s (4,990 nested archives). With default limits the 100,000-character output cap ends text-entry archives first
  (0.6-1.5 s), so `maxEmbeddedResources` binds only for archives of non-text entries.

Not contained, macOS only: the 119-byte dictionary page above (bit width 0, 2^31-1 values) parses "ok" under default
limits after 5 s. macOS has no `RLIMIT_AS`, and the compressor hides the 8 GiB array from the `ps` RSS the poll reads
(RSS 895 MiB, `phys_footprint` 9.6 GiB). Linux refuses the allocation (`RangeError`, answered `MALFORMED_DOCUMENT`).
Production isolation targets Linux; on a macOS host treat `perChildMb` as advisory for typed-array bombs. Tracked in
tikajs-ubpo (poll `phys_footprint`) and tikajs-5bg6 (bound the Parquet footer and page sizes).

Ogg Vorbis and Opus files answer `UNSUPPORTED_FORMAT` because no parser claims the detected types (tikajs-joxh).

**The native canvas.** pdf.js requires the native `@napi-rs/canvas` the moment it is imported, to polyfill rendering
classes the parser never uses. It adds about 1.2 GiB of address space plus 65 MiB per visible core (19 threads against
11), which is counted by L4. On native arm64 CI runners, with the canvas installed as it is in any real deployment, the
6 GiB cap was nearly spent before the heap grew: 180 of 1,089 PDFs and 2 of 599 OOXML files failed "out of memory" at
a child RSS under 210 MiB. The corpus runs above had been made without the binding and missed it. The standard child
now stops pdf.js from loading it (`block-pdfjs-canvas.ts`, scoped to requests made from pdfjs-dist): address space
drops by 1.6 GiB, text and metadata are identical on 88 sampled PDFs, and both corpora pass at the 6 GiB default.
The first failures appear at the 4 GiB floor, so the default keeps about 1.5x headroom. The in-process path still loads
the canvas (tikajs-lqku).

Two files of the OOXML corpus fail with an internal failure (a `RangeError` on a fuzzed docx); they are tracked as a
parser bug, not an isolation defect.

## Sizing and the deployment cliff

Each request reserves `perChildMb` (1536) + 1024 MiB of overshoot + room for its result in the pool: **2708 MiB** for
a default text request, 3056 MiB for a recursive one. The pool is sized from the smaller of the cgroup limit and host
memory, minus 512 MiB for the parent, unless `memoryPoolMb` is set.

The consequence is a cliff: **a pool below 2708 MiB cannot run one child.** In practice a container needs about
3.15 GiB of memory to isolate (2708 MiB plus the 512 MiB of parent headroom). Below that, `strict` refuses to start (exit 4, with the sum in the message) and
`lenient` parses everything in-process with a WARN, which is the behaviour isolation exists to prevent. Either
raise the limit, or lower `perChildMb` and `heapMb` and accept a smaller budget per document.

Between 2708 and 3056 MiB the pool runs text requests (`/tika`, `/meta`) but cannot hold a recursive one (`/rmeta`,
`/unpack`, `--recursive`): those that reach a child are refused with 422 ("more than the whole memory pool"), which
describes the deployment and not the document. The isolator logs a WARN at startup when that is the case. Size the
pool to at least 3056 MiB to serve recursive requests.

The number of requests that run at once is `floor(pool / reservation)`. The server's own gate is derived from it
(below), and `/status` shows both: `isolation.pool.poolMb` against `isolation.defaultReservationMb`. Both reservations
are computed for a request at the server's output ceiling.

## The server

`ripstream serve` prints the mode, where it came from and the pool at startup, and sends warnings to stderr as
`ripstream: WARN: ...`. SIGINT and SIGTERM close the listener, then dispose the isolation: every child is killed
and reaped before the process exits.

**One gate.** When isolating, and unless you set `maxConcurrent` / `maxQueue` yourself, the server admits
`floor(poolMb / max(text, records reservation)) + pool.maxQueue` requests at once and queues none of its own. The slot
is taken before the request body is read, so a flood is refused with `503` before its bytes are buffered. The gate
keeps the number of bodies held in memory near what the pool can run and queue; it is not an exact bound. A request
that reserves more than the default (a larger ceiling is in the reservation already) can still be refused by the pool
with `queue_full` after its body was read, and `/pipes` spends one slot on a run that parses several documents at once.

**Errors.** Isolation failures keep their meaning across the boundary:

| Condition | Status | `Retry-After` |
| --- | --- | --- |
| Document over a limit, malformed, encrypted | 422 | |
| Child ran out of memory, output budget or temporary disk budget | 422 | |
| Parse timed out | 408 | |
| Server or memory-pool queue full (`queue_full`) | 503 | 1 |
| Isolation unavailable (`unavailable`) | 503 | 5 |
| Child crashed without a verdict (`crash`) | 500 | |

An `unavailable` or `queue_full` answer is for that request only. The server never retries it in-process.

A PDF whose parser faults inside the child is a `crash` (500). Before isolation the same fault surfaced as a
malformed document (422). A clearly malformed PDF is still a 422.

**`/status`** (outside the gate, and behind `authenticate` only if the embedder configured one; `ripstream serve` has
none, binds `127.0.0.1` unless `--host` or `server.host` says otherwise, and serves `/status` only when the configuration's
`server.endpoints` lists it, as Tika does) reports the gate, the running and waiting counts and the
isolator's own status: `mode`, `configuredMode`, `degraded` and `degradedReason`, `containment`, `pool`,
`unreapedChildren` (should be 0), `limits`, `defaultReservationMb` and the in-process types.

**`/async` and `/pipes`** parse under the server's output ceiling like any other request. `/pipes` runs through the
same isolated engine; before this release it built its own in-process pipeline. Two limits remain: a `queue_full`
answer for one document aborts the whole `/pipes` run, and a file source is read whole in the server process before
it is handed to a child, so a large file costs parent memory that the pool does not account for.

## Limits of the design

- **Parser code is trusted.** The disk budget assumes it too: code in the child can hide its files from the poll
  (a `chmod 000` directory is counted as over budget after three failed samples, a renamed call directory is not seen).
  The child talks to the parent over file descriptor 3. Code running inside the child can
  write to it and forge well-formed result frames. A forged result is accepted; one that breaks the protocol is
  reported as a crash. The child is contained by L1 to L6 and is the first target of the kernel's OOM killer, but a
  compromised parser can lie about its own document.
- **A document password does not cross the boundary.** `--password` with `--isolation` is a usage error.
- **Exception text from a child is data.** Per-document exceptions in recursive results become plain `Error`s with
  the child's text, sanitised and length-capped. They are never a ripstream error class.
- **Only `maxOutputChars` and `maxEmbeddedResources` cross.** Other limits stay at the child's defaults, and an
  isolated request that sets another is refused up front. `contentType` overrides, streams and blobs are refused too.
- **The child's parse timer does not know about queue time.** It is derived from `maxTaskMillis`. After a long wait
  for memory the parent's deadline can fire first and kill the child; the answer is still a timeout.
- **Reservation is a policy, not a measurement.** The pool counts reservations. Real memory is held by L1, L3 and L4.
  On macOS, with no L4 and a slow L3, a child can overshoot its budget between polls.
