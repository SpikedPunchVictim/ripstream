# 04 — Pipes, Optional Services, NLP, Operations, Security

## 1. Pipes engine (library-first)

Pipes is a document-processing pipeline: iterator enumerates work, fetcher retrieves bytes, parser extracts, emitter writes results, reporter records status. The engine is a library API; the HTTP endpoints are a thin adapter.

### 1.1 Component SPIs

```ts
export interface FetchEmitTuple {
  readonly id: string;                       // opaque, emitted in reports
  readonly fetchKey: string;                // path/URI/object key
  readonly emitter?: string;                // emitter ID; default configured
  readonly emitKey?: string;
  readonly metadata?: Record<string, string>;
  readonly onParseException?: 'skip' | 'pass' | 'fail';  // SKIP | PASS | FAIL
}

export interface Fetcher {
  readonly id: string;
  initialize(config: ResolvedComponentConfig): Promise<void> | void;
  fetch(key: string, ctx: PipesContext): Promise<FetchedStream>; // bytes + optional metadata
  close?(): Promise<void>;
}

export interface Emitter {
  readonly id: string;
  initialize(config: ResolvedComponentConfig): Promise<void> | void;
  emit(key: string, payload: EmitPayload, ctx: PipesContext): Promise<void>;
  emitBatch?(entries: readonly EmitEntry[], ctx: PipesContext): Promise<void>;
  close?(): Promise<void>;
}

export interface PipesIterator extends AsyncIterable<FetchEmitTuple> {
  readonly id: string;
  initialize(config: ResolvedComponentConfig): Promise<void> | void;
  close?(): Promise<void>;
}

export interface PipesReporter {
  readonly id: string;
  initialize(config: ResolvedComponentConfig): Promise<void> | void;
  report(result: PipesResult): void | Promise<void>;
  close?(): Promise<void>;
}

export type PipesStatus =
  | 'PARSE_SUCCESS'
  | 'PARSE_EXCEPTION'
  | 'PARSE_EXCEPTION_NO_EMIT'
  | 'FETCH_EXCEPTION'
  | 'EMIT_EXCEPTION'
  | 'OOM'
  | 'TIMEOUT'
  | 'UNSPECIFIED';
```

`EmitPayload` is one of: rmeta JSON (single document or full record array), extracted text, or raw handler output. Payload shape is selected by `parseMode`.

### 1.2 Parse modes

| Mode | Output |
|---|---|
| `RMETA` | The list of metadata, the document and then what is embedded in it (JSON) |
| `CONCATENATE` | One document per input: one metadata whose `tk:content` is the text of the document and of everything embedded in it |
| `CONTENT_ONLY` | As `CONCATENATE`, for an emitter that writes only the raw content |
| `NO_PARSE` | Detection only: metadata with `tk:resource-name`, `Content-Length`, the digests when a digester factory is configured, `Content-Type` and `tk:content-type-parser-override`, no content and no copy of the input |
| `UNPACK` | Tika's Frictionless package: one zip at `<emitKey>-frictionless.zip` of `datapackage.json`, `rmeta.json` and `unpacked/<id>` (`UnpackConfig` `outputFormat: REGULAR` is the `RMETA` list at the emit key and each embedded document's bytes at `<emitKey>-embed/<embedded id>`) |

Implemented (`tikajs-68os.6.3`) from `ParseMode.java`, `ParseHandler` and `EmitHandler` in Tika 4.2.0. `FileSystemEmitter`
is Tika's: `basePath/emitKey`, `onExists` `EXCEPTION` (default) / `SKIP` / `REPLACE`, atomic writes, `GZIP`, `fileExtension`,
`prettyPrint`.

### 1.3 Engine

```
PipesIterator ──► bounded work queue ──► worker pool ──► Emitter
                                         │
                                         └──► Reporter (status per tuple)
```

