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
| `ripstream <file>` / `metadata` / `pipes` (CLI) | off; opt in with `--isolation` | One user parsing their own file, or a batch the user chose; the process exits afterwards. See the note below. |
| `createRipstreamServer()` (library) | **no default engine**: it throws without `ripstream` | The server never builds an in-process engine behind your back. Pass `createRipstream()` to accept the risk, or an isolated engine. |
| `PipesClient` (library) | in-process unless given a `ripstream` | Same as `createRipstream()`; pass an isolated engine to contain a run. |
| `createRipstream()` (library) | in-process | A library call is yours to contain. This includes PDFs: the PDF parser runs pdf.js on the calling thread and has no containment of its own. |

With isolation off, the CLI parses inside its own process: a parser crash, an out-of-memory or a runaway document ends the
whole process, and in a `pipes` run that is every input not yet done. Run `ripstream --isolation strict` (or set
`RIPSTREAM_ISOLATION=strict`, or `isolation.mode` in the config file) for input you do not trust and for batch jobs: each
document is parsed in its own child process under the bounds below, and one that crashes or exceeds them fails that document
alone. `ripstream --help` says the same.

`ripstream pipes --workers` is the other way to parse away from the run's own thread: worker threads in the same process,
for speed, with none of the containment above. The CLI refuses it together with isolation; see [workers.md](workers.md).

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

The library options behind that routing are `inProcessTypes` (a set of media types) and `inProcessMaxBytes` (the size
above which everything is isolated), both on `createNodeIsolator` and, through `StandardIsolationOptions`, on
`createStandardIsolation`. Pass `inProcessTypes: new Set()` to isolate every document, text included: each request then
costs a child and the pool has to be sized for it (see the memory table below). `ripstream serve` and the CLI do not
expose a switch for either option; an operator who needs all-isolated parsing builds the engine in code. The other
containment limits in this file (no network or filesystem denial, no temp sweep after a parent SIGKILL, memory defaults
measured on glibc arm64 only) stand as documented.

`/detect` is answered in the parent. Detection looks at a bounded prefix, except that a ZIP's central directory is
read from the end of the file; that walk is capped at 10,000 entries and 8 MiB (before the cap, a crafted directory
cost 20 s of CPU, now 138 ms). The 34-file hostile corpus used for the extractor bake-off (50 MB text documents,
50,000-entry archives, entity expansion, byte flips, truncation) detects in at most 134 ms (50 MB DOCX), and the whole
run leaves the parent at 387 MiB RSS; detection stays in the parent (tikajs-mq38).

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
counts as over budget however small they are. The bound is also the walk's end: a directory that reaches it ends the
call on that same sample, so a hostile child pays for one walk, not a poll per 100 ms (tikajs-tuqe). Measured on
macOS: one 10,000-entry walk takes about 0.7 s, and eight concurrent bound walks take about 0.6 s of wall time in all;
a child that would keep the directory there is killed after that first sample.

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

### Text-heavy documents and the heap (`tikajs-m5ng`)

A 50 MB text PDF (5,000 pages, 47 million characters) used to fail "Isolated parser ran out of memory" at
`maxOutputChars` 52,428,800, though the container peaked at 884 MiB of 11 GiB and Docker reported no OOM kill. The limit
that tripped was the child's V8 heap (`heapMb`, derived as 384 MiB plus 8 bytes per output character, capped at 512
MiB), with the child's resident set at 773 MiB, under `perChildMb` (1536). The cause was pdf.js, not the text: it kept
about 130 KiB of state for every page it had served (13 bytes per extracted character, 678 MiB live at the end, with the
text itself dropped), so a long PDF filled the heap before it reached its cap. At a 15 million character cap the same file
stopped early enough to pass. The PDF parser now calls `document.cleanup()` every 100 pages: the live heap for the same
file is 125 MiB (the text buffer, one byte per character) and the child's resident set 671 MiB at the default sizing.
Measured on Linux arm64, Node 24, records output, `truncate`, cap 52,428,800: the 47 MB PDF (47.1 million characters)
completes with 671 MiB child RSS; 60 MB text documents that reach the cap (a DOCX, a DOCX of two-byte characters, a PDF)
end as partial results with `tk:exception:write-limit-reached` at 754, 989 and 730 MiB child RSS, parent 379 to 443 MiB.

When a child does run out of memory the error now says which limit it met and the measured numbers, for example
`Isolated parser ran out of memory: the V8 heap limit was reached (heapMb 512 MiB; child resident set 773 MiB at most,
of its perChildMb 1536 MiB). ... raise heapMb (it must stay below perChildMb) or lower maxOutputChars`. A failure outside
the heap (a native allocation, the address-space cap) says so, and the RSS kill and an unexplained SIGKILL carry the same
numbers: a peak far below `perChildMb` on a SIGKILL points at the container's own OOM killer. The resident set is the
parent's last RSS poll (every 20 ms on Linux), so it can be a little under the true peak.

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

