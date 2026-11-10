# Config parity triage (tikajs-68os.8.5)

Every one of the 117 gap and partial rows of config-inventory.json has a disposition (the `triage` field of the row).
The owner accepted every non-goal group and the CLI recommendation on 2026-11-09 (tikajs-68os.24): those rows have
status `non-goal` and a `decision` field. The 22 rows of the original audit that were already `non-goal-candidate`
(CFG-001 and others, not gap or partial) are still proposals in tikajs-68os.24.
Rows marked implemented were resolved by tikajs-68os.8.1 to .8.8 and .8.12 after the audit was taken; their `status` is updated.

| Disposition | Rows |
| --- | --- |
| implemented | 24 |
| bead | 57 |
| non-goal (declared) | 36 |

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

## Merged into beads

- `tikajs-68os.9.2`: CFG-007, CFG-041, CFG-042. Metadata filters: selection by config and the filter interface.
- `tikajs-68os.9.4`: CFG-009, CFG-046, CFG-067. Renderers, pages block and the metadata limiter budgets.
- `tikajs-68os.9.1`: CFG-043, CFG-118. Digesters and --digest.
- `tikajs-68os.9.3`: CFG-051. Language detection selection by name.
- `tikajs-68os.7.6`: CFG-008, CFG-044. Content handler types on the server routes (/tika/{text,html,xml,md,json}); Tika 4.x defaults to Markdown.
- `tikajs-68os.7.5`: CFG-045. Write limit: ripstream throws (422) where Tika truncates and flags.
- `tikajs-68os.7.2`: CFG-065. tk:exception:* bounding belongs with the failure semantics.
- `tikajs-68os.7.4`: CFG-066. Unpack output layout (frictionless/regular, name strategy) belongs with /unpack.
- `tikajs-68os.6.2`: CFG-019, CFG-021, CFG-126, CFG-129, CFG-136. Fetcher and emitter ids, id-keyed components, numClients and queue naming.
- `tikajs-68os.6.1`: CFG-022, CFG-133. Reporters and the per-tuple failure policy keys.
- `tikajs-68os.6.3`: CFG-127, CFG-128. parseMode and emit strategy semantics.
- `tikajs-68os.6.6`: CFG-020, CFG-137, CFG-138, CFG-139, CFG-140. Cloud and search fetchers, emitters, iterators and reporters. The JVM-client-only iterators (kafka, jdbc, solr, graph) are already proposed as non-goals in tikajs-68os.24.
- `tikajs-68os.6`: CFG-023. Pipes section: see the pipes rows.
- `tikajs-68os.8.13`: CFG-014, CFG-053, CFG-055, CFG-057, CFG-058, CFG-060, CFG-061, CFG-063, CFG-064. Limits that need new engine behavior (stop-and-flag mode, XML depth, output:input ratio, stall timeout) and the auto-detect-parser section; refused by name meanwhile. A design reserve: built only if someone asks.
- `tikajs-68os.9.1`, `.9.2`, `.7.6` and NG-5: CFG-015. The parse-context limit blocks are applied (tikajs-68os.8.8); the other parse-context components follow their own beads.
- `tikajs-68os.8.9`: CFG-017, CFG-088, CFG-089, CFG-091, CFG-092, CFG-096, CFG-098, CFG-099, CFG-100, CFG-101, CFG-102, CFG-105, CFG-106, CFG-109. A server section for ripstream serve.
- `tikajs-68os.8.10`: CFG-028. Parser settings by Tika property name.
- `tikajs-68os.8.11`: CFG-037, CFG-146. Custom media type definitions.
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

## CLI flags (decided: ripstream's own interface)

- Non-goal (CFG-111, 112, 113, 114, 120, 123, 124, 125): the CLI is ripstream's own interface (parse, detect, metadata, language, serve), not tika-app's, so the tika-app flags are declined. -r means recursive here and pretty-print in tika-app, and -h means help here and host in tika-server, so aliases would break one group of users either way. Anyone moving from tika-app uses the flag table in docs/migration.md.
- Bead `tikajs-68os.8.12` (CFG-110): accept `--flag=value` as well as `--flag value`.
- CFG-119 (done in tikajs-68os.8.8): the embedded-limit flags --maxEmbeddedDepth and --maxEmbeddedCount.