- Worker pool default = `min(8, cpus)`; `numClients` compatibility key.
- Node: `child_process` workers for crash isolation and memory caps; `worker_threads` optional for lighter startup. A worker is recycled every `maxFilesProcessedPerProcess` documents or after `OOM`/fatal error.
- Per-document: fetch timeout, parse timeout, emit timeout. Cancellation propagates to fetcher, parser, emitter via `AbortSignal`.
- Emit batching: `maxForEmitBatchBytes` and `maxForEmitBatchDocuments`; flush on shutdown and on failure.
- Ordering: unordered by default (upstream parallel behavior); `ordered: true` serializes emission in iterator order via a single drainer over a per-input slot FIFO, bounded by a window (`maxBuffered`, default `concurrency * 4`). Each input's records (incl. UNPACK fan-out, and zero-record inputs) occupy one slot emitted exactly once; a slow head applies backpressure to fetching rather than growing memory.
- Retry: per-stage retry policy (`attempts`, `backoff`, `retryOn`) for transient fetch/emit failures; parse failures are never retried by default.
- Idempotency: optional checkpoint file of completed tuple IDs; safe to point emitters at keyed sinks.
- Graceful shutdown: stop iterator, drain queue up to `shutdownGraceMillis`, flush emitters, report summary.
- Reporting: one `PipesResult` per tuple: status, ID, parse millis, fetch millis, emit millis, byte count, exception class/message, worker ID.
  Implemented (`tikajs-68os.6.1`): `{ id, status, category, message?, elapsedMs }`, status one of Tika's 21 (not the eight
  of `PipesStatus` above, which predates the port's reading of 4.2.0), and the run goes on after any result that is not
  in the FATAL category.
- Backpressure: bounded queue; a stalled emitter blocks fetching, not memory growth.

As built (`tikajs-68os.6.4`): the retry and the idempotency lines above are the engine options `retry` and `checkpoint`.
`retry` is `{ attempts (3), baseDelayMs (50), maxDelayMs (2000), retryIf }`, applied to the fetch and to each document's emit
and by default only to `isTransientError` failures, never to a parse; the wait doubles, carries jitter (half to all) and ends
on abort. `checkpoint` is `has(id)`/`mark(id)` over tuple ids (`CheckpointStore`: an appended journal, one JSON string a
line). An input is left out when its id is held, and recorded last: after it succeeded (a SUCCESS result) and its result was
reported, so a run that stops earlier does it again and reports it again. The window between emit and record makes the
emitter's second write of a key a requirement, `onExists` `REPLACE` or `SKIP`. Tika has no checkpoint (its idempotent rerun
is `onExists` on the emitter and the reporter); its restarts are of a forked server, which an engine that parses in-process or
in a child per document does not have: a crash is that input's result and the next input gets a fresh child.

