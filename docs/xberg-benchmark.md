# ripstream vs xberg vs Apache Tika: xberg's benchmark methodology

Two runs. The first, 2026-11-14 for bead `tikajs-12zz`, had no office, PDF, ebook or Outlook binaries; the second,
2026-11-16 (UTC) for bead `tikajs-0qqm`, has them. Both are below, the second first. The first run: ripstream at commit `95d44dd` (committed sources only), xberg 1.4.0
(the `xberg-cli-aarch64-unknown-linux-musl` release), Apache Tika 4.2.0, all in one Linux container. The fixtures and
ground truth are xberg's own (`tools/benchmark-harness/fixtures` at xberg `df13c1f`, corpus `xberg-io/test_documents`
at `8760ed6`).

The harness behind xberg's published benchmark is ported to TypeScript under `scripts/bench/`. It keeps the parts that
decide the numbers: a fresh process per file, warmup and iteration counts, timeouts, failure classification, R-7
percentiles and the TF1 quality score. It runs ripstream next to the two tools on the fixtures that every tool can
handle without OCR, layout or ML models.

## Where ripstream sits, with the corpus binaries (tikajs-0qqm)

Run of 2026-11-16 00:03 to 02:09 UTC (2 h 6 min), ripstream at commit `a4346f5` (committed sources only), the same xberg
1.4.0, Tika 4.2.0, harness and corpus as below, plus the 215 binaries fetched by `fetch-corpus.ts` (102.1 MB, every
object sha256-checked against `corpus.lock.json`, none mismatched). **5 measured runs and 1 warmup per fixture, so
every per-file figure is a median of 5**; the table percentiles are over all those runs. 602 fixtures were selected, 578
were extracted by every lane and the tables cover exactly those. Ripstream extracted 583 of 602, Tika 584, xberg 601.

- **Cold process (one process per file)**: ripstream's CLI is **4.1x faster than a fresh Tika JVM** (p50 254 ms vs
  1032 ms) and **9.3x slower than xberg** (27 ms). Per group the ratio to Tika is 3.1x (PDF, 334 vs 1043 ms) to 4.7x
  (email, 392 vs 1839 ms); mostly process start-up, as before.
- **Warm process**: ripstream and Tika are level, p50 3.7 ms vs 3.6 ms, p95 51.5 vs 48.5 ms. By group ripstream is faster
  on text, markup, email, ebook and archive, level on data (2.8 vs 2.7 ms), and slower on **PDF (30.0 vs 17.5 ms p50, 2.9 vs
  6.2 MB/s)** and office (8.6 vs 6.7 ms). The first run's 2.5x warm gap (4.6 vs 1.8 ms) is gone, on a different and
  larger fixture set: the data group went from 12.2 vs 2.4 ms to 2.8 vs 2.7 ms (the warm-JSON work of `tikajs-r8rv`, see
  the next section). No warm xberg lane.
- **Memory**: ripstream CLI p50 115 MB (max 307, an EPUB), Tika 235 MB (max 406), xberg 57 MB (max 119). PDF is the
  heaviest group: 143 / 292 / 66 MB. Warm processes: ripstream 455 MB, Tika 947 MB after the whole run.
- **Batches** (one cold process per batch of 8, 97 batches, 602 files, 120 MB): xberg 26.2 files/s, ripstream 14.8,
  Tika 2.8. On the 87 PDFs (55.7 MB) ripstream is ahead of xberg: 8.8 vs 5.7 files/s, 5.6 vs 3.6 MB/s (Tika 2.3 and
  1.5), because xberg's batch spends 15.4 s on them.
- **Quality (TF1, 578 common)**: ripstream **0.871**, Tika **0.872**, xberg **0.892**; at TF1 >= 0.95, 356, 365 and
  293 fixtures. Ripstream and Tika are level overall. xberg leads on email (0.883 vs 0.550/0.541, the header block, see
  caveats), ebook (0.901 vs 0.778/0.786) and archive (0.978 vs 0.484/0.513); ripstream and Tika lead on text (0.977/0.995
  vs 0.944) and data (0.942 vs 0.900).