Each request reserves `perChildMb` (1536) + 1024 MiB of overshoot + room for its result in the pool: **2729 MiB** for
a default text request, 3042 MiB for a recursive one. The pool is sized from the smaller of the cgroup limit and host
memory, minus 512 MiB for the parent, unless `memoryPoolMb` is set.

The consequence is a cliff: **a pool below 2729 MiB cannot run one child.** In practice a container needs about
3.2 GiB of memory to isolate (2729 MiB plus the 512 MiB of parent headroom). Below that, `strict` refuses to start (exit 4, with the sum in the message) and
`lenient` parses everything in-process with a WARN, which is the behaviour isolation exists to prevent. Either
raise the limit, or lower `perChildMb` and `heapMb` and accept a smaller budget per document.

Between 2729 and 3042 MiB the pool runs text requests (`/tika`, `/meta`) but cannot hold a recursive one (`/rmeta`,
`/unpack`, `--recursive`): those that reach a child are refused with 422 (`AdmissionRefusedError`, "more than the whole memory pool"), which
describes the deployment and not the document. The isolator logs a WARN at startup when that is the case. Size the
pool to at least 3042 MiB to serve recursive requests; `/unpack` reserves a little more for the bytes it carries
(see its budget, below).

The number of requests that run at once is `floor(pool / reservation)`. The server's own gate is derived from it
(below), and `/status` shows both: `isolation.pool.poolMb` against `isolation.defaultReservationMb`. Both reservations
are computed for a request at the server's output ceiling.

### What a request reserves (`tikajs-2cvh`)

```
reservation = perChildMb + overshootMb + parentMb

parentMb    = ceil((maxOutputChars * 5  +  rest * f  +  segmentBytes * 4) / 1 MiB) + 96
rest        = maxResultBytes - 6 * maxOutputChars - (wire form of unpackBytes, if any) - segmentBytes
f           = 6 for a text request, 24 for a records request
segmentBytes = 0 without segments; with them, 24 MiB + 0.75 * maxOutputChars
```

| term | value | what it pays for |
|---|---|---|
| `perChildMb` | 1536 (config) | the child's memory: V8 heap (derived 384 - 512 MiB) plus everything outside it. The parent kills the child above this. |
| `overshootMb` | 1024 (pool option) | what a child can use beyond its budget between two RSS polls. Unchanged. |
| `maxOutputChars * 5` | 5 bytes a character | the parent holding the text: the 64 KiB chunks and the string they are joined into (2 x 1 byte for Latin-1 text, 2 x 2 for text with a character above U+00FF). The same for text and records, and whatever the text costs on the wire. |
| `rest * f` | metadata allowance (12 - 16 MiB) at 6x or 24x | metadata, paths and envelopes, which arrive as whole JSON values: a record frame with many short keys costs the parent 10 - 30x its wire size to parse. |
| `segmentBytes * 4` | with `segments`: 24 MiB + 0.75 bytes a character, at 4x | the segments (see "Segments", below). |
| 96 | fixed | the parent's heap growing in steps and collecting parse garbage late. Does not scale with the result. |

`maxResultBytes` is the cap on what the child may send: `6 * maxOutputChars` (the wire form of text at its worst, every
character escaped as `\uXXXX`) + the metadata allowance + 64 KiB. The characters' wire size is NOT what the parent
holds, which is why they are reserved per character. A request with `segments` adds the segments' own allowance to
`maxResultBytes` and reserves it apart, see "Segments", below.

