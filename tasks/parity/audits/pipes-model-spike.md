# Pipes work-unit and config shape: spike evidence (`tikajs-68os.6.2`)

Question from the owner: before building Tika's pipes model, test it against a model made of JavaScript primitives, and
test ripstream's own `{ mode, concurrency, source, sink }` config against Tika's shape, and keep what the numbers favour.
Throwaway scripts are in `tasks/parity/audits/pipes-model-spike/`; every number below comes from running them on one
machine (macOS, Node 24, Apple silicon). Nothing here ran against a live Tika.

## The three work-unit models

| | What the iterator yields | Where the bytes are read |
|---|---|---|
| **E** (today's `PipesEngine`) | `PipeDocument { id, data }`: the bytes themselves | inside the iterator's `next()`, one at a time |
| **J** (JavaScript primitives) | `{ id, open() }`: a closure | inside a worker, when it takes the item |
| **T** (Tika) | `FetchEmitTuple { id, fetcher, fetchKey, emitter, emitKey, … }`: plain data | inside a worker, through a registry of fetchers by id |

J and T are the same loop (`runLazy`); they differ only in `item.open()` against `fetchers.get(tuple.fetcher).fetch(tuple.fetchKey)`.

## Q1: how much of Tika's own pipes configuration loads (`fidelity.mjs`)

Every JSON in the 4.2.0 source tree with a pipes section (103; 40 of them the documented examples). A loader for the
local components (file-system fetcher, emitter and iterator, http fetcher, jsonl and logging reporters) and the `pipes`
keys that map (`parseMode`, `onParseException`, `numClients`, `queueSize`):

| Loads if… | all 103 | documented 40 |
|---|---|---|
| component types and root sections are in the subset | 7 | 2 |
| and every `pipes` key maps | 5 | 2 |
| and `plugin-roots` and the JVM process knobs (`forkedJvmArgs`, `javaPath`, …) are tolerated, since they change nothing here | 23 | 2 |
| and the emit-batching knobs (`emitStrategy`, `emitWithinMillis`, `numEmitters`, …) are accepted | 25 | 3 |

Today's bespoke shape loads 0 of 103. What still blocks the rest, by count: `content-handler-factory` (23; 11 of the 40
documented, the template included), `auto-detect-parser` (15), `metadata-filters` (7), the cloud components (S3, GCS,
Azure, JDBC, Kafka, Elasticsearch, OpenSearch, Solr; most of the documented examples), `configStore*` (6),
`maxFilesProcessedPerProcess` (5). The first three are not pipes: they are content-handler and parser configuration
(`CFG-014` in the config inventory). The cloud components are `tikajs-68os.6.6`.

Limits of this reading: the corpus is Tika's *test* configs, many built to exercise a failure, so the counts show what
blocks and how often, not what a user's config looks like. The classification is by section, type and key name; no config was run.

## Q2: throughput when fetching takes time (`throughput-and-memory.mjs q2`)

300 files of 2 KB (synthetic, so parse cost does not hide scheduling), `CONTENT_ONLY`, latency injected into each fetch.
Files per second, median of three runs.

| fetch latency | concurrency | E | J | T |
|---|---|---|---|---|
| 0 ms | 4 | 649 | 695 | 686 |
| 0 ms | 16 | 653 | 702 | 711 |
| 20 ms | 4 | 43 | 174 | 172 |
| 20 ms | 16 | 43 | 660 | 653 |
| 100 ms | 4 | 10 | 38 | 39 |
| 100 ms | 16 | 10 | 140 | 151 |

E is `1 / latency` whatever the concurrency: its fetcher is read one input at a time inside the iterator, so only the
parse is concurrent. Any fetcher that waits on a network (`HttpFetcher`, every cloud fetcher) is capped at one request in
flight. J and T are 4x to 15x faster at 20 and 100 ms, scale with concurrency, and are within noise of each other (and at 0 ms, where
laziness buys nothing, within 7% of E).

## Q3: bytes held when the emitter is slower than the fetcher (`throughput-and-memory.mjs q3`, one process per engine)

60 files of 20 MB, `NO_PARSE`, 100 ms per emit, concurrency 4. Peak live Buffer bytes (`process.memoryUsage().arrayBuffers`,
sampled every 5 ms). RSS is also printed but understates on macOS (memory compression), so it is not the measure.

| | E | J | T |
|---|---|---|---|
| peak Buffer bytes | 1200 MB | 240 MB | 240 MB |