| Group (fixtures) | Cold p50 ms, ripstream / Tika / xberg | Warm p50 ms, ripstream / Tika | RSS p50 MB, ripstream / Tika / xberg | TF1, ripstream / Tika / xberg |
| --- | --- | --- | --- | --- |
| text (125) | 220.2 / 959.7 / 23.1 | 1.2 / 1.4 | 113 / 235 / 56 | 0.977 / 0.995 / 0.944 |
| markup (69) | 237.1 / 996.3 / 25.1 | 1.4 / 1.8 | 114 / 233 / 58 | 0.901 / 0.902 / 0.883 |
| data (138) | 241.0 / 1063.8 / 25.3 | 2.8 / 2.7 | 114 / 235 / 56 | 0.942 / 0.942 / 0.900 |
| email (42: eml, msg) | 392.0 / 1839.1 / 39.9 | 4.8 / 8.9 | 113 / 226 / 59 | 0.550 / 0.541 / 0.883 |
| office (107) | 261.8 / 956.9 / 27.5 | 8.6 / 6.7 | 116 / 235 / 58 | 0.907 / 0.900 / 0.946 |
| ebook (6: epub) | 273.2 / 1063.1 / 25.7 | 8.3 / 31.8 | 117 / 236 / 59 | 0.778 / 0.786 / 0.901 |
| pdf (87) | 333.7 / 1043.0 / 70.9 | 30.0 / 17.5 | 143 / 292 / 66 | 0.717 / 0.708 / 0.744 |
| archive (4) | 357.8 / 1411.5 / 39.3 | 9.4 / 14.8 | 124 / 256 / 65 | 0.484 / 0.513 / 0.978 |
| **all (578)** | **254.0 / 1031.8 / 27.4** | **3.7 / 3.6** | **115 / 235 / 57** | **0.871 / 0.872 / 0.892** |

**What the new groups show.**

- **Failures only ripstream has** (benchmark-level, not minimised; beads filed): four Outlook `.msg` files with empty text
  where Tika returns some (`tikajs-8vzf`), `rtf/tables` rejected as "Not an RTF document" and `rtf/image` empty
  (`tikajs-3b5g`), `wpd_wp_mac1` rejected where Tika answers empty (`tikajs-mic4`). Both tools fail the two encrypted
  EPUBs (`OpenSans.TTF` is obfuscated), `odt/formula` and `eml/mime-no-body`; Tika alone fails `rtf/accent`, and ripstream
  alone parses the two UTF-16 `.eml` files that Tika answers empty.
- **Fixtures where ripstream and Tika differ by 0.05 TF1 or more: 57** (31 with ripstream behind, 26 ahead; the table is in
  the run's `summary.md`). The largest ripstream deficits are two PDFs (`pdfa_045` 0.155 vs 0.903, `pr-136-example` 0.424 vs
  0.955; `tikajs-4xj6`), ODT footnotes, endnotes, lists and a unicode file (-0.33 to -0.40; `tikajs-uay4`) and Markdown
  fixtures, which are the file-name effect described under the caveats (Tika is given no name and returns the source).
  Ripstream is ahead on ODT headers and metadata, RTF lists, several XLSX files (+0.15) and the PDF charts.
- **The csv zero-overlap failures** (`csv-comma-in-cell`, `csv-inconsistent-header`, `csv-too-few-columns`,
  `csv-too-many-columns`) hit ripstream and Tika alike: the ground truth is one token per cell, not a plain-text file.
- **PDF is where ripstream is weakest per file when warm** (30 ms vs 17.5 ms for Tika). It is also the largest group by
  bytes (55.7 MB of 120), so it dominates MB/s.