As built (`tikajs-68os.6.2`): the engine takes `FetchEmitTuple`s (`id`, `fetcher`, `fetchKey`, `emitter?`, `emitKey?`,
`onParseException?`; the `metadata` field and `'pass' | 'fail'` above are not read: `skip` and `emit` are Tika's two) from a
`PipesIterator` and resolves them through fetchers and emitters registered by id, inside the worker. A fetcher is
`fetch(key, { signal }) -> Uint8Array` and an emitter is `emit(document)`; neither has `initialize`, which an in-process
engine does not need (a component that cannot be built throws when the engine is made). A tuple naming a fetcher or emitter
that is not registered is `FETCHER_NOT_FOUND` or `EMITTER_NOT_FOUND` for that tuple. Tika's pipes configuration loads
through `loadConfig(...).pipes` and `createEngineFromSettings`; docs/migration.md lists what loads, what is accepted with a
notice and what is refused. The evidence for the model is `tasks/parity/audits/pipes-model-spike.md`.

### 1.4 Built-in components

Fetchers:

| ID (upstream) | Implementation | Packaging |
|---|---|---|
| `fs-fetcher` | Node `fs` with base-path confinement | core pipes |
| `http-fetcher` | `fetch` with allowlist, redirect limit, size cap, TLS verification | core pipes |
| `s3-fetcher` | Signed HTTP (SigV4) or optional AWS SDK peer | optional |
| `gcs-fetcher` | OAuth service account / ADC via `google-auth-library` peer | optional |
| `az-blob-fetcher` | `@azure/storage-blob` peer | optional |
| `google-drive-fetcher` | Drive API + OAuth | optional |
| `microsoft-graph-fetcher` | Graph API + client credentials | optional |
| `atlassian-jwt-fetcher` | JWT bearer auth | optional |

Emitters:

| ID | Implementation |
|---|---|
| `fs-emitter` | Write to base-path-confined filesystem |
| `stdout-emitter` | NDJSON to stdout |
| `s3-emitter`, `az-blob-emitter` | Object storage |
| `solr-emitter` | Solr `/update` JSON/XML |
| `es-emitter`, `opensearch-emitter` | Bulk API |
| `kafka-emitter` | Producer, batching, keyed by tuple ID |
| `jdbc-emitter` | SQL insert/upsert via `pg`/`mysql2` optional peers |

Iterators:

| ID | Source |
|---|---|
| `fs-pipes-iterator` | Directory walk with globs, sort, hidden-file policy |
| `csv-pipes-iterator`, `json-pipes-iterator` | File lists with optional metadata columns |
| `s3-pipes-iterator`, `az-blob-pipes-iterator` | Object listings |
| `solr-pipes-iterator`, `jdbc-pipes-iterator`, `kafka-pipes-iterator` | Query/stream driven |

Built (`tikajs-68os.6.6`), with no cloud or search SDK: `s3-fetcher`, `s3-emitter` and `s3-pipes-iterator` (SigV4 over `fetch`, so
the "optional AWS SDK peer" above was not needed) and `es-emitter` and `opensearch-emitter` (the `_bulk` request over `fetch`).
Tracked: GCS (`tikajs-68os.31`), Azure Blob (`tikajs-68os.32`), Solr over HTTP (`tikajs-68os.33`) and the search reporters
(`tikajs-68os.34`). Proposed non-goals awaiting the owner: the JDBC components, Kafka and the other connectors
(`tikajs-68os.24`). `docs/migration.md` says what each built component does and does not do.

Reporters:

| ID | Destination |
|---|---|
| `logging-reporter` | Structured log |
| `file-system-reporter` | One line per result |
| `file-system-jsonl-reporter` | JSONL |
| `jdbc-reporter` | SQL table |
| `es-reporter`, `opensearch-pipes-reporter` | Bulk index |
| `composite-reporter` | Fan-out |

Component IDs, config keys, and JSON shape are generated from a schema and pinned by fixtures, not hand-invented.

### 1.5 Pipes config (illustrative)

```json
{
  "numClients": 8,
  "maxFilesProcessedPerProcess": 10000,
  "forkedProcessStartupMillis": 60000,
  "forkedProcessPingMillis": 10000,
  "maxForEmitBatchBytes": 1000000,
  "timeoutMillis": 120000,
  "pipesIterator": { "id": "fs-pipes-iterator", "params": { "basePath": "/data", "includes": ["**/*.pdf"] } },
  "fetchers": [{ "id": "fs-fetcher", "params": { "basePath": "/data" } }],
  "emitters": [{ "id": "fs-emitter", "params": { "basePath": "/out" } }],
  "reporters": [{ "id": "file-system-jsonl-reporter", "params": { "path": "/out/report.jsonl" } }]
}
```

### 1.6 Operational observability

- Metrics: documents in flight, completed by status, bytes fetched/emitted, queue depth, worker restarts, per-parser durations, limit hits.
- Logs: JSON lines with tuple ID, stage, duration, status, exception class; never log document content or credentials.
- Health: engine state (`STARTING`, `RUNNING`, `DRAINING`, `STOPPED`), worker liveness.
- `PipesClient` API for embedded use: `submit(tuple)`, `submitAll(iterable)`, `awaitIdle()`, `shutdown()`.

---

## 2. Optional HTTP server package

Built entirely on the library; request handlers are exported so any framework (Fastify/Express/Node http) can mount them.

### 2.1 Endpoints

| Endpoint | Methods | Notes |
|---|---|---|
| `/tika`, `/tika/{text,html,xml,md}`, `/tika/json[/{handler}]` | PUT, POST multipart | Extract content. Tika 4.x's bare `/tika` is Markdown; here it is text (`/tika/md` and `?handler=md` give Markdown, best effort). `/tika/json` is one object: the metadata, `tk:content`, `tk:content-handler-type` (`tikajs-68os.7.6`) |
| `/tika/form` | POST multipart | A 3.x route: tika-server 4.2.0 answers 404 for it (saved response r061) and so does ripstream. Not served |
| `/tika/config`, `/tika/config/{handler}` | POST multipart | A 4.2.0 route that needs `allowPerRequestConfig` (off → 403). Not served: ripstream answers 404 |
| `/tika/preset/{name}` and handler variants | PUT, POST | A 4.2.0 route for named server-side config presets. Not served: ripstream's presets are `?preset=` |
| `/rmeta[/{handler}]`, `/rmeta/form[/{handler}]`, `/rmeta/config`, `/rmeta/preset/{name}` | PUT, POST (`form`: POST multipart) | Recursive metadata JSON array, each document's content in the handler's shape. `config` and `preset` are not served (ripstream's presets are `?preset=`) |
| `/meta`, `/meta/form` | PUT, POST (`form`: POST multipart) | Metadata only, no content and so no output limit: JSON by default, CSV by `Accept: text/csv`; `application/rdf+xml` (XMP) is a 406, a deferred non-goal |
| `/meta/{field}` | PUT, POST | One metadata field of the uploaded document, as JSON, CSV or plain text by `Accept`; 404 when it has none (upstream is PUT, not GET) |
| `/mime-types`, `/mime-types/{type}/{subtype}` | GET | The media types the server was given (`ripstream serve` passes the standard registry and the configured custom types): HTML by default, JSON or (the list) text by `Accept`; 404 for an unknown type |
| `/detect/stream` | PUT | Not in tika-server 4.2.0 (404, saved response r150) and not served here: `/detect` is the route |
| `/detect` | PUT | Media type |
| `/unpack` | PUT, POST multipart | The embedded resources as Tika's data package: a zip of `datapackage.json`, `rmeta.json` and `unpacked/<id><ext>` (`Accept: application/zip` only; `/unpack/all[/{handler}]` adds the request's own bytes as `unpacked/0`; raw POST 415). Bytes kept are held to `maxUnpackBytes` (`tikajs-68os.7.4`); `/unpack/preset/{name}` is a 4.2.0 variant that is not served |
| `/language` | PUT, POST | Language detection with Tika's CharSoup model: the ISO 639-1 code as `text/plain` (Tika's answer; `und`, a blank body, is an empty body); `Accept: application/json` is the detector's whole answer. Reads the first 100,000 characters (`tikajs-68os.7.8`, `tikajs-68os.9.3`) and keeps only the first 400,000 bytes of an uncompressed body, so its memory does not grow with the body (`tikajs-68os.9.5`); the rest still counts against `maxBodyBytes`. Tika has no `/language/stream` |
| `/translate?target=` | PUT, POST | A ripstream extension: tika-server 4.2.0 has no translate routes (404 for `/translate/all/...`, which were 3.x). Translates the body into `target` (default `en`); 501 until a translator is configured |
| `/pipes`, `/async` | POST | Requires `allowPipes` (4.x) / `enableUnsecureFeatures` (3.x). Here: off unless `pipes` is given, and `pipes` needs `authenticate`. With `pipes.settings` they are Tika's: `/pipes` takes one `FetchEmitTuple` and answers `{status, message?}` with Tika's HTTP status; `/async` takes `{"tuples": [...]}` and queues them for a background run (`tikajs-68os.6.5`, below) |
| `/status` | GET | Engine status; same gating |
| `/version` | GET | Version |
| `/` (HEAD/GET), `GET /tika` | GET, HEAD | Welcome page (HTML or text by `Accept`, 406 otherwise) listing the served routes; `GET /tika` is the one-line greeting. Both name ripstream |

