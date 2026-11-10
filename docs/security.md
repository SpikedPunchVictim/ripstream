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
- A request can set only what its route reads, and anything else is a 400 that names it, not a 200 that drops it:
  an unknown or repeated query parameter (`/tika` reads `filename`, `preset`, `handler`, `maxOutputChars` and
  `maxEmbeddedResources`; `/meta`, `/rmeta` and `/unpack` the same without `handler`; `/detect` and `/async` only
  `filename`), an unknown `?preset=` or `?handler=` (`meta`, `json`), any `X-Tika-*` header, and a multipart part
  other than the one file (Tika's per-request parse context is not accepted).
- `maxJobs` (default 1000): maximum retained `/async` jobs. Finished jobs are evicted first; new
  jobs get 503 when all retained jobs are still running.
- `jobTtlMs` (default 10 minutes): how long finished `/async` jobs are retained.

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
| `sourceRoot` (required) | Directory that client `source.path` values resolve against |
| `sinkRoot` | Directory for client `sink.path`; sinks are refused (403) when omitted |
| `allowHttp` | Allow `source.type: "http"` (SSRF-guarded); default `false` |
| `maxConcurrency` | Upper bound for client `concurrency` (default 4) |
| `maxQueue` | Upper bound for client `maxQueue` (default 64) |

Breaking change: earlier versions exposed `/pipes` without these options; it now returns 404 until
configured.

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
