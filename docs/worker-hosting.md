# Hosting Ripstream in your own Worker

Ripstream can run inside a `worker_threads` Worker that your application starts and supervises. This is a different
thing from the isolation child process ([isolation.md](isolation.md)) and from the `pipes` parse pool
([workers.md](workers.md)): ripstream does not start, watch or kill your Worker. You do, and this page says what to
set, what the failures look like, and how they map to the errors the isolator gives a dead child, so that a service can
treat both hosts alike. Everything below was run: `packages/bundle-standard/test/worker-hosting.test.ts` hosts the
standard Ripstream in a real Worker, runs it out of heap, and `terminate()`s it.

Choose a Worker only when the document may fail but cannot bring the process down. A Worker shares the process with
you: a native fault in a parser's addon, or the operating system running out of memory, ends your process and every
Worker in it. A child process ([isolation.md](isolation.md)) is the host for documents you do not trust.

| | Worker you host | Isolation child |
| --- | --- | --- |
| Memory pool, queue, `queue_full` | None; any queue is yours | `MemoryPool`, `maxQueue`, `AdmissionRefusedError`, `IsolationError("queue_full")` |
| `maxInputBytes` and every other `ParseLimits` member but `maxTaskMillis` | Set in the Worker, per call (all of them) | Per request, checked in the parent first (`maxInputBytes`) or by the child |
| Heap | `resourceLimits.maxOldGenerationSizeMb`; V8 stops the Worker | `heapMb`; the parent classifies the death |
| Memory outside the heap | **Not bounded** (below) | `perChildMb` by an RSS poll, an address-space cap and the kernel |
| CPU, disk, wall clock | `maxParseMillis` (cooperative) plus your own `terminate()` | `maxTaskMillis` kill, CPU limit, `maxDiskMb` |
| A native crash | Ends the process | Fails that document (`IsolationError("crash")`) |

## Memory is not bounded by the heap limit

