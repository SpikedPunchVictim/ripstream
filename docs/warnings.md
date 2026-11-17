# Warnings: when a result is not the whole document

A parse that resolves is not always a parse that read the document. A scanned PDF gives empty text, a zip whose
entries all fail to parse gives an empty archive, a damaged file read through a recovery may give a few words. A
consumer that must see every word (a DLP scan, a compliance index) must not take any of these for a clean, empty
document. `ParseResult.warnings` says which it was, as data, without changing anything else a parse writes.

```ts
const result = await ripstream.parse(bytes, { filename: "scan.pdf" });
result.warnings;
// [{ kind: "image-only", pages: 1, of: 1, pageNumbers: [1], chars: 0 }]

await ripstream.parse(bytes, { filename: "scan.pdf", onLowYield: "throw" });
// throws LowYieldError (code LOW_YIELD), error.warnings is the list above
```

Bead `tikajs-icjf`. The `tk:` metadata keys that carry the same facts (`tk:pdf:image-only-*`, `tk:pdf:repaired`,
`tk:exception:*`) are exactly what they were; warnings are an addition, never a replacement.

## The shape

`result.warnings` is a `readonly ParseWarning[]`, **always present, empty when the parse read everything it was asked
to**. (Decision: an array that is always there means a consumer writes `result.warnings.length > 0` with no `undefined`
branch; an absent field would be one more way to forget a check.) `ParseRecord.warnings` is optional in the type, so a
record a caller builds by hand still type-checks, and always set by `parseRecursive`: each record has the warnings of
its own document. A plain `parse` collects the warnings of the embedded documents too, each with a `path` (its
embedded resource path); a document's own warnings have none.

| `kind` | Fields | Raised when |
| --- | --- | --- |
| `image-only` | `pages`, `of`, `pageNumbers` (first 100, 1-based), `chars` | PDF pages paint an image and show no text. `of` is the page count, `chars` the characters the document gave in all (the sum of `pdf:chars-per-page`). |
| `repaired` | `steps`, `of`, `chars` | PDF read through a recovery. `steps` are `tk:pdf:repair-steps`. |
| `truncated` | `limit`: `outputChars`, `embeddedResources` or `zipEntries` | The caller chose `onOutputLimit: "truncate"` or `onEmbeddedLimit: "truncate"` and the cut happened (`tk:exception:write-limit-reached`, `tk:exception:embedded-resource-limit-reached`). |
| `partial` | `reason`, `failed`, `of` | Parts of the document were lost to failures: `failed` of its `of` parts could not be read. |

`partial.reason` says what the parts are:

| `reason` | Parts | Raised by |
| --- | --- | --- |
| `pages-failed` | PDF pages (each is a `0` in `pdf:chars-per-page`; `of` is `xmpTPg:NPages`) | the PDF parser |
| `sheets-failed` | worksheets the workbook lists and the package has no part for (xlsx) | the OOXML parser |
| `entries-failed` | entries of an archive (zip, tar, cpio, ar, ISO and the rest): unreadable, unparseable, encrypted, an unknown compression method, or a header the walk could not pass | the archive parsers and the embedded document extractors |
| `embedded-failed` | resources embedded in a document that are not archive entries (attachments, images, OLE objects) | the embedded document extractors |
| `warnings-capped` | warnings dropped because a result keeps at most 100 (`failed` dropped, `of` raised) | the collector. It means the list is not the whole story. |

`path` is on any warning of an embedded document in a plain `parse`.

Clean means **empty**: a text PDF, an xlsx whose sheets all read, a zip of readable entries each give `[]` (tests
pin all three).

## What "low yield" means

A warning is **low yield** when `isLowYield(warning)` is true. This is the rule, and the only place it lives:

- `partial`: always. Part of the document was not read.
- `image-only` and `repaired`: when the document as a whole gave **fewer than 20 characters per page**, that is
  `chars < 20 * max(1, of)` (`LOW_YIELD_CHARS_PER_PAGE`). A scan gives none (the test scans give 0), or a handful when
  OCR leftovers such as a page number are text (1 character on 1 page, 9 on 5, as the consumer reported them); a page of
  prose is hundreds. A text PDF with one scanned page among 20 text pages is a warning to look at, not a
  low yield; a one-page scan, or a five-page scan with a footer line, is.
- `truncated`: never. The caller asked for the truncating option, and the cut is on the result.

A *result* is low yield when any of its warnings is (`lowYieldWarnings(warnings)` returns them).

## The policy: record by default, throw on request

`ParseOptions.onLowYield` is `"record"` (default) or `"throw"`. Recording changes nothing: the result is resolved with
its warnings, as every parse before it. `"throw"` raises `LowYieldError` (code `LOW_YIELD`) when the result is low
yield, with `error.warnings` set to the low-yield warnings, each with its `path` when it came from an embedded
document (in `parseRecursive`, the record's path). Any other value is a `TypeError`.

`LowYieldError` extends `RipstreamError`, not `MalformedDocumentError`: the document parsed, and a handler written for
damaged input does not swallow a policy refusal. It is raised **after** the parse, in the caller's process (see
"Isolation"), so the document's text and metadata cost the same to produce either way; a caller that wants the text of
a low-yield document uses `"record"`.

| Where | What a `LowYieldError` becomes |
| --- | --- |
| HTTP (`httpStatusForError`) | 422 |
| CLI | exit 3; `parse --on-low-yield throw`, and `parse --json` adds a `warnings` list when there is one |
| pipes (`statusForParseError`) | `PARSE_EXCEPTION_NO_EMIT` |

The server and the pipes engine **do not ask for it**: there is no `onLowYield` request parameter, and the
Tika-compatible routes (`/tika`, `/rmeta`, `/unpack`, `/detect`...) neither read nor write warnings. Their output is
what Tika writes, byte for byte as before; adding a field there is a decision about Tika parity that belongs to a
separate change. The mapping exists so a ripstream a caller passes in with the option set behaves like any other
failure. The CLI's `--json` for `parse` (a ripstream shape, not Tika's) gains `warnings` only when non-empty; `-r`,
`jsonl` and `metadata` output do not change.

## Isolation and worker threads

Warnings cross the boundary as data in the result, and the policy never does:

- A child process sends them in its `meta` frame (text) or on each `record` frame. The parent checks them field by
  field like every other frame (`parseWireWarnings`): an unknown kind or field, a count that is not a whole number, more
  than 104 warnings (100, the three truncation flags and the capped marker), more than 100 page numbers, a `path` over
  1024 characters is a protocol violation, as for any hostile frame. A result with none sends none.
- `onLowYield` is applied in the parent after the answer (`createIsolatedRipstream`), so it is not a field of the wire
  and a child cannot be asked to throw. The same code applies it in a worker thread pool (`WorkerParsePool`) and in a
  plain `Ripstream`: the same input gives the same warnings and the same error in all three (pinned by a test that runs
  a real standard child against the in-process pipeline).

## Not covered

- **A format with no parser-level signal gives no warning.** 7z and RAR give metadata only and no entries, and say
  nothing: `ok` for them does not mean the contents were read ([limits-and-statuses.md](limits-and-statuses.md)).
  An image-only DOCX or a PPTX of pictures has text parts that are empty without any failure; nothing here flags it.
- **An xlsx sheet that is in the package and cannot be parsed** fails the whole document with `MalformedDocumentError`
  (as before; checked); `sheets-failed` is for sheets the workbook lists and the package lacks.
- `chars` counts the characters pdf.js gave per page, not the text that survived `onOutputLimit`.
- OCR is not run. `image-only` is the signal to run it, not a substitute.