### 2.2 Protocol behavior

- Binary input: PUT with raw body. Multipart: `file` part plus optional `config`, `metadata`, `filename`.
- Filename for name-based detection from `Content-Disposition` or multipart filename.
- Output negotiation: the route fixes what it writes (path suffix), and an `Accept` that does not name it is a 406 with no body, answered before the document is read (`tikajs-68os.7.8`); default handler follows the configured Tika generation (4.x Markdown, 3.x text; here text, see docs/migration.md).
- Compression: a text, JSON or XML response of 32 bytes or more is gzipped for `Accept-Encoding: gzip`; a request body with `Content-Encoding: gzip` is inflated, bounded by the body limit (`tikajs-68os.7.8`).
- Response headers: `Content-Type` with charset, `Content-Length` when buffered; streaming/chunked for large output. Digests are metadata keys, `tk:digest:*`, written when a `parse-context` digester factory is configured (status: implemented, `tikajs-68os.9.1`; no digest response header is sent).
- Per-request headers: `X-Tika-OCR*`, `X-Tika-PDF*`, `X-Tika-ContentHandler`-style knobs accepted only when `allowPerRequestConfig` or header overrides are enabled.
- Errors: 4.x JSON error body `{ "status": n, "message": "...", "exception": "..." }`; 3.x plain text. Configurable compat mode.
- Status mapping: 200 success; 204 empty body; 400 malformed request; 403 gated feature; 408 parse timeout; 413 request too large; 422 a limit other than the output limit (reaching `maxOutputChars` is a 200 with the text up to it, flagged by `tk:exception:write-limit-reached`, and on text routes by `X-Ripstream-Write-Limit-Reached`; `tikajs-68os.7.5`), and (text routes only) a malformed, encrypted or empty document, whose body is the text extracted before the failure; 500 internal; 503 the queue is full or isolation is unavailable (`Retry-After`), or shutting down. As Tika does, `/rmeta`, `/meta` and the JSON form of `/tika` answer 200 for a document they could not read, with `tk:exception:container-exception` in the metadata, and a format no parser takes is an empty 200 (`tikajs-68os.7.2`; Tika's own semantics read from its source, not a live server).
- Streaming request bodies are allowed when the selected parser does not require random access; otherwise the server spools to disk with the same limits.
- Concurrency: request pool sized independently; `/async` has its own pool; a request beyond the slots waits, body unread, in a queue of `maxQueue` (default 100) for up to `requestTimeoutMs` (408); beyond the queue it is a 503 with `Retry-After`. The server answers 429 only on Tika's tuple routes (below).
- Tika's tuple routes (`tikajs-68os.6.5`; `pipes.settings`, behind `authenticate`): a `/pipes` body without `source` is one tuple, a `/async` body that is a JSON object with a `tuples` key is a batch (a body of any other kind is the old raw-document job, `202 {id}`). A request names fetchers and emitters of the settings, never paths; an id that starts with `__`, and a `parseContext`, `preset`, `metadata` or range field, are a 400. `/pipes` maps the result to Tika's HTTP status: 200 for every success category (a recorded parse exception included), 400 for a fetcher, emitter or preset that is not there, 413 `PAYLOAD_LIMIT_EXCEEDED`, 429 `CLIENT_UNAVAILABLE_WITHIN_MS` with `Retry-After: 60`, 503 with `Retry-After: 5` for `TIMEOUT` and `UNSPECIFIED_CRASH`, 500 for the rest. `/async` answers 200 `{status:"ok", added}` once every tuple of the batch is queued (the batch is checked whole first: 400 for a component that is not configured, or a batch larger than `pipes.queueSize`), 429 `{status:"throttled", message, capacity}` with `Retry-After` when the queue stays full for `asyncMaxWaitMs` (default 5000; Tika's is 60 000), and `close()` finishes what was accepted. `ripstream serve` leaves both off: `authenticate` is code.
- Server never enables CORS by default; TLS termination is the deployer's job; bind localhost by default.
- No auth implementation beyond optional bearer/HMAC hook documented for reverse proxies.

### 2.3 gRPC (optional, later)

Upstream `tika-grpc` exposes parse/metadata/detect over protobuf. If built, reuse Ripstream's `.proto` definitions for wire compatibility, and ship as a separate optional package. Not part of the core library milestone.

---

## 3. CLI package (optional)

`tika` binary parity with `tika-app`:

```
tika [--text|--html|--xml|--md|--json] [--metadata] [--detect] [--language]
     [--recursive] [--config file] [--encoding enc] [--password pw]
     [--include-embedded] [--max-chars n] [file ... | -]
tika --server [--port 9998] [--host localhost]
```

- stdin/stdout streaming; binary-safe; exit codes: 0 success, 1 parse failure, 2 usage error.
- `--metadata` prints metadata only; `--detect` prints media type; `--recursive` emits rmeta JSON.
- No network access by default for URL inputs; explicit flag required.

---

## 4. Language detection

```ts
export interface LanguageResult {
  language: string;              // ISO 639-1/3, "unknown" when uncertain
  rawScore: number;
  confidence: number;
  isReasonablyCertain(): boolean;
}

export interface LanguageDetector {
  readonly id: string;
  detect(text: string, opts?: { mixedLanguagePolicy?: 'UNKNOWN' | 'WHITELIST'; whitelist?: string[] }): Promise<LanguageResult>;
  reset?(): void;                // streaming/stateful backends
}
```

- Backends: `CharSoupLanguageDetector` (default: a port of Tika 4.2.0's detector running Tika's own 204-language model, `tikajs-68os.9.3`), `franc` and CLD3 wasm (optional, not used by the server or the CLI).
- CharSoup answers a short text with its best guess and says how far to trust it (`confidence` `HIGH`, `MEDIUM`, `LOW` or `NONE`, and the raw score); it answers `NONE` only for a blank text or one whose best language does not lead the next.
- The `charsoup-metadata-filter` writes `tk:detected-language`, `tk:detected-language-confidence` and `tk:detected-language-confidence-raw` from `tk:content` in a `metadata-filters` chain; core takes the detector as a service (`MetadataFilterServices.languageIdentifier`).
- Scores are Tika's model's, not checked against a running Tika (`docs/migration.md`, Language detection).
- Streaming API: `LanguageDetectorStream` accumulates up to `maxChars`, returns result at end or on threshold.

---

## 5. Translation

```ts
export interface Translator {
  readonly id: string;
  isAvailable(src: string | null, dest: string): Promise<boolean>;
  translate(text: string, src: string | null, dest: string, opts?: { signal?: AbortSignal }): Promise<string>;
}
```

- Providers: Google Cloud Translation, Microsoft Translator, DeepL, LibreTranslate, local model/CLI adapter.
- Config: endpoint, credentials from env/secret provider only, timeout, batch size, per-request char cap.
- No default provider and no network use unless explicitly configured. Failures raise `TranslationError`; no fake translations.
- Markup: plain text by default; HTML-preserving mode only for providers that guarantee tag preservation, followed by structural validation.
- Rate limiting and retry with jitter; request IDs for tracing.

---

## 6. Security model

### 6.1 Threat model

Documents are hostile. Assume malformed structures, decompression bombs, XML entity attacks, huge embedded trees, path traversal names, encrypted payloads, and parser crashes. The library must fail closed on limits and never execute content.

### 6.2 Controls

| Risk | Control |
|---|---|
| XML external entities / SSRF | No DTD processing, no external entities, no XInclude, no network from XML/HTML/SVG parsers |
| Billion laughs | Entity expansion disabled; `maxXmlEntityExpansions = 0` |
| Zip bomb | Ratio cap, per-entry cap, total cap, entry-count cap; stop early |
| Nested archive recursion | Depth/count/byte/time budgets; global to top-level parse |
| Path traversal | Entry names normalized; never joined with filesystem paths for writing unless explicitly unpacking, and then confined to base dir with `..`/absolute rejection |
| Symlinks/devices | Never followed or written |
| PDF JavaScript / launch actions | Never executed; only text extraction |
| Embedded executables/macros | Never executed; not extracted by default |
| Huge output | `maxOutputChars`, stream backpressure, metadata value caps |
| CPU/memory DoS | Per-parse timeouts, worker isolation, memory cap, parser concurrency limits |
| Regex DoS | User-supplied patterns go through a length cap and optional RE2-compatible engine; internal hot paths use literal matching |
| Temp files | `0600`, unpredictable names, cleanup on abort/error/exit; optional in-memory only mode |
| Secrets | Password callbacks; never logged; config serialization redacts credential fields |
| SSRF in fetchers | Scheme allowlist (`https`), host allowlist, deny loopback/link-local/metadata IPs, redirect limit, DNS rebinding mitigation by re-checking resolved IP |
| Supply chain | Lockfile, provenance, SBOM, license scan, no lifecycle scripts from dependencies, pinned optional peers |

### 6.3 Isolation

- Parsers marked `unsafe` (Office binaries, PDF, archives, CAD, executables) run in a worker/child when `sandbox.enabled` (default true in Node).
- Worker policy: no inherited credentials, restricted env, temp dir per worker, memory cap, wall-clock kill, one document per process for maximum isolation (configurable batch size).
- Browser builds: no Node APIs, no filesystem, no worker spawning of native modules; heavy parsers unavailable rather than silently degraded.
- Server deployments should additionally use container-level isolation, read-only filesystem, and egress denial for the request-handling process.

### 6.4 Privacy

- No telemetry, no phone-home, no default network calls.
- VLM/translation providers are opt-in and receive only the images/text explicitly routed to them; document this in the API and require a provider instance to be passed.
- Metadata filters can strip PII before emission; raw bytes are never logged.

---

## 7. Operational defaults

| Setting | Default |
|---|---|
| Parse timeout | 60 s per document (configurable) |
| Output chars | 100,000 (a ripstream bound: Tika's server has no write limit by default). Reaching it truncates and flags |
| Embedded resources | 10,000 |
| Total embedded bytes | 1 GiB |
| Decompression ratio | 100× |
| Zip entries | 10,000 |
| Node/nesting depth | 100 |
| Worker memory cap | 512 MiB |
| Request body cap (server) | 100 MiB (`maxRequestSizeBytes`; Tika's default is 1 GiB) |
| Temp dir | OS temp, per-process subdir, cleaned on exit |

All defaults are documented with the upstream value they mirror, and every one is overridable per parse and per server.
