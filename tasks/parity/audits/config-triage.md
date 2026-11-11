# Config parity triage (tikajs-68os.8.5)

Every one of the 117 gap and partial rows of config-inventory.json has a disposition (the `triage` field of the row).
The owner accepted every non-goal group and the CLI recommendation on 2026-11-09 (tikajs-68os.24): those rows have
status `non-goal` and a `decision` field. The 22 rows of the original audit that were already `non-goal-candidate`
(CFG-001 and others, not gap or partial) are still proposals in tikajs-68os.24.
Rows marked implemented were resolved by tikajs-68os.8.1 to .8.12, tikajs-68os.6.2 and tikajs-68os.6.3 after the audit was taken; their `status` is updated.

| Disposition | Rows |
| --- | --- |
| implemented | 43 |
| bead | 32 |
| non-goal (declared) | 39 |
| non-goal-candidate (proposed, awaiting the owner) | 3 |

## Implemented since the audit

- CFG-004, CFG-005 (f8c1ac4 712f12e: The section is read and applied by name (createRipstream and the CLI).)
- CFG-025, CFG-034, CFG-035 (f8c1ac4: default-parser / default-detector marker, auto-exclusion of listed components and the marker position follow AbstractSpiComponentLoader.)
- CFG-026 (f8c1ac4: An unknown exclude name is fatal as upstream; a non-string exclude item is refused where upstream skips it silently.)
- CFG-027 (f8c1ac4: Media type filters equal ParserDecorator.withMimeFilters; a malformed value and the retired image/ocr-* types are refused where upstream is silent or fails later.)
- CFG-029 (f8c1ac4: The string shorthand is accepted.)
- CFG-030 (f8c1ac4: An entry with more than one key is refused where upstream drops the extra keys without a word.)
- CFG-032 (f8c1ac4: Names are Tika's kebab-case names; an unknown one is fatal. Only the 89 standard-server parsers that claim types can be named (docs/parsing.md).)
- CFG-036 (712f12e: A detector takes no media type filters: refused, which is what Tika does on the marker and a silent drop on a named entry.)
- CFG-071 (234e04c f8c1ac4: Every known section and every component setting is validated; an unknown key or setting is refused by name.)
- CFG-073 (c41e22b: loadConfig refuses a repeated key (escapes decoded).)
- CFG-078 (c41e22b: loadConfig refuses nesting deeper than 64 levels (Jackson's bound is 1000).)
- CFG-079 (working tree (this change): One leading UTF-8 byte order mark is skipped, for text and for bytes.)
- CFG-076 (1bc5b63 c41e22b: A null, string, fractional or out-of-range value is refused for every numeric setting.)
- CFG-081, CFG-082, CFG-083, CFG-084, CFG-085 (234e04c: ripstream no longer reads XML configuration, which Tika 4.x does not read at runtime either (loadXmlConfig removed).)
- CFG-052, CFG-062 (tikajs-68os.8.8: embedded-limits.maxDepth is maxNodeDepth and timeout-limits.totalTaskTimeoutMillis is maxParseMillis; each is accepted only beside its throwOn flag set to true, because ripstream fails at a limit where Tika's default stops quietly.)
- CFG-119 (tikajs-68os.8.8: --maxEmbeddedDepth and --maxEmbeddedCount.)
- CFG-017, CFG-088, CFG-089, CFG-098, CFG-100, CFG-102, CFG-105, CFG-106 (tikajs-68os.8.9: `serve --config` reads a `server` section: port, host, endpoints, cors, maxRequestSizeBytes, requestLogLevel, maxRequestReadMillis and idleTimeoutMillis are applied; serve takes Tika's `-h <host>` and `-p <port>`; every other server setting is refused by name. Read from Tika source, not run against a Tika.)
- CFG-091, CFG-109 (tikajs-68os.8.9: `server.endpoints` selects the served endpoints by Tika's names, so `ripstream serve` serves /status and /async only when listed. Partial: /mime, /mime-types, /detectors, /parsers and /pipes are not served and are refused in `endpoints`; /health, /translate and /pipes are not governed by it.)
- CFG-037, CFG-146 (tikajs-68os.8.11: the `custom-mimetypes` config key names a Tika custom-mimetypes.xml; same XML, merged into the registry, malformed definitions refused by name.)
- CFG-126, CFG-129, CFG-136 (tikajs-68os.6.2: `pipes.numClients` and `pipes.queueSize` are read; component ids follow Tika's rules. The JVM-only knobs (CFG-024, CFG-131, CFG-132) and the emit-batching ones (CFG-128) are accepted with a notice that they change nothing.)
- CFG-127 (tikajs-68os.6.3: every parse mode is Tika's per input: CONCATENATE one document per input, NO_PARSE detection only, UNPACK the RMETA list and the embedded bytes. The Frictionless default of UNPACK is tikajs-68os.6.7.)

## Merged into beads

- `tikajs-68os.9.2`: CFG-007, CFG-041, CFG-042 (done). Metadata filters: the section is read, checked when the config loads and run on the rmeta, pipes, CLI (recursive JSON) and server output paths with Tika's EmitHandler choice. CFG-007 and CFG-041 are implemented; CFG-042 stays partial for the per-request wire alone (NG-5).
- `tikajs-68os.9.4`: CFG-009, CFG-046, CFG-067. Renderers, pages block and the metadata limiter budgets.
- `tikajs-68os.9.1`: CFG-043, CFG-118. Digesters and --digest.
- `tikajs-68os.9.3`: CFG-051. Language detection selection by name.
- `tikajs-68os.7.6`: CFG-008, CFG-044 (done). Every handler type is a library option and a server route or `?handler=`; CFG-044 is implemented (partial: the default stays text where Tika's is Markdown, by the owner's decision) and CFG-008, a configured default type, is proposed as a non-goal (refused by name), awaiting the owner.
- CFG-028 (tikajs-68os.8.10: a parsers entry sets the PDFParserConfig properties ripstream has an option for, sortByPosition and extractAnnotationText, as true or false; every other parser setting is refused by name. Partial: the rest of the properties have no ripstream counterpart.)
- `tikajs-68os.7.5`: CFG-045. Write limit: reaching it truncates and flags, as Tika does (done; ParseOptions.onOutputLimit, and the server always truncates).
- `tikajs-68os.7.2`: CFG-065. tk:exception:* bounding belongs with the failure semantics.
- `tikajs-68os.7.4`: CFG-066. Unpack output layout (frictionless/regular, name strategy) belongs with /unpack.
- `tikajs-68os.6.5`: CFG-133 (done). The server and CLI map results to statuses and Retry-After. maxTotalTaskTimeoutMillis, maxWaitForClientMillis and stopOnlyOnFatal tune a forked-client pool and a request-supplied timeout that ripstream does not have, so they are proposed as non-goals and stay refused by name, awaiting the owner.
- `tikajs-68os.6.5`, with CFG-133: CFG-128 (done). emitStrategy EMIT_ALL and DYNAMIC and the batching knobs are accepted with a notice (the engine emits in-process). PASSBACK_ALL is refused by Tika on /pipes itself and a library user collects results with a reporter or MemoryEmitter, so it is proposed as a non-goal and stays refused by name, awaiting the owner.
- `tikajs-68os.6.6`: CFG-019, CFG-020, CFG-021, CFG-022, CFG-137, CFG-138, CFG-139, CFG-140. Cloud and search fetchers, emitters, iterators and reporters. The JVM-client-only iterators (kafka, jdbc, solr, graph) are already proposed as non-goals in tikajs-68os.24.
- `tikajs-68os.6`: CFG-023. Pipes section: see the pipes rows.
- `tikajs-68os.8.13`: CFG-014, CFG-053, CFG-055, CFG-057, CFG-058, CFG-060, CFG-061, CFG-063, CFG-064. Limits that need new engine behavior (stop-and-flag mode, XML depth, output:input ratio, stall timeout) and the auto-detect-parser section; refused by name meanwhile. A design reserve: built only if someone asks. The bead was closed as a deferred non-goal on 2026-11-10 (owner); each key stays refused by name and the bead is reopened if someone asks.
- `tikajs-68os.9.1`, `.9.2`, `.7.6` and NG-5: CFG-015. The parse-context limit blocks are applied (tikajs-68os.8.8), and so are the digester factories (.9.1) and the metadata-filters list (.9.2); the other parse-context components follow their own beads.
- `tikajs-68os.6`: CFG-092. `server.allowPipes: true` is refused by name in the server section (tikajs-68os.8.9): /pipes needs an authenticate function and path roots only code can supply. The pipes group decides what a file form could be.
- `tikajs-68os.8.12`: CFG-110. `--flag=value` on the CLI.

## Non-goals (declared by the owner, 2026-11-09)

- **tikajs-68os.24 (already proposed)**: CFG-033, CFG-038, CFG-103, CFG-104. /parsers and /detectors list a JVM class graph. (8.6 gives ripstream component names, which weakens that reason: a name list is now cheap.)
- **NG-1 pluggable encoding detectors**: CFG-006, CFG-039, CFG-040. Text decoding uses a built-in detector with no plugin point; default-behavior parity is a parse-quality matter (tikajs-68os.10). The encodingDetector section is already refused by name.
- **NG-2 OCR selection by config**: CFG-010, CFG-047. OCR is an optional parser built in code (TesseractOcrParser); an external-process engine list with size checks is deployment wiring. Joins CFG-031.
- **NG-3 translators**: CFG-013, CFG-050. Every Tika translator calls a hosted web service; none is implemented here and the filters audit already proposes the named ones as non-goals.
- **NG-4 Tika presets**: CFG-016, CFG-107, CFG-141. Tika presets are catalog config fragments switched on by --preset / TIKA_PRESETS; ripstream has no catalog. Its server presets are a different, per-request thing.
- **NG-5 per-request config and instantiated context**: CFG-068, CFG-069, CFG-093. Tika instantiates Java classes from JSON and guards them with @OperatorOnly; ripstream builds components in code and its request contract is a fixed allowlist by design (a part other than the file is a 400 since 8.3).
- **NG-6 loader leniency**: CFG-074, CFG-075. Comments in JSON and case-insensitive enum values are Jackson options. ripstream is stricter on purpose; the cost is that a config copied from Tika with a comment or STRICT is refused with a clear message.
- **NG-7 ${env:NAME} interpolation**: CFG-077, CFG-143. No ripstream config value is a string worth interpolating (mode, component names, media types), and every setting already has a RIPSTREAM_* variable.
- **NG-8 TIKA_PASSWORD**: CFG-117, CFG-142. A password in the environment leaks through /proc and process listings, and a password cannot cross the isolation boundary anyway. --password and the library option remain.
- **NG-9 fork mode, server id, XML conversion**: CFG-086, CFG-090, CFG-121, CFG-122. Isolation replaces fork mode and its watchdog; the server id exists for that watchdog; Tika's XML-to-JSON converter has nothing to convert because ripstream never read XML configuration.
- **NG-10 JVM system properties**: CFG-147. java.io.tmpdir is a JVM property; the isolation child's TMPDIR is set per child.
- **NG-11 server settings with no ripstream counterpart** (declared by the owner, 2026-11-10, tikajs-68os.8.9): CFG-096, CFG-099, CFG-101. `maxQueuePauseMillis` (ripstream answers 503 at once when its queue is full), `maxResponseWriteMillis` (the idle timeout bounds a stalled reader) and `maxInFlightRequestBytes` (requests are bounded by number and body size, not bytes in flight). Each is refused by name when set, with the reason. `id` (CFG-090, NG-9), `tlsConfig` (CFG-103) and `metricsPort` (CFG-104) are already declared non-goals and `allowPerRequestConfig: true` is NG-5 (CFG-093); all are refused by name too, as is `allowHttp2: true` (CFG-094).

## CLI flags (decided: ripstream's own interface)

- Non-goal (CFG-111, 112, 113, 114, 120, 123, 124, 125): the CLI is ripstream's own interface (parse, detect, metadata, language, serve), not tika-app's, so the tika-app flags are declined. -r means recursive here and pretty-print in tika-app, and -h means help here and host in tika-server, so aliases would break one group of users either way. Anyone moving from tika-app uses the flag table in docs/migration.md.
- Bead `tikajs-68os.8.12` (CFG-110): accept `--flag=value` as well as `--flag value`.
- CFG-119 (done in tikajs-68os.8.8): the embedded-limit flags --maxEmbeddedDepth and --maxEmbeddedCount.