**Markup (`tikajs-n89x`).** For `handlerType` `html`, `xml` and `markdown`, core counts against `maxOutputChars` the
characters the parsers write and not the markup around them (as Tika's write limit does), so the content can be far longer
than `maxOutputChars`: an HTML file of 1.26 million empty `<span></span>` is 16.4 million characters of content and counts
none, and the same parse in this process returns it. The isolator therefore adds a markup allowance of
`16 Mi + 16 * maxOutputChars` characters (18.4 million at the default), at the wire rate of 6 bytes, to `maxResultBytes`,
and reserves those characters in the parent with the text, at 5 bytes each (the markup travels in the same text frames), so
`maxOutputChars` in the formulas above is `maxOutputChars + markup` for those types. A result with more markup than that is a
`LimitExceededError`, as before. The allowance never makes a request refusable that its text fits: it is cut to what is left
under the 512 MiB ceiling (a request of 80 million characters gets about 5 million of markup). The numbers are the repro
rounded up and a rate for tag-dense tables; they are not measured beyond that. Core still does not count markup
(counting it would change what the in-process parse returns).

**Worked example**, `maxOutputChars` 52,428,800, records, default `perChildMb`, `maxEmbeddedResources` 1000 (the metadata
allowance is then its floor of 12 MiB; the default of 10,000 makes it 16 MiB):

```
maxResultBytes = 6 * 52,428,800 + 12 MiB + 64 KiB       = 327,221,248 bytes
rest           = 327,221,248 - 314,572,800              =  12,648,448 bytes (12 MiB + 64 KiB)
parentMb       = ceil((52,428,800 * 5 + 12,648,448 * 24) / 1 MiB) + 96   = ceil(539.5) + 96 = 636 MiB
reservation    = 1536 + 1024 + 636                      = 3196 MiB
```

A 4 GiB container has a pool of 4096 - 512 = 3584 MiB, so one such request runs. With `maxEmbeddedResources` 10,000 the
parent part is 732 MiB and the reservation 3292 MiB. The same request as text is 1536 + 1024 + 419 = 2979 MiB. Before
`tikajs-2cvh` the records request reserved 24 x `maxResultBytes` + 96 = 7586 MiB for the parent, 10,146 MiB in all.

**Why the reservation came down.** A record's content used to travel inside its one record frame, so the parent had to
read, decode and `JSON.parse` a line as long as the whole result: it held the line buffer, the decoded string and the
parsed value at once, 3.5 - 4.6x the frame's wire bytes, and the wire is up to 6 bytes a character. The reservation
was 24x the wire. Content longer than 64 Ki characters now follows its record in `text` frames, the way a text result
does (`record` has `contentLength`, then `text` frames adding up to exactly that, then any `bytes` frames), so the
largest frame the parent parses is the metadata, and a record frame is capped at the metadata allowance plus one
chunk (17.2 MiB at the default 10,000 embedded resources). Segments cross in frames of their own, below.

Measured in Docker (Linux arm64, Node 24, the standard child, `maxOutputChars` 52,428,800, one run each; the generator
and driver are scratch scripts, not in the repository). The documents are synthetic: a text-heavy DOCX (paragraphs of
about 80 characters, a heading every so often), a DOCX of a million tiny paragraphs, and two XLSX of inline-string
cells. Parent: peak RSS above its idle baseline, with segments and without them; "frames" is the size of the
`segments` frames on the wire.

| input | segments | frames | parent without / with (MiB) | extra / frame bytes |
|---|---|---|---|---|
| DOCX, 48 M characters | 597,831 | 40.1 MiB | 136 - 151 / 286 - 293 | 3.5x |
| DOCX, tiny paragraphs | 997,633 | 65.2 MiB | 35 / 249 | 3.3x |
| XLSX, 8 columns | 537,499 | | 23 / 200 | |
| XLSX, 16 columns | 944,436 | 81.5 MiB | 31 / 278 | 3.0x |

The extra is about 220 - 250 bytes a segment (the parent keeps the list and rebuilds each entry as a `Segment` with its
`text`), so per wire byte it is highest for the smallest segments. The worst measured is 3.5x; the 4 in the formula adds
about 15%. The text-heavy DOCX at the full cap in a `--memory 4g` container (pool 3584 MiB) is admitted and completes:
container peak 967 MiB. The segments, labels and locations are identical to the in-process parse (a digest over the
content, `start`, `end`, labels and location of every segment agrees, checked on a DOCX and an XLSX).

The reservation at the full cap, default `maxEmbeddedResources`: 1536 + 1024 + 978 = 3538 MiB, which fits the 3584 MiB
pool of a 4 GiB container. Before, the parent term alone was over 9 GiB (24 x 331 MB of result). A request without
segments is unchanged (3292 MiB).

What it gives up. The allowance is a fixed 24 MiB plus 0.75 bytes a character, where the result cap used to let the
segments take whatever the text left. A document whose segments are denser than that is refused with a
`LimitExceededError` ("segments exceeded the maximum size allowed for segments") where it used to pass. The
tiny-paragraph DOCX above (65 MiB of frames, 11 bytes a character) is one at the full cap. Raise `maxOutputChars` to buy
more allowance, or read such a document without `segments`.

A request that does not fit the pool is an `AdmissionRefusedError` (code `ADMISSION_REFUSED`, 422 from the server, exit
3 from the CLI, `PAYLOAD_LIMIT_EXCEEDED` in pipes). It does **not** extend `LimitExceededError` (it did before `tikajs-mz56`: a
capacity problem of the deployment is not a limit the document hit, and had no `limit` to name), so code that catches
`LimitExceededError` must also catch it, or branch on `code`. It has its own name and code so a consumer can tell it
from a limit the parse itself hit (output, entries, nested documents) and from a crash. Its message gives each part and, on purpose, uses none of the words those
limits use (`output`, `entries`, `embedded`, `ratio`, `timeout`, `corrupt`...), so a classifier that matches messages
does not mistake it for one:

```
Admission refused: a records request allowing 52428800 characters and 1000 nested documents (the defaults unless the
caller set them) needs 3196 MiB (1536 per child + 1024 overshoot + 636 for the parent to hold the result), more than
the whole memory pool of 3200 MiB. Lower the caps or enlarge the pool
```

To fit a small container, lower `maxOutputChars` (each million characters costs about 5 MiB of reservation), or
`perChildMb`, or enlarge the container: a records request at the cap needs
about 3.7 GiB of container (3196 + 512 MiB of headroom).

## The server

`ripstream serve` prints the mode, where it came from and the pool at startup, and sends warnings to stderr as
`ripstream: WARN: ...`. SIGINT and SIGTERM close the listener, then dispose the isolation: every child is killed
and reaped before the process exits.

**One gate.** When isolating, and unless you set `maxConcurrent` / `maxQueue` yourself, the server admits
`floor(poolMb / max(text, records reservation)) + pool.maxQueue` requests at once and holds the next 100 (`maxQueue`)
waiting for a slot, as it does without isolation. The slot is taken before the request body is read, so a request that
waits has not buffered a byte: a burst costs sockets, not memory. A waiting request that gets no slot within
`requestTimeoutMs` (60 s) is a `408`; one that finds the queue full is refused with `503` and `Retry-After: 1`. The gate
keeps the number of bodies held in memory near what the pool can run and queue; it is not an exact bound. A request
that reserves more than the default (a larger ceiling is in the reservation already) can still be refused by the pool
with `queue_full` after its body was read. A separate body-byte budget (`maxInFlightBodyBytes`, default four times
`maxBodyBytes`) counts the bodies the admitted requests hold: a known `Content-Length` reserves that many bytes, a
chunked or gzip body reserves `maxBodyBytes`, and a request that would pass it is answered 503 with `Retry-After: 1`
before its body is read (tikajs-x1f3). Under isolation a `/pipes` run holds one gate slot and parses one document
at a time, so one slot is one child, whatever concurrency the request or the settings ask for. For CONTENT_ONLY and
RMETA its file-system fetcher hands the child the validated path, so a large input is not also copied into the parent;
NO_PARSE (which digests and detects) and UNPACK (which builds a package) read the bytes in the parent (tikajs-2az5). `maxQueue: 0` turns the waiting off: whatever the slots cannot run is refused at once. With children reused, "cannot run" does not include memory an idle child of another trust domain holds: the pool asks for those to be retired first, and one request may wait for their exit (the only one over `maxQueue`, so with `maxQueue: 0` one). With nothing idle to retire, it is refused at once (`tikajs-moxa`).

**Errors.** Isolation failures keep their meaning across the boundary:

| Condition | Status | `Retry-After` |
| --- | --- | --- |
| Document over a limit other than the output limit | 422 | |
| Text reaches the output limit | 200: the text up to it, `tk:exception:write-limit-reached` in the metadata (`X-Ripstream-Write-Limit-Reached` on text routes) | |
| Document malformed, encrypted or empty | 422 on a text route and on `/unpack` (the failure is the body); 200 with `tk:exception:container-exception` on `/rmeta`, `/meta` and JSON | |
| Child ran out of memory, output budget or temporary disk budget | 422 | |
| Parse timed out | 408 | |
| Server or memory-pool queue full (`queue_full`) | 503 | 1 |
| Isolation unavailable (`unavailable`) | 503 | 5 |
| Child crashed without a verdict (`crash`) | 500 | |

An `unavailable` or `queue_full` answer is for that request only. The server never retries it in-process.

A PDF whose parser faults inside the child is a `crash` (500). Before isolation the same fault surfaced as a
malformed document (422). A clearly malformed PDF is still a 422.

**`/unpack` and its byte budget.** `/unpack` answers a zip of the embedded documents, so the parse keeps their bytes
until the package is written. `maxUnpackBytes` (a server option; default 100 MiB; `ripstream serve --config` sets it
with `server.maxUnpackBytes`) is the most it keeps per request. A document that would take the total past it is left out of the zip
and still has its record in `rmeta.json`; there is no query parameter, so a client cannot raise it. With isolation the
bytes cross the boundary as `bytes` frames after their record, counted against `maxResultBytes`, and the budget may not
exceed what a child can hold: `min(256 MiB, perChildMb / 4)`, shown in `/status` as `isolation.limits.unpackCeiling`. A
`maxUnpackBytes` above it is refused when the server is built, with both numbers in the message, and the default is
held under it. The request reserves twice its budget in the pool on top of the usual result room. Measured on macOS
arm64, Node 24, with a real child: the parent's heap and external memory peaked at +78 MiB for 64 MiB of stored entries
(1.2x), +82 MiB for the same deflated (1.3x) and +275 MiB for 256 MiB (1.07x); the child's RSS was about 140 MiB plus
twice the bytes (640 MiB at 256 MiB). The parent writes the zip one file at a time. The archive parser's own
decompression-ratio and size limits still apply to the container, whatever the budget.

**`/status`** (outside the gate, and behind `authenticate` only if the embedder configured one; `ripstream serve` has
none, binds `127.0.0.1` unless `--host` or `server.host` says otherwise, and serves `/status` only when the configuration's
`server.endpoints` lists it, as Tika does) reports the gate, the running and waiting counts and the
isolator's own status: `mode`, `configuredMode`, `degraded` and `degradedReason`, `containment`, `pool`,
`unreapedChildren` (should be 0), `limits`, `defaultReservationMb` and the in-process types.

**`/async` and `/pipes`** parse under the server's output ceiling like any other request. `/pipes` runs through the
same isolated engine; before this release it built its own in-process pipeline. A `queue_full` or `unavailable` answer
for one document is `CLIENT_UNAVAILABLE_WITHIN_MS` for it, listed in the answer's `failures`, and the run goes on.
A file source is handed to the child as a validated path in CONTENT_ONLY and RMETA; NO_PARSE and UNPACK still read it
whole in the parent, so those modes cost parent memory the pool does not account for.

## Reusing children (`tikajs-dasw`)

A fresh child costs about 290 ms before it parses anything (Node's start and the parsers' modules), which is most of
the time a small document takes. A library caller can let a child answer several requests instead. **This is off by
default, and off changes nothing:** the command, the environment, the wire bytes and one child per request are what
they were. `ripstream serve` and `ripstream pipes` expose it too ("In the CLI and the server", below).

```ts
const isolator = await createNodeIsolator({
  config: { mode: "strict" },
  ripstream,
  childModule,
  reuse: { enabled: true, trustDomain: "tenant-a" },
});
await isolator.isolate(request, { trustDomain: "tenant-b" }); // a request of another owner gets another child
```

`createStandardIsolation` passes `reuse` through; its `ripstream` sends every request with the default
`reuse.trustDomain`, so use `isolator.isolate(request, { trustDomain })` when requests have different owners.
`status().reuse` counts domains, idle and busy children, spawns, reused requests and retirements by reason.

| Setting | Default | |
| --- | --- | --- |
| `enabled` | `false` | |
| `trustDomain` | required when enabled | The domain of a request that names none. A non-empty string of at most 256 characters. |
| `maxRequests` | 100 | Requests one child answers before it is retired. |
| `rssCeilingMb` | half the RSS kill limit (`perChildMb`), 768 | A child above it after a request is retired. Must be below the kill limit. |
| `rssSampleEvery` | 10 | The ceiling is checked every this many requests of a child (one sample costs about 50 ms on macOS). |
| `idleTimeoutMs` | 30000 | An idle child is retired after this long. Idle children never keep the process alive. |
| `maxIdleChildren` | 4 | Over all domains; the least recently used goes first. |
| `maxTrustDomains` | 8 | Domains with live children. A request of one more domain gets a child that serves only it, unless a domain whose children are all idle can be cleared. |

Reuse is refused at construction on a platform where the parent cannot read a child's CPU time (anything but Linux
and macOS), and checked at construction unless the mode is `off`; it is ignored when the mode is `off` or a lenient
isolator found isolation unavailable.

