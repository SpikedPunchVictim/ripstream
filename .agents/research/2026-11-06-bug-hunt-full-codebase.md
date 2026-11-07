# Bug Hunt Report: Full Codebase (ripstream / Apache Tika TypeScript port)

**Date:** 2026-11-06
**Commit:** 34a2733 (`initial-port`); main at 31c81a7
**Scope:** All 141 non-generated source files across 15 packages. Candidates prioritized by consequence: input-handling parsers, the HTTP server, the core parse/limit/abort machinery, and the pipes engine.
**Lenses Applied:** All 9 (Assumptions, State Machine, Boundaries, Data Lifecycle, Error Paths, Time & Concurrency, Environment Divergence, Cross-Implementation Divergence, Write/Read Asymmetry).
**Runtime context:** All Node, live — the library is embedded in Node services, the CLI, and `packages/server`. The server **parses in-process** (`server/src/index.ts:343` calls `ripstream.parse`; `runIsolatedTask` in `core/src/worker-runner.ts` is **not** on any HTTP path), so a hang, OOM, or uncaught crash in any parser takes down the whole server process and every concurrent request with it. Excluded as generated/test: `mime/src/generated/`, all `test/`, all `dist/`.
**Files read in full:** 141 (core 38, parsers 28, parser-office 19, parser-archive 15, mime 9, parser-media 9, parser-pdf 6, language 5, pipes 4, parser-db 3, server 1, cli 1, parity 1, bundle-standard 1, test-corpus 1). Media/office/archive/parsers/db/pdf/mime were read in full by delegated agents; server/core/pipes/cli/parity by the main thread.

### How to read the confidence labels

- **main** — reproduced by running code on the **main thread this session** (command + output recorded in the finding).
- **agent** — reproduced only by a delegated subagent; agent output carries no user authority and is treated as a lead re-checked against source, not as proof.
- **Traced** — mechanism verified clause-by-clause against current source; no run.
- **no in-repo caller** — the flagged function is exported public API with no in-repo call site; reachable by an embedder, flagged as such.

### Safety note

