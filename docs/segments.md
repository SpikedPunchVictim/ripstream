# Segments: labels and locations inside a document

`parseRecursive(source, { segments: true })` gives each record a `segments` list: the record's content cut into the
pieces a reader would point at (a paragraph, a slide's shape, a table row, a spreadsheet cell, a line, a JSON value), each
with where it is in the document and the headings it sits under. A scanner that finds a secret in a record can then say
"sheet Vendors, cell C7, column Tax ID" instead of "somewhere in vendors.xlsx".

```ts
const [record] = await ripstream.parseRecursive(bytes, { filename: "vendors.xlsx", segments: true });
record.segments;
// [ ...,
//   { text: "PLANTED-XLSX-C7", start: 412, end: 427, labels: ["Vendors", "Tax ID"], location: "sheet=Vendors;cell=C7" },
//   ... ]
```

```ts
interface Segment {
  readonly text: string;              // === record.content.slice(start, end)
  readonly start: number;             // offsets into record.content, in UTF-16 code units
  readonly end: number;
  readonly labels: readonly string[]; // outermost first: the heading chain, then the column header
  readonly location: string;          // the closed grammar below; parseSegmentLocation reads it
}
```

## What does not change

- **The content.** Segments are a side channel. With them on, every handler sees the same SAX events, so `content` is
  byte for byte what it is with them off, and what Tika 4.2.0 gives. The parity tests run every parser fixture both ways.
- **The cost when off.** Off is the default. No tap is built and parsers get no hint object, so a parser's
  `ctx.get(CONTEXT_KEYS.SEGMENT_HINTS)?.row(n)` does nothing.
- **Other output.** `parse()` and `tk:` metadata carry no segments. The rmeta JSON, the CLI and the pipes emitters carry
  them only when asked (below), and are byte for byte what Tika writes when not.

Segments need a `handlerType` of `text` (the default) or `body`, because their offsets index plain text. Any other
handlerType, or a `segments` that is not a boolean, is refused (RangeError, TypeError). Under isolation the flag crosses
on `IsolatedParseRequest.segments` (records only). The segments come back without their text, which is rebuilt from the
content, and the frame reader checks every offset and location. Segments count against the isolation's result cap.

## In the recursive output: `--segments`

`ripstream parse -r --segments FILE` (and `-o jsonl`) and `ripstream pipes --segments` add one key to the object of each
record that has segments, `tk:segments`. Its value is a string, as every value in Tika's rmeta is (a reader written for
Tika's list of metadata, which has no nested objects, still reads it): the JSON of an array of the segments in content
order, each `{ "start", "end", "labels", "location" }`, with no `text`:

```json
{ "tk:content": "Tax ID\nPLANTED-XLSX-C7", "tk:segments": "[{\"start\":7,\"end\":22,\"labels\":[\"Vendors\",\"Tax ID\"],\"location\":\"sheet=Vendors;cell=C7\"}]" }
```

`start` and `end` index the same object's `tk:content`, in UTF-16 code units, so the text is
`tk:content.slice(start, end)`. A record with no segments has no key. The key is metadata like the others: a
`metadata-filters` allow-list has to name `tk:segments` to keep it, and a filter that rewrites `tk:content` makes the
offsets stale, which is for whoever configured it to know.

- **Library:** `serializeRmeta(records, { segments: true })` and `rmetaObjects(records, { segments: true })`, for
  records parsed with `ParseOptions.segments`; `SEGMENTS_KEY` is the key. The pipes engine's `segments: true` option (and
  `createEngineFromSettings(settings, { segments: true })`) parses with segments and passes the flag, so every emitter that
  writes the list carries them: the file, cloud and search emitters and an UNPACK package's `rmeta.json`.
- **Modes:** pipes takes `--segments` for the parse modes RMETA and UNPACK, which write the list; another mode is refused
  (exit 2 for the CLI). `parse` takes it only with `-r`; any other command refuses it.
- **Under workers and isolation:** the flag crosses to a worker thread and to an isolated child like any other option.
- **Server:** not yet; `/rmeta` writes no segments.

## Coverage