### In the CLI and the server

`ripstream serve` and `ripstream pipes` take the same settings, off unless switched on. A trust domain is required:
the CLI cannot know who owns the documents, so it does not pick one.

```bash
ripstream serve --isolation strict --isolation-reuse tenant-a --isolation-reuse-max-requests 50
RIPSTREAM_ISOLATION_REUSE=true RIPSTREAM_ISOLATION_REUSE_TRUST_DOMAIN=tenant-a ripstream pipes --config pipes.json --isolation strict
```

```json
{ "version": 2, "isolation": { "mode": "strict", "reuse": { "enabled": true, "trustDomain": "tenant-a", "maxRequests": 50 } } }
```

- `--isolation-reuse <trust-domain>` switches reuse on and names the domain. `--isolation-reuse-max-requests <n>` sets
  `maxRequests`; the other settings are `RIPSTREAM_ISOLATION_REUSE_<MAX_REQUESTS|RSS_CEILING_MB|RSS_SAMPLE_EVERY|IDLE_TIMEOUT_MS|MAX_IDLE_CHILDREN|MAX_TRUST_DOMAINS>`
  and the keys of `isolation.reuse`.
- Precedence, per setting: flag, then environment, then the config file. `RIPSTREAM_ISOLATION_REUSE=false` switches off
  what the file switched on.
