# ripstream vs xberg vs Apache Tika: xberg's benchmark methodology

Measured 2026-11-14 for bead `tikajs-12zz`. Ripstream at commit `95d44dd` (committed sources only), xberg 1.4.0
(the `xberg-cli-aarch64-unknown-linux-musl` release), Apache Tika 4.2.0, all in one Linux container. The fixtures and
ground truth are xberg's own (`tools/benchmark-harness/fixtures` at xberg `df13c1f`, corpus `xberg-io/test_documents`
at `8760ed6`).

The harness behind xberg's published benchmark is ported to TypeScript under `scripts/bench/`. It keeps the parts that
decide the numbers: a fresh process per file, warmup and iteration counts, timeouts, failure classification, R-7
percentiles and the TF1 quality score. It runs ripstream next to the two tools on the fixtures that every tool can
handle without OCR, layout or ML models.

## Where ripstream sits

Run of 2026-11-14 22:40 to 23:21 UTC: 387 fixtures, 5 per-file lanes, 3 batch lanes, about 42 minutes. 373 fixtures
were extracted by every lane; the tables cover exactly those, so each row is over the same files.

- **Run once per file (cold process)**, ripstream's CLI is about **3.7x faster than a fresh Tika JVM** (p50 257 ms vs
  961 ms) and about **12x slower than xberg's static binary** (22 ms). This is almost all process start-up (Node and
  ripstream's module graph against a JVM against a Rust binary), not parsing.
- **In a long-lived process (warm)**, ripstream is about **2.5x slower than warm Tika** (p50 4.6 ms vs 1.8 ms; p95
  34 ms vs 12 ms). The gap is widest on `data` (mostly JSON: 12.2 ms vs 2.4 ms). There is no warm xberg lane (see
  caveats).
- **Memory**: ripstream's CLI peaks at 132 MB (p50) against Tika's 231 MB (168 to 231 MB across three runs) and
  xberg's 52 MB. A warm ripstream
  process peaked at 355 MB over the whole run, warm Tika at 787 MB.
- **Batches** (one cold process per batch of 8 files): xberg 93.5 files/s, ripstream 21.2, Tika 3.7.
- **Quality (TF1)**: ripstream 0.903, Tika 0.915, xberg 0.913; at TF1 >= 0.95, 280, 295 and 192 fixtures.
  Ripstream's shortfall against Tika comes from two sources. One is HTML and email-body line breaks, which are fixed
  in the uncommitted working tree (see findings). The other is Markdown, where Tika, given no file name, returns
  the raw source. All selected fixtures, failures included: ripstream 377 of 387 ok, Tika 375, xberg 386.

### All common fixtures (373)

| Lane | p50 ms | p95 ms | MB/s p50 | RSS p50 MB | RSS max MB | TF1 mean | TF1 >= 0.95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ripstream-cli (cold) | 257.4 | 330.5 | 0.008 | 132 | 188 | 0.903 | 280 |
| tika (cold) | 960.7 | 1127.2 | 0.002 | 231 | 303 | 0.915 | 295 |
| xberg (cold) | 21.9 | 47.4 | 0.099 | 52 | 109 | 0.913 | 192 |
| ripstream-inproc (warm) | 4.6 | 33.9 | 0.520 | - | - | 0.903 | 280 |
| tika-warm (warm) | 1.8 | 11.9 | 1.494 | - | - | 0.915 | 295 |

### By format group (same 373 fixtures)