`resourceLimits.maxOldGenerationSizeMb` caps the V8 old-generation heap of that Worker, and nothing else. Buffers
and `ArrayBuffer`s, native allocations (an addon, zlib, an image decoder), and thread stacks live outside it. Measured
(Linux or macOS, Node 24): a Worker started with `maxOldGenerationSizeMb: 32` held 1000 MiB of `Buffer`s with a V8
heap of 3 MiB and exited normally. The parsers inflate, decode and spool outside the heap (a flate bomb inflates
as bytes; a PDF's page data is buffers), so for those documents the heap limit never trips and the process grows until
the operating system or V8 ends it, taking every Worker with it. The heap limit turns one kind of runaway (a JavaScript
object graph that grows without bound) into a catchable event. It is not a memory budget. Bound the rest with the
limits below (`maxInputBytes`, `maxEmbeddedResourceBytes`, `maxTotalEmbeddedBytes`, `maxDecompressionRatio`,
`maxOutputChars`), with one Worker per document at a time, and with the container's own limit; use isolation when you
need a number you can rely on.

## What to set

**In the Worker**, build the ripstream once and pass limits on every call (a call's `limits` win over the ripstream's
own):

```ts
// worker.ts
import { parentPort } from "node:worker_threads";
import { createRipstream } from "@spikedpunch/ripstream-bundle-standard";

const ripstream = createRipstream();
parentPort!.on("message", async ({ id, bytes }) => {
  try {
    const { text } = await ripstream.parse(bytes, {
      limits: { maxInputBytes: 50 * 2 ** 20, maxOutputChars: 2_000_000, maxParseMillis: 30_000 },
    });
    parentPort!.postMessage({ id, ok: true, text });
  } catch (error) {
    const { name, message, code, limit, observed, max } = error as Record<string, unknown>;
    parentPort!.postMessage({ id, ok: false, error: { name, message, code, limit, observed, max } });
  }
});
```

Every `ParseLimits` member applies in a Worker (`maxTaskMillis` is the isolation's own budget and is not read in
process). The ones that matter for memory and time:

| Limit | Default | Why set it in a Worker |
| --- | --- | --- |
| `maxInputBytes` | none | Refused before a parser sees the input; for bytes, a `Blob` and a `{ path }` nothing is read. In process the default is no cap, so set one |
| `maxOutputChars` | 100,000 | The text is held in memory; `-1` is unlimited, which only a Worker with a heap limit you trust should ask for |
| `maxEmbeddedResourceBytes`, `maxTotalEmbeddedBytes`, `maxDecompressionRatio` | 512 MiB, 1 GiB, 1000 | The bomb limits; the heap limit does not see inflated bytes |
| `maxZipEntries`, `maxEmbeddedResources`, `maxNodeDepth` | 10,000, 10,000, 100 | Counts of work |
| `maxParseMillis` | 60,000 | A timer that aborts the parse and rejects with `ParseTimeoutError`. It is cooperative: a parser stuck in a synchronous loop never sees it, so your own `terminate()` deadline is the backstop (the `pipes` pool uses `maxParseMillis` plus 5 s) |

Pass a `signal` for cancellation. `password` works in a Worker (it cannot cross to an isolation child).

**For the Worker**: `resourceLimits: { maxOldGenerationSizeMb }` with room for the biggest document you accept (the
isolator's default heap is 385 MiB at its default output cap, and 128 MiB parsed every test PDF but one: see
[Measured defaults](isolation.md#measured-defaults)), and `stackSizeMb` about 1.17 for the stack depth of the main
thread (a Worker's default is four times deeper, so a document that overflows the stack in process would parse in the
Worker; this is what the `pipes` pool sets). Send the input as a transferred `ArrayBuffer` or as a `{ path }` the
Worker reads, not as a copy. Run one document per Worker at a time: two parses share one heap, and one document's
runaway ends the other.

## What you get back

A parse in a Worker rejects with the same typed errors as in process (`error.code` is the stable name; errors do not keep
their class across `postMessage`, so send `code`, `limit`, `observed` and `max` as the example does):

| `code` | Class | Meaning |
| --- | --- | --- |
| `LIMIT_EXCEEDED` | `LimitExceededError` | `limit` says which (`inputBytes`, `outputChars`, `zipEntries`, `ratio`, `memory`, ...), with `observed` and `max` when known; see [limits-and-statuses.md](limits-and-statuses.md) |
| `PARSE_TIMEOUT` | `ParseTimeoutError` | `maxParseMillis` fired |
| `ABORTED` | `AbortError` | your `signal` aborted |
| `MALFORMED_DOCUMENT`, `ENCRYPTED_DOCUMENT`, `UNSUPPORTED_FORMAT` | the classes of those names | the document, not the Worker |

A failure of the Worker itself is not an error the parse throws; it is an event on the `Worker` object.

## Worker events to ripstream errors

`classifyWorkerFailure(facts)` (exported from `@spikedpunch/ripstream-isolation-node`, pure, it starts nothing) turns what you
observed into the error the isolator would have thrown for the same death, and into the `IsolationFailureReason` where the
isolator has one. Collect the value of the `'error'` event (if one came) and the code of the `'exit'` event, and say
whether you called `terminate()` for a deadline or a cancellation:

```ts
import { classifyWorkerFailure } from "@spikedpunch/ripstream-isolation-node";

let error: unknown;
worker.on("error", (value) => (error = value));
worker.once("exit", (exitCode) => {
  const { kind, reason, error: ripstreamError } = classifyWorkerFailure({
    error,
    exitCode,
    maxOldGenerationSizeMb: 512, // only for the message
    // terminatedBy: "timeout" when your own watchdog called worker.terminate() for the parse's deadline, "abort" for a cancellation
  });
  // reject the pending parse with ripstreamError; `reason` is the IsolationFailureReason, or null
});
```

The table is the contract; the first row that matches decides, and a unit test holds each row
(`packages/isolation-node/test/worker-failure.test.ts`):

| What happened to the Worker | `kind` | Error | `IsolationFailureReason` |
| --- | --- | --- | --- |
| `'error'` with `code` `ERR_WORKER_OUT_OF_MEMORY` (V8 heap limit; then `'exit'` with code 1) | `out_of_memory` | `LimitExceededError`, `limit: "memory"` | none: the isolator reports a child's heap death the same way, because the document caused it |
| You called `terminate()` for a deadline (`'exit'`, code 1, no `'error'`) | `timeout` | `ParseTimeoutError` | none |
| You called `terminate()` for a cancellation | `abort` | `AbortError` | none |
| `'error'` with `ERR_WORKER_INIT_FAILED`, `ERR_WORKER_INVALID_EXEC_ARGV` or `ERR_WORKER_PATH` (could not start) | `init_failed` | `IsolationError`, `reason: "unavailable"` | `unavailable` |
| Any other `'error'` (an uncaught exception, `ERR_WORKER_UNSERIALIZABLE_ERROR`), an `'exit'` without an answer (any code, 0 included), or a `terminate()` nobody here asked for (code 1, no `'error'`) | `crash` | `IsolationError`, `reason: "crash"` | `crash` |

`queue_full` is never the answer: a Worker has no pool, and a queue in front of it is yours. Out-of-memory carrying no
`IsolationFailureReason` is the point of the table: callers that map an `IsolationError`'s `reason` to a verdict, and a
`LimitExceededError`'s `limit` to another, get the same verdict from a Worker and from a child. `error.recoverable` is
`false` for `crash` and `unavailable` as for a child's. After any of these the Worker is gone: start a new one.

## Testing your mapping

- **Unit**: call `classifyWorkerFailure` with the facts of each row, as `worker-failure.test.ts` does. Node produces the
  same facts for real: `packages/bundle-standard/test/worker-hosting.test.ts` runs a Worker that allocates until
  `maxOldGenerationSizeMb: 96` stops it (the `'error'` event carries `ERR_WORKER_OUT_OF_MEMORY`), one that spins until
  `terminate()` (resolves to 1, no `'error'`), and one that throws.
- **An `IsolationFailureReason` of `"crash"` from the child isolator**, for a caller that also hosts isolation or wants to
  test its handling of `IsolationError`: no hook is needed, the isolator's `childModule` can be any module that speaks the
  child protocol. A child that says "ready" and then exits without a terminal frame is reported as
  `IsolationError("crash")` (a child that dies before "ready" is `"unavailable"`):

  ```js
  // crash-child.mjs
  import { initChildProcess, readInput, sendFrame } from "@spikedpunch/ripstream-isolation-node";

  initChildProcess();
  sendFrame({ t: "ready", pid: process.pid });
  await readInput();
  process.exit(1); // no terminal frame
  ```

  ```js
  const isolator = await createNodeIsolator({
    config: { mode: "strict" },
    childModule: new URL("./crash-child.mjs", import.meta.url).pathname,
    ripstream, // anything that detects a type outside the in-process allowlist, e.g. application/zip
  });
  await isolator.isolate({ input }); // rejects with IsolationError { reason: "crash" }
  ```

  `packages/isolation-node/test/documented-crash.test.ts` runs exactly this with a real child process. The other reasons
  come from `createNodeIsolator` too: `queue_full` from a pool with `maxQueue: 0` held by a running request, `unavailable`
  from `mode: "strict"` on a platform whose probe fails.