Findings give **mechanism + `file:line` + fix only**. Byte-level construction recipes for crafted malicious inputs are deliberately omitted. Reproduction harnesses live in the session scratchpad and are **not** committed. One finding (#11, bplist) had its fix re-test (Step 6 check 8) **not run** because re-running the amplification locally is itself the hazard; it is marked throughout.

### Error contract (`core/src/errors.ts:128-151`, `httpStatusForError`)

| Error code | HTTP |
|---|---|
| not a `RipstreamError` | **500** |
| `UNSUPPORTED_FORMAT` | 415 |
| `ENCRYPTED_DOCUMENT` / `MALFORMED_DOCUMENT` / `LIMIT_EXCEEDED` | 422 |
| `WRITE_LIMIT_REACHED` / `EMPTY_DOCUMENT` | 200 |
| `PARSE_TIMEOUT` | 408 |
| `REQUEST_TOO_LARGE` | 413 |
| `MISSING_DEPENDENCY` / `RANDOM_ACCESS_UNAVAILABLE` / `PARSER_DECLINED` / `ABORTED` / `UNSUPPORTED_RUNTIME` | 500 |

**Two architecture facts that shape most findings:** (1) the server parses in-process, so any parser DoS is a whole-server DoS; (2) `maxParseMillis` (default 60 s, `parse-context.ts:51`, timer at `ripstream.ts:224-232`) and the server's `AbortSignal.timeout` (`index.ts:239`) are **macrotask timers** — they cannot preempt synchronous or microtask-only loops. Only `pdf.ts`, `dbf.ts`, and `html.ts` check the abort signal inside their loops.

---

## Guard Map

Guard locations consulted during verification and refutation (Step 2):

- **Error contract / mapping:** `core/src/errors.ts`, `core/src/ripstream.ts` (`withStream` :215; `parseToStream` abort mapping :98-106/:130), `core/src/signal-checkpoint.ts`, `core/src/parse-context.ts` (`throwIfAborted` :142-154).
- **Config defaults / limits:** `core/src/parse-context.ts` `DEFAULT_LIMITS` :44-56 (maxOutputChars 100k, maxEmbeddedResources 10k, maxEmbeddedResourceBytes 512 MiB, maxTotalEmbeddedBytes 1 GiB, maxDecompressionRatio 100, maxNodeDepth 100, maxParseMillis 60 s, maxMetadataValueChars 1 000 000, maxZipEntries 10k, maxXmlEntityExpansions 0); server defaults `server/src/index.ts:76-84` (maxBodyBytes 100 MiB, maxConcurrent 100, maxQueue 100, requestTimeoutMs 60 s, maxJobs 1000).
- **Output / memory budgets:** `core/src/handlers/limits.ts` (`OutputLimitContentHandler`), `core/src/embedded.ts` (charge* :32-63; `BodyContentHandler` buffering :138-150), `core/src/bounded-inflate.ts`, `core/src/metadata.ts` (`add` — value-length cap only), `core/src/metadata-utils.ts` (`parseXmpPacket` :128).
- **Validation / security:** `core/src/security.ts` (`compileSafeRegex` :42), `core/src/url-security.ts` (`safeFetch` :101 → `pinnedFetch` :113), `core/src/pinned-fetch.ts`.
- **Parser dispatch:** `core/src/parser.ts` (`CompositeParser` :112-128, `matchRank` :261), `mime/src/detector.ts` (container→magic→XML→filename→text), `mime/src/containers/*`.
- **Archive safety:** `parser-archive/src/util.ts` (`safeEntryName`, `readAll` :63-81, `parseEntry` :92-104), `zip.ts`, `tar.ts`, `compressor.ts`, `bounded-inflate.ts`.
- **Office safety:** `parser-office/src/bounded-unzip.ts`, `xml-tree.ts` (depth 256 :35), `cfb.ts` (cycle guards).
- **Sibling implementations:** `parser-archive/src/{zip,tar,gzip,compressor}.ts` (error-wrapping siblings of `tar.ts`); `mime/src/containers/{zip,ole2}.ts` (throwing vs non-throwing sniffers); `core/src/recursive.ts` vs `parser-archive/src/util.ts` vs `parsers/src/mail.ts` (embedded-error contract).
- **Tests:** `core/test/adversarial.test.ts`, `truncation.test.ts`, `safety.test.ts`, `parser-archive/test/compressor-limits.test.ts`, `parsers/test/tnef.test.ts` (encodes the non-spec TNEF layout), `pipes/test/pipes.test.ts`.

---

## Summary

| Status | Count |
|--------|-------|
| Bugs Found | 56 |
| Fragile Code | 13 |
| OK (Already Guarded) | 34 |
| Needs Review | 36 |
| Killed in Refutation | 16 |

---

## Issue Rating Table

All BUG and FRAGILE findings, sorted by Urgency then ROI. Blast Radius uses the three-axis notation (code files + data/migration + coordination).

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---------|------|-----------|---------|-----------|--------------|-----|--------------|------------|
| 1 | `server/src/index.ts:124` — semaphore double-counts the handed-off slot; server wedges | State Machine | main | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 2 | `server/src/index.ts:152` — authenticate throw bypasses auth / crashes, echoes internals | Error Paths | main | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 3 | `parser-media/src/image.ts:72` — HEIC box-walk infinite microtask loop, 64 B total-server hang | Assumptions | main | 🔴 Critical | 🟡 | 🔴 Critical | 🟢 Good | 1 file + lib pin | Small |
| 4 | `parser-db/src/openpgp.ts:58` — unbounded packet array → host OOM crash | Boundary | main | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 5 | `parser-office/src/excel-binary.ts:180` — O(N²) BOUNDSHEET scan, uninterruptible hang | Time | main | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Small |
| 6 | `parser-db/src/index.ts:79` — generated columns materialized in WASM, event-loop freeze + RSS | Assumptions | main | 🔴 Critical | 🟡 | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 7 | `parsers/src/icc.ts:76` — quadratic `.replace(/\0+$/)` on NUL run, ~8 min/MB stall | Cross-Impl | agent | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 8 | `parsers/src/mail.ts:89` — uncapped multipart boundary, O(n·m) scan stall | Boundary | agent | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 9 | `parsers/src/tnef.ts:114` — HTML-strip non-memoised close-tag rescan, O(n²) stall | Time | agent | 🔴 Critical | ⚪ | 🔴 Critical | 🟢 Good | 1 file | Small |
| 10 | `parsers/src/asn1.ts:64` — lazy PEM regex scans to EOF per BEGIN, O(n²) stall | Time | agent | 🔴 Critical | ⚪ | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 11 | `parser-archive/src/plist.ts:39` — bplist ref-expansion → uncatchable OOM from <1 KB | Data Lifecycle | main + agent | 🔴 Critical | 🟡 | 🔴 Critical | 🟢 Good | design | requires design work |
| 12 | `parser-media/src/image.ts:77` — exifr XMP quadratic regex, O(n²) stall | Time | main | 🔴 Critical | 🟡 | 🔴 Critical | 🟢 Good | design | requires design work |
| 13 | `core/src/parse-context.ts:142` — timeout abort reported as 500, not 408 | Error Paths | main | 🟡 High | 🟡 | 🟡 High | 🟠 Excellent | 3 files | Small |
| 14 | `core/src/ripstream.ts:215` — swallowed abort reported as success (parse "completes" after timeout) | Error Paths | main | 🟡 High | 🟡 | 🔴 Critical | 🟠 Excellent | 3 files | Small |
| 15 | `server/src/index.ts:339` — `/rmeta` & `/unpack` ignore the limits ceiling | Data Lifecycle | main | 🟡 High | ⚪ | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 16 | `server/src/index.ts:361` — no slowloris protection; a slow upload holds a slot | Time | main | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 1 file | Small |
| 17 | `pipes/src/pool.ts:54` — semaphore double-counts handed-off slot (same bug as #1) | State Machine | main (no in-repo caller) | 🟡 High | ⚪ | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 18 | `pipes/src/adapters.ts:71` — concurrent `appendFile` interleaves JSONL lines | Time | main | 🟡 High | ⚪ | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 19 | `parser-office/src/legacy.ts:64` — `push(...spread)` stack overflow → 500 | Boundary | agent | 🟡 High | ⚪ | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 20 | `mime/src/containers/zip.ts:83` + `iwork13.ts` — iWork'13 type never routed; + spread overflow | Cross-Impl | main | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 3 files | Small + design |
| 21 | Raw library errors → 500 cluster (tar, parquet, audio, feeds, dicom, icc, rtf, translate) | Error Paths | main + agent | 🟡 High | 🟡 | 🟡 High | 🟢 Good | ~9 files | requires design work |
| 22 | `core/src/embedded.ts:141` + `text.ts:75` — embedded/line text buffered whole; memory unbounded | Data Lifecycle | main | 🟡 High | 🔴 | 🔴 Critical | 🟡 Marginal | design | requires design work |
| 23 | `parsers/src/csv.ts:134` — newline-free row buffered whole, ~9 B/input B, OOM | Boundary | agent | 🟡 High | 🔴 | 🔴 Critical | 🟡 Marginal | design | requires design work |
| 24 | `parsers/src/mail.ts:158` — embedded catch swallows LimitExceeded/ParseTimeout → 200 | Error Paths | agent | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 1 file | Small |
| 25 | `parser-office/src/ooxml.ts:626` — embedded-part `catch {}` swallows LimitExceeded → 200 | Error Paths | main | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 1 file | Small |
| 26 | `pipes/src/index.ts:120` — ordered delivery can invert/reorder across concurrency | Time | main | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 1 file | Small |
| 27 | `pipes/src/index.ts:142` — **UNPACK + ordered drops all embedded records** | Data Lifecycle | main | 🟡 High | 🟡 | 🔴 Critical | 🟢 Good | 1 file | requires design work |
| 28 | `pipes/src/index.ts:176` — one worker throw abandons in-flight siblings (zombie emits) | Error Paths | main | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 1 file | Small |
| 29 | `parser-pdf/src/pdf.ts:137` — whole input spooled to disk before size cap (library/CLI) | Boundary | agent | 🟡 High | ⚪ | 🟡 High | 🟢 Good | 1 file | Small |
| 30 | `language/src/translate.ts:98` — race timeout never aborts fetch; sockets leak, 4xx retried | Time | agent | 🟡 High | 🟡 | 🟡 High | 🟢 Good | 1 file | Small |
| 31 | `parsers/src/xml.ts:105` — ParseTimeout/Limit rewrapped as MalformedDocument (422/code) | Error Paths | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟠 Excellent | 1 file | Trivial |
| 32 | `pipes/src/index.ts:308` — two distinct ids collide to one `.txt`, silent overwrite | Write/Read | main | 🟢 Medium | 🟡 | 🟢 Medium | 🟢 Good | 1 file | Small |
| 33 | `pipes/src/resilience.ts:59` — non-atomic checkpoint `writeFile`; torn file reads empty | Data Lifecycle | main | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 34 | `core/src/ripstream-input-stream.ts:85` — `readFully` truncates instead of enforcing cap | Boundary | main (no in-repo caller) | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 35 | `mime/src/containers/ole2.ts:25` — sniffer throws during detect(); defeats fallbacks | Error Paths | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 36 | `parser-archive/src/cpio-ar.ts:85` — negative `ar` size → non-monotonic, ~10⁴× rescan | Boundary | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 37 | `core/src/pinned-fetch.ts:78` — upstream status outside 200–599 → RangeError 500 | Boundary | main | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 38 | `parser-db/src/x509.ts:25` — detector emits `x-x509-cert`; parser never matches → 415 | Cross-Impl | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 39 | `parser-media/src/audio.ts:20` — detector emits canonical types; WAV/FLAC → 415 | Cross-Impl | main | 🟢 Medium | ⚪ | 🟢 Medium | 🟠 Excellent | 1 file | Trivial |
| 40 | `parsers/src/web.ts:42` — WARC loop breaks after first record | Write/Read | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 41 | `parser-db/src/openpgp.ts:94` — armor header lines break base64 decode → 422 | Boundary | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 42 | `parser-media/src/image.ts:382` — WebP VP8 lossy reads wrong dimension offset | Boundary | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 43 | `parser-media/src/av-container.ts:26` — AVI never descends into LIST; valid AVI → 422 | Assumptions | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 44 | `parser-media/src/av-container.ts:137` — Matroska width/height unreachable; many → 422 | Assumptions | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 45 | `parser-media/src/av-container.ts:102` — ASF double-counts 24 B header; order-dependent 422 | Boundary | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 46 | `parser-media/src/wmf.ts:55` — only placeable WMF accepted; standard WMF → 422 | Assumptions | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 47 | `parsers/src/mbox.ts:44` — whole mbox decoded UTF-8; 8-bit bytes corrupted | Write/Read | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 48 | `parsers/src/tnef.ts:12` — spec-format TNEF produces empty output | Write/Read | agent | 🟢 Medium | 🟡 | 🟢 Medium | 🟡 Marginal | 1 file + tests | Medium |
| 49 | `parsers/src/rtf.ts:201` — each `\'xx` decoded alone; double-byte code pages lost | Boundary | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 50 | `parsers/src/web.ts:174` — XLIFF/TMX always decoded UTF-8, ignores XML declaration | Cross-Impl | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 51 | `parsers/src/dicom.ts:94` — undefined-length SQ breaks the whole tag walk | Boundary | agent | 🟢 Medium | ⚪ | 🟢 Medium | 🟢 Good | 1 file | Small |
| 52 | `parser-archive/src/plist.ts:42` — LimitExceeded masked as MalformedDocument | Error Paths | agent | ⚪ Low | ⚪ | ⚪ Low | 🟢 Good | 1 file | Trivial |
| 53 | `parser-media/src/font.ts:149` — dead AFM validity check; garbage → 200, empty | Error Paths | main | ⚪ Low | ⚪ | ⚪ Low | 🟢 Good | 1 file | Trivial |
| 54 | `cli/src/main.ts:147` — every runtime error exits 1 (no 2/3/4 distinction) | Error Paths | main | ⚪ Low | ⚪ | ⚪ Low | 🟢 Good | 1 file | Small |
| 55 | `cli/src/main.ts:191` — `--port abc` → NaN → raw `validatePort` crash | Boundary | main | ⚪ Low | ⚪ | ⚪ Low | 🟢 Good | 1 file | Trivial |
| 56 | `cli/src/main.ts:129` — `-o jsonl` silently emits plain text (unimplemented) | Assumptions | main | ⚪ Low | ⚪ | ⚪ Low | 🟢 Good | 1 file | Small |

---

## Fix Plan & Interactions

The section to read before acting on anything above.

**Ships-with sets** (never split across phases):
- **#13 + #14** (C3 + C11) — #14's "post-check that the parse didn't swallow the abort" depends on #13's timeout→`ParseTimeoutError` mapping existing first. Together they make every timeout path return 408 instead of 500/200.
- **#13 + #14 + #15** (C3 + C11 + C10) — the `/rmeta`+`/unpack` limit fix (#15) is independent code but shares the timeout behavior; verify them together so the recursive paths honor both the ceiling and the timeout.
- **#1 + #17** (C1 + C5) — identical slot-double-count defect in two semaphores (`server` and `pipes/pool`); fix and verify as one change.
- **#4 + metadata-count cap + #17-media** (M4 + M17) — bounding the OpenPGP packet array (#4) does not bound `Metadata.add` count; the JPEG-COM amplification (Review) hits the same uncapped `Metadata.add`. Add the packet cap and a metadata multi-value cap together or the OOM re-opens via COM segments.
- **#20 type fix + iWork spread fix** (C16 + O3) — adding `application/vnd.apple.iwork` to `iwork13.ts` TYPES makes the parser reachable, which immediately exposes the `push(...spread)` overflow at `iwork13.ts:65`. The type fix is a BUG; shipping it *without* the spread fix converts a 415 into a 500. They ship together.
- **#18 + stats append** (`adapters.ts:71` and the stats `appendFile` at `:116`) — same interleave defect in two methods; serialize both through one promise chain.
- **#16 slowloris + health-endpoint exemption** — adding `requestTimeout`/`connectionsCheckingInterval` is the fix; exempting `/version` and `/status` from the semaphore is the same change's companion (unverified — see finding).

**Ordering constraints:**
- #13 ships with or before #14 (mapping must exist first).
- #2 is the most urgent single fix: the `/pipes` route *requires* an `authenticate` hook (`index.ts:88`), so a throwing authenticator is a reachable auth-bypass/crash on a route that is always behind auth.
- Decide #21's shape (central mapper vs per-parser wrap vs both) **before** touching the individual parsers in Phase 3/4, or the per-parser fixes will be redone.
- #39 (register canonical audio types) is independent of, and simpler than, the alias-aware `matchRank` that #38/#39 both ultimately want; ship the type registration now, defer alias resolution to design.

**Shared migrations:** none — no persistent store schema in this repo. **#32** (FileSystemEmitter naming) is an **output-contract change** (file names on disk change), not a DB migration, but downstream consumers keyed on the old names must be told.

**Deferred to design work (failed a Step 6 check):**
- **#11** (bplist OOM) — check 1/5: an uncatchable OOM cannot be fixed in-process; the durable fix is worker isolation (`runIsolatedTask`) or replacing `bplist-parser`. Check 8 (empirical re-test of fix) **not run** by design.
- **#12** (exifr XMP) and **#3** (exifr HEIC) — check 1: the quadratic/loop is inside the `exifr` dependency; the in-repo guard (#3) mirrors exifr internals and must be pinned to a known version, so worker isolation is the real fix.
- **#21** (raw-error cluster) — check 6: central vs per-parser is a cross-cutting design choice; recommended: **both** (a `wrapParserErrors` boundary in `CompositeParser` as backstop + `TranslationError extends RipstreamError`).
- **#22**, **#23** (whole-buffer text/CSV) — check 1/5: bounding requires a streaming output-charge redesign of `BodyContentHandler`/`OutputLimitContentHandler`; a naive cap changes truncation semantics.
- **#27** (UNPACK+ordered) — check 7: the ordered-delivery protocol assumes one emitted document per source index; emitting N records per index needs a protocol change, not a one-liner.

**Suggested phases:**
1. **Cheap verified server/core fixes:** #1, #17, #2, #16, #13+#14+#15, #18. (All Trivial/Small, all `main`-verified.)
2. **Cheap verified parser fixes:** #3, #4, #5, #6, #19, #20(+O3), #34, #39. (Caps and type registrations.)
3. **Agent-verified parser caps & status fixes (re-verify on main first):** #7, #8, #9, #10, #24, #25, #31, #35, #36, #52.
4. **Error-contract design then rollout:** decide #21 shape, then #30, #37, and the per-parser raw-error wraps.
5. **Isolation & memory design:** #11, #12, #22, #23, metadata cap; pipes delivery redesign (#26, #27, #28, #32, #33).
6. **Fidelity backlog:** #38, #40–#51, #53–#56.

---

## Detailed Findings

### 1. `server/src/index.ts:124` — concurrency semaphore double-counts the handed-off slot
**Lens:** State Machine
**Confidence:** main — Before fix, at `maxConcurrent=1`: a burst of 3 returned `[200,200,200]` but then an idle `/status` returned `Request timed out waiting for a worker` and a lone request returned `408` after ~1004 ms. After removing the extra `active++`: idle `/status` → `{"status":"ok","active":1}`, lone request → `200` in 155 ms; same at `maxConcurrent=2`.
**Assumption:** the waiter-resume path and the fast path each acquire exactly one slot.
**Violation scenario:** when a queued waiter is resumed, `start()` runs `active++` *and* the earlier `acquire`'s accounting treats the slot as already charged — the handoff transfers the slot, so incrementing again permanently over-counts `active`. After a burst that fills the queue, `active` never returns to 0 and the server rejects everything with 408/queue-full.
**Consequence:** permanent wedge after any burst that touches the queue — a trivially reachable DoS.

**Current code:**
```ts
const start = (): void => {
  clearTimeout(timer);
  active++;            // <-- double count: the slot was already held by the releaser's handoff
  resolve(release);
};
```
**Verified fix** (passed all 8 checks):
```ts
const start = (): void => {
  clearTimeout(timer);
  // The releasing request hands its slot directly to this waiter; do not re-acquire.
  resolve(release);
};
```
**Fix notes:** mirror-path — `release()` already decrements only when there is no waiter (`:104-106`), so the handoff is complete without the increment. Optionally make `release` idempotent to defend against a double-release. Caller contract unchanged (still resolves with a `release` fn). Interaction: identical defect at #17 (`pipes/pool.ts:54`) — fix both.

### 2. `server/src/index.ts:152` — authenticator exceptions bypass auth and crash the request
**Lens:** Error Paths
**Confidence:** main — Before: a throwing authenticator (`jwt malformed`) crashed with process exit 1 and the error text surfaced from `server/dist/index.js:132`. After wrapping and failing closed: `Bearer bad -> 401 Unauthorized`, `Bearer nope -> 401 Unauthorized`, process exit 0.
**Assumption:** `options.authenticate(request)` resolves to a boolean and never throws.
**Violation scenario:** the `authenticate` call sits **outside** the `try` (`:152`), so a hook that throws (malformed JWT, network blip to an auth service, bug) escapes before the slot is even acquired. The outer handler maps it to 500 and echoes `error.message`. Because the `/pipes` route *requires* an authenticate hook (`:88`), this is a reachable path on an always-authenticated route.
**Consequence:** auth infrastructure errors become 500s that leak authenticator internals; depending on framing a throw can also skip the `!authorized` branch. Fail-open risk + information disclosure.

**Current code:**
```ts
if (options.authenticate !== undefined && !(await options.authenticate(request))) {
  send(response, 401, "text/plain", "Unauthorized");
  return;
}
```
**Verified fix:**
```ts
let authorized: boolean;
try {
  authorized = options.authenticate === undefined || (await options.authenticate(request));
} catch {
  authorized = false; // fail closed; never echo authenticator internals
}
if (!authorized) {
  send(response, 401, "text/plain", "Unauthorized");
  return;
}
```
**Fix notes:** fails closed (check 5). An alternative that distinguishes "bad credential" (401) from "auth system down" (503) is reasonable but needs the hook to signal which — deferred. Caller contract unchanged. No data/migration.

### 3. `parser-media/src/image.ts:72` — HEIC box-walk infinite loop hangs the entire server from a tiny input
**Lens:** Assumptions
**Confidence:** main — one small PUT made `/version` probes time out at +302/+1305/+2306/+3308 ms and never return, even with `requestTimeoutMs=1000`; detected as `image/heic` by magic alone. After the structural pre-check: both the malformed and a real `real.heic` return in ~0 ms, and `real.heic` metadata is byte-identical before/after (`{"Content-Type":"image/heic","tiff:ImageWidth":"64","tiff:ImageLength":"48",...}`).
**Assumption:** `exifr.parse` always terminates on buffers it accepts.
**Violation scenario:** `exifr`'s HEIF box walker advances `nextBoxOffset += box.length`; a box declaring length 0 with no `meta` box never advances. The loop `await`s a microtask-resolved chunk read, so it spins as a microtask loop that never yields to the macrotask queue — `maxParseMillis` and `AbortSignal.timeout` can never fire. Node is single-threaded, so one such request freezes all concurrent requests and the health endpoint.
**Consequence:** permanent, unauthenticated, whole-server hang from a sub-100-byte upload.

**Current code:**
```ts
const exif = await exifr.parse(data, { tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: false });
```
**Fix: requires design work — checks 1 & 5.** The non-termination is inside `exifr`; the durable fix is worker isolation with a hard `terminate` (as `pdf.ts` does). As an in-process stopgap, a structural pre-walk that confirms the box chain terminates and reaches `meta` before calling exifr (verified above to preserve real-file output) — but it mirrors exifr's internals and therefore requires pinning `exifr` to the audited version:
```js
// Guard: confirm the HEIF/ISO-BMFF box chain terminates before handing data to exifr.
function heifBoxChainTerminates(data) {
  if (data.length < 8) return true; // too short for exifr's HEIF path; let it decline normally
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  for (let guard = 0; guard < 4096 && offset + 8 <= data.length; guard++) {
    let length = view.getUint32(offset);
    const kind = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
    if (length === 1) {              // 64-bit extended size
      if (offset + 16 > data.length) return true;
      length = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
    }
    if (kind === "meta") return true; // exifr's walk terminates here
    if (length < 8) return false;     // zero/sub-header length: exifr would spin
    offset += length;
  }
  return true;
}
```
**Fix notes:** empirical re-test confirmed real-file parity (check 8). Check 1 (fix arithmetic) exercised at length 0/1/<8/64-bit. **Pin `exifr` to the audited version** or the mirror can drift. Related: #12 (same library, quadratic XMP). Worker isolation subsumes both.

### 4. `parser-db/src/openpgp.ts:58` — unbounded packet array → host OOM crash
**Lens:** Boundary
**Confidence:** main — at `--max-old-space-size=1024`: a 4 MB input → 422 at 460 MB heap; 16 MB → `FATAL ERROR: JavaScript heap out of memory` (process abort). After the cap: 4/16/32 MB → 422 in 69/106/149 ms, heap ≤24 MB; a real armored key still parses.
**Assumption:** the packet stream is a bounded number of real packets.
**Violation scenario:** `readPackets` appends to `packets[]` with no count bound, and each packet emits one `metadata.add` + one XHTML line. A stream of minimal repeated packets amplifies ~70× into heap before the output limit is consulted.
**Consequence:** OOM crash of the host process; the 100 MiB body cap leaves a wide margin above the crash threshold.

**Current code:**
```ts
const packets = readPackets(body);   // unbounded
```
**Verified fix:** inside the packet loop, before `packets.push`:
```ts
if (packets.length >= 10_000) {
  throw new LimitExceededError("OpenPGP packet count exceeds 10000");
}
```
**Fix notes:** 422 LIMIT_EXCEEDED (check 5, loud). Caveat: a very large legitimate keyring (many subkeys/signatures) could exceed 10 000 and be rejected; an alternative is to truncate at the cap and set a `truncated` flag rather than throw. **Ships with a `Metadata.add` multi-value cap** — otherwise the same OOM re-opens via JPEG COM segments (Review item M17) which also call uncapped `Metadata.add`.

### 5. `parser-office/src/excel-binary.ts:180` — O(N²) BOUNDSHEET scan, uninterruptible hang
**Lens:** Time
**Confidence:** main — original vs fixed (same hand-built CFB): vector A 10k records 374→20 ms, 40k 2863→38 ms; vector B 40k 4995→134 ms (both 422). Agent measured 80k → 11 512 ms, extrapolating to ~2 h at the 2 000 000-record cap. Office suite 59/59 before and after.
**Assumption:** each BOUNDSHEET's stored offset corresponds to a real record position, so `findIndex(r => r.offset >= bound.offset)` finds it quickly.
**Violation scenario:** a workbook full of BOUNDSHEET records whose declared sheet-offset never matches any real offset makes every `findIndex` scan all N records → O(N²), fully synchronous, no signal check. The blocked event loop freezes every concurrent request; no HTTP status is ever returned.
**Consequence:** full-process DoS hang.

**Current code:**
```ts
for (const bound of boundSheets) {
  const start = records.findIndex((record) => record.offset >= bound.offset);
  if (start === -1) continue;
  const cells = readSheet(records, start, biff8, codepage, formats, xfFormats, sst);
  // ...
}
```
**Verified fix:** precompute sheet-start indices once by binary search over the offset-sorted records, give `readSheet` an explicit `stop`, and memoize identical starts:
```ts
function firstRecordAt(records: Record[], offset: number): number {
  let low = 0, high = records.length;
  while (low < high) { const mid = (low + high) >>> 1; if (records[mid]!.offset < offset) low = mid + 1; else high = mid; }
  return low === records.length ? -1 : low;
}
const starts = [...new Set(boundSheets.map((b) => firstRecordAt(records, b.offset)))].filter((s) => s !== -1).sort((a, b) => a - b);
const stopFor = new Map(starts.map((s, i) => [s, starts[i + 1] ?? records.length]));
const rowsByStart = new Map<number, Sheet["rows"]>();
for (const bound of boundSheets) {
  const start = firstRecordAt(records, bound.offset);
  if (start === -1) continue;
  let rows = rowsByStart.get(start);
  if (rows === undefined) {
    const cells = readSheet(records, start, stopFor.get(start)!, biff8, codepage, formats, xfFormats, sst);
    rows = toRows(cells, date1904, formats);
    rowsByStart.set(start, rows);
  }
  sheets.push({ name: bound.name, rows });
}
```
(and `readSheet(records, start, stop, …)` loops `for (let i = start; i < stop; i++)`.)
**Fix notes:** records are offset-sorted (relied on at `:216`), so binary search is sound (check 4). Independently, office parsers should call `signalCheckpoint(ctx)` in long loops so `maxParseMillis` can fire — that is the general class fix (F4).

### 6. `parser-db/src/index.ts:79` — generated columns materialized inside WASM freeze the loop and retain RSS
**Lens:** Assumptions
**Confidence:** main — original: a DB of generated `hex(zeroblob(...))` columns froze the event loop 13 335 ms at 828 MB RSS (then 422); a wide generated-column DB → 1.3 s + ~1 GB; a single huge generated cell drove RSS to 975 MB and WASM never released it across parses. After the filter fix: every file ≤56 ms, RSS ≤142 MB. Output parity on a normal DB: original emitted the extra generated columns, fixed drops them (`alpha\talpha-stored` vs `alpha\talpha-stored\talpha-virtual`).
**Assumption:** `column[hiddenIndex] !== 1` excludes all columns that should not be selected.
**Violation scenario:** `PRAGMA table_xinfo` marks VIRTUAL generated columns `2` and STORED `3`; the `!== 1` filter keeps both, so they are SELECTed. `substr(col,1,4096)` truncates the *result string* but SQLite first fully materializes the generated expression (e.g. a 50 MB blob-to-hex per cell) inside WASM before truncating. WASM linear memory is outside the V8 heap, so `--max-old-space-size` does not bound it and it is retained across requests.
**Consequence:** multi-second whole-server freeze + ~1 GB RSS retained — DoS.

**Current code:**
```ts
.filter((column) => column[hiddenIndex] !== 1)
```
**Verified fix:**
```ts
// table_xinfo hidden flag: 0 normal, 1 hidden, 2 VIRTUAL generated, 3 STORED generated.
// Select only real columns; generated expressions can materialize unboundedly inside WASM.
.filter((column) => column[hiddenIndex] === 0)
```
**Fix notes:** drops both VIRTUAL and STORED generated columns (check 4, values read from `table_xinfo` docs). **Residual (Review):** views were not checked (a view can wrap a generated expression); and sql.js WASM RSS retention across parses remains — a memory-budgeted worker is the durable bound. Keeping STORED generated columns would reintroduce the blob-materialization cost, so excluding `=== 0` only is deliberate.

### 7. `parsers/src/icc.ts:76` — quadratic trailing-NUL strip
**Lens:** Cross-Implementation Divergence
**Confidence:** agent — 20k/40k/80k NUL runs → 187/740/3000 ms (clean quadratic, ~8 min/MB); e2e via magic `acsp` at 40k → 761 ms, 200.
**Assumption:** `.replace(/\0+$/, "")` is linear.
**Violation scenario:** a run of NULs followed by a non-NUL causes the regex engine to backtrack quadratically. A linear `stripTrailingNuls` already exists (`dicom.ts:111`, `tnef.ts:142`) but was not applied here — a divergence between siblings.
**Consequence:** multi-second synchronous stall per request; no signal check, so uninterruptible.

**Current code:**
```ts
return ascii(data, offset + 12, Math.min(length, size - 12)).replace(/\0+$/, "").trim();
```
**Verified fix:** use the existing linear helper:
```ts
return stripTrailingNuls(ascii(data, offset + 12, Math.min(length, size - 12))).trim();
```
**Fix notes:** agent-verified; re-run on main before shipping. The same `.replace(/\0+$/)` pattern should be swept across `parsers/src` and `parser-media/src`.

### 8. `parsers/src/mail.ts:89` — uncapped multipart boundary, O(n·m) scan
**Lens:** Boundary
**Confidence:** agent — 48/96/192 KB boundaries → 175/673/2748 ms (~4× per doubling, ~75 s/MB extrapolated); e2e (detected `message/rfc822`) 144 KB → 1543 ms, 200 with empty text.
**Assumption:** boundaries are short (RFC 2046 caps them at 70 chars).
**Violation scenario:** a long boundary drives a naive `indexOf` byte search run synchronously for each part separator.
**Consequence:** event-loop stall; no timeout can fire.

**Current code:**
```ts
const boundary = contentType.parameters.get("boundary");
// ... splitMultipart(entity.body, boundary)
```
**Verified fix:** reject over-long boundaries up front (RFC 2046 §5.1.1 limit is 70):
```ts
if (boundary !== undefined && boundary.length > 70) {
  throw new MalformedDocumentError("Multipart boundary exceeds 70 characters");
}
```
**Fix notes:** agent-verified; re-run on main. 422 (check 5). Constraint value 70 is the RFC maximum (check 4).

### 9. `parsers/src/tnef.ts:114` — HTML-strip close-tag rescan is O(n²)
**Lens:** Time
**Confidence:** agent — 70/140/280 KB → 150/596/2432 ms (~33 s/MB); e2e via magic 40k → 2439 ms then 422.
**Assumption:** the comment at `:91-92` claims close-tag searches are memoised.
**Violation scenario:** when `</script` is found but no `>` follows, nothing is memoised, so every later `<script` re-runs `scriptClose.exec` from `lt` to the same tail → O(n²).
**Consequence:** multi-second synchronous stall.

**Current code:**
```ts
if (rawClose !== null) {
  rawClose.lastIndex = lt;
  const close = rawClose.exec(value);
  if (close === null) { if (rawClose === scriptClose) scriptMissing = true; else styleMissing = true; }
  else { const gt = value.indexOf(">", close.index); if (gt !== -1) { index = gt + 1; continue; } }
}
```
**Verified fix (sketch):** cache the close index once found and reuse it while `lt < close.index`; set `gtMissing` when no `>` follows so later iterations skip the rescan. **Re-verify on main and run Step 6 check 8 before shipping** (agent-only).

### 10. `parsers/src/asn1.ts:64` — lazy PEM regex scans to EOF per BEGIN marker
**Lens:** Time
**Confidence:** agent — 34/68/136 KB → 30/116/455 ms (~26 s/MB); e2e with a `.p7s` filename 8k → 504 ms then 422. Reachable because the server takes the filename from the client (`?filename=`), so the pkcs7/p12 content-type requirement is attacker-satisfiable.
**Assumption:** the BEGIN/END block is well-formed.
**Violation scenario:** with no END marker, `/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/` lazily scans to EOF from every BEGIN.
**Consequence:** O(n²) synchronous stall.

**Current code:**
```ts
const match = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(text);
```
**Verified fix:** replace the regex with two `indexOf`:
```ts
const begin = text.indexOf("-----BEGIN ");
const end = begin === -1 ? -1 : text.indexOf("-----END ", begin);
// slice the body between them; decode as before.
```
**Fix notes:** agent-verified; re-run on main. `decodeArmor` in `openpgp.ts:94` already uses exactly this linear shape — reuse it (also see #41).

### 11. `parser-archive/src/plist.ts:39` — binary-plist reference expansion → uncatchable OOM from a sub-kilobyte file
**Lens:** Data Lifecycle
**Confidence:** main + agent — a 126 B file returned 422 "Invalid binary plist" at +727 ms (the 50 ms timer fired at +723 ms, i.e. far too late); the next size up aborted the process with a V8 FATAL heap OOM. Agent reproduced a 569 ms synchronous run under `maxParseMillis:50`. Reported only as a "sub-kilobyte file" with no construction detail.
**Assumption:** `bplist-parser`'s `maxObjectCount` bounds the work.
**Violation scenario:** `parseObject` recurses through array/dict object-refs with no visited-set and no depth limit; shared refs let a small number of distinct objects expand into an exponential number of materialized nodes. `maxObjectCount` bounds *distinct* objects, not expansion. The work is fully synchronous, so `maxParseMillis` cannot fire; a FATAL OOM is uncatchable by the `try/catch` at `:41`.
**Consequence:** a tiny upload either blocks the event loop for seconds-to-minutes or aborts the whole process. Detected as `application/x-bplist` by magic — no filename trust needed.

**Current code:**
```ts
const [parsed] = parseBuffer(Buffer.from(data));
await xhtml.element("p", JSON.stringify(parsed));
```
**Fix: requires design work — checks 1, 5, 8.** An uncatchable OOM cannot be contained in-process. Options, best first:
1. Run plist parsing in `runIsolatedTask` (worker + `memoryLimitMb` + wall-clock terminate), as the pipes/PDF paths do. This bounds both the OOM and the synchronous stall.
2. Replace `bplist-parser` with a reader that charges an output/node budget and detects reference cycles.

**Check 8 (empirical re-test of the fix) deliberately NOT run** — re-running the amplification locally is the hazard. The ROI is high (small, high-impact), but the fix is isolation, not a patch.

### 12. `parser-media/src/image.ts:77` — exifr XMP quadratic regex
**Lens:** Time
**Confidence:** main — TIFF-embedded XMP: 64/128/256 KB → 209/664/2562 ms; the macrotask timer lag tracked parse time (so the loop is blocking), and `maxParseMillis:1000` was ignored. Agent: 512 KB → 10 019 ms.
**Assumption:** exifr's XMP tag parsing is linear.
**Violation scenario:** exifr's `XmlTag.findAll` builds a per-tag `RegExp` and recurses, which is quadratic in the number of nested tags. The server body cap (100 MiB) does not bound XMP cost.
**Consequence:** O(n²) synchronous stall; a few MB of XMP freezes the event loop for minutes.

**Current code:** same `exifr.parse(...)` call as #3 (XMP enabled).
**Fix: requires design work — check 1.** The quadratic is inside exifr. Durable fix: worker isolation (shared with #3). In-process stopgap: cap the XMP payload (TIFF tag 0x02BC / PNG iTXt / JPEG APP1) to a bounded size before handing to exifr — but this changes which metadata is extracted for large legitimate XMP, so it needs a product decision.

### 13. `core/src/parse-context.ts:142` — timeout abort surfaces as 500 instead of 408
**Lens:** Error Paths
**Confidence:** main — Before: `requestTimeoutMs=200` → `500 {"error":"The operation was aborted due to timeout","code":"ERROR"}`, while a preset `maxParseMillis` gave 408. After: 408 PARSE_TIMEOUT on both paths.
**Assumption:** `throwIfAborted` turns every abort into a `RipstreamError`.
**Violation scenario:** when the signal reason is a `DOMException` named `TimeoutError` (from `AbortSignal.timeout`), the current logic falls through to a generic `AbortError` — but if the reason is a raw timeout DOMException it is thrown as-is in some paths, becoming a non-`RipstreamError` → 500.
**Consequence:** legitimate timeouts look like server faults; drives client retries and false alerts.

**Current code:**
```ts
const reason: unknown = this.signal.reason;
if (reason instanceof Error && !(reason instanceof DOMException && reason.name === "AbortError")) {
  throw reason;
}
throw new AbortError(reason instanceof Error ? reason.message : "Operation aborted");
```
**Verified fix:**
```ts
import { AbortError, ParseTimeoutError } from "./errors.ts";
const reason: unknown = this.signal.reason;
if (reason instanceof DOMException && reason.name === "TimeoutError") {
  throw new ParseTimeoutError(reason.message);
}
throw new AbortError(reason instanceof Error ? reason.message : "Operation aborted");
```
**Fix notes:** `signal-checkpoint.ts:14-21` duplicates this logic — dedupe onto the same mapping (recommended, untested). **Ships with #14.**

### 14. `core/src/ripstream.ts:215` — a parser that swallows the abort reports success after a timeout
**Lens:** Error Paths
**Confidence:** main — on a 10 000-entry zip: no timeout → 5668 ms / 5 437 747 chars; `maxParseMillis=30` → "RESOLVED after 170 ms with only 36 000 chars" (success with truncated output, no error); `parseRecursive` produced 3001 records, 3000 carrying a `ParseTimeoutError` but the overall call resolving. After fix: both paths reject with `ParseTimeoutError` in ~115 ms. Suites green before/after (core 160, parser-archive 35, server 17, parsers 93, pipes 12, parser-office 59).
**Assumption:** once the timeout fires, the parse rejects.
**Violation scenario:** `withStream` returns whatever `action()` resolves to. Several parsers catch the abort internally (archive `parseEntry`, mail `dispatchEmbedded`, `recursive.ts` child catch) and resolve normally, so a timed-out parse returns a **partial success** (200 with truncated text) instead of 408.
**Consequence:** silent truncation presented as success — the worst failure for a resiliency contract, because callers cannot tell complete from truncated.

**Current code:**
```ts
try {
  return await action(stream, metadata, ctx);
} finally {
  if (timer !== null) clearTimeout(timer);
  // ...
}
```
**Verified fix:** add a post-check and make the abort-swallowing catches rethrow when aborted:
```ts
// ripstream.ts withStream
try {
  const result = await action(stream, metadata, ctx);
  ctx.throwIfAborted();          // a parser that swallowed the abort must not report success
  return result;
} catch (error) {
  if (signal.aborted) ctx.throwIfAborted();
  throw error;
} finally { /* clearTimeout */ }

// recursive.ts RecordExtractor child catch
record.exception = error instanceof Error ? error : new Error(String(error));
if (ctx.signal.aborted) throw error;

// parser-archive/src/util.ts parseEntry catch
if (error instanceof LimitExceededError || ctx.signal.aborted) throw error;
```
**Fix notes:** caller contract changes — `parse`/`parseRecursive` now reject on timeout where they previously resolved (check 7). This is the intended contract. **Ships with #13** (needs the 408 mapping). Also apply the same `|| ctx.signal.aborted` guard to `mail.ts:158` (#24).

### 15. `server/src/index.ts:339` — `/rmeta` and `/unpack` ignore the configured limits ceiling
**Lens:** Data Lifecycle
**Confidence:** main — with server `maxLimits {maxEmbeddedResources:1}`: `/tika` correctly returned 422, but `/rmeta` returned 200 with 6 records and `?maxEmbeddedResources=1` also returned 6. After fix: `/rmeta`, `?=1`, `?=999` (clamped) and `/unpack` all return `422 {"code":"LIMIT_EXCEEDED"}`.
**Assumption:** the recursive routes honor the same limits as `/tika`.
**Violation scenario:** `/rmeta` and `/unpack` call `parseRecursive(body, parseOptions)` with no `limits`, so the operator-configured ceiling is bypassed.
**Consequence:** the embedded-resource ceiling — the main defense against zip-bomb fan-out — is unenforced on two routes.

**Current code:**
```ts
const records = await ripstream.parseRecursive(body, parseOptions);
```
**Verified fix:**
```ts
const records = await ripstream.parseRecursive(body, {
  ...parseOptions,
  ...(Object.keys(limits).length === 0 ? {} : { limits }),
});
```
**Fix notes:** matches the `/tika` path (`:343`). Verify together with #13/#14 so timeouts on the recursive path also map correctly.

### 16. `server/src/index.ts:361` — no slowloris protection; a slow upload holds a slot
**Lens:** Time
**Confidence:** main — Before: `/version` probes during a slow upload returned 408 at +200/+2500/+5000 ms (slot held throughout). After adding `requestTimeout`/`connectionsCheckingInterval` and exempting health endpoints: +200 ms → 408 (slot still filling), +2500 ms → 200 in 4 ms, +5000 ms → 200 in 5 ms; a fast PUT → 200.
**Assumption:** `readBody` completes promptly.
**Violation scenario:** `createServer(handler)` sets no `requestTimeout`, so a client that trickles bytes holds its acquired concurrency slot indefinitely; `maxConcurrent` such clients wedge the server. Health endpoints are themselves behind the semaphore, so they cannot report the problem.
**Consequence:** classic slowloris DoS with a small number of slow connections.

**Current code:**
```ts
const server = createServer(handler);
```
**Verified fix:**
```ts
const server = createServer({ requestTimeout: requestTimeoutMs, connectionsCheckingInterval: 30_000 }, handler);
```
plus routing `/version` and `/status` before `acquire()` so they are not gated by the semaphore.
**Fix notes:** the health-endpoint exemption is **unverified** in isolation (the combined behavior above was verified). Confirm the exemption does not skip auth where auth is required.

### 17. `pipes/src/pool.ts:54` — semaphore double-counts the handed-off slot
**Lens:** State Machine
**Confidence:** main — a burst of 6 on `size=2`: before, the next run reported "STILL WAITING after 5s"; after removing the extra `this.#active++`, "99 (49 ms)".
**Assumption / scenario / consequence:** identical to #1 — the waiter callback re-increments a slot already transferred by `#release`.
**Current code:**
```ts
await new Promise<void>((resolve) => {
  this.#waiters.push(() => { this.#active++; resolve(); });  // double count
});
```
**Verified fix:** drop `this.#active++` from the waiter callback (the slot carries over from `#release`). **Ships with #1.** `no in-repo caller`: `Pool` is exported but not used by the current server/CLI pipes paths — reachable by an embedder.

### 18. `pipes/src/adapters.ts:71` — concurrent `appendFile` interleaves JSONL lines
**Lens:** Time
**Confidence:** main — 8 concurrent 3 MiB documents → 8 corrupted lines; after serializing through a promise chain → 0 corrupted; an unwritable path rejects both calls with ENOENT.
**Assumption:** `fs.appendFile` is atomic for the whole string.
**Violation scenario:** `appendFile` writes in 512 KiB chunks, so two concurrent emits interleave their chunks and produce invalid JSONL.
**Consequence:** silent output corruption under any concurrent pipeline.

**Current code:**
```ts
async emit(document: EmittedDocument): Promise<void> {
  await appendFile(this.#path, `${JSON.stringify({ id: document.id, text: document.text, metadata: document.metadata })}\n`);
}
```
**Verified fix:** serialize appends through an instance promise chain, where a failed append does not poison the chain yet the caller still sees the rejection:
```ts
#tail: Promise<void> = Promise.resolve();
async emit(document: EmittedDocument): Promise<void> {
  const line = `${JSON.stringify({ id: document.id, text: document.text, metadata: document.metadata })}\n`;
  const run = this.#tail.then(() => appendFile(this.#path, line));
  this.#tail = run.catch(() => undefined); // keep the chain alive
  await run;                               // caller still observes this append's error
}
```
**Fix notes:** the stats `appendFile` at `adapters.ts:116` has the identical defect — **ships together**.

### 19. `parser-office/src/legacy.ts:64` — `push(...spread)` stack overflow → 500
**Lens:** Boundary
**Confidence:** agent — `push(...100000)` OK, `push(...125000)` throws `RangeError: Maximum call stack size exceeded`; an OneNote input driven end-to-end threw RangeError → `RipstreamError=false httpStatus=500`.
**Assumption:** the string array from `printableStrings(...)` is small enough to spread.
**Violation scenario:** `Array.prototype.push(...arr)` throws past ~125k elements. CFB streams (Visio/Publisher/MS-Project at `:64`), OneNote (`:67`), and Access (`:74`) each feed one element per short printable run, so a moderately large file exceeds the limit.
**Consequence:** raw RangeError → 500 (should be 422).

**Current code:**
```ts
strings.push(...printableStrings(compound.read(entry.path)));
```
**Verified fix:** iterate and cap instead of spreading (at all three sites, `:64/:67/:74`):
```ts
for (const s of printableStrings(/* ... */)) {
  if (strings.length >= MAX_STRINGS) throw new LimitExceededError("Extracted string count exceeds limit");
  strings.push(s);
}
```
**Fix notes:** agent-verified; re-run on main. Same pattern as #20's iWork sink.

### 20. `mime/src/containers/zip.ts:83` + `iwork13.ts` — iWork'13 type is detected but never routed; routing it exposes a spread overflow
**Lens:** Cross-Implementation Divergence
**Confidence:** main — with only the type fix, a direct IWork13 parse at n=200000 → RangeError 500; with the type fix **and** the spread→loop fix, parse succeeds and text is extracted (6 vs 0 strings). (`iwork13.ts` TYPES at `:14-18` list the keynote/pages/numbers types but **not** `application/vnd.apple.iwork`, which is what the container sniffer at `zip.ts:83` emits.)
**Assumption:** the type the sniffer emits is one the parser registers.
**Violation scenario:** `detectZipContainer` returns `application/vnd.apple.iwork` for `Index/*.iwa` packages, but `IWork13Parser` does not register that type, so `CompositeParser` finds no parser (or, via the all-decline path, resolves silently). Adding the type makes the parser reachable — which immediately exposes `strings.push(...printable(decoded))` at `iwork13.ts:65` (same class as #19).
**Consequence:** today iWork'13 files are not parsed; naively "fixing" the type alone converts that into a 500 crash.

**Current code:**
```ts
// iwork13.ts
const TYPES = ["application/vnd.apple.keynote","application/vnd.apple.pages","application/vnd.apple.numbers"];
```
**Verified fix:** add the container type **and** fix the sink in one change:
```ts
const TYPES = ["application/vnd.apple.keynote","application/vnd.apple.pages","application/vnd.apple.numbers","application/vnd.apple.iwork"];
// and at :65, replace strings.push(...printable(decoded)) with the capped for-of loop from #19.
```
**Fix notes:** the type addition is `main`-verified; the decline-semantics question (should `CompositeParser` throw when all candidates decline? — see Refutation Log) is separate design work. **Ships with #19's sink fix (O3).**

### 21. Raw library errors mapped to 500 instead of 422 — cluster
**Lens:** Error Paths / Cross-Implementation Divergence
**Confidence:** main + agent — fuzzing surfaced 629/16014 inputs escaping as raw errors. End-to-end on main: truncated tar → `500 "Unexpected end of data"`; bad parquet → `500 "parquet metadata length … exceeds available buffer"`; malformed RSS → `500 "duplicate attribute"`. Agent confirmed audio (`audio.ts:52`), dicom/icc/rtf, xliff/atom/tmx, and `TranslationError` all → 500.
**Assumption:** parser libraries throw `RipstreamError`.
**Violation scenario:** `tar.ts:116` rethrows a plain `Error` (unused `MalformedDocumentError` import at `:3`); `columnar.ts:50`, `audio.ts:52`, `feed.ts:86`/`web.ts:206` (saxes, no `on("error")`), and `TranslationError extends Error` (not `RipstreamError`) all bypass the contract. Siblings wrap correctly (`zip.ts`, `gzip.ts`, `compressor.ts`), so this is a divergence.
**Consequence:** ordinary malformed/truncated *client* files report as *server* faults — drives retries, alerts, and masks real 500s.
**Fix: requires design work — check 6 (central vs per-parser).** Recommended **both**:
1. `TranslationError extends RipstreamError` (code `TRANSLATION_FAILED` or reuse an existing 4xx code).
2. A backstop in `CompositeParser.parse`: wrap a non-`RipstreamError` throw as `MalformedDocumentError` with `cause` preserved, so no parser can emit a raw 500.
3. Still fix the obvious per-parser sites (tar rethrow → `new MalformedDocumentError("Invalid tar archive", { cause })`; add saxes `on("error")`).
**Fix notes:** a central backstop risks masking genuine internal bugs as 422 — so log the original at error level. Decide before Phase 3/4 or per-parser fixes get redone.

### 22. `core/src/embedded.ts:141` + `parsers/src/text.ts:75` — embedded and line text buffered whole; memory unbounded
**Lens:** Data Lifecycle
**Confidence:** main — a 36 MB text body emitted a single `characters()` call of 36 012 383 chars (+108 MiB RSS); a zip of the same → +213 MiB; a 3.5 MiB decompression-ratio zip drove +1150–1320 MiB before `LimitExceeded` (no crash, but ~3.5 s and a large transient).
**Assumption:** the output limit truncates incrementally.
**Violation scenario:** `ParsingEmbeddedDocumentExtractor` buffers a child's entire text in a `BodyContentHandler` and forwards it in one `characters()` call, so `OutputLimitContentHandler` sees the whole thing at once (drops the entire child rather than truncating), and the child's memory is unbounded before that. `TextParser` similarly accumulates a newline-free input into `pending` and emits it whole.
**Consequence:** large transient memory spikes; the output limit degrades to all-or-nothing per child.
**Fix: requires design work — checks 1 & 5.** Streaming the child's output through the shared `OutputLimitContentHandler` (charging as bytes are produced, not after) is the correct fix but changes truncation semantics and the handler contract. A naive per-child cap would silently change output for legitimate large embeds. **Risk: No Fix is Critical** (memory), but the fix is a redesign, not a patch.

### 23. `parsers/src/csv.ts:134` — a newline-free row is buffered whole (~9 B/input B)
**Lens:** Boundary
**Confidence:** agent — 8M/32M/64M/100M commas → heap 102/333/657/923 MB, RSS 307 MB/741 MB/1.16 GB/1.64 GB (then 422 at 100M). ~9 heap bytes per input byte; two concurrent requests at the body cap OOM the process.
**Assumption:** rows are delimited by newlines, so `flush` drains them.
**Violation scenario:** cells accumulate in `this.row` until a newline; `flush` only drains finished rows, so a row with no newline never hits the output limit until the whole body is buffered and amplified.
**Consequence:** OOM from a single body at the cap.
**Fix: requires design work — checks 1 & 5.** Cap cells-per-row and field length, throwing `LimitExceededError`. This is a small code change but choosing the caps is a product decision (legitimate wide CSVs exist), and it interacts with the output-charge redesign in #22.

### 24. `parsers/src/mail.ts:158` — embedded-dispatch catch swallows LimitExceeded / ParseTimeout → 200
**Lens:** Error Paths
**Confidence:** agent — with `maxEmbeddedResources:1` and 3 CSV attachments: `OK text="inline text a1 a2"` (the zip control gives 422); a large attachment "silently disappears"; a `ParseTimeoutError` mid-parse still resolved OK with no X-TIKA keys on the parent.
**Assumption:** recording the exception into part metadata is sufficient.
**Violation scenario:** `dispatchEmbedded` catches **every** error into `partMetadata` (which is then discarded), so `LimitExceededError`, `ParseTimeoutError`, and `AbortError` never propagate — limits are bypassable through email, and the parent metadata loses the exception entirely.
**Consequence:** 200 with silently truncated content where 422/408 is due.

**Current code:**
```ts
} catch (error) {
  partMetadata.set(`X-TIKA:EXCEPTION:${error instanceof Error ? error.constructor.name : "Error"}`, error instanceof Error ? error.message : String(error));
}
```
**Verified fix (sketch):** mirror `parser-archive/src/util.ts:100` — rethrow `RipstreamError` (at least `LimitExceededError`) and any error when `ctx.signal.aborted`, and copy the exception keys to the parent metadata. Re-verify on main (agent-only). **Shares the `|| ctx.signal.aborted` guard with #14.**

### 25. `parser-office/src/ooxml.ts:626` — embedded-part `catch {}` swallows LimitExceeded → 200
**Lens:** Error Paths
**Confidence:** main — a docx carrying an over-limit embedded zip (`maxEmbeddedResources:1`) returned `200 OK text="outer body inner.zip"` with **zero** `X-TIKA:EXCEPTION` keys; the standalone zip control returned 422.
**Assumption:** "unsupported embedded formats must not fail the package" — but the blanket catch also discards `LimitExceededError`/`EncryptedDocumentError`.
**Violation scenario:** `parseEmbeddedPart`'s `catch {}` drops all errors, including limit violations, and does not even record them as metadata. The sibling archive reader deliberately rethrows `LimitExceededError` (`util.ts:100`) — a divergence.
**Consequence:** over-limit embedded parts are silently dropped; the package returns success with truncated content and wrong status.

**Current code:**
```ts
try { await extractor.parseEmbedded(stream, handler, metadata, ctx); }
catch { /* Unsupported embedded formats are recorded but must not fail the package. */ }
```
**Verified fix (sketch):** mirror `util.ts` — rethrow `RipstreamError` (at minimum `LimitExceededError`, `EncryptedDocumentError`) and record other errors as `X-TIKA:EXCEPTION`:
```ts
} catch (error) {
  if (error instanceof RipstreamError) throw error;
  metadata.set(`X-TIKA:EXCEPTION:${error instanceof Error ? error.constructor.name : "Error"}`, error instanceof Error ? error.message : String(error));
}
```
**Fix notes:** the BUG is `main`-confirmed; the fix sketch itself was not re-driven (Step 6 check 8 pending). Same contract as #24 — ship the embedded-error contract as one decision.

### 26. `pipes/src/index.ts:120` — ordered delivery reorders/inverts across concurrency
**Lens:** Time
**Confidence:** main — 40 docs at concurrency 4: `emit` called 43 times (N + concurrency − 1), none missing but d0 emitted 4×; seeds of 60 docs showed 15–20 inversions in CONTENT_ONLY mode. (This is the *reorder* defect; the *data-loss* defect in UNPACK mode is #27.)
**Assumption:** `nextIndex`-gated buffering yields strict fetch order.
**Violation scenario:** concurrent workers call `deliver` and race on `buffered`/`nextIndex`; the "lost docs" theory was **refuted** for CONTENT_ONLY (all N are emitted) but ordering is not actually guaranteed, and duplicate emits of the same index occur at the boundaries.
**Consequence:** downstream consumers that trust ordering (or uniqueness) see reorders/duplicates.
**Fix: requires design work.** The delivery buffer needs a single-owner drain (one awaited chain) rather than per-worker `while` loops. Ships with the pipes delivery redesign (#27, #28, #32, #33).

### 27. `pipes/src/index.ts:142` — UNPACK + ordered delivery drops every embedded record
**Lens:** Data Lifecycle
**Confidence:** main — 3 zip docs, each with 3 entries (expect 12 emits = 3 containers + 9 entries). `ordered=false` → **12** emitted (correct). `ordered=true, concurrency=1` → **3** emitted (only the container docs; all 9 entries lost). `ordered=true, concurrency=3` → **3** emitted, and *which* survive is nondeterministic (`doc0.zip/doc0.zip`, `doc1…/c.txt`, `doc2…/c.txt`). Stats reported `emitted:3, failed:0` — no error raised.
**Assumption:** each source index maps to exactly one emitted document.
**Violation scenario:** in UNPACK mode the worker calls `deliver(index, …)` once per record (`:142-148`), reusing the same `index`. With `ordered`, `deliver` does `buffered.set(index, doc)` (overwriting the previous record for that index) and advances `nextIndex` past `index` after the first flush, so every subsequent record for that index is stranded in `buffered` forever and silently dropped.
**Consequence:** **silent data loss** — ordered UNPACK pipelines emit only the first record (or a race-determined subset) of each container, with a success status and stats that under-report. The server exposes `ordered` (`index.ts:444`), so this is reachable in production.

**Current code:**
```ts
buffered.set(index, document);
while (buffered.has(nextIndex)) {
  await this.#options.emitter.emit(buffered.get(nextIndex)!);
  buffered.delete(nextIndex);
  nextIndex++;
}
```
**Fix: requires design work — check 7.** The one-document-per-index invariant is baked into `nextIndex`. Emitting N records per source index needs a protocol change — e.g. buffer `Map<number, EmittedDocument[]>` and only advance `nextIndex` when the worker signals the index is *complete* (a per-index "done" marker), so all records for an index flush in order before advancing. This touches the worker→deliver contract, so it is not a one-liner. Pairs with #26.

### 28. `pipes/src/index.ts:176` — one worker throw abandons in-flight siblings
**Lens:** Error Paths
**Confidence:** main — `run()` rejected with `LimitExceededError`: at reject time `emitted=0`, stats `{fetched:12, emitted:0, failed:1}`, `emitter.close` not called; ~1.5 s later the still-running "zombie" workers had emitted all 11 good docs — after the caller already saw the rejection and (likely) tore down.
**Assumption:** `Promise.all` failing stops the pipeline cleanly.
**Violation scenario:** `Promise.all` rejects on the first worker error but the other workers keep running and keep calling `emit`; the emitter is never closed and stats are frozen at the reject instant.
**Consequence:** emits continue after the caller believes the run failed; resource cleanup (`emitter.close`) is skipped; stats are wrong.
**Fix (sketch):** use an `AbortController` shared by workers; on first failure, signal it, `await Promise.allSettled`, then close the emitter in a `finally`. Re-verify. Ships with the pipes redesign.

### 29. `parser-pdf/src/pdf.ts:137` — whole input spooled to disk before the size cap
**Lens:** Boundary
**Confidence:** agent — `PdfParser({maxInputBytes: 1 MB})` fed a 256 MB generator wrote all 256 MB to a temp file (`pulledMB: 256`) before throwing `LimitExceededError`.
**Assumption:** the size cap bounds disk usage.
**Violation scenario:** `await stream.getFile()` spills the entire stream before the `size > maxInputBytes` check at `:139`.
**Consequence:** unbounded temp-disk write for library/CLI callers (the server is bounded by the 100 MiB body cap, which is below the 512 MiB PDF cap, so the server itself is not exposed — library/CLI embedders are).
**Verified fix (sketch):** check a declared/available length before `getFile()`, or cap bytes while spilling. Agent-verified mechanism; re-run on main.

### 30. `language/src/translate.ts:98` — race timeout never aborts fetch; sockets leak, 4xx retried
**Lens:** Time
**Confidence:** agent — against a never-responding local server, `timeoutMs 200 / attempts 3` left 3 sockets open immediately and 5 s after the promise rejected; the server `/translate` route holds a concurrency slot with no outer timeout.
**Assumption:** `Promise.race` against a timer cancels the losing fetch.
**Violation scenario:** `#json`'s `fetch` has no `AbortSignal`; the race timer rejects but never cancels the request; `:145` retries **all** errors including 4xx (backing off `25 * 2 ** attempt`).
**Consequence:** leaked in-flight requests (up to `attempts` per call), a held slot, and retry storms against upstreams that returned a definitive 4xx.
**Verified fix (sketch):** pass an `AbortSignal` to `fetch` and abort on timeout; do not retry non-retriable (4xx) statuses; wrap `/translate` and `/language` in the request timeout. Agent-verified; re-run on main.

### 31. `parsers/src/xml.ts:105` — ParseTimeout/Limit rewrapped as MalformedDocument
**Lens:** Error Paths
**Confidence:** agent — `MalformedDocumentError code=MALFORMED_DOCUMENT http=422 cause=ParseTimeoutError`; control TextParser gives `ParseTimeoutError http=408`.
**Violation scenario:** one `try` wraps both the `for await` read and `parser.close()`, so a `ParseTimeoutError` (from the stream's signal check) or `LimitExceededError` gets rewrapped as `MalformedDocumentError`.
**Consequence:** timeouts come back as 422 "Malformed XML"; limit hits get the wrong code.
**Verified fix:**
```ts
} catch (error) {
  if (error instanceof RipstreamError) throw error;
  throw new MalformedDocumentError("Malformed XML", { cause: error });
}
```
**Fix notes:** agent-verified; re-run on main.

### 32. `pipes/src/index.ts:308` — two distinct ids collide to one output file
**Lens:** Write/Read Asymmetry
**Confidence:** main — ids `a/b.txt` and `a_b.txt` both became `a_b.txt.txt`; the second write overwrote the first (the file contained "SECOND document").
**Violation scenario:** `document.id.replace(/[^A-Za-z0-9._-]+/g, "_")` maps different ids to the same sanitized name; the `.txt`/`.bin` write then silently overwrites.
**Consequence:** silent data loss in `FileSystemEmitter` when ids differ only in sanitized characters.
**Verified fix (sketch):** disambiguate collisions (append a short hash of the original id, or a counter). **Output-contract change** — on-disk names change; tell downstream consumers (check 2/6). Re-verify after choosing the scheme.

### 33. `pipes/src/resilience.ts:59` — non-atomic checkpoint write; torn file reads as empty
**Lens:** Data Lifecycle
**Confidence:** main — a deliberately torn checkpoint opened with size 0 and **no error** (the `catch` at `:46` treats any parse failure as "fresh"); 300 concurrent `mark` calls left a valid file (so the write race did not corrupt at that scale — see Review for >512 KiB).
**Violation scenario:** `mark` calls `writeFile` directly (not atomic); a crash mid-write truncates the file, and `open`'s `catch` silently resets all progress to empty instead of surfacing corruption.
**Consequence:** a crash during checkpointing silently discards all completed-id state, so a resumed run reprocesses everything.
**Verified fix (sketch):** write to a temp file and `rename` (atomic on POSIX); in `open`, distinguish ENOENT (fresh) from a parse error on a non-empty file (corruption → surface or back up). Re-verify.

### 34. `core/src/ripstream-input-stream.ts:85` — `readFully` truncates instead of enforcing the cap
**Lens:** Boundary
**Confidence:** main (no in-repo caller) — on 4+4 byte chunks, `readFully(4)` returned 4 bytes with **no error**; `maxBytes` 0 and NaN also truncated silently. After fix: no truncation; `-1` and NaN → RangeError.
**Violation scenario:** `if (available > maxBytes) throw` uses `>`, so when `available === maxBytes` it returns, but the method is meant to enforce a cap — it reads up to `maxBytes` and silently drops the rest when more is buffered, and accepts negative/NaN caps.
**Consequence:** a public API that silently truncates; an embedder relying on it to bound input gets wrong data with no signal.
**Verified fix:**
```ts
if (!(maxBytes >= 0)) throw new RangeError(`maxBytes must be >= 0, got ${maxBytes}`);
await this.ensureBuffered(maxBytes + 1);
// ... then the existing (available > maxBytes) throw now correctly fires one byte over the cap
```
**Fix notes:** `no in-repo caller` — exported API; caller contract tightens (negative/NaN now throw). Verified in isolation.

### 35. `mime/src/containers/ole2.ts:25` — sniffer throws during detect(), defeating fallbacks
**Lens:** Error Paths
**Confidence:** agent — `ole2-bad-sectorshift: THREW MalformedDocumentError http=422` for both detect and parse; the ZIP sniffer on garbage returns `application/zip` (no throw).
**Violation scenario:** a bad sector-shift/DIFAT count throws out of `detectOle2Container`, propagating out of `DefaultDetector.detect` and short-circuiting the magic/XML/text fallbacks. Detection is contractually best-effort; the ZIP sniffer swallows and returns a type.
**Consequence:** any file with the 8-byte OLE2 signature but a corrupt header fails the whole request at the detect stage (422 on `/detect`, and on `/parse` before any parser runs). Asymmetric with ZIP; defeats graceful degradation.
**Verified fix (sketch):** wrap the OLE2 sniffer body in try/catch and return `null` on malformation, matching `detectZipContainer`. Agent-verified; re-run on main.

### 36. `parser-archive/src/cpio-ar.ts:85` — negative `ar` size → non-monotonic position, ~10⁴× rescan
**Lens:** Boundary
**Confidence:** agent — a ~68 B `ar` input detected `application/x-archive` and parsed in ~829 ms (bounded by `maxZipEntries=10000`).
**Violation scenario:** `Number.parseInt(header.slice(48,58).trim(), 10)` admits negative sizes; `!Number.isFinite` does not reject them; `position = start + size + (size % 2)` can be ≤ the previous position, so the entry loop re-reads the same header up to the cap.
**Consequence:** large synchronous amplification from a tiny input (bounded, not infinite).
**Verified fix:**
```ts
if (!Number.isFinite(size) || size < 0) break;
const next = start + size + (size % 2);
if (next <= position) break; // require strictly monotonic advance
position = next;
```
**Fix notes:** agent-verified; re-run on main. CPIO is immune (hex parse is ≥0 or NaN→exit).

### 37. `core/src/pinned-fetch.ts:78` — upstream status outside 200–599 → RangeError 500
**Lens:** Boundary
**Confidence:** main — an upstream responding with status 999 or 600 → `RangeError: init["status"] must be in the range of 200 to 599`.
**Violation scenario:** `const status = incoming.statusCode ?? 502;` is passed straight into `new Response(…, { status })`; Node's undici accepts out-of-range status codes from a server, but the `Response` constructor rejects them.
**Consequence:** a malicious/broken upstream turns a fetch into a 500 instead of a handled gateway error.
**Verified fix:**
```ts
const raw = incoming.statusCode ?? 502;
const status = raw >= 200 && raw <= 599 ? raw : 502;
```
**Fix notes:** `safeFetch` is used by `streams.ts:113` (URL input) and `pipes/index.ts:283` (HTTP fetcher) — both reachable. Verified in isolation.

### 38. `parser-db/src/x509.ts:25` — detector emits `x-x509-cert`; parser never matches → 415
**Lens:** Cross-Implementation Divergence
**Confidence:** agent — PEM and DER certs with various names all → `415 No parser for application/x-x509-cert`; only a DER cert named `.cer` parses.
**Violation scenario:** the parser registers `x-x509-ca-cert`, `pkix-cert`, `x-pem-file`; the detector emits `application/x-x509-cert` (optionally `; format=pem|der`), and `matchRank` matches only the exact base type.
**Consequence:** ordinary certificates get 415.
**Verified fix:** register `application/x-x509-cert` in the parser's TYPES. Agent-verified; re-run on main. (Alias-aware `matchRank` is the broader fix — design.)

### 39. `parser-media/src/audio.ts:20` — canonical WAV/FLAC types never route → 415
**Lens:** Cross-Implementation Divergence
**Confidence:** main — real `afconvert` files: `real.wav → 415 "No parser for audio/vnd.wave"`, `real.flac → 415 "audio/x-flac"`; m4a/aiff work.
**Violation scenario:** the parser registers `audio/wav`, `audio/x-wav`, `audio/flac`, but the detector emits the canonical `audio/vnd.wave` and `audio/x-flac` (from `tika-mimetypes.xml`); `matchRank` does no alias resolution.
**Consequence:** valid WAV and FLAC are rejected as unsupported.
**Verified fix:** add `"audio/vnd.wave"` and `"audio/x-flac"` to the parser TYPES.
**Fix notes:** `main`-verified. Independent of the alias-aware `matchRank` (deferred). Ship now.

### 40. `parsers/src/web.ts:42` — WARC loop breaks after the first record
**Lens:** Write/Read Asymmetry
**Confidence:** agent — a WARC with a warcinfo record + 2 resource records → `OK text="urn:info warcinfo software: test "` (only record 1).
**Violation scenario:** after a record, `offset` sits on the mandatory `\r\n\r\n` trailer; `indexOfDoubleCrlf` matches right there, the header is `""`, the `startsWith("WARC/")` check fails, and the loop breaks.
**Consequence:** only the first record (usually warcinfo) is parsed; no page content returned.
**Verified fix (sketch):** skip leading CR/LF bytes before reading the next header. Agent-verified; re-run on main.

### 41. `parser-db/src/openpgp.ts:94` — armor header lines break base64 decode → 422
**Lens:** Boundary
**Confidence:** agent — an armored key with no headers parses; adding a `Comment:`/`Version:` header line → `422 "No OpenPGP packets"`. GnuPG/OpenPGP.js output almost always carries headers.
**Violation scenario:** `decodeArmor` takes everything from the first `-----` after BEGIN to END and base64-decodes it, including the `Version:`/`Comment:` header block and the `=CRC` line.
**Consequence:** real armored certificates/keys → 422.
**Verified fix (sketch):** skip the armor-header block (lines up to the first blank line) and drop the `=CRC` line before decoding. Agent-verified; re-run on main.

### 42. `parser-media/src/image.ts:382` — WebP VP8 lossy reads the wrong dimension offset
**Lens:** Boundary
**Confidence:** agent — a real 640×480 lossy WebP reported `tiff:ImageWidth 202`; VP8L (lossless) reported no dimensions.
**Violation scenario:** the code reads width/height at `start=20` (`data[21..24]`); the correct bytes are at offset 26..29 (after the 3-byte frame tag and `9d 01 2a` start code). VP8L is unhandled.
**Consequence:** silently wrong dimensions (200 OK).
**Verified fix (sketch):** read VP8 dimensions at the correct offset; add a VP8L branch. Agent-verified; re-run on main.

### 43. `parser-media/src/av-container.ts:26` — AVI never descends into LIST; valid AVI → 422
**Lens:** Assumptions
**Confidence:** agent — a spec AVI (`RIFF/AVI_/LIST hdrl{avih}/LIST movi`) → `422 "Missing AVI header chunk"`; the test suite only uses a synthetic top-level `avih`.
**Violation scenario:** the walker scans only top-level chunks, but the real `avih` lives inside `LIST hdrl`.
**Consequence:** every spec-compliant AVI is rejected.
**Verified fix (sketch):** descend into `LIST` chunks to find `avih`. Agent-verified; re-run on main.

### 44. `parser-media/src/av-container.ts:137` — Matroska width/height unreachable; many → 422
**Lens:** Assumptions
**Confidence:** agent — a WebM with dimensions but no Duration → `422 "No Matroska metadata"`; an unknown-size segment → 422; the known-size control succeeds but reports no width/height despite PixelWidth present.
**Violation scenario:** the walker descends into Segment/Info/Tracks/Video (0xE0) but not TrackEntry (0xAE), where PixelWidth (0xB0)/Height (0xBA) live; an unknown-size element returns early (`:137`).
**Consequence:** dimensions never extracted; files without Duration → 422.
**Verified fix (sketch):** descend into TrackEntry; handle unknown-size elements. Agent-verified; re-run on main.

### 45. `parser-media/src/av-container.ts:102` — ASF double-counts the 24-byte header
**Lens:** Boundary
**Confidence:** agent — File-Properties-first ASF → ok; Content-Description-first → `422 "Missing ASF file properties"`.
**Violation scenario:** `offset += 24 + size` but the ASF object size already includes its 24-byte header, so after the first object the walk is misaligned unless File Properties happens to be first.
**Consequence:** order-dependent 422 on valid ASF.
**Verified fix:** `offset += size;` (the size is inclusive). Agent-verified; re-run on main.

### 46. `parser-media/src/wmf.ts:55` — only placeable WMF accepted
**Lens:** Assumptions
**Confidence:** agent — a standard non-placeable WMF → `422 "Not a WMF/EMF file"`.
**Violation scenario:** the parser accepts only the placeable magic `0x9ac6cdd7` or EMF; standard WMF (`01 00 09 00 …`) is rejected.
**Consequence:** common WMF files → 422.
**Verified fix (sketch):** also accept the standard WMF header. Agent-verified; re-run on main.

### 47. `parsers/src/mbox.ts:44` — whole mbox decoded UTF-8; 8-bit bytes corrupted
**Lens:** Write/Read Asymmetry
**Confidence:** agent — the same message gives `"café crème"` as `.eml` but `"s cafï¿½ crï¿½me"` inside `.mbox`.
**Violation scenario:** the whole mbox is decoded as UTF-8 (fatal:false) and each message re-encoded, so any 8-bit byte that is not valid UTF-8 becomes U+FFFD before the part's charset applies.
**Consequence:** lossy text for any non-UTF-8 mbox.
**Verified fix (sketch):** split on bytes, or round-trip through latin1 (lossless). Agent-verified; re-run on main.

### 48. `parsers/src/tnef.ts:12` — spec-format TNEF produces empty output
**Lens:** Write/Read Asymmetry
**Confidence:** agent — a spec-format winmail.dat → `OK text=""`, `dc:title=null`.
**Violation scenario:** in MS-OXTNEF the attribute ID's high word holds the type (attSubject = 0x00018004) and each attribute ends with a 2-byte checksum; the reader compares the full u32 against 0x8004 and never skips the checksum, so nothing matches and every later attribute misaligns. 0x800d is attPriority, not an HTML body.
**Consequence:** every real winmail.dat yields empty output.
**Fix:** ID = `tag & 0xffff`; skip the 2-byte checksum; read bodies from attMsgProps. **The existing `tnef.test.ts` encodes the same non-spec layout**, so tests must be reworked against real fixtures (check 2). Medium effort. Agent-verified; re-run on main.

### 49. `parsers/src/rtf.ts:201` — each `\'xx` decoded alone; double-byte code pages lost
**Lens:** Boundary
**Confidence:** agent — cp932 `\'82\'a0` (あ) → "��"; cp936 `\'c4\'e3` (你) → "��"; cp1252 `\'e9` → "é" (correct).
**Violation scenario:** each `\'xx` is decoded with a fresh `TextDecoder`, so double-byte code pages (932/936/949/950) lose every multi-byte character.
**Consequence:** CJK RTF content is corrupted.
**Verified fix (sketch):** buffer consecutive `\'xx` bytes and decode them together. Agent-verified; re-run on main.

### 50. `parsers/src/web.ts:174` — XLIFF/TMX always decoded UTF-8, ignoring the XML declaration
**Lens:** Cross-Implementation Divergence
**Confidence:** agent — an ISO-8859-1 XLIFF → "caf�" while RSS (which honors the declaration) → "café".
**Violation scenario:** `readText` always uses UTF-8; `feed.ts`/`xml.ts` honor the declared encoding via `detectXmlEncoding`, which `web.ts` never calls.
**Consequence:** non-UTF-8 XLIFF/TMX corrupted.
**Verified fix (sketch):** `createDecoder(detectXmlEncoding(prefix))` as the siblings do. Agent-verified; re-run on main.

### 51. `parsers/src/dicom.ts:94` — undefined-length SQ breaks the whole tag walk
**Lens:** Boundary
**Confidence:** agent — `PatientName=Doe^Jane` with no SQ, but `null` when an undefined-length (0008,1110) SQ precedes it.
**Violation scenario:** an undefined length (0xFFFFFFFF), standard for sequences, hits `if (length === 0xffffffff … ) break` and terminates the walk.
**Consequence:** any DICOM with an undefined-length SQ before a wanted tag loses later metadata.
**Verified fix (sketch):** on an undefined-length SQ, scan forward to the sequence delimiter (FFFE,E0DD) and continue. Agent-verified; re-run on main.

### 52. `parser-archive/src/plist.ts:42` — LimitExceeded masked as MalformedDocument
**Lens:** Error Paths
**Confidence:** agent — observed as a `MalformedDocumentError` where the output cap fired.
**Violation scenario:** `JSON.stringify(parsed)` + `xhtml.element` can throw `LimitExceededError` from the output cap; the catch at `:41` re-wraps it as `MalformedDocumentError` (both 422, but wrong `code` and `recoverable`).
**Verified fix:** `if (error instanceof LimitExceededError) throw error;` before the rewrap (as `util.ts:100` does). Agent-verified; re-run on main.

### 53. `parser-media/src/font.ts:149` — dead AFM validity check; garbage accepted
**Lens:** Error Paths
**Confidence:** main — a non-font input containing the substring `FontName ` returned `200 OK` as `application/x-font-adobe-metric` with empty text and no error.
**Violation scenario:** `if (Object.keys(fields).length === 0)` is always false — `fields` is a 5-key const literal — so the "empty metrics" guard is dead. Any file containing `FontName ` or starting with `StartFontMetrics` is treated as AFM.
**Consequence:** silent false-positive parse (200, empty) instead of a decline/malformed.
**Verified fix (sketch):** track whether any metric field was actually set and throw `MalformedDocumentError` when none were. Verified the dead branch on main; the fix itself not re-driven.

### 54. `cli/src/main.ts:147` — every runtime error exits 1
**Lens:** Error Paths
**Confidence:** main — argument errors exit 2 (`--bogus` → exit 2), but a malformed input (`bad.gz` → "Invalid GZIP stream") and a missing file (`nope.txt` → ENOENT) **both** exit 1.
**Violation scenario:** the final `catch` returns 1 for every error regardless of class, so scripts cannot distinguish "bad input" (data) from "file not found" (environment) from "internal error".
**Consequence:** poor CLI composability; no exit-code contract.
**Verified fix (sketch):** map `RipstreamError` subclasses to distinct exit codes (e.g. malformed/unsupported → 3, missing dependency/file → 4, internal → 1), documented in `--help`. Verified current behavior on main.

### 55. `cli/src/main.ts:191` — `--port abc` → NaN → raw `validatePort` crash
**Lens:** Boundary
**Confidence:** main — `serve --port abc` printed a Node `validatePort` stack trace and exited 1 (uncaught; the serve branch has no try around `listen` at `:63`).
**Violation scenario:** `port = Number(rest[++index] ?? "9998")` yields NaN for non-numeric input; the serve branch calls `listen(NaN)` with no validation, so Node throws synchronously outside any handler.
**Consequence:** an unfriendly crash with a stack trace instead of a usage error.
**Verified fix:** validate the parsed port (`Number.isInteger(port) && port >= 0 && port <= 65535`) and exit 2 with a message otherwise. Verified current behavior on main.

### 56. `cli/src/main.ts:129` — `-o jsonl` silently emits plain text
**Lens:** Assumptions
**Confidence:** main — `-o jsonl a.txt` emitted the plain text body (not JSONL); the non-recursive branch routes `jsonl` to the plain-text arm, and `:129` has `options.output === "jsonl" ? "\n" : "\n"` (both branches identical — dead ternary).
**Violation scenario:** `jsonl` is accepted by the arg parser but only implemented for the recursive path; the non-recursive path falls through to plain text.
**Consequence:** a documented option silently produces the wrong format.
**Verified fix (sketch):** implement JSONL for the non-recursive path, or reject `jsonl` without `--recursive` with a usage error. Verified current behavior on main.

---

## Fragile Code (Works Now, May Break Later)

### F1. `core/src/handlers/xhtml.ts:90` — `pendingStarts` flush is super-linear
**Lens/Confidence:** Time / main — 160k pending inline-start elements flushed in 10 165 ms; the HTML depth cap throws `LimitExceeded` at 2000 within ~20 ms, so the HTML path is safe today.
**Breaking scenario:** a non-HTML producer that emits many `TRIMMED_INLINE` starts without the depth cap (a new parser targeting this handler) reintroduces the stall.
**Recommendation:** bound `pendingStarts` length and flush incrementally.

### F2. `parser-office/src/iwork13.ts:65` — spread overflow in the IWA sink
**Lens/Confidence:** Boundary / agent — `strings.push(...printable(decoded))` crashes past ~125k elements (same as #19). Unreachable *today* only because the type is not routed (#20).
**Breaking scenario:** shipping #20's type registration without the sink fix makes it live — hence they ship together.
**Recommendation:** the capped for-of loop from #19. (This is the F-side of #20/O3.)

### F3. `parser-office/src/cfb.ts:268` — mini-stream allocates the declared size
**Lens/Confidence:** Write/Read + Env / agent — `new Uint8Array(size)` where `size` is an unvalidated header uint32 gated only by `miniCutoff`; a declared `0xFFFFFFF0` "read OK" at 4 294 967 280 bytes on this Node build (lazy/virtual zero-fill, so no crash).
**Breaking scenario:** a runtime with a smaller max ArrayBuffer (constrained V8 cage / 32-bit / non-Node) throws a raw `RangeError` → 500; and ~4 GB of virtual address space per request is a DoS amplifier.
**Recommendation:** clamp to `min(size, miniContainer.byteLength, data.byteLength)` and/or `maxEmbeddedResourceBytes`.

### F4. Synchronous parsers never checkpoint `ctx.signal` — class
**Lens/Confidence:** Time/Signal / main + agent — only `pdf.ts`, `dbf.ts`, `html.ts` check the signal in loops; office (0 signal refs across 19 files), archive decompressors (`uncompressZ`, bzip2, snappy frames), and most `parsers` loops run synchronously. Demonstrated by #5, #7–#10, #11, #12.
**Breaking scenario:** any new within-budget synchronous loop becomes an uninterruptible stall; `maxParseMillis` is structurally unable to fire.
**Recommendation:** interleave `signalCheckpoint(ctx)` into long synchronous loops as a standard, and/or move heavy parsers into `runIsolatedTask`.

### F5. `parsers/src/xml.ts:116`, `csv.ts:52` — `events.shift()` drain is O(n²)
**Lens/Confidence:** Time / agent — `<a/>`×25k…800k took 101…3790 ms (super-linear within one in-memory chunk); RTF tokenize is linear but uninterruptible (~17 s at the 100 MiB cap). `html.ts:155` already uses an index cursor.
**Breaking scenario:** larger in-memory XML/CSV inputs (or a higher body cap) turn the `shift()` drain into a visible stall.
**Recommendation:** use an index cursor (as `html.ts` does) and add `signalCheckpoint`.

### F6. `parser-archive/src/plist.ts:44` — XML-plist branch raw saxes `Error` → 500 (latent)
**Lens/Confidence:** Error Paths / agent — the XML branch is unwrapped; malformed XML → raw `Error` → 500. **Unreachable today** because this port's generated registry has no glob/magic for `application/x-plist` and `trustContentTypeHeader` defaults false.
**Breaking scenario:** a registry regen that adds the upstream `*.plist` glob, or a pipeline setting `trustContentTypeHeader:true`, makes it live.
**Recommendation:** wrap the XML branch (and `xmlPlistLines`) to rethrow `MalformedDocumentError`; add a saxes error handler.

### F7. `core/src/metadata-utils.ts:128` — `parseXmpPacket` regex super-linear
**Lens/Confidence:** Time / main (no in-repo caller) — the element regex went 20k→160k chars 37→2374 ms; the attribute regex 8k→64k 21→1336 ms.
**Breaking scenario:** if any parser routes untrusted XMP through this exported helper (today none does), it becomes a stall.
**Recommendation:** cap input length; prefer a streaming/bounded parse. Describe as a super-linear class, no literal pattern shipped.

### F8. `core/src/security.ts:42` — `compileSafeRegex` guard is bypassable
**Lens/Confidence:** Time / main (no in-repo caller) — two textbook catastrophic-backtracking classes that the `NESTED_QUANTIFIER`/quantified-alternation checks do **not** catch each took 6–7 s on a 27-char input: (a) a quantifier nested inside *two* groups, and (b) a bounded outer quantifier (`{1,N}`) over a quantified inner group. Only `index.ts` re-exports it; no internal caller.
**Breaking scenario:** if a future feature exposes `compileSafeRegex`/`safeRegexTest` to user patterns (its evident purpose), these bypass classes are a ReDoS.
**Recommendation:** do not rely on structural denylisting; run user regexes under a timeout/worker, or use a backtracking-free engine (RE2). Bypass *classes* described above without shipping a weaponizable corpus.

### F9. `parser-db/src/index.ts:52`, `columnar.ts:11` — optional deps imported outside try
**Lens/Confidence:** Env / agent — `await import("sql.js")` (`:52`) and static `import … from "hyparquet"` are outside any try; a resolution failure yields raw `ERR_MODULE_NOT_FOUND` → 500. `package.json` lists both as hard `dependencies`, yet a comment calls sql.js "optional" — a mismatch. (PDF handles this correctly → `MissingDependencyError`.)
**Breaking scenario:** a broken/partial install (or making them truly optional) turns a missing dep into a 500 instead of `MissingDependencyError` (500 but with the right code/cause).
**Recommendation:** wrap the imports and map to `MissingDependencyError`; reconcile the dependency classification.

### F10. `parser-pdf/src/pdf.ts:136/167` — abort-listener race
**Lens/Confidence:** State Machine / agent — the abort listener is added (`:167`) *after* the worker spawn (`:146`) and the pre-spawn `throwIfAborted` (`:136`); an abort landing in that window is missed until the per-page `throwIfAborted`.
**Breaking scenario:** a client disconnect/timeout in the spawn window lets the parse overrun by up to `pageTimeoutMs`.
**Recommendation:** register the listener before/at spawn, or re-check `signal.aborted` immediately after spawn.

### F11. `parser-pdf/src/pdf.ts:315` — worker clean-exit-before-ready → 408 not 422
**Lens/Confidence:** State Machine / agent — only a non-zero exit fails; a clean exit before posting "ready" leaves the parent waiting out `pageTimeoutMs` → 408.
**Breaking scenario:** a worker that exits 0 early (OOM-killed child reported as 0, early return) stalls to timeout instead of a prompt malformed error.
**Recommendation:** treat "exit before ready" as a malformed/!ready failure, not a timeout.

### F12. `parser-media/src/image.ts:269/324` — `new DataView(data.buffer, data.byteOffset)` without byteLength
**Lens/Confidence:** Boundary / agent — safe today because `data` is a fresh exact-size buffer.
**Breaking scenario:** if ever fed a subarray or pooled buffer, the DataView over-reads into neighboring bytes.
**Recommendation:** always pass the explicit `byteLength`.

### F13. `parser-media/src/ocr.ts:64` — Tesseract spawn has no timeout/signal (not registered by default)
**Lens/Confidence:** Time / agent — `runTesseract` spawns with no timeout and no abort wiring; a hanging `tesseract` left the parse "pending" at 5 s with a leaked temp dir; spawn error drops the `cause`. Not registered by default.
**Breaking scenario:** registering the OCR parser makes an external-process hang a whole-server hang.
**Recommendation:** add a child timeout + kill, wire `ctx.signal`, clean up the temp dir in `finally`, preserve the error cause. (This is a BUG the moment it is registered.)

---

## Already Guarded (Reference)

Candidates cleared by verification — cite the guard:

- **ZIP bombs / entry count / traversal** — `parser-archive/src/zip.ts:40-63` (count/total/per-entry/ratio) + `safeEntryName` `:83`; asserted by `safety.test.ts`/`compressor-limits.test.ts`.
- **tar bombs / traversal** — `tar.ts:60-89` + `safeEntryName` `:68`.
- **gzip/brotli/xz/lz4 bombs** — `bounded-inflate.ts:72` `inflateBounded` + `BudgetedSink`; `CompressorParser` wraps non-limit errors (`compressor.ts:104`); lz4 pre-checks `decompressBound` (`:214-219`).
- **Snappy huge declared length** — snappyjs validates before allocating; `compressor.ts:270` caps each chunk at 65536 + `BudgetedSink`; asserted by `compressor-limits.test.ts`.
- **ISO9660 cycles/depth/zero-advance** — `visited` set (`iso9660.ts:64`), `maxNodeDepth` (`:59`), `MAX_ENTRIES`, record length ≥34 forces advance (`:110`).
- **CPIO NaN fields** — hex `parseInt`→NaN terminates the loop.
- **AppleSingle OOB** — header length check (`apple-single.ts:32`), per-entry `offset+12>byteLength` break (`:44`), fork subarray clamp (`:49`).
- **ZIP/OLE2 attacker-offset reads** — bounded by file size; zip64 loop breaks on short read/bad signature (`containers/zip.ts:117-134`); OLE2 DIFAT/dir loops have `seenDifat`/`visited` cycle guards (`ole2.ts:44-49/72-73`).
- **Regex magic ReDoS** — all 42 magic regex rules are `^`-anchored and tested at a single offset; 256-byte + 64 KiB fuzz, worst case 68 ms, zero throws. (Correctness caveat in Review: `^`-anchoring diverges from Tika's `find()` for range-offset rules.)
- **CFB cyclic FAT/DIFAT/mini chains** — `seen` sets at `cfb.ts:193/236/274`, `visited`+depth cap at `:109/:112`, `MAX_ENTRIES` at `:296`, chain reads capped at `MAX_ENTRIES*sectorSize` and clamped to data.
- **CFB FAT allocation from uint32** — bounded by `#readFat` check `:210`; DIFAT count vs `maxSectors` `:187`.
- **Office `offset += size` zero/negative loops** — every record walker advances by a fixed minimum (`excel-binary.ts:216`, `word-binary.ts:148/153`, `powerpoint:130`, `opc.ts:256`, `iwork13 decodeIwa:90`, `property-sets:115/120`).
- **Office OOB reads** — `readUInt*` use `data[i] ?? 0` and `subarray`/`slice` clamp.
- **bounded-unzip ratio/size/entry enforcement** — per-entry + package `OutputBudget` on produced bytes (`bounded-unzip.ts:52/74-80`), `maxZipEntries` during scan, truncation → MalformedDocument.
- **XML-driven stack overflow (office)** — `xml-tree.ts:35` throws at depth >256; saxes propagates the throw (verified depth 300 and 100000 → 422).
- **mp4 `findBox`** — size<header and size==0 break (`mp4.ts:103`); 64-bit via `Number(BigInt)`.
- **flv AMF recursion** — unbounded but `applyScript` try/catch catches the stack-overflow RangeError (1 000 000-deep → ok, no metadata).
- **EBML depth** — `MAX_EBML_DEPTH=64` (`av-container.ts:126-131`).
- **TIFF/JPEG dimension reads** — bounds-checked (`:177`, `:406`).
- **franc language input** — capped at `MAX_LENGTH=2048` (`language/src/index.ts:108`).
- **PDF** — `maxInputBytes` enforced (late, #29), worker memory 256 MB + 20 ms watchdog, `pageTimeout` 30 s, per-page `throwIfAborted`; missing `pdfjs-dist` → `MissingDependencyError`; preflight quadratic runs *in the worker* so `pageTimeout` catches it (verified e2e → 408, main loop unaffected).
- **SQLite output char cap** — `OutputLimitContentHandler` fires (422) — but only *after* the WASM materialization in #6.
- **WARC Content-Length** — negative/unsafe rejected (`web.ts:50-54`); an overstated length is clamped by `subarray`.
- **XML DTDs** — rejected at `xml.ts:58`; saxes does not expand internal-subset entities (`maxXmlEntityExpansions:0`).
- **Linear NUL stripping** — `dicom.ts:111`, `tnef.ts:142` (the helper #7 should reuse).
- **DBF** — guarded at `dbf.ts:84`; covered by `adversarial.test.ts:117-155`.
- **ICC tag count** — capped at `icc.ts:66`.
- **Markdown** — covered by `adversarial.test.ts:87-91`.
- **Mail/RTF/ASN.1 nesting** — capped at `mail.ts:80`, `rtf.ts:163`, `asn1.ts:76`.
- **RDF prefix expansion** — ropes, no amplification; 422 at the output limit.
- **`String.fromCharCode(...)` stack overflow** — spreads are ≤5 bytes or chunked at 4096 (`magic.ts:308`, `text-encoding.ts:133`).
- **Path traversal via cpio/ar/iso/apple-single names** — names used only as metadata/`<h1>` text, never as filesystem paths.
- **`readBody` size cap** — `server/src/index.ts:462` throws `REQUEST_TOO_LARGE` (413) past `maxBodyBytes`.
- **pinned-fetch SSRF** — `safeFetch`/`pinnedFetch` pin resolved addresses (the status-range gap is #37).

---

## Refutation Log

Findings and sub-claims killed or corrected in Step 5 — kept to show coverage and prevent re-flagging:

- **"pipes loses documents in CONTENT_ONLY"** — **Refuted.** 40 docs at concurrency 4 emitted all 40 (43 `emit` calls = N + concurrency − 1, with duplicate boundary emits, not losses). The *real* bug is reorder/duplicate (#26) and, separately, UNPACK-mode data loss (#27).
- **"small `maxQueue` < concurrency makes workers exit early / lose work (F9/PipesEngine)"** — **Refuted.** `maxQueue=1, concurrency=4` emitted all 12 docs with `peakInflight=1` (serialized throughput, no lost work); `maxQueue=2` → peak 2; `maxQueue=64` → peak 4. It is a throughput limitation, not a correctness bug. Removed from Fragile.
- **"concurrent checkpoint `mark` corrupts the file"** — **Refuted** at 300 concurrent marks (valid file). The surviving finding is the non-atomic write + silent "fresh" fallback (#33); corruption above 512 KiB is untested (Review).
- **"EMFILE at the fd limit crashes the server"** — **Refuted.** libuv's EMFILE handling keeps the server alive at the fd limit.
- **"CompositeParser silently resolves when all candidates decline is unreachable"** — **Reversed.** It is reachable via the iWork'13 type gap (#20); the all-decline silent-resolve at `parser.ts:112-128` is a real latent correctness hole once a type routes to only-declining parsers.
- **"XHTML `pendingStarts` is a live DoS"** — **Corrected** to FRAGILE (F1): the HTML depth cap throws at 2000 (~20 ms) before the super-linear flush matters.
- **"iWork'13 (#20) and XML-plist (F6) are reachable BUGs today"** — **Corrected:** both downgraded — #20's crash needs the type fix to be reachable (so it is a routing BUG + a FRAGILE sink); F6 is latent (no `*.plist` glob/magic in this registry).
- **"C14 is embedded-only"** — **Corrected:** the whole-buffer accumulation also affects top-level `TextParser` (#22), not just embedded children.
- **"M3's `substr(col,1,N)` bounds memory"** (code comment at `parser-db/src/index.ts:71-72`) — **Refuted:** SQLite materializes the generated expression in WASM before truncation (#6).
- **"OCR exit-vs-close truncates stdout"** — **Not observed** (0/30 runs); the real OCR issues are the missing timeout/signal/cleanup (F13).
- **"dist is stale and findings may be against old code"** — **Cleared:** only `parser-pdf/src/pdf-worker.ts` is newer than its dist, and no finding depends on it.
- **"the bplist bomb needs `?maxParseMillis`"** — **Corrected:** the server ignores that query param; the default/configured `maxParseMillis` is what fails to fire (it is a timer vs a synchronous loop).
- **"A1 latency is ~50 ms"** — **Corrected:** the 50 ms timer fired at +723 ms; the measurement was the timer-fire time, not parse latency.
- **"P-04 (asn1) is unreachable without a trusted content-type"** — **Corrected:** the filename is client-controlled (`?filename=`), so a `.p7s`/pkcs7 name reaches it.
- **"TextParser streams, so #22 doesn't apply to it"** — **Qualified:** it streams per *line*; a newline-free input is buffered whole (#22).
- **"M6 (PDF pre-cap spill) exposes the server"** — **Refuted:** the 100 MiB body cap is below the 512 MiB PDF cap, so the server is bounded; library/CLI embedders are the exposure (#29).

---

## Needs Human Review

Including all Suspected-confidence items and reachability gaps:

- **O4 — Word `.doc` text past ~2²⁹ chars → `RangeError` 500** (`word-binary.ts:121`). Primitive verified (`text += 32M-char chunk` throws at len≈503M); not driven e2e (needs a ~50 MB effective stream). Same class as #22, less amplified.
- **A7 — `readAll`'s `limit` param is never passed** (11 call sites, default `Number.MAX_SAFE_INTEGER`). Bounded by the server body cap; unbounded for library/CLI embedders. Consider deriving a limit from `ctx.limits`.
- **Metadata has no value-**count** cap** (`metadata.ts` `add` truncates length only). Root cause shared by #4 and M17; decide a global cap.
- **M17 — JPEG COM-segment metadata amplification** (`image.ts:178`). 32 MB of COM segments → 6.7M metadata values, +211 MB heap, 200 OK. Bounded by the body cap; fixed by the metadata count cap.
- **`maxOutputChars` → 422 vs `WRITE_LIMIT_REACHED` → 200** — two output-limit behaviors with different statuses; confirm which the contract intends.
- **`ParseOptions.contentType` (`ripstream.ts:26`) is never read** — dead option or missing wiring?
- **Non-`RipstreamError` classes → 500 generally** — the central-backstop decision (#21) determines whether this stays.
- **Worker exits 0 without posting (`runIsolatedTask`)** — waits out the timeout rather than failing fast (sibling of F11).
- **`/language` and `/translate` have no outer timeout** (`server/src/index.ts`) — slot held for the full retry/backoff window (#30).
- **`/async` stores `String(error)`** (`:246`) — loses the error code/structure for the status endpoint.
- **Memory defaults** — `maxConcurrent 100 × maxBodyBytes 100 MiB` plus multipart ×4 copies is a large aggregate ceiling; review defaults for small hosts.
- **Health endpoints gated by the semaphore** — companion to #16; confirm the exemption doesn't bypass required auth.
- **Client disconnect doesn't abort the parse** — the server passes `AbortSignal.timeout` but not a disconnect signal, so a client hang-up still runs the parse to completion.
- **Error-message leakage at `index.ts:171`** — the generic 500 path echoes `error.message`; audit what parser messages can contain.
- **`buildPipesConfig` doesn't validate mode/urls** — malformed pipe config shape handling.
- **`ModuleEmitter` created per document; `HttpEmitter`/`HttpFetcher` have no timeout or cap** — pipes emitters/fetchers lack the `safeFetch` bounds.
- **`embedded.ts:116-118` reports a missing parser as `LimitExceeded`** — wrong code for "no parser".
- **`streams.ts:104-122` throws a plain `Error` and doesn't cancel the body** on a bad URL-input response — 500 + socket retention (sibling of #30/#37).
- **Markdown `<a>` swallows text** — link text handling in the markdown parser.
- **url-security minor items** — redirect hop counting, scheme allowlist edges.
- **`JsonFetcher`/`CsvFetcher` assumptions** — shape/row validation in pipes fetchers.
- **P-16 — one bad message fails the whole mbox** (`mbox.ts:53-83`). An unescaped `From ` body line splits a message and 422s the bundle; Tika isolates per message.
- **M14 — Avro/ORC types unknown to the registry** — `Obj\x01`/`ORC` → `application/octet-stream` → 415; several columnar/RAW/font registered type strings are dead (RAW still works via TIFF magic fallback).
- **M22 — hyparquet unsupported codec / attacker-controlled page size** — plain `Error` → 500 for GZIP/ZSTD without `hyparquet-compressors`; `new Uint8Array(uncompressed_page_size)` from the header before validation. Not fully driven.
- **sql.js WASM RSS retained across parses** (#6 residual) — a memory-budgeted worker is the durable bound.
- **#33 corruption above 512 KiB** — concurrent `mark` untested at larger sizes.
- **FileSystemFetcher follows symlinks** — path containment in the pipes filesystem fetcher.
- **Regex magic `^`-anchoring diverges from Tika's `find()`** — range-offset rules (e.g. `audio/x-aac 512:8192`) match only at the first offset → missed detections.
- **excel `readSheet` builds the full cell map before `MAX_SHEET_CELLS`** (~16× transient); `legacy-formats.ts:73` materializes the whole `[...matchAll]` before `.slice(0,500)`.
- **`seek` throws `RangeError`** on some inputs (`ripstream-input-stream`) — audit for a mapped error.
- **Raw zlib errors in office `opc.ts` not wrapped** — may escape as 500 (sibling of #21).
- **`__proto__` as an rmeta key / metadata coerce divergence / XML escaping** — serialization edge cases in `serializeRmeta` and metadata coercion.
- **The server ignores the `maxParseMillis` query param** — documented-looking knob that has no effect (confirm intended).