- Refused as a usage error (exit 2), not ignored: reuse without a trust domain; reuse while the mode is `off` (there are
  no children to reuse); a detail (`--isolation-reuse-max-requests`, `RIPSTREAM_ISOLATION_REUSE_*`) while reuse is not
  switched on; a non-positive or non-integer number; the flags on a command that parses one document. The variables are
  ignored by those commands, as `RIPSTREAM_WORKERS` is. A platform that cannot do reuse (not Linux or macOS) is refused
  by the isolator at start, with its message.
- **One trust domain for the whole process.** `serve` sends every request with the configured domain, so every client of
  that server shares children. Run one server per owner, or use the library and `isolate(request, { trustDomain })`, when
  documents of different owners must not meet in a child. `pipes` is one job, so one domain fits it.
- The startup line says reuse is on, and `GET /status` carries the isolator's `reuse` counts under `isolation`.

### What reuse gives up

**When documents of different owners can reach the same isolator, one child per document is the strong option.**
Reuse weakens the boundary *between documents of one child*; the boundary between a child and the server is the same.

- A parser that a document compromises runs in a process that parsed earlier documents and will parse later ones. It
  can read what earlier documents left in the heap and in module state, and watch the documents that come after it.
- It can patch built-ins (`JSON`, `TextDecoder`, prototypes) or the parsers' modules, and change what later documents
  of that child answer.