E held the whole corpus: its queue is bounded in inputs (`maxQueue`, 64), not in bytes, and the fetcher fills it as fast as the
disk reads. J and T hold about concurrency x file size and do not grow with the number of files.

## Q5: can the unit cross a process, a queue or an HTTP body (`wire.mjs`)

| | JSON (HTTP body, queue) | `structuredClone` (worker thread) | `child_process` IPC |
|---|---|---|---|
| closure item | `{"id":"a.docx"}`: `open` silently gone | throws `DataCloneError` | `["id"]`: `open` silently gone |
| tuple | all six fields | all six fields | all six fields |

A closure loses its meaning at the first boundary; a queued `/async` job, a `/pipes` request body, a checkpoint file and a
retry after a restart all need the unit as data. To cross a boundary a J item must be reduced to "which fetcher, which
key", which is a tuple.

## Not measured

- **Recovery** (kill a run, resume it, retry one input by key). Both models can resume by input id; what differs is
  that a tuple names its fetcher and key. Measured under `tikajs-68os.6.4`, in the last section.
- **A byte budget** for the queue. Q3 shows lazy fetch removes the growth with corpus size; the bound that remains is
  concurrency x the largest input, which `maxInputBytes` caps. A `maxInFlightBytes` budget stays in reserve until a run shows
  a need for it.
- **Streaming** a fetch to the parser. The parsers take bytes; only `NO_PARSE` and the emitters could stream.

## Q6: the two config shapes

Each key of the bespoke shape (`validatePipesConfig`) against Tika's (`PipesConfig`, `FileSystem*Config`):

| bespoke key | Tika's shape |
|---|---|
| `mode` | `pipes.parseMode` (default RMETA where the bespoke default is CONTENT_ONLY) |
| `concurrency` | `pipes.numClients` |
| `maxQueue` | `pipes.queueSize` |
| `source.path` (filesystem) | `fetchers.<id>.file-system-fetcher.basePath` and `pipes-iterator.file-system-pipes-iterator.basePath` |
| `sink.path` (filesystem) | `emitters.<id>.file-system-emitter.basePath`; the layout differs (Tika mirrors `emitKey` under it and writes `fileExtension`; the bespoke sink writes one flat directory of sanitised names) |
| `source.urls` (http) | no inline list: tuples with `fetcher` http-fetcher and the URL as `fetchKey`, from a json or csv iterator |
| `ordered` | none (Tika emits as inputs finish) |
| `followSymlinks` | none (Tika's fetcher confines to `basePath`, and has no symlink switch) |

Five of eight map directly, one maps through another component, two have no counterpart, and the sink layout differs.
Going the other way, the bespoke shape has no ids, no routing, no `fetchKey`, no `onParseException`, no reporters, no `onExists`.
Neither shape contains the other.

## Decision

1. **The unit of work is a `FetchEmitTuple`, resolved lazily inside the worker** (T). It ties J on every measured axis (0 ms:
   686 against 695 files/s; 20 ms: 653 against 660) and beats it on the one that decides (Q5: it is data). E loses on throughput
   (Q2) and memory (Q3). The cost of T over J, the registry lookup, is below the noise.
   Fetchers become `fetch(key, signal) -> bytes` registered by id; iterators yield tuples; the engine reads the bytes in
   the worker. Code can register any fetcher or emitter under an id of its own, so J's "just pass a function" ergonomics
   stay (Tika reserves ids that start with `__` for components it supplies itself).
2. **Keep both config shapes, with one engine.** Neither contains the other (Q6), and Tika's own configs do not load through
   the bespoke one (0 of 103) while its two ripstream-only switches cannot be written in Tika's. The bespoke shape stays as
   a shorthand that is turned into an anonymous fetcher, emitter and iterator, so nothing runs on a second code path. A config with a Tika
   `pipes-iterator` section is read as Tika's, with Tika's defaults. Unknown keys in either are refused by name.
3. **Accept what changes nothing, refuse the rest by name.** `plugin-roots` and the JVM process knobs go from 5 to 23 loadable
   configs (Q1); they are accepted when they are the only thing that differs, because ripstream's components are built in and it
   has no forked JVM, and the answer says so. Emit-batching knobs add two more (25) and are accepted for the same reason where
   their value cannot change what is emitted (`emitStrategy` `PASSBACK_ALL` can, and is refused). `content-handler-factory`,
   `auto-detect-parser` and `metadata-filters` stay refused: they change output, so ignoring them would report success while
   changing nothing (`CFG-014`).

Promoted from the design reserve by this evidence: lazy, in-worker fetch (Q2, Q3). Left in reserve: a byte budget for the
queue, streaming fetch, a separate iterator process.

## After the build: what the shipped loader loads (`loader.mjs`, same 103 configs)

`fidelity.mjs` above simulated a loader before one existed. `loader.mjs` runs the real `loadConfig` over the same files:

| | all 103 | documented 40 |
|---|---|---|
| load | 3 (2 of them with a notice that a setting changes nothing) | 1 |
| refused | 100 | 39 |

That is well under the 23 to 25 the simulation allowed, because the simulation only looked at the pipes sections and a
configuration also has the rest of Tika's JSON. What refuses them, by configurations affected (a configuration counts under
every reason): `parse-context.timeout-limits.progressTimeoutMillis`, which ripstream has no stall timer for (38, `CFG-053`,
`tikajs-68os.8.13`); the top-level `content-handler-factory`, `auto-detect-parser` and `metadata-filters` (37, `CFG-014`); other
`parse-context` components (16); the file-system emitter's `fileExtension` (15) and `onExists` (24), which
`tikajs-68os.6.3` implements; `server.allowPipes` (12) and `server.allowPerRequestConfig` (9); `configStore*` (6 each); and the
cloud, search and database components (`tikajs-68os.6.6`). Eight refusals are a template placeholder
(`"emitIntermediateResults": "EMIT_INTERMEDIATE_RESULTS"`), and five `emitterId` refusals follow from the emitter next to
them being refused. So: Tika's pipes sections load, and a configuration loads when everything it asks for is something
ripstream does; most of Tika's own test configurations ask for something that is not, and each says which in its refusal.
Re-run it after `tikajs-68os.6.3`, which should move the file-system emitter configurations.