| Group (fixtures) | Cold p50 ms, ripstream / Tika / xberg | Warm p50 ms, ripstream / Tika | RSS p50 MB, ripstream / Tika / xberg | TF1, ripstream / Tika / xberg |
| --- | --- | --- | --- | --- |
| text (125: md, txt) | 249.9 / 949.7 / 20.4 | 2.8 / 1.2 | 130 / 229 / 51 | 0.974 / 0.995 / 0.944 |
| markup (69: html, htm, xml, svg, rst, org, latex, bib) | 257.8 / 921.7 / 22.2 | 3.0 / 1.6 | 130 / 231 / 53 | 0.893 / 0.902 / 0.883 |
| data (138: json, csv, tsv, yaml, yml, toml, ipynb) | 261.4 / 980.7 / 23.3 | 12.2 / 2.4 | 140 / 234 / 51 | 0.942 / 0.942 / 0.900 |
| email (37: eml) | 265.5 / 1010.1 / 23.7 | 4.3 / 2.4 | 130 / 233 / 54 | 0.540 / 0.573 / 0.913 |
| office (4: WordPerfect only) | 254.4 / 820.9 / 23.8 | 7.9 / 3.3 | 141 / 220 / 51 | 0.870 / 0.871 / 0.967 |

p95 per group, MB/s, per-file-type rows and every failure are in the run's `summary.md`. The office row covers only
four files, because the Word, Excel, PowerPoint and OpenDocument binaries were not available (see skipped fixtures).
The `ebook`, `pdf` and `archive` groups have no fixture in this run.

### Start-up

| Lane | First extraction ms | Process start to ready ms | Process peak RSS MB |
| --- | ---: | ---: | ---: |
| ripstream-cli | 474 | | |
| tika | 1190 | | |
| xberg | 94 | | |
| ripstream-inproc | 18 | 600 | 355 |
| tika-warm | 164 | 1013 | 787 |

### Batch throughput (58 batches, 387 files, 17.85 MB)

| Lane | Wall ms (sum of batch medians) | Files/s | MB/s | RSS max MB | Files ok |
| --- | ---: | ---: | ---: | ---: | ---: |
| xberg-batch | 4138 | 93.5 | 4.313 | 117 | 386 |
| ripstream-batch | 18212 | 21.2 | 0.980 | 214 | 382 |
| tika-batch | 104282 | 3.7 | 0.171 | 372 | 380 |

The raw results are not in the repository (`results.json` is 1.7 MB). Re-running gives them (see below), or they are in
the session scratchpad of the run, if it still exists:
`/private/tmp/claude-501/-Users-spikedpunchvictim-projects-tikajs/d25af458-a0f9-4572-ad89-e79c09805e70/scratchpad/bench-out/full-utf8/`.
Three earlier runs sit next to it: `full` (before the Tika stdout fix), `full-default-limit` (ripstream's default
output limit) and `subset`.

## Where things live

| Path | What |
| --- | --- |
| `scripts/bench/run.ts` | The runner: fixture selection, the task queue, batches, results.json and summary.md |
| `scripts/bench/adapters.ts` | The lanes (`ripstream-cli`, `ripstream-inproc`, `tika`, `tika-warm`, `xberg`, and the `*-batch` lanes) |
| `scripts/bench/measure.ts` | Spawning with a start barrier, wall clock, process-group timeouts, peak RSS via GNU time, the line protocol of the warm lanes |
| `scripts/bench/inproc-worker.ts` | Ripstream in one long-lived Node process (warm lane and batch lane) |
| `scripts/bench/quality.ts` (+ `quality.test.ts`) | Port of xberg's TF1 (`src/quality/`), checked against its unit-test values |
| `scripts/bench/fixtures.ts` | Loads harness fixtures and cohorts, decides what is in the common cohort and why the rest is skipped |
| `scripts/bench/stats.ts`, `report.ts`, `render.ts` | Aggregation and summary.md (`render.ts` re-renders or merges results.json files) |
| `scripts/bench/fetch-corpus.ts` | Fetches the corpus binaries (office, PDF, ebook) from xberg's bucket, checking each sha256 |
| `scripts/bench/ripstream-config.json` | `writeLimit: -1` for ripstream, so it extracts as much as Tika and xberg do (see deviations) |
| `scripts/bench/docker/Dockerfile`, `run.sh` | The image every lane runs in, and the one command that builds and runs it |

Nothing is a workspace package, nothing is published, and no corpus document is in the repository: the harness and the
corpus are mounted read-only from wherever they are checked out.