- The temp-directory check covers files. It does not cover the heap or module state: nothing short of a new process
  does.
- The controls are: `trustDomain` (a child only ever serves the domain it was started for), a small `maxRequests`,
  retiring a child on anything unusual (below), and the OS limits, which apply to the reused child as to a fresh one
  (ulimit, the RSS kill, the process-group kill, the disk budget).

A state audit of the parsers for what one document can leave for the next (n3, sql.js, xz-decompress, pdf.js, the
media-type and parser caches, stderr) found three real carry-overs. The n3 blank-node counters made the same RDF
document print different labels after earlier ones, and told it how many blank nodes those had: each parse now
numbers its own (fixed in this change). sql.js kept one WASM instance per process, so document bytes stayed in its
memory file system when a close failed and a trapped instance served the next file: each document now loads its own
instance (`tikajs-usub`, about 6 ms a document); xz-decompress kept a static instance and a mutex that a
failing dispose never released, and now loads its own class for each document (`tikajs-3o6d`). Retiring a child after any
fault is still the bound for anything this audit did not find. The rest is either
independent of the document or is caches that never show in a later answer (the media-type parse cache, the
composite parser's ranking cache, pdf.js's name caches, cleared on every document's destroy).

`reuse-isolation.test.ts` (bundle-standard) checks this with the real child: documents of four formats carrying a
unique marker are parsed first, then repository fixtures for every parser family (office, ODF, EPUB, ZIP, tar,
GeoPackage, SAS, Ogg, HTML, mail, PDF, RDF), twice, as bytes and as paths, on the same child. Every answer must equal
a fresh child's and never contain the marker; so must requests with `emailHeaders`, records with segments and the
truncating limits, each followed by a request without them.

### When a child is retired

A retired child is SIGKILLed with its process group; the request it served is answered once it is dead and its
directory removed. The parent decides all of this from what it sees; nothing depends on the child cooperating.

| Reason | When |
| --- | --- |
| `error_frame` | The child answered with an error, whatever it was. |
| `exception` | The answer carries an exception or any `tk:exception:` key (an embedded failure, a truncated output). |
| `timeout`, `abort` | The wall-clock deadline fired or the caller aborted: the child is killed, as a fresh one would be. |
| `cpu` | The request used more than `cpuSecs` of CPU (see below); the answer is a `LimitExceededError`. |
| `cpu_unmeasured` | The child's CPU time could not be read after the request. |
| `rss`, `disk`, `result_cap`, `frame_cap`, `metadata_cap` | A limit was hit during the request, as for a fresh child. |
| `protocol` | A frame broke the protocol, the child wrote on fd 3 outside a request or after its answer, or did not consume its input. |
| `exit` | The child exited, crashed or was killed by anything, busy or idle. An idle child that dies leaves the idle list at once. |
| `unavailable` | It could not be started or never became ready. |
| `temp_leftover` | Anything is left in its TMPDIR after a request, or the directory was replaced. |
| `stderr_budget` | It used up its stderr budget (a budget for the child's life, not per request). |
| `rss_ceiling` | Above `rssCeilingMb` (or not measurable) at a sampled request. |
| `max_requests` | It answered `maxRequests`. |
| `single_use` | It was started for a domain beyond `maxTrustDomains`. |
| `idle_timeout`, `evicted`, `dispose` | Idle too long; retired to make room (memory another request waits for, `maxIdleChildren`, `maxTrustDomains`); the isolator was disposed. |

**CPU.** `ulimit -t` counts a process's whole life, so with reuse it is only a backstop (`cpuSecs × maxRequests`, at
most a day). The parent polls the child's CPU time during the request (`/proc/<pid>/stat` every 100 ms, `ps` every
250 ms on macOS) and reads it once more after the answer; what the request added, including anything the child did
while idle, must stay within `cpuSecs`. On macOS the final read is one `ps` per request (about 2 ms).