### After `tikajs-68os.6.3` (same loader, same 103 configs)

| | all 103 | documented 40 |
|---|---|---|
| load | 6 (4 of them with a notice that a setting changes nothing) | 1 |
| refused | 97 | 39 |

The file-system emitter no longer refuses anything: `fileExtension`, `onExists`, `prettyPrint`, `atomicWrites`, `compression`
and `allowAbsolutePaths` are read (no emitter reason is left in the refusal table), and three more configurations load. The
documented examples did not move: each of the 39 asks for something else as well (a cloud, search or database component, a
`parse-context` component, `progressTimeoutMillis`, or a top-level section ripstream does not take). The honest reading is that
the emitter was one reason among several in most of these configurations, and the rest are `tikajs-68os.6.6`, `CFG-014` and
`CFG-053`.

## After `tikajs-68os.6.4`: recovery, measured

The "Not measured" item above, measured (macOS, node 24, a local SSD).

- **Resume by tuple id works with the tuple model.** A child process runs 8 inputs with a checkpoint and `concurrency 1`, stops
  at the fourth, and is sent SIGKILL (packages/pipes/test/resume.test.ts, run three times in a row). A second run over the
  same directory fetched exactly the five inputs the dead run had not recorded, wrote all eight outputs, wrote none twice and
  recorded eight. The checkpoint is the tuple's id; nothing of the closure model's per-item state had to be saved.
- **The one window is emit-then-record.** Stopped after the fourth input was emitted and before it was recorded, with
  `onExists` `REPLACE` or `SKIP` the resumed run did it again cleanly. With Tika's default, `EXCEPTION`, that input was
  `EMIT_EXCEPTION` (its first file untouched) and stayed unrecorded: the cost of Tika's default to a resumable run, now stated
  in docs/migration.md. Recording before emitting would remove the window and lose the input instead; a begin/done journal that
  could tell an input in doubt from one not started is held in reserve, because the emitter's own idempotence already covers it.
- **The old checkpoint store did not scale.** It rewrote the whole JSON file on each `mark`: 0.33 ms an id at 1 000 ids, 0.43
  at 4 000, 1.09 at 16 000 (17.4 s for 16 000 marks), so a 100 000 input run would spend minutes on the checkpoint alone. The
  journal measured 0.09, 0.06, 0.06 and 0.055 ms an id at 1 000, 4 000, 16 000 and 100 000 (5.5 s for 100 000), flat. The race
  I suspected in the old store (two marks finishing out of order and the file losing one) did not reproduce in 200 concurrent
  marks; the journal appends one at a time so it cannot happen.