## How to re-run

Needs Docker, a checkout of xberg (for `tools/benchmark-harness`), a clone of `xberg-io/test_documents`, and the
xberg CLI release unpacked:

```sh
gh release download v1.4.0 -R xberg-io/xberg -p 'xberg-cli-aarch64-unknown-linux-musl.tar.gz' -D <new empty dir>
tar -xzf <that dir>/xberg-cli-aarch64-unknown-linux-musl.tar.gz -C <another new dir>

XBERG_REPO=<xberg checkout> XBERG_CORPUS=<test_documents clone> \
XBERG_CLI=<another new dir>/xberg-cli-aarch64-unknown-linux-musl \
BENCH_OUT=<results dir> \
  scripts/bench/docker/run.sh                  # every common fixture, -i 3 -w 1 (about 45 minutes)

scripts/bench/docker/run.sh --cohort /xberg/cohorts/native-email-fast.json --cohort /xberg/cohorts/native-data-fast.json
scripts/bench/docker/run.sh --types eml,csv --limit-per-type 5 -i 1   # a quick subset
node scripts/bench/run.ts --help                                      # every option
```

`run.sh` builds `ripstream-bench:<short HEAD>` once from `git archive HEAD` (so uncommitted work in the checkout does
not leak into the numbers), then runs the container with no network. Results land in `BENCH_OUT` (default
`artifacts/bench-xberg/`, which is git-ignored): `results.json` (every iteration of every lane, the skipped fixtures
with reasons) and `summary.md`. Remove the image with `docker rmi ripstream-bench:<commit>` and the pnpm build cache
with `docker builder prune`.

The office, PDF, ebook and Outlook binaries are not in the `test_documents` git clone; they live in xberg's public bucket.
To include them:

```sh
node scripts/bench/fetch-corpus.ts --fixtures <xberg>/tools/benchmark-harness/fixtures --corpus <test_documents> \
  --out <new empty dir>            # 215 documents, 102.1 MB; --dry-run lists them
XBERG_CORPUS_BIN=<that dir> ... scripts/bench/docker/run.sh
```

## Method

Taken from `tools/benchmark-harness` (single-file mode); deviations are listed further down.

- **Fixtures.** Every harness fixture whose format is in the harness's Tika format list, that does not need OCR (the
  fixture's `requires_ocr`, defaulting to true for images), that has ground truth (`text_file`, else
  `markdown_file`) and whose document and ground truth are present. Split sidecars (`*.split.json`) are skipped as the
  harness skips them.