**Temp files.** The child's TMPDIR is its own call directory. The parent lists it after every request; a file left
there retires the child, and the directory goes with it.

**Memory.** A child holds one pool lease from its start until it is dead. While busy, the lease is its cap, the
overshoot and the parent's room for the result; while idle it gives the result room back and keeps the cap and the
overshoot, so the pool never holds more children than it was sized for. The next request takes its result room again
only when nobody is waiting; otherwise it queues like any request. Idle memory is never stranded: a request that has to
wait makes the pool retire idle children, least recently used first, and a child that finishes while requests are
queued goes to the request at the head of the queue (when it is of the same domain and fits the lease) or is retired
so the head gets its memory. The queue stays first in, first out. A request that can never fit the pool gets the same
message as without reuse.

### What is left

- A reused child that dies after it was checked out and before it began the request (the window between its death and
  our exit event, in which it can still be checked out) is not a failure of the request: the child sends an `accepted`
  frame once it has read the request whole and before it parses anything, so a child that dies without one, with no
  answer, no kill of ours, no abort and nothing on stderr never started it, and the request runs once more on another
  child (`retried` in the reuse stats; `tikajs-krih`). A child that dies after `accepted` is the document's doing and is
  never retried, whatever it left behind. Only the one retry: if that child dies the same way the request fails. The
  failed attempt is still reported to `onRunSettled`. This is for the reused child only; a child started for the
  request is never retried.
- CPU a child spends while idle counts toward its next request. An idle child does nothing unless a parser left work
  behind, which is why it is counted, but the next request then pays for it.
- The audit and the marker test cover the parsers and fixtures named above, not every path of every parser. What they
  miss can only live in the heap or module state, which only a new process clears: hence `maxRequests` and the domains.
- On macOS the CPU and RSS reads start `ps`: about 2 ms per request for the CPU read, and about 50 ms for an RSS sample
  every `rssSampleEvery` requests.

### Measured

`packages/isolation-node/test/bench/warm.mjs` (needs `pnpm build`), darwin/arm64, 12 CPUs, Node 24.18.0. Corpus: the
repository's fixtures (hazard and chaos left out), the 20 largest (3.66 MB) and 200 small ones (153 distinct files of
64 KiB or less, cycled). Every type goes to the child (`inProcessTypes: []`). Concurrency equals the pool size, each of
7 reps builds a new isolation (the warm rows include starting their children), median rep; p50 and p95 per file over
all reps.

| Set | Pool | In-process files/s | One-shot files/s (p50 / p95 ms) | Reused files/s (p50 / p95 ms) |
| --- | --- | --- | --- | --- |
| small | 1 | 290 | 3.3 (298 / 345) | 20.5 (5.0 / 310) |
| small | 2 | 312 | 6.2 (308 / 457) | 39.8 (6.5 / 312) |
| small | 4 | 317 | 11.7 (331 / 408) | 70.5 (7.5 / 330) |
| large | 1 | 246 | 3.2 (311 / 380) | 9.2 (13 / 371) |
| large | 2 | 249 | 6.1 (325 / 398) | 15.1 (21 / 363) |
| large | 4 | 264 | 11.4 (333 / 398) | 19.4 (47 / 399) |

The p95 of the reused rows is a child's start: 11 of the small files fail (HWP, StarOffice 5.2, Word 6, password-
protected OOXML) and 4 of the large ones exceed the output limit; an error retires the child, so the next request
starts one. The small rows started 25 or 26 children for 200 requests (22 `error_frame`, 1 `exception`), the large
rows 6 or 7 for 20. On the 141 small files a reused child answers without being retired, one child answered 500
requests one after another in 2.2 s (4.4 ms each); with `maxRequests` 100, five children took 3.8 s.

The child's RSS over those 500 requests, without recycling: 157 MiB after request 49, 175 after 149, 187 after 499 (a
first run ended at 163). With `maxRequests` 100 it stays between 129 and 175 MiB. The default ceiling, 768 MiB, is far
above both.

## Per-request limits

