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
content, and the frame reader checks every offset and location. Segments cross in `segments` frames of their own, with
an allowance of their own (24 MiB + 0.75 bytes a character of `maxOutputChars`; a denser document fails with a
`LimitExceededError`), see docs/isolation.md.

## In the recursive output: `--segments`

`ripstream parse -r --segments FILE` (and `-o jsonl`), `ripstream pipes --segments` and the server's `/rmeta?segments=true` add one key to the object of each
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
- **Server:** `PUT /rmeta?segments=true` (and `/rmeta/text`, `/rmeta/body`) writes the key as the CLI does, and
  `/unpack?segments=true` writes it into the package's `rmeta.json`. It is a query parameter like `maxOutputChars` and `preset`,
  and takes `true` or `false` (any case, once; anything else is a 400); the other routes ignore it, as they ignore any parameter they do not read (Tika does the same). It
  needs a text or body handler: `/rmeta/html`, `/xml`, `/markdown`, `/ignore`, or a preset whose handler is one of them, is a 400
  before the document is read. Without it the answer is what it was.

## Coverage

| format | segment | location | labels |
| --- | --- | --- | --- |
| xlsx | a row, and each cell | `sheet=Vendors;row=7`, `sheet=Vendors;cell=C7` (the sheet's own row numbers: empty rows are skipped in the text, not in the numbers) | the sheet name (its heading), the column header (row 1's cell) for a cell below row 1 |
| xls | a row, and each cell | `sheet=Sheet1;row=7`, `sheet=Sheet1;cell=C7` (the sheet's own row numbers, as xlsx) | as xlsx |
| docx, odt, doc, rtf | a paragraph; a table row, and each cell | `para=14`; `table=2;row=3`, `table=2;row=3;col=1`; `part=footer;para=20` (header, footer, footnote, endnote, comment) | the heading chain (docx heading styles, odt native headings), the column header |
| pptx | a shape (all its paragraphs) | `slide=3;shape=Title 1`, `slide=3;part=notes;shape=Notes Placeholder 2`; a second shape of a slide with the same name is `Title 1~2` | the slide's title, notes included |
| csv read as a table (see below) | a row, and each field | `row=3`, `row=3;col=2` (row 1 is the header row) | the header row's field |
| tsv | a line as a row, and each tab-separated field | `row=3`, `row=3;col=2` | the first line's field |
| json | each scalar value | `ptr=/customers/0/tax_id` (RFC 6901), with `line=N;` before it when the text holds several values | the object keys on the path; a string of only spaces holds no value and is no segment |
| text, log, csv read as text | a line | `line=120` | none |
| markdown | a block | `line=7`, the source line the block starts on (fences counted) | the heading chain, `#` and setext (`Title` over `===` or `---`) |
| html, xhtml | each block, row and cell | `selector=body > table:nth-of-type(1) tr:nth-of-type(2) > td:nth-of-type(2)`, `selector=#footer > span:nth-of-type(1)` | headings (`h1`-`h6`), the column header |
| pdf | a paragraph, or a form field | `page=2;para=5`; an AcroForm field is `page=1;field=customer.name` (a second field of the page with the same name is `taxid~2`) | the page's `/PageLabels` label (`iv`, `A-3`), a field's full name, headings the parser writes |
| the rest | a paragraph | `para=5`, or `page=2;para=5` where the parser writes pages | headings the parser writes |
| any title | the document title | `part=title` (the root record's content starts with it) | none |

The parser fixtures in `packages/parsers/test/fixtures/segments/` plant a value per format and assert the location
and labels of the segment that holds it.

Text that is outside every block still belongs to a segment: it is located at the element it is in, up to the next
block. Segments are trimmed of surrounding whitespace, and empty ones are dropped. They come in content order; of two
that start together, the longer comes first, so a row comes before its first cell.

### Overlap, and one segment per value

Row and cell segments overlap by design: a row is its cells, a pptx table's shape is its rows, an html `tr` is its
`td`s. A reader that takes the first segment holding a value gets the container (the row, with the sheet's name as its
only label), not the cell (which also has the column header). `leafSegments(record.segments)` drops every segment
whose characters, apart from whitespace, are all in the segments inside it, so a value is in exactly one segment: the
cell. A segment with text of its own (a list item with a nested list) stays. Segments are unchanged by it; it is a
function of the list, and the default output is the same with or without it. Over a generated set (290 documents of
13 formats, a known value planted in each place a detector would look) every planted value is in a segment; the table cells (xlsx, csv read as a table, tsv, docx,
pptx, html) are each in one leaf, labelled by their column header, at the location of the cell the generator put them in.

### A short csv is text

Tika reads a `.csv` as a table only when it is regular enough: at the default confidence a table with no quoted
cells needs eleven rows (`docs/migration.md`, *Text and CSV*). A shorter one is `text/plain`, and ripstream keeps that for
parity: its `content` is the lines as written, quotes and commas included. Its segments are still the cells
(`tikajs-e0sm`): a document detected as `text/csv` (in practice a `.csv` name) gets a segment
per non-blank cell, located `row=3;col=2` and labelled by the header cell of its column, as a table would, and no `line=`
segments. The segments are all that changes: `content` and the metadata are the same with segments on or off.

- The delimiter is the most confident of the sniffer's (comma, tab, semicolon, pipe), or a comma when none has any
  confidence, so `a;b` rows are read by their semicolons. A document that is only `text/plain` (no csv name) is not declared to be a table, so it keeps its `line=` segments, however csv-like.
- Rows are counted as a table counts them: a blank line is not a row, and a quoted cell may hold line breaks and stays one cell,
  so the rows after it keep their numbers. The first row names the columns and has no labels itself.
- A segment is `content.slice(start, end)` like any other, so a quoted cell is its characters between the quotes and a doubled
  quote (`""`) stays doubled; the commas and quotes are in no segment, as a JSON document's punctuation is in none. Its label
  is the header with doubled quotes undoubled. A row has no segment of its own, since it could not be made of its cells.
- Cell locations count against the record's allowance for locations (below); a csv that would outgrow it gets `line=` segments
  and `tk:segments-degraded: cell`.
- A `.tsv` is `text/tab-separated-values`, which TextParser reads as lines of tab-separated cells and has had row and cell
  segments all along. `createRipstream({ csv: { delimiter: "," } })` (or a lower `csv.minConfidence`) still reads every
  document as a table, with tab-separated text.

### What labels there are not

Labels are names the document gives, so a format that names nothing has none. A log has no labels, and a pdf has only
what the parser writes as a heading, the page's label and a form field's name (the text a pdf writes as a row, such as `label  value`, is one paragraph
`page=1;para=4`: the label is in the segment's text, not in `labels`). An archive's entries are records of their own, each with
its own segments and `embeddedResourcePath`; the archive's record holds the entry names. A consumer that matches a
detector's context (a keyword near the value) sees the header only in `labels`, so a detector that looks at a segment's
text alone does not see the header of a csv, short or not.

## Location grammar

A location is `key=value` parts joined by `;`. The keys come in this order, each at most once:

```text
page, slide, sheet, part, shape, field, table, row, col, cell, para, line, ptr, selector
```

Values escape `%`, `;`, `=`, CR and LF as `%25`, `%3B`, `%3D`, `%0D`, `%0A`. A sheet named `Q1;Q2` gives
`sheet=Q1%3BQ2;cell=A1`. `parseSegmentLocation(location)` returns the parts as a `Map` with the values decoded, and
throws a RangeError for anything outside the grammar. `SEGMENT_LOCATION_KEYS` lists the keys.

Counters start at 1. `para` and `table` count the blocks and tables as written, through the whole document, and restart
at each page, slide and sheet. A docx `para` is Word's own count instead: empty paragraphs and the paragraphs in table cells count
(a table is not one), through the body and then the headers, footers, notes and comments, so the number holds when a consumer
maps a segment back to the document (the parser says it through `SegmentHints.para`).
`(embeddedResourcePath, location)` names one segment of a parse. The round-trip test holds every fixture to that.

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
| `delimited(delimiter)` | CsvParser, for a document declared `text/csv` that it reads as text: the lines are rows of cells |
| `layout("table")` | CsvParser's table: the document is one table, so no `table=` |
| `row(n)` | the sheet's own row number: OOXML spreadsheet `<row r>`; xls the row's index; xlsb the row header's number; ods the count of rows before it, with `number-rows-repeated` |
| `col(n)` | the sheet's own column number of the next cell, when it is not the one after the last: xlsb (empty cells are not written), ods (`number-columns-repeated` and covered cells) |
| `heading(level, title?)` | OOXML word heading styles (`Title` is level 1 and `Subtitle` level 2, as Tika writes them `<h1>` and `<h2>`; `Heading1`-`Heading6`, or a style whose `word/styles.xml` name is `heading N`, whatever its localized id; the same styles `handlerType: "html"` writes as `<h1>`-`<h6>`), markdown `#` and setext (`title` is the text without the underline) |
| `line(n)` | markdown: a block's source line |
| `shape(name, title)` | OOXML presentation: `cNvPr@name`, title placeholders |
| `pageLabel(label)` | PDF: the next page's `/PageLabels` label, an additive first label of its segments (the location still counts pages from 1) |
| `field(name)` | PDF: the text written until `field(undefined)` is an AcroForm field's: one segment `field=<name>`, labelled with the field's full name |

## The allowance for locations (`tikajs-yub3`)

A JSON pointer holds every key above its scalar, and a selector every ancestor of its block, so a document can make
locations far larger than its text: one 30,000-character key above 34,000 scalars is 98 KB of input and a gigabyte of
pointers, whatever `maxOutputChars` is. Each record therefore has an allowance of characters for locations and labels:
24 Mi plus eight a character of `maxOutputChars` (a spreadsheet's `sheet=...;cell=C7` needs about five), at most 256 Mi,
checked before a pointer or a selector is built (a label slot counts as 8).

A record that would go over keeps its text and its segments, but coarser, and says so on its metadata:

| `tk:segments-degraded` | what the record's segments are |
| --- | --- |
| `ptr` | a JSON document gets one segment per line (`line=N`), as text does, instead of one per scalar |
| `selector` | an HTML block after the allowance is spent is located by `para=N`, with no `selector=` |
| `cell` | a csv read as text gets one segment per line (`line=N`) instead of one per cell |

All values can be present. The record is not failed, and `content` is the same. Under isolation the allowance is
checked in the child as well, so it comes first for a document whose locations are large; what the isolation's own
allowance for segment frames (24 MiB + 0.75 bytes a character, docs/isolation.md) then refuses is the text, labels and
encoding of a document with very many segments, and that is still a `LimitExceededError`.

## Not done

- A PDF's page label is read only when segments are on, and a label longer than 64 characters is cut. A field of a form that the parser
  does not write as text (`extractAnnotationText` off) has no segment.
- A table's column headers are its first row, even when that row is a title spanning the sheet.
- A spreadsheet's `sheet=` (or a slide's title) is repeated in every location it holds; a very long name is not counted against
  the allowance above, as a pointer is. Only xlsx sheet names, which Excel limits to 31 characters, were considered.
- Selectors are over Tika's XHTML, which drops some of the page's elements, so `nth-of-type` can differ from the page.
- No XPath for XML, no JSON Lines `ptr` without the `line`.
