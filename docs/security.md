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
  or context cleanup.
- **Workers.** Optional parsers (PDF) run in a worker with isolated flags; generic
  `runIsolatedTask` supports env isolation, memory caps, timeout and abort.
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
| `maxTaskMillis` | 60,000 | Isolated worker tasks (`runIsolatedTask`) |
| `maxMetadataValueChars` | 1,000,000 | Metadata values are truncated at this length |
| `maxXmlEntityExpansions` | 0 | Moot: DTDs are rejected outright and saxes expands only the predefined entities |

Parser-specific caps outside `ParseLimits`:

- **HTML/XHTML open-element depth**: 2000 by default (`DEFAULT_MAX_HTML_DEPTH`), configurable with
  `new HtmlDocumentParser({ maxDepth })`. It is independent of `maxNodeDepth`, which bounds
  embedded-document nesting (default 100) and would reject ordinary deeply nested markup.
- **PDF**: `maxInputBytes`, `workerMemoryMb`, `maxPageTextChars` (see "PDF worker budget").
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
- `maxJobs` (default 1000): maximum retained `/async` jobs. Finished jobs are evicted first; new
  jobs get 503 when all retained jobs are still running.
- `jobTtlMs` (default 10 minutes): how long finished `/async` jobs are retained.

### `POST /pipes`

Disabled (404) unless `options.pipes` is set, and `createRipstreamServer` throws at construction if
`pipes` is set without `authenticate`. Requests must use `Content-Type: application/json`
(otherwise 415), which blocks cross-site "simple" POSTs that skip CORS preflight. Clients name
paths only relative to server-configured roots; absolute paths, `..` and symlinks are rejected
(403) and `followSymlinks` is always false.

| Option | Meaning |
| --- | --- |
| `sourceRoot` (required) | Directory that client `source.path` values resolve against |
| `sinkRoot` | Directory for client `sink.path`; sinks are refused (403) when omitted |
| `allowHttp` | Allow `source.type: "http"` (SSRF-guarded); default `false` |
| `maxConcurrency` | Upper bound for client `concurrency` (default 4) |
| `maxQueue` | Upper bound for client `maxQueue` (default 64) |

Breaking change: earlier versions exposed `/pipes` without these options; it now returns 404 until
configured.

## PDF worker budget

`PdfParser` options bound pdf.js resource use:

- `maxInputBytes` (default 512 MiB): larger files are rejected with `LimitExceededError` before the
  worker starts.
- `workerMemoryMb` (default 256): V8 old-generation limit for the worker, also enforced by a
  watchdog on heap plus ArrayBuffer memory; the worker is terminated when exceeded.
- `maxPageTextChars` (default 32 Mi): per-page cap on extracted text characters.

Attachment extraction follows `maxEmbeddedResources`, `maxEmbeddedResourceBytes` and
`maxTotalEmbeddedBytes`.
