# Results by format: what is text, what is metadata

A result is `text` (what `handlerType: "text"` writes, the default) plus `metadata` (key to values). Which of the two a fact lands in
is part of the output contract: moving a fact from one to the other changes the text, so it is listed under "Output changes" in
[CHANGELOG.md](../CHANGELOG.md) (see its convention at the top). This page says where each format puts things today.

Every result's metadata carries `tk:extractor-version` (the ripstream release that wrote it, `RIPSTREAM_VERSION`). Store it with an
extraction; when it differs from the running release, compare the CHANGELOG's "Output changes" between the two before trusting an old
text or its detector hits. Parsed in a child or in this process the key is the same. Only the container's metadata has it: an embedded
record's metadata (`parseRecursive`) does not. There is no per-parser version: the changelog names the format of each change.

What a result did not read (a scan, a repair, a failed entry) is not in text or metadata but in `warnings`, see
[warnings.md](warnings.md). Limits and statuses: [limits-and-statuses.md](limits-and-statuses.md).

## Where things go

| Format | In text | Only in metadata |
|---|---|---|
| Plain text, CSV/TSV | The text. A CSV is its rows, one per line, a cell after a tab (Tika's table text); the text of a cell is its text, quotes removed. | `Content-Type` (with `charset` and for CSV `delimiter`), `Content-Encoding`, `tk:detected-encoding`, `csv:delimiter`, `csv:num-columns`, `csv:num-rows` |
| HTML, XHTML | Body text, block ends as line breaks, a cell or list item after a tab. Text after `</body>` is body text. | **`<title>` of the head: `dc:title` and `title`, never text** (a `<title>` inside the body or an inline `svg` is text, or ignored, not the page title). `<meta>` values, `Content-Encoding`, `tk:detected-encoding`. Script and style content is in neither. |
| Markdown | Rendered text (CommonMark): headings, list items, a table as tab-separated rows, link text, reference-link definitions dropped; front matter is text, written without its `---` fences. | `Content-Type`, `Content-Encoding`. |
| Email (`.eml`, mbox, `.emlx`) | **The header block** (`Subject`, `From`, `To`, `CC`, `BCC`, `Reply-To`, `Date`, `Message-ID`, `In-Reply-To`, `References`, `List-Id`, `List-Unsubscribe`; one line each, then a blank line) unless `emailHeaders: false`; every body part in order (the best of a multipart/alternative); then `Attachments:`, one line per attachment, and each attachment's text under its name. | `message:from*`, `message:to`, `dc:title` (the subject), `dc:creator`, `dc:subject`, `message:raw-header:*`, `multipart:subtype`, `multipart:boundary`. The same keys either way: `emailHeaders` changes the text only. |
| Outlook `.msg` | The body (HTML, else RTF, else text) and attachment text. | Message properties as `message:*`, `dc:*` keys. |
| docx, pptx, xlsx and ODF (odt, odp, ods) | docx: paragraphs in order, a heading in `handlerType: "html"` as `<h1>`-`<h6>` and in `"markdown"` as `#` marks (text mode is unchanged by it), table cells, headers, footers, footnotes, comments. pptx: slide text, notes. xlsx/ods: for each sheet its name, then the cells that have a value, a tab before each cell, one line per row (a formatted cell as Excel shows it). | Core and extended properties: `dc:title`, `dc:creator`, `dcterms:created`/`modified`, `cp:*`, `extended-properties:*`, `meta:page-count`, `meta:word-count`, `xmpTPg:NPages`, `tk:embedded-*` for embedded objects. Images and embedded files are records of their own in `parseRecursive`. |
| Legacy Office (doc, xls, ppt) and RTF | The same text model as the OOXML twin (RTF: Tika's one-paragraph model). | OLE summary information as `dc:*`, `meta:*`. |
| PDF | Page text in reading order, one newline per line, a blank line at a paragraph gap, each page a block of its own. A space is written where PDFBox writes one (see the CHANGELOG entry for `tikajs-4c5k`). A page with only an image has no text. | Document info and XMP (`dc:*`, `pdf:*`), `xmpTPg:NPages`, `pdf:chars-per-page`, `pdf:encrypted`, `access-permission:*`, `pdf:contains-damaged-font`, `pdf:contains-non-embedded-font`. **Image-only pages**: `tk:pdf:image-only-page-count` and `tk:pdf:image-only-pages` (also the `image-only` warning). **Repair**: `tk:pdf:repaired`, `tk:pdf:repair-steps` (also the `repaired` warning). |
| Archives (zip, tar, cpio, ar, iso, 7z, gzip, ...) | Each entry's extracted text in archive order (the archive itself has no text of its own); an entry that is skipped or fails contributes none. | `Content-Type` of the container; per entry (`parseRecursive`) `tk:embedded-resource-path`, `tk:resource-name`, `tk:embedded-depth`, and `tk:exception:*` for a failure or a cut (`tk:exception:embedded-resource-limit-reached` and its `-limit`, `-max`, `-seen`, `-read`). |
| Images, audio, video | Nothing (no OCR, no transcript). | EXIF, XMP, tags, dimensions, duration, as Tika names them. |
| Databases and columnar files (SQLite, GeoPackage, Parquet, DBF) | Table names and rows as text; a blob is an embedded record. | `Content-Type` and the keys the parser sets. |

## What is the same everywhere

- `Content-Type` and `tk:parsed-by` (the parsers that ran, outermost first) are always in metadata.
- `tk:parse-time-millis` varies by run and `tk:extractor-version` by release; every other key is a function of the input, the options and
  the release.
- A limit that is reached while parsing is a typed error or, under `onOutputLimit`/`onEmbeddedLimit: "truncate"`, a `truncated`
  warning with `tk:exception:write-limit-reached` or `tk:exception:embedded-resource-limit-reached` on the metadata.
- Text is the same in a child, in a worker and in this process for the same options (the isolation tests compare them).

This page is a summary: a key list that is exact is in [the Tika metadata schema](../packages/core/src/generated) for Tika's keys and in
each parser's tests for ripstream's own (`tk:` keys that are not Tika's: `tk:extractor-version`, `tk:segments`, `tk:segments-degraded`,
`tk:pdf:*`, `tk:exception:embedded-resource-limit*`).
