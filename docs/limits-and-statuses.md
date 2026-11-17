# What a result means: ok, damaged, repaired, limit hit

ripstream returns **no status**. `parse` and `parseRecursive` resolve with text and metadata, or throw, or (with
`onDocumentFailure: "record"`) resolve with the failure written on the metadata. A caller that needs a status derives
it from those three things, and from `result.warnings`, the typed list of what an ok result did not read
([warnings.md](warnings.md): image-only, repaired, truncated, partial; `onLowYield: "throw"` refuses the low-yield ones); [Mapping to a status](#mapping-to-a-status) gives a rule that follows from this page.

Everything below was read from the code (the file is named) and, where a number is given, run: zip, tar and gzip
nested 1 to 200 deep, DOCTYPE and entity payloads through eleven parsers, and damaged zip, gzip, docx, pdf, xml and rtf
inputs, all with `createRipstream()` at the default limits (2026-11-15). The depth outcomes are pinned by
`packages/parsers/test/nested-archive-depth.test.ts`. None of it was compared with a running Tika unless said.

## How a failure reaches you

| Parse | A document that cannot be read (`MalformedDocumentError`, `EncryptedDocumentError`, zero bytes) | A limit, a timeout, an abort |
| --- | --- | --- |
| `parse`, `parseRecursive` (default `onDocumentFailure: "throw"`) | throws | throws (embedded documents: see below) |
| `onDocumentFailure: "record"` | resolves; `ParseResult.exception` / `ParseRecord.exception` is set and the root record carries `tk:exception:container-exception` (`Name: message`, no stack) | throws |
| `parseToString`, `parseToHandler`, `parseToStream` | throws | throws, and ignore `onOutputLimit` and `onEmbeddedLimit` |

(`packages/core/src/failure.ts`: `classifyFailure`, `isFatalParseError`; `docs/migration.md` "A document that cannot be
read".) Three more rules apply to documents inside a container in `parseRecursive`
(`packages/core/src/recursive.ts`, `RecordExtractor.parseEmbedded`):

- An embedded document that fails is **recorded, not thrown**: its own record has `exception` and
  `tk:exception:embedded-exception`, and the siblings are still read. This holds for a limit of that one document
  (depth, per-entry size, ratio) as well as for a malformed one.
- A limit of the **whole parse** (`maxEmbeddedResources`, `maxTotalEmbeddedBytes`, the shared output budget) is never
  absorbed by a record: it throws (`isWholeParseLimit`), unless `onEmbeddedLimit` / `onOutputLimit: "truncate"` asks for
  the cut.
- The **root** document's own failure always ends the call: under `"record"` a malformed root resolves, but a limit hit
  in the root's own entries throws (run: `maxNodeDepth: 0` on a zip throws from `parseRecursive` even under `"record"`;
  `maxNodeDepth: 1` resolves and flags the depth-1 record).

In plain `parse` the embedded metadata is dropped, so the container also carries each failed child's
`tk:exception:embedded-exception` (`ParsingEmbeddedDocumentExtractor`, `packages/core/src/embedded.ts`); an embedded
*limit* error is not a child failure there and throws.

## What `ok` means, by format family

`ok` here is "resolved with no exception". The right-hand columns are the signals that an ok result was not the whole
document. A key is written only when it applies.

| Family | Tolerant of damage (ok, maybe less text)? | Signals on an ok result | Throws |
| --- | --- | --- | --- |
| Text, CSV, JSON, YAML, markdown | Yes: bytes are decoded, bad JSON is read as text (`{"a": [1,2` is ok, parsed by `TextParser`) | `tk:detected-encoding`; output cut: `tk:exception:write-limit-reached` | `LimitExceededError` at `maxOutputChars` unless `onOutputLimit: "truncate"`; zero bytes |
| HTML, XHTML | Yes: unclosed tags are closed (`<html><body><p>unclosed <b>x` is ok) | `tk:detected-encoding`, write-limit flag | open-element depth over 2000: `LimitExceededError: HTML nesting exceeds 2000 open elements` (`html.ts`; `docs/security.md`) |
| XML, SVG, RSS/Atom, plist | No: not well-formed is a `MalformedDocumentError` (`<a><b></a>`: "Malformed XML") | none | malformed; a reference to any DTD entity is malformed, not expanded ([XXE](#xxe-and-entity-expansion)) |
| RTF | Yes: a truncated group is read as far as it goes (`{\rtf1\ansi Hello {\b bold` is ok, 11 characters) | none | not RTF at all: `MalformedDocumentError: Not an RTF document`; group nesting over the cap: `MalformedDocumentError: RTF group nesting exceeds N` (`rtf.ts`) |
| OOXML (docx, xlsx, pptx), ODF, EPUB | No for the container: a cut zip is `MalformedDocumentError: Missing ZIP end record`. Parts that fail inside a good container are recorded | embedded failures: `tk:exception:embedded-exception` | encrypted: `EncryptedDocumentError` (a password via `password`, in process only); `<!ENTITY` in a read part: `LimitExceededError` ([XXE](#xxe-and-entity-expansion)) |
| Legacy OLE2 (doc, xls, ppt, msg, WordPerfect) | No | embedded failures as above | encrypted: `EncryptedDocumentError` (`word-binary.ts`, `excel-binary.ts`, `powerpoint-binary.ts`, `msg.ts`, `wordperfect.ts`) |
| PDF | Partly: a damaged file is read after a recovery | `tk:pdf:repaired` = `true` and `tk:pdf:repair-steps` (what was done); `tk:exception:warn` (`MalformedDocumentError: page N could not be read: ...`, first ten pages named, the rest counted) with a `0` in `pdf:chars-per-page`; `tk:pdf:image-only-page-count` and `tk:pdf:image-only-pages` (pages with an image and no text: a caller derives "needs OCR" from them, e.g. count equal to `xmpTPg:NPages`) | no recovery: `MalformedDocumentError: Unable to read PDF (<damage>)`; recovered but no text and not provably empty: `PDF is damaged and no text could be recovered (<damage>)`; pages failed and none had text; more than 10,000 pages: `LimitExceededError`; encrypted without the password: `EncryptedDocumentError`; `maxInputBytes` |
| Archives (zip, tar, gzip, bzip2, xz, cpio, ar, ISO) | A cut or corrupt zip or gzip is not read around: `MalformedDocumentError: Invalid ZIP archive`, `Invalid GZIP stream` | an entry that cannot be read (an **encrypted zip entry**, an unknown method) is listed by name and recorded on the archive as `tk:exception:embedded-stream-exception` (`EncryptedDocumentException: stream (a.txt) is encrypted`); the root is ok and the other entries are read (`packages/parser-archive/src/zip.ts`, Tika 4.2.0 `/rmeta` oracle per its comment); an entry renamed because it left the root: the same key | entries over `maxZipEntries` (also tar, cpio, ar, ISO), bytes and ratio: `LimitExceededError`; entry count can be cut, see below |
| 7z, RAR | Signature-level metadata only, no decompression, no entries (`archive-metadata.ts`) | the result is ok with `format`/`version` and no embedded records: **ok does not mean the contents were read** | a cut header: `MalformedDocumentError` |
| Mail (eml, mbox, msg, emlx) | Yes: attachments that fail are recorded | `tk:exception:embedded-exception` | `Mail nesting depth N exceeds maxNodeDepth` (`mail.ts`) |
| Images, audio, video | Metadata only; a damaged ICO or an unsupported AU variant is a warning | `tk:exception:warn` (`ico.ts`, `au.ts`) | `MalformedDocumentError` on a structure the parser cannot walk (for example an unrepresentable ISO-BMFF box size in `image.ts`); each format's own errors, not listed here |
| Unknown or unsupported type | An empty result, not an error | `tk:parsed-by` is `EmptyParser` and the text is empty (as Tika's fallback) | nothing; only a parser that is named and cannot read the file throws |

A reading of this table that matters in practice: **empty text with no exception is not evidence of an empty
document**. It is what a 7z, an unknown type and an image-only PDF give. Use `result.warnings` ([warnings.md](warnings.md):
an `image-only` or `partial` warning is the answer for a scan or an archive whose entries all failed), `tk:parsed-by`,
`tk:pdf:image-only-*` and the archive keys to tell them apart.

## Limits: which ones throw, which truncate

Defaults and what each enforces are in [security.md](security.md#resource-limits). What happens at the limit:

| Limit | Default | At the limit | Opt-in to keep what was read |
| --- | --- | --- | --- |
| `maxInputBytes` | none (isolator: 100 MiB) | `LimitExceededError` with `limit: "inputBytes"`, `observed` (the input's size) and `max`, before any parsing; where the size is known (bytes, Blob, `{ path }`) nothing is read, and an isolator refuses it before a child is spawned or pool memory is reserved; a stream of unknown length is refused as soon as it passes the cap | none |
| `maxOutputChars` | 100,000 | `LimitExceededError` ("Output exceeds 100000 characters"; "Recursive output exceeds ..." in `parseRecursive`) | `onOutputLimit: "truncate"`: text so far, `tk:exception:write-limit-reached` = `true` |
| `maxZipEntries` | 10,000 | `LimitExceededError` ("ZIP entries exceed 10000") | `onEmbeddedLimit: "truncate"`: first N entries in archive order, five keys: `tk:exception:embedded-resource-limit-reached` = `true`, `-limit` (which), `-max`, `-seen`, `-read` |
| `maxEmbeddedResources` | 10,000 | `LimitExceededError` ("Embedded count 10001 exceeds 10000"), a whole-parse limit | the same `onEmbeddedLimit: "truncate"`, noted on the container |
| `maxNodeDepth` | 100 | see [Nested depth](#nested-archive-depth): `parse` throws, `parseRecursive` records on the deepest document | none |
| `maxEmbeddedResourceBytes`, `maxTotalEmbeddedBytes`, `maxDecompressionRatio` | 512 MiB, 1 GiB, 1000 | always throw `LimitExceededError`; not covered by `truncate` | none |
| `maxParseMillis` | 60,000 | `ParseTimeoutError` (HTTP 408) | none |
| `maxMetadataValueChars` | 1,000,000 | **the value is cut silently, with no flag** (`Metadata.setMaxValueChars`) | none |
| `maxMetadataTotalChars` | 2,000,000 | `LimitExceededError` | none |
| PDF pages | 10,000 (fixed) | `LimitExceededError` naming the count | none |
| `maxXmlEntityExpansions` | 0, reserved | never reached: DTD entities are not expanded | none |

`onOutputLimit` and `onEmbeddedLimit` cross the isolation boundary, and so does every limit but `maxTaskMillis` (the
isolation's own budget; which limit is enforced where is the table in [isolation.md](isolation.md#per-request-limits)). The server and
the CLI keep throwing at the entry limits except where `docs/migration.md` says otherwise.

Two flags belong to a *segmented* result, not a limit of the parse: `tk:segments-degraded` (value `ptr` or `selector`)
says the record's segment locations did not fit the allowance for locations and its segments are line (JSON) or
paragraph (HTML) segments instead, with the text kept ([segments.md](segments.md)).

## Nested archive depth

Default `maxNodeDepth` is 100: a document at embedded depth 101 is refused (`chargeEmbeddedResource`,
`packages/core/src/embedded.ts`). Depth 0 is the file, so a zip containing a zip containing text is depth 2. Run on a
zip, tar and gzip nested N times around a text file (the three behave the same):

| N | `parse` | `parseRecursive` (default or `"record"`) |
| --- | --- | --- |
| 21, 50, 99, 100 | ok, innermost text read | N + 1 records, max depth N, innermost text in the last, no exception |
| 101 | throws `LimitExceededError`: `Embedded depth 101 exceeds 100` | resolves with 101 records, max depth 100. The record at depth 100 has `exception` (`LimitExceededError`) and `tk:exception:embedded-exception` = `LimitExceededError: Embedded depth 101 exceeds 100`; no record for depth 101 and the innermost text is absent |
| 200 | the same error (the walk stops at 101, it does not count to 200) | the same 101 records and the same record at depth 100 |

So a consumer that uses `parseRecursive` must look at `exception` of the deepest records: a nest of 1,000 zips is a
**resolved** result that is missing everything below depth 100. Lowering the limit moves the cut (`maxNodeDepth: 1`
keeps the file and its first embedded document and flags the latter); `maxNodeDepth: 0` makes even `parseRecursive`
throw for any container. `maxNodeDepth` can be set per request, in the configuration (`embedded-limits.maxDepth`,
accepted only beside `throwOnMaxDepth: true`, `parse-context-config.ts`) and, isolated, per request header. Other parsers add their own nesting guards with
their own errors: mail (`Mail nesting depth N exceeds maxNodeDepth`), ISO 9660 and Unix dump directories (against
`maxNodeDepth`), XML (`XML nesting exceeds N levels`), property lists (256), Parquet schemas.

## XXE and entity expansion

ripstream never fetches a DTD or an external entity and never expands a DTD entity (`saxes` expands only the five
predefined entities; `packages/core/src/parse-context.ts` documents `maxXmlEntityExpansions`). What differs is what the
caller sees. The payload was an `<!ENTITY x SYSTEM "file:///...secret.txt">` or an internal `<!ENTITY x "internal">`,
referenced as `&x;`; the secret never appeared in any text:

| Input | Result |
| --- | --- |
| `.xml` / `.svg` with an entity reference (external or internal) | `MalformedDocumentError: Malformed XML`; recorded as `tk:exception:container-exception` under `"record"` |
| `.rss`, `.plist` with an entity reference | `MalformedDocumentError` ("Malformed feed XML: ... undefined entity", "Malformed XML plist: ...") |
| `.xml` with `<!DOCTYPE doc SYSTEM "http://...">` or a declared entity that is never referenced | ok: the DOCTYPE is accepted, nothing is fetched (`html-xml.test.ts`) |
| `.html` / `.xhtml` with the same DOCTYPE | ok: read as HTML, `&x;` stays literal text |
| docx, xlsx, pptx (OPC) with `<!ENTITY` in any `.xml` / `.rels` part the parser reads, even an internal one | **`LimitExceededError: XML entity expansion exceeds the expanded-size limit`**, thrown from `collectParts` (`packages/parser-office/src/ooxml.ts`), not absorbed by `"record"`; HTTP 422, exit code 3, pipes `PAYLOAD_LIMIT_EXCEEDED`. This is the "limit_expanded" outcome: it is a refusal named after Tika's limit, and it also refuses a harmless declared entity |
| OPC with `<!DOCTYPE ... SYSTEM>` but no `<!ENTITY`, or an `<!ENTITY` in a part the parser does not read | ok |
| odt (`content.xml`, `meta.xml`), epub (`content.opf`) with an external entity declaration | ok, no leak (declared, not referenced; ODF and EPUB do not go through `collectParts`) |

The comment in `html-xml.test.ts` says Tika answers an external entity with an empty stream and reads on, so an XML
document with a reference to one would be ok there and is malformed here. That comes from reading Tika's source and
was not run against Tika for this page.

## Refused before parsing: `AdmissionRefusedError`

`AdmissionRefusedError` (code `ADMISSION_REFUSED`, extends `RipstreamError`, not `LimitExceededError`;
`packages/core/src/errors.ts`) is raised in the parent by the isolation layer when a request could never fit the memory
pool: the per-child budget plus overshoot plus the parent's result allowance is more than the whole pool
(`isolator.ts`). It says nothing about the document, so treat it as a deployment or cap problem (lower the caps or
enlarge `memoryPoolMb`), not as a hostile or oversized file. It is not a `LimitExceededError` (it was until
`tikajs-mz56`), so a `catch` of that class does not take it and it has no `limit`: branch on the class or on `code`.
Its message deliberately avoids the names of the parse limits. It never crosses the child boundary and is mapped like
a limit: HTTP 422, CLI exit 3, pipes `PAYLOAD_LIMIT_EXCEEDED`.

## Which limit: `LimitExceededError.limit`

| `limit` | The limit it is about |
| --- | --- |
| `outputChars` | `maxOutputChars`: the text, or the recursive total |
| `documentOutputChars` | `maxDocumentOutputChars` |
| `zipEntries` | `maxZipEntries`: entries of a zip, tar, cpio, ar, ISO or dump |
| `ratio` | `maxDecompressionRatio` (`observed` and `max` are ratios) |
| `entryBytes` | `maxEmbeddedResourceBytes`: one entry, part or decompressed stream |
| `totalBytes` | `maxTotalEmbeddedBytes`: all of an archive or package |
| `nodeDepth` | embedded depth (`maxNodeDepth`) and the nesting guards of mail, HTML, XML and directories |
| `embeddedResources` | `maxEmbeddedResources` |
| `entityExpansion` | an XML entity declaration (`maxXmlEntityExpansions`); no numbers |
| `metadataChars` | `maxMetadataTotalChars` |
| `inputBytes` | the input is too large: `maxInputBytes` (a call's own limit, or the isolator's), a bounded read, a fetched body or a PDF over its cap |
| `pages` | the PDF page cap |
| `memory`, `cpu`, `disk` | an isolated child's memory, CPU-time or temporary-disk budget; `memory` also covers a parse worker that ran out of heap |
| `resultBytes` | the result an isolated child may send back, or a `maxOutputChars` whose result would not fit the isolation ceiling |
| `other` | a format's own guard that no `ParseLimits` member names (a row, cell, packet or box count, a header block); the message says which, and `observed` and `max` may be absent |

A child's answer carries the same `limit`, `observed` and `max` as the in-process one (they travel in the error frame). A
`limit` name a parent does not know (a newer child) arrives as `other`. Some sites that throw carry no numbers (a stream whose length is
unknown, a child killed from outside), so `observed` and `max` are optional; `limit` is always set.

## Error to status

| Error | `code` | HTTP (`httpStatusForError`) | CLI exit | pipes status (`statusForParseError`) |
| --- | --- | --- | --- | --- |
| `MalformedDocumentError`, `EncryptedDocumentError`, `ZeroByteFileError` | `MALFORMED_DOCUMENT`, `ENCRYPTED_DOCUMENT` | 422 (JSON routes answer 200 with the exception in the metadata) | 3 | recorded: `*_PARSE_EXCEPTION` statuses, the input is not a crash |
| `UnsupportedFormatError` | `UNSUPPORTED_FORMAT` | 415 | 3 | recorded as an empty parse |
| `LimitExceededError`, `AdmissionRefusedError`, `WriteLimitReachedError`, `RequestTooLargeError` | `LIMIT_EXCEEDED`, `ADMISSION_REFUSED`, `WRITE_LIMIT_REACHED`, `REQUEST_TOO_LARGE` | 422, 422, 200, 413 | 3 | `PAYLOAD_LIMIT_EXCEEDED` |
| `LowYieldError` (only with `onLowYield: "throw"`; [warnings.md](warnings.md)) | `LOW_YIELD` | 422 | 3 | `PARSE_EXCEPTION_NO_EMIT` |
| `ParseTimeoutError` | `PARSE_TIMEOUT` | 408 | 1 | `TIMEOUT` |
| `AbortError` | `ABORTED` | 500 | 1 | `UNSPECIFIED_CRASH` |
| `IsolationError` `crash` / `queue_full` / `unavailable` | `ISOLATION_FAILED` | 500 / 503 / 503 | 1 / 4 / 4 | `UNSPECIFIED_CRASH` / `CLIENT_UNAVAILABLE_WITHIN_MS` |

An out-of-memory child arrives as a limit error, so it cannot be told from an output or entry limit by class alone.
A child's per-document exceptions in a recursive result are plain `Error`s carrying the child's sanitised text, never a
ripstream class: classify by the `tk:exception:*` key and the leading `Name:` of the text, not by `instanceof`.

## Mapping to a status

A rule that follows from the above, for a consumer that wants one status per input. Check in this order and stop at the
first match:

1. Threw `AdmissionRefusedError`: **refused (deployment)**. Not the document's fault; retry with lower caps.
2. Threw `ParseTimeoutError` or `AbortError`, or `IsolationError`: **timeout / aborted / infrastructure** (`reason`
   tells a crash from a full queue).
3. Threw `LimitExceededError`: **refused, over a limit**. `error.limit` names which (see below); `observed` and `max` are the
   numbers when the parser knew them. Do not match the message.
4. Threw `EncryptedDocumentError`, or (record mode) the root `exception` is one, or an archive has an
   `embedded-stream-exception` starting `EncryptedDocumentException`: **encrypted** (whole file, or some entries).
5. Threw `MalformedDocumentError` / `ZeroByteFileError`, or (record mode) the root has `tk:exception:container-exception`:
   **damaged, nothing usable**.
6. Resolved and any record has `exception`, or the root has `tk:exception:embedded-exception` /
   `embedded-stream-exception` / `tk:exception:warn`: **partial** (some documents or pages were not read; look at
   which). A depth cut is this case. `warnings` has the same fact, with the counts: a `partial` warning (`failed` of `of`).
7. Resolved with `tk:exception:write-limit-reached` or `tk:exception:embedded-resource-limit-reached`: **truncated**
   by a limit the caller opted into.
8. Resolved with `tk:pdf:repaired`: **repaired** (ok, but not the file as written). `tk:pdf:image-only-pages` equal to
   all pages: **needs OCR**. (A `repaired` or `image-only` warning is the typed form; `isLowYield` says when it amounts to
   a document that gave almost nothing, and `onLowYield: "throw"` turns that into a `LowYieldError`, a refusal the caller
   never has to read off this list.) `tk:segments-degraded`: ok, segments coarser than asked.
9. `tk:parsed-by` is only `EmptyParser`, or the type is 7z/RAR: **not read** (unsupported, or signature only).
10. Otherwise: **ok**.

## Cost of a child for each file

The bead behind this page asked how much of a ~1.4 s per-file wall in an isolated run is child spawn. Measured in
`docs/isolation.md` ("Measured", 7 reps, darwin/arm64, Node 24.18): a one-shot isolated child answers a small file in a
p50 of 298 to 333 ms against about 3.4 ms in process (290 to 317 files/s), so a fresh child costs about 0.3 s per
file, and a reused child 5 to 13 ms (`reuse`). CLI start is another 0.14 to 0.23 s ([cli-startup.md](cli-startup.md)).
Those two do not add up to 1.4 s; the rest of that figure came from outside this repository's measurements and is not
explained here.

## Not covered

- Password fixtures: a pptx (right password, wrong password, none) is in `office-protected.test.ts` and an encrypted zip entry in
  `fixtures/archive-samples/zip-encrypted-entry.json` (`tikajs-2gsr`). ripstream has no password path for zip (an encrypted entry
  is recorded, never decrypted) and does not open 7z, so there is nothing to test beyond the entry record.
- The XXE and depth rows were run on the library API, not on `serve`; `serve` maps the same errors per the table.