**Not in this run.** 92 PDF fixtures (the `reference` tier of xberg's corpus: arXiv papers via ReaDoc and ParseBench)
are license-restricted. xberg never publishes their bytes: they are materialised into `.corpus-cache/` from the
pinned upstream datasets, or restored from a private GCS bucket (`tools/benchmark-harness/CORPUS.md`). `corpus.lock.json`
has no entry for them, so they cannot be fetched or sha256-verified here. Everything else is in the run or accounted
for under "Skipped fixtures" (46 OCR fixtures are skipped on purpose). They were run separately, local only, in the next
section.

## Reference-tier PDFs (92), quality only, local only (tikajs-0qqm follow-up)

**License situation.** The 92 PDFs are third-party documents (58 arXiv papers from the READoc dataset, whose MIT tag cannot
license the bundled arXiv PDFs; 34 single pages from ParseBench, whose Apache-2.0 covers the annotations and not the
bundled PDFs). xberg's own `test_documents/LICENSES.md` classes them `reference`: not committed, fetched on demand, each
document keeps its upstream license. This run therefore used them for local, non-commercial benchmarking only. The PDFs and
their ground truth were materialised outside this repository, parsed only inside the network-less Docker container
(read-only mounts) and are not redistributed: not in git, not in a fixture, not in the Docker image, not in any artifact.
This section carries aggregate scores and fixture ids only.

**Provenance.** Run of 2026-11-16 03:06 to 03:10 UTC. ripstream at commit `027d7ad` (committed sources, built in the
image), Tika 4.2.0, xberg 1.4.0. Harness: xberg `df13c1f` (`tools/benchmark-harness`); `xberg-io/test_documents` at
`385ddd5` ("require Python 3.11", no corpus change against `8760ed6`). The reference cache was built with xberg's own
`build_corpus.py --stage normalize` and `--stage materialize` from READoc `lazyc/READoc@782bf954` (`arxiv.zip` 1.19 GB, the
58 papers extracted from it) and ParseBench `llamaindex/ParseBench@2805a1d9` (`table.jsonl` plus the 34 page PDFs), the
revisions the xberg manifest records. Download in all about 1.3 GB.

**Verification against the xberg manifest** (`ground_truth/corpus_manifest.json`): all 92 PDFs match `pdf_sha256`; the 58
READoc ground-truth Markdown files match `out_gt_md_sha256`; the 34 raw ParseBench annotations match `src_gt_sha256`.
Mismatches: the converted Markdown (and text) ground truth of **12 of the 34 ParseBench fixtures** differs from the
manifest hash, because the HTML-to-Markdown step uses xberg's Rust `html-to-markdown` CLI, which was not available, and
the PyPI `html-to-markdown` 3.22.2 was used instead (other 22 are identical). The ids: `pb_1948bb0c-...-page2`,
`pb_203924_...page11`, `page26`, `pb_AZ_LIC_Rate_Tables_2.0.v2_page47`, `page48`, `pb_DLR.2004.page_61.pdf_21918_page1`,
`pb_FBLB-134215544_page147`, `pb_SERFF_CA_random_pages_1_page{1414,2467,408,756}` and `pb_SERFF_TX_random_pages_1_page706`.
All three lanes are scored against the same files, so the comparison holds, but the absolute TF1 of those 12 may differ
slightly from xberg's published numbers.

**Run.** `scripts/bench/docker/run.sh --cohort <cohort of the 92 ids> -i 1 -w 0 --frameworks ripstream-cli,tika,xberg
--batch ""`, `XBERG_CORPUS` pointing at the `test_documents` clone that holds `.corpus-cache` (nothing under `scripts/bench`
was changed). Quality only: one iteration, no warmup, and **no timings are reported** because the host was loaded by other
agents' work. TF1 is scored as in the rest of this document (plaintext, 0.6 text + 0.4 numeric F1).

| Lane | Extracted | Failures / timeouts | TF1 mean | TF1 median | TF1 >= 0.95 | TF1 < 0.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ripstream-cli | 92 / 92 | 0 / 0 | 0.810 | 0.855 | 20 | 6 |
| tika | 92 / 92 | 0 / 0 | 0.822 | 0.857 | 19 | 5 |
| xberg | 92 / 92 | 0 / 0 | 0.827 | 0.873 | 21 | 4 |

| Source | Fixtures | ripstream TF1 mean (median) | Tika | xberg | At TF1 >= 0.95 (ripstream / Tika / xberg) |
| --- | ---: | --- | --- | --- | --- |
| READoc arXiv papers | 58 | 0.759 (0.794) | 0.776 (0.800) | 0.784 (0.797) | 0 / 0 / 1 |
| ParseBench table pages | 34 | 0.898 (0.959) | 0.901 (0.959) | 0.901 (0.959) | 20 / 19 / 20 |

Reading it:

- **Ripstream is 0.012 TF1 behind Tika and 0.017 behind xberg overall**, all of it on the arXiv papers (-0.017 against
  Tika, -0.025 against xberg). On the ParseBench pages the three tools are level (within 0.003). By fixture, ripstream is
  behind Tika on 50, ahead on 17 and level on the other 25, and behind xberg on 60.
- **No gap is larger than 0.1**: the worst ripstream-vs-Tika gap is -0.087. 52 of the 92 fixtures differ by less than
  0.01; 8 are 0.05 or more behind Tika and 1 is 0.05 or more ahead (`pb_1_timetable_1__page2`, +0.053).
- **Text F1 / numeric F1 means** over the 92: ripstream 0.856 / 0.742, Tika 0.870 / 0.750, xberg 0.874 / 0.758. Ripstream
  extracts about 1.39x the ground-truth token count, Tika 1.35x, xberg 1.33x: the arXiv ground truth is the author's LaTeX
  converted by pandoc (no tables, per xberg's `build_corpus.py`), so every tool is penalised for extracting text the
  ground truth lacks. TF1 on these is bounded well below 1 (no arXiv paper reaches 0.95 for ripstream or Tika).
- Four papers are below 0.5 for all three tools (`1304.6413`, `1602.03238`, `1904.07444`, `2211.13451`): the ground truth
  is far shorter than the paper (for `1602.03238` 2,387 ground-truth tokens against about 14,000 extracted).

The 15 largest ripstream deficits against Tika (TF1, ripstream / Tika / xberg):

| Fixture | Gap | ripstream | Tika | xberg |
| --- | ---: | ---: | ---: | ---: |
| `1401.4991` | -0.087 | 0.828 | 0.915 | 0.891 |
| `0910.1571` | -0.079 | 0.493 | 0.572 | 0.560 |
| `1904.07444` | -0.058 | 0.346 | 0.404 | 0.403 |
| `pb_fqr-retail-blackrock-global-allocation-fund-inc_page4` | -0.057 | 0.597 | 0.654 | 0.654 |
| `1304.6413` | -0.057 | 0.400 | 0.457 | 0.474 |
| `pb_1948bb0c-01f1-aa67-a1bd-4d54323f4f0d_page2` | -0.056 | 0.543 | 0.599 | 0.600 |
| `1409.7193` | -0.054 | 0.701 | 0.755 | 0.755 |
| `math0601436` | -0.052 | 0.439 | 0.491 | 0.508 |
| `2211.13451` | -0.048 | 0.274 | 0.322 | 0.322 |
| `1610.09400` | -0.047 | 0.676 | 0.723 | 0.741 |
| `2004.08365` | -0.042 | 0.721 | 0.763 | 0.763 |
| `2007.06510` | -0.041 | 0.665 | 0.706 | 0.729 |
| `2204.04480` | -0.041 | 0.749 | 0.789 | 0.794 |
| `2301.02744` | -0.040 | 0.577 | 0.617 | 0.623 |
| `1211.0443` | -0.040 | 0.642 | 0.682 | 0.716 |

Ripstream's best fixtures against Tika: `pb_1_timetable_1__page2` (+0.053), `1310.3692` (+0.025), `1501.05144` (+0.015),
`2103.17067` and `2312.15797` (+0.012).

**Weaknesses seen** (a token-multiset comparison of ripstream's and Tika's output for the largest gaps, run in the same
container; beads filed at P3, ids only, nothing fixed here):

- Math-heavy papers (`0910.1571`, `1904.07444`, `1304.6413`, `1409.7193`, `math0601436`, `2211.13451`, `1610.09400`,
  `2007.06510`, `1211.0443`): ripstream emits 1.2 to 1.4x Tika's token count, the surplus being single letters and digits
  (sub- and superscripts as tokens of their own). `tikajs-yt4g`.
- Table pages `pb_1948bb0c-01f1-aa67-a1bd-4d54323f4f0d_page2` and `pb_fqr-retail-blackrock-global-allocation-fund-inc_page4`:
  adjacent text in table cells is glued without a separator (fewer tokens than Tika, long concatenated words and digit
  strings). `tikajs-jmd0`.
- `1401.4991`, the largest gap: word fragments and extra digit tokens, a different pattern from the math papers.
  `tikajs-p5a4`.

Raw results (`results.json`, 176 KB, scores only) and the log are in the session scratchpad of the run, if it still
exists: `/private/tmp/claude-501/-Users-spikedpunchvictim-projects-tikajs/d25af458-a0f9-4572-ad89-e79c09805e70/scratchpad/xberg-ref/out/`.
The PDFs and ground truth sit in the same scratchpad under `xberg-ref/td/.corpus-cache/` and are never to be copied into
the repository.

To repeat it locally (the owner's machine, local use only): materialise the cache, pass `--cohort` with the 92 fixture
ids (fixtures whose `metadata.redistribute` is `reference`), and set `XBERG_CORPUS` to the `test_documents` clone that
holds `.corpus-cache`. `build_corpus.py` expects `/tmp/corpus_src` and `/tmp/parsebench` as staging directories and
the `html-to-markdown` CLI on `PATH`; keep the downloaded PDFs outside the repository and out of every image.

**Noise.** The host had a load average of 40 to 45 for the whole run (other agents' builds and tests), on an 8 vCPU VM.
The cold p50s sit close to the first run's (ripstream 254 ms against 236 to 257; Tika 1032 against 939 to 976 ms, 6 to
10 % slow; xberg 27 against 21 to 22 ms, 25 % slow), so the absolute numbers of this run are somewhat inflated by load and
the ratios are the signal. The warm numbers are a few milliseconds and moved by up to 27 % between earlier runs; a 1.04x
gap (3.7 vs 3.6 ms) is parity, not a win. First-extraction ("cold start") times in this run (ripstream CLI 1107 ms,
Tika 4086 ms, xberg 922 ms) are the load-inflated first call of the first fixture and say little.

Raw results: `results.json` (3.6 MB) and `summary.md` are in the session scratchpad of the run, if it still exists:
`/private/tmp/claude-501/-Users-spikedpunchvictim-projects-tikajs/d25af458-a0f9-4572-ad89-e79c09805e70/scratchpad/bench-out/corpus5/`.
The command was `scripts/bench/docker/run.sh -i 5 -w 1` with `XBERG_CORPUS_BIN` set.

## First run: text formats only (tikajs-12zz)

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

**With the corpus binaries (tikajs-0qqm)**: 602 of 801 are in the run and 199 are skipped. 92 are the license-restricted
`reference` PDFs (document not present under any corpus root), 46 need OCR (jpg 17, png 12, pdf 10, one each of bmp, gif,
jp2, jpeg, tif, tiff, webp), 59 are formats outside the harness's Tika list (as below) and 2 PDFs have no ground truth.
The 307 fixtures that the first run could not read are now 215 fetched documents plus the 92 above.

**First run (tikajs-12zz)**: 387 of the harness's 801 fixtures are in the run. The other 414:

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
  includes the Subject/From/To/Date header block, which xberg writes into the content and Tika keeps in metadata, so every
  Tika-style extractor scores about 0.55 on `eml`. Ripstream writes xberg's email content by default now (the header
  block, the body, an Attachments summary and the inlined attachment text; `docs/migration.md`, "The email header
  block"), so it is scored on that strategy rather than Tika's body-only output. For CSV, raw comma-separated output is one token
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
- **Warm JSON latency** (`tikajs-r8rv`, profiled 2026-11-15 at `1174a6f`). The 9.4 ms p50 on JSON under 20 KB (`95d44dd`) does not
  reproduce: at `1174a6f` the Docker bench lane read 2.8 ms (ripstream) against 3.4 ms (Tika) with the harness's one
  warmup, and with five warmups 1.58 ms against 1.59 ms under 20 KB, 3.8 against 2.4 ms from 20 to 100 KB and 17.5 against
  9.4 ms from 100 KB, over the 112 JSON fixtures (5 iterations each). What was left is a per-event cost that grows with
  size. CPU profile of a tight warm loop on the host (100 and 30 runs, 1 ms sampling, self time):

  | Where | Under 20 KB (64 files) | 100 KB and more (18 files) |
  | --- | ---: | ---: |
  | `magic.ts` (mime detection: `detect`, `evaluate`) | 44% | 4% |
  | `handlers/xhtml.ts` (`filterText`, `writeCharacters`, `startElement`) | 12% | 45% |
  | `text.ts` (`feed`, `emitSegment`: an await chain per line) | 12% | 17% |
  | `text-encoding.ts` (`isBinary`, `detectIso2022`) | 9% | 2% |
  | `handlers/text.ts` (the output handlers) | 5% | 7% |
  | garbage collector and runtime | 9% | 22% |

  Charset detection and the JSON path itself are not the cost: the same bytes read as `.txt` take the same time, and
  `detectEncoding` is 0.1 to 0.5 ms for these sizes. Mime detection runs all 917 magic rules against the prefix, and
  76 range rules compare at about 95,000 offsets per file. Three changes, all keeping the output byte for byte (fixtures
  and goldens green): a range rule tests its first byte inline before comparing the rest (detect 0.168 to 0.122 ms);
  `writeText` and `WriteOutContentHandler` wait only for a delegate that returns a promise (97 ns against 7 ns per
  event in a microbenchmark); `filterText` skips code point decoding for printable ASCII. Measured in one process
  alternating the committed code and the new code, five pairs per size class, 30 warmups and 40 rounds, p50 per call:
  under 20 KB 0.40 to 0.32 ms, 20 to 100 KB 1.89 to 1.44 ms, 100 KB and more 8.8 to 5.8 ms. The Docker bench lane could
  not confirm it: the machine was under heavy load from other work (load average 45 to 90) and the ripstream/Tika p50
  ratio moved by 0.3 to 0.4 between identical runs, so the Docker comparison is inconclusive. A native `indexOf` for
  the range scan was tried and was slower (0.168 to 0.26 ms); decoding the regex windows once per detection saved 3%
  and was dropped. The remaining gap on large files is the per-line XHTML events (a paragraph per line, as in Tika).
- **Shared failures**: four malformed-CSV fixtures (zero overlap, because the ground truth keeps commas inside tokens),
  `fake-encrypted.eml` (zero overlap) and `mime-no-body.eml` and `wp_mac3.wpd` (empty) fail for ripstream and Tika
  alike. xberg's only failure is `redp5110_sampled.doctags.txt` ("Nesting too deep: 1025").
