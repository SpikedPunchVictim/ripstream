# Worker threads for pipes

A `pipes` run parses its documents on the thread that fetches and emits them, so it uses one CPU however many the
machine has. `--workers` spreads the parsing over a fixed pool of worker threads in the same process: each worker parses
one document at a time, and the run's own thread fetches, detects, filters metadata and emits.

Workers make parsing faster. They do not contain it: a worker shares the process, so a document that crashes a parser
or exhausts memory can still end the run. For input you do not trust, use [isolation](isolation.md) instead; the two
cannot be combined.

## Using it

From the command line:

```sh
ripstream pipes --config tika-config.json --workers 4      # four workers
ripstream pipes --config tika-config.json --workers auto   # sized from the machine
RIPSTREAM_WORKERS=auto ripstream pipes --config tika-config.json
```

| Value | Meaning |
| --- | --- |
| `off` (the default) | Parse on the run's own thread, as without the flag. |
| `1` to `64` | That many workers. |
| `auto` | One worker per CPU the process may use, at most 8, and no more than half the memory allows at 256 MiB per worker (`os.availableParallelism()`, and `process.constrainedMemory()` when a cgroup sets it). If that is fewer than 2, the run parses on its own thread and says so on stderr. |

The flag wins over `RIPSTREAM_WORKERS`. Both are for `pipes` only: `--workers` on another command is a usage error
(exit 2), and the variable is ignored there. A count above 64 is a usage error too.

When the configuration's `pipes` section sets no `numClients`, a run with workers keeps `max(4, 2 × workers)` documents
in flight, so each worker has one document waiting while another is being fetched or emitted. A `numClients` the
configuration sets is used as it is, even when it is lower than the number of workers.

From code, `@spikedpunch/ripstream-pipes/workers` builds the pool. It is a ripstream: hand it to the engine as
`ripstream` and close it when the run is done.

```ts
import { createEngineFromSettings } from "@spikedpunch/ripstream-pipes";
import { createParsePool } from "@spikedpunch/ripstream-pipes/workers";

const pool = await createParsePool({ workers: 4, config });
try {
  await createEngineFromSettings(config.pipes!, { ripstream: pool }).run();
} finally {
  await pool.close();
}
```

`createParsePool({ workers, config?, limits?, digest? })` resolves once every worker has built its ripstream, and rejects
with the reason when one cannot (for example a `RipstreamConfigError` for a `custom-mimetypes` file that does not exist,
which the CLI reports with exit 2). `workers` must be a whole number from 1 to `MAX_WORKERS` (64); `autoWorkerCount()`
is what `--workers auto` picks, 0 when a pool would not pay for itself. The module is loaded only when it is imported: a
run without workers loads none of it and starts no thread.

## Workers or isolation

| | Workers | Isolation |
| --- | --- | --- |
| Where a document is parsed | A thread of this process | A child process per document |
| A native fault in a parser's addon | Ends the run | Fails that document |
| A document that exhausts memory | Usually fails that document; may end the run (below) | Fails that document; the child's memory is budgeted |
| Disk, CPU time, RSS limits | None beyond `maxParseMillis` | `maxDiskMb`, `maxTaskMillis`, memory pool |
| Cost per document | A copy of the input and the result between threads | A process start and a copy over a pipe |

The CLI refuses workers together with isolation, wherever either was set (the flag, the environment, the configuration
file), with exit 2 and a message naming both sources. A worker cannot start a child process, and an operator who asked
for isolation asked for what workers cannot give.

**Out of memory.** Each worker has its own V8 heap. When a parse fills it, V8 stops that worker with
`ERR_WORKER_OUT_OF_MEMORY`, and the pool fails the document with a `LimitExceededError` (a failed input in a `pipes`
run) and starts a new worker. That is best effort: memory outside the V8 heap (buffers, native code) is shared by the
whole process, and when the process itself runs out the operating system or V8 ends it, every worker and every
document in flight with it. The pool sets no heap size; there is no setting that makes a worker's out-of-memory safe.
Use isolation for documents that might.

## When workers help

Workers pay for CPU-bound parsing of many documents: office files, PDFs, HTML and XML, spreadsheets. They do not help
when the run waits on fetching or emitting (a slow object store, a remote search index). They do not reliably help for
tiny documents either, ones that parse in well under a tenth of a millisecond: handing such a document to a worker and
taking its result back costs the run's own thread about as much as parsing it there, so that thread stays the limit
however many workers there are, and a run can be slower than without them (RTF below). One worker is about as fast
as no workers, or slower for tiny documents: the gain comes from parsing several documents at once.

### Measurements

Measured 2026-11-14 for `tikajs-ow39` on an Apple M2 Pro (12 CPUs, 16 GiB, macOS, Node 24.18), where `auto` is 8.
Other work kept the machine at a load average of 7 to 18, so a single run swings by tens of percent; each figure is
the median of three runs. Each group is 6 to 10 documents of xberg's test corpus (the one
[xberg-benchmark.md](xberg-benchmark.md) uses), parsed warm 1,200 times with `parseRecursive` and
`scripts/bench/ripstream-config.json`. In-process is the best of 1, 8 and 16 parses in flight on one thread; `n`
workers keep `2n` in flight, as the CLI does. Documents per second:

| Group (median size) | In-process | 1 worker | 2 | 4 | 8 (`auto`) | 8 against in-process |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Markdown, text (2.9 KB) | 1,206 | 1,056 | 2,117 | 2,596 | 4,567 | 3.8× |
| HTML, XML (4.2 KB) | 2,566 | 2,299 | 3,731 | 6,670 | 7,789 | 3.0× |
| JSON (7.8 KB) | 1,111 | 1,099 | 2,073 | 3,961 | 5,169 | 4.7× |
| CSV, TSV (1.0 KB) | 5,427 | 3,926 | 8,452 | 11,623 | 14,992 | 2.8× |
| YAML, TOML, ipynb (2.5 KB) | 2,919 | 2,633 | 4,948 | 8,863 | 13,194 | 4.5× |
| Email (1.2 KB) | 2,000 | 1,351 | 3,243 | 5,314 | 2,939 | 1.5× |
| OOXML, ODF (28 KB) | 389 | 304 | 395 | 493 | 609 | 1.6× |
| RTF (85 bytes) | 18,516 | 10,592 | 18,950 | 22,706 | 22,011 | 1.2× (0.6× to 1.4×) |

- **RTF is the group `auto` does not win.** Its documents are about 85 bytes and parse in about 50 µs each; with 8
  workers the run's own thread was busy 71 to 98% of the time. Over eight runs of 8 workers against in-process
  (these three and five more), workers were faster in four and slower in four, from 0.57 to 1.36 times. `--help`
  says the same.
- **Email** at 8 workers swung from 2,620 to 8,304 documents a second over the same eight runs, never below
  in-process (about 2,000).
- **Office files** gain least of the larger documents. The run's own thread was busy only about 8% of the time at
  8 workers, so the workers are the limit. A separate series on the same machine measured 1.6 to 2.2 times at
  8 workers; `auto` stays capped at 8 because 8 workers had the best median for office files in every series.

## How failures arrive

| What happened in the worker | What the caller sees | The worker |
| --- | --- | --- |
| The parse threw | The same error class, message and properties: every core error (`RipstreamConfigError` with its `issues`, `UrlSecurityError`, `UnsafePatternError`, `VlmError`, ...), `AggregateError`, `DOMException`, and the built-in errors. A class the pool does not know arrives as an `Error` with the original `name`. | Keeps going |
| The parse ran past `maxParseMillis` | `ParseTimeoutError`, from the worker's own ripstream | Keeps going |
| The worker did not answer 5 s after that (stuck in synchronous code, say) | `ParseTimeoutError`, from the pool's watchdog | Terminated and replaced |
| The caller's signal aborted | The abort error at once, as for an in-process parse | Told to stop; terminated and replaced if it has not within 5 s |
| The worker crashed, exited, or threw where nothing caught it | `IsolationError` with reason `crash` | Replaced |
| The worker ran out of heap | `LimitExceededError` | Replaced |
| A new worker could not be started (four attempts, 100 ms, 400 ms and 1.6 s apart) | `PipesFatalError` for this and every later parse | The pool has failed: the `pipes` run stops |

The watchdog runs on the run's own thread, so it stops a parse stuck in synchronous code, which neither the worker's
own timer nor an abort can.
Its delay is `maxParseMillis` (the call's, else the pool's `limits`, else the configuration's, else the default)
plus the 5 s grace, capped at the largest delay a timer can have; a `maxParseMillis` of 0 means no watchdog.

A promise a parser rejects with nothing to catch it ends its worker, as an unhandled rejection ends a Node process,
even when it happens after the parse answered. The document that worker is parsing then fails with
`IsolationError` (`crash`). An in-process parse has the same failure, except that there it ends the run.

## What crosses to a worker

- **Input**: bytes (a `Uint8Array` or an `ArrayBuffer`, copied, so the caller's buffer stays usable) or a `{ path }` the
  worker reads itself. A stream, a `Blob` or a `{ url }` is refused with a `TypeError`: fetch first.
- **Options**: every `ParseOptions` field but `signal`, which stays on the calling thread. A `password` must be a
  string; a `PasswordProvider` function cannot cross and is refused with a `TypeError`.
- **Configuration**: the `parsers`, `detectors`, `parse-context` limits, digester and `custom-mimetypes` of `config`,
  plus the pool's `limits` and `digest`. Each worker builds its ripstream from them as `createRipstream({ config })`
  does. Metadata filters, fetchers, emitters and reporters run on the calling thread.
- **Detection** runs on the calling thread: it is cheap next to a parse.
- **Results**: text, metadata, records (their embedded bytes copied), media types and errors, rebuilt as the same
  classes.

## Threads, temporary files and shutdown

- **Pool size.** A worker being terminated still counts: its replacement starts after it has exited, so the process
  never has more than `workers` parse threads.
- **Temporary files.** Each worker gets its own temporary directory as `TMPDIR` (and `TMP`, `TEMP`), inside one
  directory per pool under `os.tmpdir()`. A spooled input (a parse spills inputs above 1 MiB to a file) or any other
  scratch file goes there. Terminating a worker runs no `finally` block, so the worker's directory is removed when it
  exits, before its replacement starts, and `close()` removes the pool's directory.
- **`close()`** rejects the parses that are queued or running, waits at most 5 s for the workers to exit, and removes
  the temporary files. Calling it again is harmless. An idle pool does not keep the process alive.
- **Node flags.** A worker keeps only the parent's flags that change how modules load or how warnings print
  (`--conditions`, `--enable-source-maps`, `--no-warnings`, `--disable-warning`, the deprecation and type-stripping
  flags). Preloads (`--import`, `--require`, loaders) are dropped, because a preload written for the main thread must
  not run again in every worker. Heap flags are not passed: `Worker` refuses them.
- **Stack size.** A worker's default stack recurses about four times as deep as the main thread's, so a document that
  overflows the stack in-process would parse in a worker. The pool sizes each worker's stack so that it recurses about
  as deep as the main thread does under the process's `--stack-size` (default 984 KiB).
- **pdf.js and the canvas.** Each worker loads the PDF parser on its own and blocks the native `@napi-rs/canvas` pdf.js
  would otherwise load, as the main thread does.
