# Security model

- **Untrusted input.** Parsers never execute macros, scripts or embedded programs.
- **SSRF.** `safeFetch` allows http/https only, rejects credentials, enforces host allowlists,
  blocks loopback/private/link-local/ULA/metadata addresses for literals and DNS results, caps
  redirects and revalidates every hop. `allowPrivateNetworks` is explicit opt-in.
- **Archives.** Entry names escaping the root are skipped; TAR symlinks/hardlinks are ignored;
  ZIP/OPC pre-checks entry count, per-entry bytes, total bytes and decompression ratio.
- **Limits.** `ParseContext.limits`: output chars, embedded count/bytes, compression ratio,
  node depth, parse time. Violations throw typed errors; archive entry limits propagate.
- **Temp files.** Spool files are created 0600 inside a 0700 temp directory and removed on close
  or context cleanup. In an isolated child that directory is private to the call (the child's `TMPDIR`),
  is held to `isolation.maxDiskMb` and is removed once the child is gone (see [isolation.md](isolation.md)).
- **Parse isolation.** `ripstream serve` parses each document in a short-lived child process with
  heap, RSS, address-space (Linux), CPU, wall-clock and temporary-disk bounds, and refuses to start when it cannot
  (see [isolation.md](isolation.md)). A plain `createRipstream()` parses in the calling process, and
  so does the PDF parser: pdf.js runs on the calling thread with no containment of its own.
- **Secrets.** `redactMetadata` replaces credential-like keys before logging/serialization.
- **Regex.** `compileSafeRegex`/`safeRegexTest` reject oversized and catastrophic-backtracking
  patterns and cap input length.
- **Configuration.** JSON config is validated fail-fast; unknown component classes are ignored by
  the registry loader unless explicitly registered.

## Resource limits

`ParseContext.limits` defaults (`DEFAULT_LIMITS` in `packages/core/src/parse-context.ts`). Violations
throw `LimitExceededError` (or `ParseTimeoutError` for time).

| Limit | Default | Enforced on |
| --- | --- | --- |
| `maxOutputChars` | 100,000 | Extracted text written to the content handler |
| `maxEmbeddedResources` | 10,000 | Count of embedded documents/attachments per parse |
| `maxEmbeddedResourceBytes` | 512 MiB | Size of any single embedded resource |
| `maxTotalEmbeddedBytes` | 1 GiB | Sum of all embedded resource bytes |
| `maxDecompressionRatio` | 100 | Compressed-to-expanded ratio for ZIP/OPC and other inflated streams |
| `maxZipEntries` | 10,000 | Entries in a ZIP/OPC container (checked before extraction) |
| `maxNodeDepth` | 100 | Embedded-document recursion depth |
| `maxParseMillis` | 60,000 | Wall-clock parse time (aborts via `ctx.signal`) |
| `maxTaskMillis` | 60,000 | Wall-clock budget of one isolated request (default of `isolation.maxTaskMillis`) |
| `maxMetadataValueChars` | 1,000,000 | Metadata values are truncated at this length |
| `maxXmlEntityExpansions` | 0 | Moot: DTDs are rejected outright and saxes expands only the predefined entities |

Parser-specific caps outside `ParseLimits`:

- **HTML/XHTML open-element depth**: 2000 by default (`DEFAULT_MAX_HTML_DEPTH`), configurable with
  `new HtmlDocumentParser({ maxDepth })`. It is independent of `maxNodeDepth`, which bounds
  embedded-document nesting (default 100) and would reject ordinary deeply nested markup.
- **PDF**: `maxInputBytes`, `maxPageTextChars`, `pageTimeoutMs` (see "PDF limits").
- **Time**: the DBF and HTML/XHTML parsers check `ctx.signal` periodically, so `maxParseMillis` and
  caller aborts interrupt long inputs.

## SSRF: DNS rebinding (mitigated)

`safeFetch` resolves the hostname once, validates every returned address, and then connects through
`node:http`/`node:https` with a `lookup` that answers only with those validated addresses. The socket
therefore goes to the IP that was checked; a hostile resolver cannot return a public address to the
check and a private one to the connection. TLS SNI and certificate validation still use the original
hostname, and each redirect hop is resolved, validated and pinned again. Response bodies are streamed,
not buffered.

Remaining notes:

- Pinning applies only to the default transport. A custom `fetchImpl` is called as-is and must pin
  addresses itself.
- With `allowPrivateNetworks: true` nothing is validated, so nothing is pinned.
- Request bodies are buffered in memory before sending.
- Still prefer `allowedHosts` for hostnames you control and network-layer egress rules as defence in
  depth.

### Blocked address ranges

`isBlockedAddress` fails closed: anything that is not a parseable IP literal is blocked.

- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `168.63.129.16` (Azure wire server),
  `169.254/16` (link-local, cloud metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`,
  `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4` (reserved).
- IPv6: `::/96` (unspecified, loopback, IPv4-compatible), `::ffff:0:0/96` IPv4-mapped (checked as the
  embedded IPv4), NAT64 `64:ff9b::/96` (embedded IPv4) and `64:ff9b:1::/48`, 6to4 `2002::/16`
  (embedded IPv4), Teredo `2001::/32`, documentation `2001:db8::/32`, unique local `fc00::/7`,
  link-local `fe80::/10`, site-local `fec0::/10`, multicast `ff00::/8`.

### Redirects

Redirects are followed manually (`redirect: "manual"`), capped by `maxRedirects` (default 5), and
every hop is revalidated. `Authorization`, `Cookie` and `Proxy-Authorization` headers are stripped
when a redirect changes origin. The request body is dropped when the redirect downgrades the method
to GET (303 for non-GET/HEAD, 301/302 for POST).

## Server hardening (`createRipstreamServer`)

- `authenticate(request)`: optional gate applied to every request.
- `maxLimits: { maxOutputChars, maxEmbeddedResources }`: server-side ceilings. Client query
  parameters of the same names (and preset values) are clamped to these.
- `maxUnpackBytes` (default 100 MiB; `ripstream serve` takes it from `server.maxUnpackBytes`): the most embedded-document
  bytes `/unpack` keeps for one request, so the zip it
  answers cannot outgrow it; a document past it is left out of the zip and stays in `rmeta.json`. A client cannot set
  it. With isolation it may not exceed the children's `unpackCeiling` (see `docs/isolation.md`). Entry names in the zip
  are `unpacked/<id><extension>`, never a name from the document, so a hostile name cannot become a path; the name
  only appears as data in the manifest and `rmeta.json`. Pipes' UNPACK (`tikajs-68os.6.7`) keeps that: a file's key is the
  container's emit key, the embedded id and a suffix, and the suffix is the registry's extension or, with `EXISTING`, 1 to 4
  ASCII letters or digits taken from the document's name (never a path). `packageRoot`, `emitKeyBase` and `packageName`
  are the operator's, and an emitter still refuses a key that leaves its `basePath`.
- A request can set only what its route reads, and anything else is a 400 that names it, not a 200 that drops it:
  an unknown or repeated query parameter (`/tika` reads `filename`, `preset`, `handler`, `maxOutputChars` and
  `maxEmbeddedResources`; `/meta`, `/rmeta` and `/unpack` the same without `handler`; `/detect` and `/async` only
  `filename`; `/language` and `/mime-types` none), an unknown `?preset=` or `?handler=` (`meta`, `json`, or a content type: `text`,
  `txt`, `html`, `xml`, `body`, `markdown`, `md`, `ignore`), any `X-Tika-*` header, and a multipart part
  other than the one file (Tika's per-request parse context is not accepted).
- `maxJobs` (default 1000): maximum retained `/async` jobs. Finished jobs are evicted first; new
  jobs get 503 when all retained jobs are still running.
- `jobTtlMs` (default 10 minutes): how long finished `/async` jobs are retained.
- Configuration values may read the server's environment: `${env:NAME}` in a `--config` file is replaced by the variable's
  value (see [parsing.md](parsing.md#environment-references)). Never load a configuration an untrusted party wrote; a request
  is never interpolated. Messages name the variable and the path, never a value, but a validation message may quote a value
  that was already interpolated, so a secret placed in a field that is validated by quoting it can reach stderr.

### `POST /pipes`

Disabled (404) unless `options.pipes` is set, and `createRipstreamServer` throws at construction if
`pipes` is set without `authenticate`. Requests must use `Content-Type: application/json`
(otherwise 415), which blocks cross-site "simple" POSTs that skip CORS preflight. Clients name
paths only relative to server-configured roots; absolute paths, `..` and symlinks are rejected
(403) and `followSymlinks` is always false (a client that sends `true` gets a 400). The body is checked
before anything runs: an unknown key, a `mode` other than `CONTENT_ONLY`, `CONCATENATE`, `RMETA`, `NO_PARSE` or
`UNPACK`, a `source.type` or `sink.type` the engine does not implement, and a value of the wrong type are each a 400.

| Option | Meaning |
| --- | --- |
| `sourceRoot` | Directory that client `source.path` values resolve against. Without it the batch body is refused (400) |
| `sinkRoot` | Directory for client `sink.path`; sinks are refused (403) when omitted |
| `allowHttp` | Allow `source.type: "http"` (SSRF-guarded); default `false` |
| `maxConcurrency` | Upper bound for client `concurrency` (default 4) |
| `maxQueue` | Upper bound for client `maxQueue` (default 64) |
| `settings` | Tika's pipes sections (`loadConfig(...).pipes`): turns on Tika's tuple form of `/pipes` and `/async`, below |
| `asyncMaxWaitMs` | How long a `/async` request waits for room in the queue before it is answered 429 (default 5000) |

`pipes` needs `sourceRoot`, `settings` or both, or the server throws at construction.

Breaking change: earlier versions exposed `/pipes` without these options; it now returns 404 until
configured.

### Tika's tuples: `POST /pipes` and `POST /async` with `pipes.settings`

With `pipes.settings`, a `/pipes` body without a `source` is one Tika `FetchEmitTuple` and a `/async` body with a `tuples`
array is a list of them (a `/async` body that is not JSON typed `application/json`, or has no `tuples`, is still a document
for the old job). Every route is behind `authenticate`, as above, and `/pipes` still needs `application/json`.

- **A request names components, not places.** `fetcher` and `emitter` are ids from the settings; `fetchKey` and `emitKey` resolve
  under that component's `basePath` and may not leave it. Symlinks that leave the fetcher's `basePath` are refused (the
  default). That holds only while the settings say so: a fetcher or emitter with `allowAbsolutePaths: true` lets a client name any
  file the process can read or write, so leave it `false` for anything a client can reach. A client chooses `emitKey`, so give the
  emitter a directory of its own, and keep `onExists` at Tika's `EXCEPTION` unless overwriting is wanted: `REPLACE` lets a client
  replace any file under that directory.
- **What the server keeps for itself is refused.** A fetcher or emitter id that starts with `__` is a 400 (Tika's
  `rejectReservedComponentIds`). A tuple field ripstream does not act on is a 400 that names it: `parseContext`, `preset`,
  `metadata`, `fetchRangeStart`, `fetchRangeEnd`. A client cannot choose parser settings, an emit strategy or a Frictionless
  unpack target.
- **`/async` checks the whole batch before it queues any of it.** An id that is not in the settings is a 400 (`can't find fetcher
  for X`, `can't find emitter for X`) and a tuple that names no emitter, where there is not exactly one configured, is a 400.
  A batch bigger than the queue (`pipes.queueSize`, 10 000 by default) is a 400 because waiting would never make room.
- **The queue is bounded and a full one says so.** A request waits up to `asyncMaxWaitMs` for room, then gets `429` with
  `{status: "throttled", message, capacity}` and a `Retry-After` of that wait in whole seconds, at least 1. Tika's wait is 60 s; a
  request held that long would meet `requestTimeoutMs` (also 60 s), so the default here is 5 s. Parsing a queued tuple is not held
  to `maxConcurrent` (the settings' `numClients` bounds it) but does go through the server's isolation and output ceilings.
- **A tuple that was taken is owed its result.** `/async` answers 200 once a tuple is queued, and `close()` finishes every queued
  tuple before it returns, so a server that is stopped does not drop work it said yes to. What became of each is in the settings'
  reporters and emitters, not in the answer. A run that cannot go on (a reporter that throws) fails the next `/async` with its error.
- **`/pipes` runs no reporter** from the settings: its answer is the report, and a reporter that writes a file would fail the second request.
- **The answer is Tika's.** `{status, message?}`: 200 for a success (a parse exception that was recorded is one), 400 for a
  fetcher, emitter or preset that is not there, 413 for a document over a limit, 429 with `Retry-After` for a full client pool, 500
  for a fetch or emit that failed, and 503 with `Retry-After: 5` for a timeout or a crash. `message` carries the exception text
  of the document the client sent, which can name a path under its `basePath`.

`ripstream serve` does not turn this on: `authenticate` is code, and there is no flag for it that is not a way to expose `/pipes`
without one. Embed `createRipstreamServer` with `pipes.settings` and your own `authenticate` (`tikajs-68os.6.5`).

### Cloud and search components

The S3, Elasticsearch and OpenSearch components (`tikajs-68os.6.6`) talk to an address the **operator** sets in the
configuration: `endpointConfigurationService`, `esUrl`, `openSearchUrl`. That address is not put through the SSRF guard that
`http-fetcher` and `/parse` use, so a configuration an untrusted party can write can point a run at any host. A client of
`/pipes` or `/async` still names a component by id and a key, never an endpoint or a credential.

- **Secrets are in the configuration.** `accessKey`, `secretKey`, `apiKey` and `password` are read from it as Tika reads them.
  No message ripstream builds repeats one (a refused value is named by its key, never quoted), and an error from the service
  carries the service's own text and not the request. Keep the file readable by the operator only, or use the instance role
  or a profile, which keep the keys out of it.
- **A redirect is an error.** Requests are sent with `redirect: "error"`, so a signature or an `Authorization` header is never
  sent to a host the service redirected to; a bucket in another region is a setting to fix.
- **Certificates are checked.** `verifySsl: false` and a proxy are refused rather than honoured one connection at a time. A
  server with a private CA is trusted with `NODE_EXTRA_CA_CERTS`. A configuration that sends credentials over plain `http` is
  accepted and said so.
- **An emit key is a key, not a path.** The S3 emitter and the search emitters put the key in a URL or a JSON string, so it
  cannot leave a directory, but a client that chooses `emitKey` chooses which object or document is written: give a component
  that a client can reach a prefix or an index of its own, as with a file-system emitter's directory. The S3 emitter and the
  fetcher's `prefix` are the operator's, and the fetcher's is put in front of the key as it is, with no slash.

## PDF limits

`PdfParser` runs pdf.js on the calling thread. Its options bound what it can bound from there:

- `maxInputBytes` (default 512 MiB): larger files are rejected with `LimitExceededError` before
  pdf.js is loaded.
- `maxPageTextChars` (default 32 Mi): per-page cap on extracted text characters.
- `pageTimeoutMs` (default 30 s): ends a load or page extraction that stalls asynchronously with
  `ParseTimeoutError`. It cannot interrupt a synchronous pdf.js loop, because the timer cannot fire
  while the thread is busy.

The parser has no memory cap and cannot survive a crash of pdf.js. Earlier versions ran pdf.js in a
worker thread with a memory watchdog; that path was removed in favour of process isolation. Parse
untrusted PDFs through the isolation layer ([isolation.md](isolation.md)), which bounds heap, RSS,
CPU, wall-clock time and temporary disk of the whole parse.

Attachment extraction follows `maxEmbeddedResources`, `maxEmbeddedResourceBytes` and
`maxTotalEmbeddedBytes`.
