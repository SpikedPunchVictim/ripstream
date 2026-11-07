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
| `RMETA` | Full recursive metadata + content per document (JSON) |
| `CONCATENATE` | Single text blob, embedded documents concatenated |
| `CONTENT_ONLY` | Top-level content only, no embedded |
| `NO_PARSE` | No parsing; fetch → emit (copy/route mode) |
| `UNPACK` | Extracted embedded resources written as files |

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
- Ordering: unordered by default (upstream parallel behavior); `ordered: true` buffers emission in iterator order with a bounded window.
- Retry: per-stage retry policy (`attempts`, `backoff`, `retryOn`) for transient fetch/emit failures; parse failures are never retried by default.
- Idempotency: optional checkpoint file of completed tuple IDs; safe to point emitters at keyed sinks.
- Graceful shutdown: stop iterator, drain queue up to `shutdownGraceMillis`, flush emitters, report summary.
- Reporting: one `PipesResult` per tuple: status, ID, parse millis, fetch millis, emit millis, byte count, exception class/message, worker ID.
- Backpressure: bounded queue; a stalled emitter blocks fetching, not memory growth.

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
| `/tika`, `/tika/{text,html,xml,md,json}` | PUT, POST multipart | Extract content; 4.x bare `/tika` defaults to Markdown |
| `/tika/form` | POST multipart | 3.x compatibility |
| `/tika/config`, `/tika/config/{handler}` | POST multipart | Requires `allowPerRequestConfig` (default off → 403) |
| `/tika/preset/{name}` and handler variants | PUT, POST | Named server-side config presets |
| `/rmeta`, `/rmeta/config`, `/rmeta/preset/{name}` | PUT, POST | Recursive metadata JSON array |
| `/meta` | PUT, POST | Metadata only; default CSV in 3.x, JSON/XML by `Accept` |
| `/meta/{key}` | GET | Fetch a metadata value from the last response? Upstream behavior pinned by tests |
| `/detect/stream` | PUT | Media type of body |
| `/detect` | PUT | Media type |
| `/unpack` | PUT | Write embedded resources; 4.x variant `/unpack/preset/{name}` |
| `/language/stream` | PUT, POST | Language detection |
| `/translate/all/{translator}/{src}/{dest}` | PUT, POST | Translation |
| `/translate/all/{translator}/{dest}` | PUT, POST | Source auto-detected |
| `/pipes`, `/async` | POST | Requires `allowPipes` (4.x) / `enableUnsecureFeatures` (3.x) |
| `/status` | GET | Engine status; same gating |
| `/version` | GET | Version |
| `/` (HEAD/GET) | GET | Greeting/health |

### 2.2 Protocol behavior

- Binary input: PUT with raw body. Multipart: `file` part plus optional `config`, `metadata`, `filename`.
- Filename for name-based detection from `Content-Disposition` or multipart filename.
- Output negotiation: path suffix wins over `Accept`; default handler follows the configured Tika generation (4.x Markdown, 3.x text).
- Response headers: `Content-Type` with charset, `Content-Length` when buffered, `X-TIKA:…` digests when configured; streaming/chunked for large output.
- Per-request headers: `X-Tika-OCR*`, `X-Tika-PDF*`, `X-Tika-ContentHandler`-style knobs accepted only when `allowPerRequestConfig` or header overrides are enabled.
- Errors: 4.x JSON error body `{ "status": n, "message": "...", "exception": "..." }`; 3.x plain text. Configurable compat mode.
- Status mapping: 200 success; 204 empty body; 400 malformed request; 403 gated feature; 408 parse timeout; 413 request too large; 422 unsupported/encrypted/malformed document; 429 concurrency limit; 500 internal; 503 shutting down.
- Streaming request bodies are allowed when the selected parser does not require random access; otherwise the server spools to disk with the same limits.
- Concurrency: request pool sized independently; `/async` has its own pool; queue overflow → 429 with `Retry-After`.
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

- Backends: `franc` (default, many languages, fast), optional CLD3 wasm, optional upstream-compatible naive-Bayes profile for score parity.
- Short text (< 20 chars) returns `unknown` unless a whitelist narrows the choice.
- Scores are backend-specific; the SPI is compatible, numeric parity with upstream is not promised.
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
| Output chars | 100,000 (upstream-compatible) |
| Embedded resources | 10,000 |
| Total embedded bytes | 1 GiB |
| Decompression ratio | 100× |
| Zip entries | 10,000 |
| Node/nesting depth | 100 |
| Worker memory cap | 512 MiB |
| Request body cap (server) | 1 GiB |
| Temp dir | OS temp, per-process subdir, cleaned on exit |

All defaults are documented with the upstream value they mirror, and every one is overridable per parse and per server.