| format | segment | location | labels |
| --- | --- | --- | --- |
| xlsx | a row, and each cell | `sheet=Vendors;row=7`, `sheet=Vendors;cell=C7` (the sheet's own row numbers: empty rows are skipped in the text, not in the numbers) | the sheet name (its heading), the column header (row 1's cell) for a cell below row 1 |
| xls | a row, and each cell | `sheet=Sheet1;row=3;col=2`, rows counted as written | as xlsx |
| docx, odt, doc, rtf | a paragraph; a table row, and each cell | `para=14`; `table=2;row=3`, `table=2;row=3;col=1`; `part=footer;para=20` (header, footer, footnote, endnote, comment) | the heading chain (docx heading styles, odt native headings), the column header |
| pptx | a shape (all its paragraphs) | `slide=3;shape=Title 1`, `slide=3;part=notes;shape=Notes Placeholder 2` | the slide's title, notes included |
| csv read as a table | a row, and each field | `row=3`, `row=3;col=2` (row 1 is the header row) | the header row's field |
| tsv | a line as a row, and each tab-separated field | `row=3`, `row=3;col=2` | the first line's field |
| json | each scalar value | `ptr=/customers/0/tax_id` (RFC 6901), with `line=N;` before it when the text holds several values | the object keys on the path |
| text, log, csv read as text | a line | `line=120` | none |
| markdown | a block | `line=7`, the source line the block starts on (fences counted) | the `#` heading chain |
| html, xhtml | each block, row and cell | `selector=body > table:nth-of-type(1) tr:nth-of-type(2) > td:nth-of-type(2)`, `selector=#footer > span:nth-of-type(1)` | headings (`h1`-`h6`), the column header |
| pdf and the rest | a paragraph | `page=2;para=5` where the parser writes pages, else `para=5` | headings the parser writes |
| any title | the document title | `part=title` (the root record's content starts with it) | none |

The parser fixtures in `packages/parsers/test/fixtures/segments/` plant a value per format and assert the location
and labels of the segment that holds it.

Text that is outside every block still belongs to a segment: it is located at the element it is in, up to the next
block. Segments are trimmed of surrounding whitespace, and empty ones are dropped. They come in content order; of two
that start together, the longer comes first, so a row comes before its first cell.

## Location grammar

A location is `key=value` parts joined by `;`. The keys come in this order, each at most once:

```text
page, slide, sheet, part, shape, table, row, col, cell, para, line, ptr, selector
```

Values escape `%`, `;`, `=`, CR and LF as `%25`, `%3B`, `%3D`, `%0D`, `%0A`. A sheet named `Q1;Q2` gives
`sheet=Q1%3BQ2;cell=A1`. `parseSegmentLocation(location)` returns the parts as a `Map` with the values decoded, and
throws a RangeError for anything outside the grammar. `SEGMENT_LOCATION_KEYS` lists the keys.

Counters start at 1. `para` and `table` count the blocks and tables as written, through the whole document, and restart
at each page, slide and sheet. `(embeddedResourcePath, location)` names one segment of a parse. The round-trip test
holds every fixture to that.

## How it works

`SegmentTap` (core) wraps each record's own content handler, behind the output budget, so it sees exactly the characters
the record keeps. It reads the handler's length at each block's start and end, follows the XHTML structure (containers
`div.page|slide|sheet`, parts `div.header|footer|…|notes`, tables, blocks, headings), and slices the text once, at the
end. The dialect comes from the record's Content-Type at `<body>`: html selectors, tsv cells, json pointers. Some things
are not in the XHTML, so the parser says them through `SegmentHints` on `CONTEXT_KEYS.SEGMENT_HINTS`. That key is set
only when segments are on, and a hint never touches the SAX stream:

| hint | from |
| --- | --- |
| `layout("lines")` | TextParser and CSV read as text: a `p` per source line |
| `layout("table")` | CsvParser's table: the document is one table, so no `table=` |
| `row(n)` | OOXML spreadsheet: `<row r>` |
| `heading(level)` | OOXML word heading styles (`Title`, `Heading1`-`Heading6`), markdown `#` |
| `line(n)` | markdown: a block's source line |
| `shape(name, title)` | OOXML presentation: `cNvPr@name`, title placeholders |

## Not done

- PDF page labels (`/PageLabels`, "iv" or "A-3"): pages are numbered from 1.
- A docx `para` counts the paragraphs written, not Word's own count, which includes empty paragraphs.
- Localized heading style ids (`berschrift1`, `Titre1`) are not recognized as headings.
- Spreadsheets other than xlsx number rows as written, so an empty row is not counted. Only xlsx and xls were checked.
  xlsb and ods get whatever their XHTML gives.
- A table's column headers are its first row, even when that row is a title spanning the sheet.
- Shape names are what the author left: two shapes can share a name, and then `(path, location)` is not unique.
- Selectors are over Tika's XHTML, which drops some of the page's elements, so `nth-of-type` can differ from the page.
- No XPath for XML, no setext (`===`) markdown headings, no JSON Lines `ptr` without the `line`.
- A CSV with too few rows to be sniffed as a table is read as text, so it gets `line=` segments, not cells.