- **Lanes.**
  - `ripstream-cli`: `node packages/cli/bin/ripstream.js -c ripstream-config.json <file>`, text on stdout. A fresh
    process per file (cold_process).
  - `tika`: the harness's `TikaExtract` in `sync` mode, a fresh JVM per file (`-server -Xms512m -Xmx2g -XX:+UseG1GC`,
    plus `-Dstdout.encoding=UTF-8`, see deviations; `BodyContentHandler(-1)`, `AutoDetectParser`, no OCR).
  - `xberg`: `xberg extract --no-config-discovery --format json --content-format plain --config-json
    {"extraction_timeout_secs":1740,"use_cache":false} --pdf-backend native <file>`, as the harness's plaintext
    baseline.
  - `ripstream-inproc` and `tika-warm`: one long-lived process each (the worker, and `TikaExtract server`) fed one
    path per line (warm_in_process). Their numbers are steady-state and not comparable with the cold lanes.
  - `*-batch`: one fresh process per batch of 8 files of one type (cohort runs use the cohort's `batch_size`),
    cold end to end, no warmup: `xberg batch`, the ripstream worker in batch mode, `TikaExtract batch`.
- **Timing.** Per fixture and lane: 1 warmup, then 3 measured runs. Each process is spawned behind a stdin barrier
  and the clock starts when the barrier is released, so fork and exec of the measuring shell are not counted. Timeout
  1800 s (Tika 180 s), the process group is killed at the timeout; a warmup that times out leaves one measured run, a
  measured run that times out ends the fixture.
- **Success.** Every measured run succeeded, the output is not empty, and (ZeroOverlap) it shares at least one token
  with non-empty ground truth.
- **Aggregation.** p50 and p95 by R-7 over every measured run of the successful fixtures (p95 only from 20 runs),
  MB/s as file size over wall time (decimal MB), peak RSS per run, TF1 mean over successes and the count of fixtures at
  TF1 >= 0.95.
- **TF1.** Text and ground truth lower-cased after NFKC, Markdown links and images reduced to their text, URLs and
  zero-width characters dropped, split on white space, everything but letters, digits, `.` and `,` removed, CJK split
  into bigrams. F1 over the token multisets, the same over the numeric tokens (normalised as Rust parses f64), and
  `0.6 text + 0.4 numeric` when the ground truth has numbers (text F1 alone when it has none).

## Skipped fixtures

387 of the harness's 801 fixtures are in the run. The other 414:

| Reason | Fixtures | File types |
| --- | ---: | --- |
| Document not in the `test_documents` git clone: the binaries live in xberg's bucket, and downloading from it was not permitted in the session that made this run | 307 | pdf 179, docx 31, odt 21, rtf 18, xlsx 12, msg 9, epub 8, pptx 8, doc 6, ods 3, xls 3, one each of 7z, gz, ppsx, ppt, pptm, tar, xlsb, xlsm, zip |
| Needs OCR (ripstream has none; the harness treats images as OCR fixtures unless they say otherwise) | 46 | jpg 17, png 12, pdf 10, one each of bmp, gif, jp2, jpeg, tif, tiff, webp |
| Format not in the harness's Tika format list, so the harness never runs Tika on it and there is no three-way comparison | 59 | typ 8, fb2 7, docbook 6, opml 4, jsonl 2, one each of asciidoc, commonmark, dbf, dbk, djot, enw, hwp, hwpx, j2c, j2k, jats, jpm, jpx, key, markdown, mdx, mj2, nbib, numbers, nxml, odp, pages, pbm, pgm, pnm, ppm, ris, tgz |
| No ground truth in the fixture | 2 | pdf 2 |

No fixture was dropped because ripstream lacks the format: every locally present, non-OCR fixture in the Tika list
is a format ripstream parses. The consequence of the first row is that the run has no PDF, Word, Excel, PowerPoint,
OpenDocument, RTF, EPUB, Outlook or archive fixture. The `office` group is four WordPerfect files, and the `ebook`,
`pdf` and `archive` groups are empty. `fetch-corpus.ts` (above) brings in the 215 distinct documents behind the 307
fixtures.

## Fairness caveats

- **Cold lanes measure process start.** Most fixtures are a few KB, so the cold numbers are almost all start-up: a JVM
  plus Tika's service loading (about 0.9 s), Node plus ripstream's module graph (about 0.23 s), a static Rust binary
  (about 0.02 s). They say how each tool behaves when it is run once per file, not how fast it parses.
- **Warm lanes are a different regime.** `ripstream-inproc` and `tika-warm` keep one process and JIT-warm code, and
  their per-file RSS is not attributable (left blank, as the harness zeroes it); compare them with each other only.
  xberg has no warm lane here: the harness's steady-state xberg lane links the xberg crate into the Rust harness, and
  building it needs a Rust toolchain.
- **Tika gets no file name.** `TikaExtract` opens a `TikaInputStream` and detects by content only, as the harness
  does; ripstream and xberg get the path. This decides some fixtures by itself: Tika reads `.md` files as plain
  text and returns the Markdown source, while ripstream picks its Markdown parser by extension and returns the text
  without the markers (so ordered-list numbers, which the ground truth keeps, are gone).
- **The ground truth is not neutral.** It comes from `python_email`, pandoc and xberg's own exporters. For email it
  includes the Subject/From/To/Date header block, which xberg writes into the content and Tika and ripstream keep in
  metadata, so every Tika-style extractor scores about 0.55 on `eml`. Ripstream's opt-in `emailHeaders` writes that block into the
  text (`docs/migration.md`, "The email header block"); `node scripts/bench/run.ts ... --ripstream-email-headers` scores it in
  the worker lanes: 0.567 to 0.968 on the 37 common `eml` fixtures. The default stays Tika's output. For CSV, raw comma-separated output is one token
  per line (commas are kept inside tokens), which drives several CSV fixtures to zero overlap for Tika and ripstream.
  TF1 is best read as "how close to xberg's notion of plain text", and the ripstream-to-Tika gap as the parity signal.
- **xberg batch may use several cores.** `xberg batch` runs with a thread budget (8 here, per its own log line); the
  ripstream and Tika batch lanes parse one file after another.
- **One shared machine.** Docker Desktop's Linux VM on an Apple Silicon Mac (8 vCPUs, 8.3 GB), with other work on the
  host at the same time. Across three full runs, the cold-lane p50s moved by 4 to 9 % (ripstream CLI 236, 252,
  257 ms; Tika 939, 976, 961 ms; xberg 20.6, 22.0, 21.9 ms), and the warm medians, which are a few milliseconds, by
  up to 27 %. Tika's cold RSS p50 was 168, 177 and 231 MB with the same settings, against 125 to 132 MB for ripstream
  and 51 to 52 MB for xberg, so treat Tika's RSS as a range. The ratios between the tools held in every run.

## Deviations from the harness

- **Tika 4.2.0, not the harness's default 3.2.3**, from the `apache/tika:4.2.0` image's server jars (the version
  ripstream ports). `TikaExtract.java` is the harness's, with the three edits the 4.x API needs: `parse()` takes a
  `TikaInputStream` (`TikaInputStream.get(new FileInputStream(file))`), and `Metadata.CONTENT_TYPE` is the string
  `"Content-Type"`.
- **Peak RSS from GNU `time -f %M`** (the kernel's `ru_maxrss` of the measured process, which the start barrier
  `exec`s into), not the harness's 1 to 10 ms polling sampler. It cannot miss a short peak. xberg's self-reported
  `peak_memory_bytes` is used when larger, as the harness does.
- **Tika's stdout is UTF-8.** The image has no locale, so the JVM's `stdout.encoding` is ASCII, and `TikaExtract`
  prints non-ASCII characters into its JSON unescaped: every one of them became `?`. The first full run had this and
  under-scored Tika on Arabic, CJK and accented text; the JVM now gets `-Dstdout.encoding=UTF-8` (what a UTF-8 locale
  gives on any developer machine or CI runner), and the numbers here come from the run after the fix.
- **A Tika batch lane.** The harness refuses Tika in batch mode; `TikaExtract batch` exists, so it is run for
  comparison.
- **ripstream batch via the worker script**, since the ripstream CLI parses one file per process.
- **Output limit.** Ripstream stops at 100,000 output characters by default (documented in `docs/parsing.md`; Tika's
  `BodyContentHandler()` has the same default, but `TikaExtract` and tika-app use `-1`). The run passes
  `writeLimit: -1` so ripstream extracts the same amount of text. With ripstream's default, 21 of the 387 fixtures fail
  with `LimitExceededError` (18 `json`, 2 `html`, 1 `yaml`); that run is kept as `full-default-limit`.
- **Not ported:** the reading-order score, CER, markdown-structure quality and the PDF layout lanes (no fixture in the
  common cohort needs them), the harness's split between infrastructure and extraction failures, and its sampled
  CPU percentage.
- **Docker Desktop instead of a bare Linux host**, and xberg's Linux build running under the VM.

## Findings for ripstream

The ripstream-vs-Tika comparison flags 32 fixtures: their TF1 differs by 0.05 or more, or only one of the two
succeeded. Each was re-scored with the working tree as it stood after the run. That tree holds other agents'
uncommitted fixes, so its build is not `95d44dd`.

| What | Fixtures | At `95d44dd` | Working tree | Bead |
| --- | ---: | --- | --- | --- |
| HTML line breaks: `<br>` and block elements gave no newline, so words glued together (`First ParagraphSecond Paragraph`); `<title>` went into the body text; a `<figcaption>` holding a link was dropped | 6 html/htm | 0.06 to 0.11 below Tika | equal to Tika on all six | `tikajs-jtxx`, `tikajs-gz44` (closed, not yet committed) |
| The same line-break problem in the HTML bodies of emails | 9 eml | 0.09 to 0.18 below Tika | equal to Tika on all nine | as above |
| Text after `</html>` dropped (an mbox `From ` line after a single-part HTML mail) | 1 eml | 0.671 vs 0.832 | unchanged | `tikajs-ftl1` (new) |
| Markdown: Tika, given no file name, returns the source as plain text; ripstream picks its Markdown parser by extension and drops the markers, including ordered-list numbers that the ground truth keeps | 12 md | 0.05 to 0.42 below Tika | about the same (`markdown_technical` 0.943 to 0.990) | none: a harness effect (see caveats). Whether Tika's own Markdown parser keeps list numbers was not checked |
| UTF-16LE XML with a BOM whose declaration says `encoding="UTF-8"`: ripstream fails with `Malformed XML`, Tika returns the raw markup (TF1 0.024) | 1 xml | failed | failed | `tikajs-5tjh` (new) |
| Ripstream ahead: UTF-16 emails (BE and LE) and a Shift-JIS CSV, where Tika returns nothing | 3 | 0.615, 0.615, 0.071 | unchanged | - |

On those fixtures the working tree lifts ripstream's TF1 mean from 0.903 to about 0.907. Nearly all of the
remaining gap to Tika's 0.915 is the Markdown harness effect.

Other findings:

- **pdfjs-dist warnings on the CLI's stdout** (`tikajs-08ld`, new). Any document that reaches pdf.js prints
  `Warning: ...` lines into the extracted text, even with stderr discarded. In this run that is
  `email/mailgun_pdf_attachment.eml` (CLI TF1 0.059 against 0.157 in process), which is why the CLI's email TF1
  (0.537) is below the in-process lane's (0.540).
- **The 100,000-character default output limit** fails 21 of the 387 fixtures (18 JSON, 2 HTML, 1 YAML) with
  `LimitExceededError`, where Tika's CLI tools and the harness extract everything. It is a documented, deliberate
  default. A user who compares ripstream with tika-app on large text files will hit it first.
- **WordPerfect 4.2** (`tikajs-5ur3`, new, P4). Tika detects `wp42.wp` as `application/vnd.wordperfect; version=4.2`
  and returns empty content; ripstream fails it with `Not a WordPerfect document`. Neither extracts text, but xberg
  does. `wp_mac1.wpd` fails the same way in ripstream, while Tika, without a file name, calls it
  `application/octet-stream`.
- **Warm JSON latency.** Warm ripstream takes 9.4 ms (p50) on JSON files under 20 KB against Tika's 1.8 ms, and
  29 ms against 13 ms on files of 100 KB and more. The bench's one-warmup regime exaggerates this. On
  `csv-comma.csv.json` (61 KB) the bench measured 81 ms against Tika's 3.3 ms. In a tight loop (5 warmups, 20 runs)
  the same file takes 20 ms at `95d44dd` in the container, of which 11 ms is the same bytes read as `.txt`, and
  10 ms with the working tree. That is worth a profile once the tree is committed.
- **Shared failures**: four malformed-CSV fixtures (zero overlap, because the ground truth keeps commas inside tokens),
  `fake-encrypted.eml` (zero overlap) and `mime-no-body.eml` and `wp_mac3.wpd` (empty) fail for ripstream and Tika
  alike. xberg's only failure is `redp5110_sampled.doctags.txt` ("Nesting too deep: 1025").