Every member of `ParseLimits` but one is a per-request limit in child mode, and the child applies the value the request
names (or core's default when it names none), exactly as an in-process parse does. The values are validated in the parent
(`assertValidLimits`, plus the ceilings below) before anything is spawned, so a bad limit is a `RangeError` at the call,
never a surprise from the child; a limit that crosses is never refused for crossing. The same table holds for the limits an
isolated ripstream or `createStandardIsolation` is built with (`limits`, and `parse-context` limits of a configuration):
they take the same path as a call's own, merged under it, and are checked when the facade is built.

| Limit | Wire field of the request and the child's input header | Enforced by | Parent-side bound |
| --- | --- | --- | --- |
| `maxOutputChars` | `maxOutputChars` | the child's output handler | finite (`-1` is refused: the heap and result cap are sized from it) |
| `maxEmbeddedResources` | `maxEmbeddedResources` | the child's embedded-resource counter | non-negative integer |
| `maxNodeDepth` | `maxNodeDepth` | the child's recursion walk | non-negative integer |
| `maxParseMillis` | `maxParseMillis` | the child's parse timer | at most `maxTaskMillis` less the margin; the parent's kill timer is the real bound |
| `maxInputBytes` | `limits.maxInputBytes` | the parent, before routing, pool admission or a spawn (bytes: their length; `{ path }`: stat); the child and an in-process parse apply it again | non-negative integer, at most the isolator's own `maxInputBytes` (a request can lower the operator's cap, never raise it); omitted: the isolator's (100 MiB by default) |
| `maxDocumentOutputChars` | `limits.maxDocumentOutputChars` | the child's per-document output handler (`parseRecursive`) | `-1` or a non-negative number; the shared `maxOutputChars` still caps the total |
| `maxZipEntries` | `limits.maxZipEntries` | the child's zip, tar, cpio, ar, ISO and dump readers | non-negative integer |
| `maxDecompressionRatio` | `limits.maxDecompressionRatio` | the child's inflate budgets (zip, OPC, gzip and the other codecs) | positive finite number |
| `maxEmbeddedResourceBytes` | `limits.maxEmbeddedResourceBytes` | the child's per-entry size check | non-negative integer |
| `maxTotalEmbeddedBytes` | `limits.maxTotalEmbeddedBytes` | the child's per-archive size budget | non-negative integer |
| `maxMetadataValueChars` | `limits.maxMetadataValueChars` | the child's metadata (a value is cut, with no flag) | non-negative integer |
| `maxMetadataTotalChars` | `limits.maxMetadataTotalChars` | the child's metadata (`LimitExceededError`) | at most the default, 2,000,000: a result frame is sized for that many metadata characters |
| `maxXmlEntityExpansions` | `limits.maxXmlEntityExpansions` | reserved: no parser expands DTD entities, so nothing reads it | non-negative integer |
| `maxTaskMillis` | none (does not cross) | the isolator, once, from `IsolationConfig.maxTaskMillis`: it sets the parent's deadline and the child's CPU backstop | refused by name with a pointer to the isolation config; name `maxParseMillis` to shorten one parse |

The four flat fields are the older request shape; the rest ride in one `limits` object (`IsolatedParseRequest.limits`,
`IsolatedLimits` in core). Both are the same limits, so `request.limits` may not repeat a flat one. The input header
stays at version 1: `limits` is an optional field, and the parent and the child it spawns always come from the same
install, so there is no version skew to bridge. An allowlisted type parsed in this process takes the same limits. A limit
raised above what the pool can hold is still answered per request (`ADMISSION_REFUSED`), not at construction.

## Hosting in your own Worker

An application that cannot start a child process can host a Ripstream in a `worker_threads` Worker it supervises itself.
[worker-hosting.md](worker-hosting.md) says what to set there, that the heap limit does not bound total memory, and how
`ERR_WORKER_OUT_OF_MEMORY`, `terminate()` and the Worker's `'error'` and `'exit'` events map to the errors (and the
`IsolationFailureReason`) of this page, through `classifyWorkerFailure`.

## Limits of the design

- **Parser code is trusted.** The disk budget assumes it too: code in the child can hide its files from the poll
  (a `chmod 000` directory is counted as over budget after three failed samples, a renamed call directory is not seen).
  The child talks to the parent over file descriptor 3. Code running inside the child can
  write to it and forge well-formed result frames. A forged result is accepted; one that breaks the protocol is
  reported as a crash. The child is contained by L1 to L6 and is the first target of the kernel's OOM killer, but a
  compromised parser can lie about its own document.
- **A reused child is shared by the documents it serves.** With the opt-in `reuse`, a compromised parser sees and can
  tamper with the later documents of its child; the parent's temp-directory check covers files, not the heap. Keep one child per document when
  owners mix (see "Reusing children").
- **A document password does not cross the boundary.** `--password` with `--isolation` is a usage error.
- **Exception text from a child is data.** Per-document exceptions in recursive results become plain `Error`s with
  the child's text, sanitised and length-capped. They are never a ripstream error class.
- **Every limit but `maxTaskMillis` crosses** ([Per-request limits](#per-request-limits)). `maxTaskMillis` is the isolation's
  own budget and is refused by name; `maxParseMillis` cannot exceed what it allows. `contentType` overrides, passwords,
  streams and blobs are refused too.
- **The child's parse timer does not know about queue time.** It is derived from `maxTaskMillis`. After a long wait
  for memory the parent's deadline can fire first and kill the child; the answer is still a timeout.
- **Reservation is a policy, not a measurement.** The pool counts reservations. Real memory is held by L1, L3 and L4.
  On macOS, with no L4 and a slow L3, a child can overshoot its budget between polls.
