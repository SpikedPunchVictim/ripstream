# CLI start-up: the bundle and the compile cache

A `ripstream parse` of a small file is a process start, and most of what that costs is loading code. Built per file
(`pnpm build`, tsc), the CLI loads about 486 small modules before it parses anything. The CLI package therefore also ships
the same code as a **split bundle**, and `bin/ripstream.js` runs that one when it can (tikajs-jjat; measured in the
spike tikajs-cp6g).

## What ships

```
@spikedpunch/ripstream-cli
  bin/ripstream.js     the command: picks the bundle or dist, switches on the compile cache
  dist/                per-file build: the library entry (main.js) and the fallback (run.js)
  bundle/dist/         the bundle: run.js, 3 sibling entries, 43 chunks (about 4.4 MiB of unminified code)
  bundle/data/         the language model (langdetect-*.bin), found as ../data/ from the chunks
```

The bundle is built by `pnpm build:bundle` (`scripts/build-cli-bundle.ts`, esbuild) from the `dist` that `pnpm build`
makes, so run them in that order. `packages/cli/bundle/` is git-ignored; CI builds it before the tests. The library
(`exports`, `main`, `types`) is `dist` as before: the bundle is only for the command, and the public API is unchanged.

- **Split, not one file, not minified.** One file parses code a plain `parse` never runs (13 ms slower in the spike);
  minifying is slower again (8 ms) and mangles error class names that end up in metadata, so names are kept. `parse`,
  `detect` and `metadata` load 11 files; isolation, pipes, the server and the language model are lazy chunks, as they are
  lazy `import()`s in `dist`.
- **Sibling entries.** Code that finds a file next to itself by `import.meta.url` needs that file to be an entry in the
  same directory: `isolation-child.js` (isolated parsing), `probe-child.js` (the isolation self-test) and
  `parse-worker.js` (`pipes --workers`). The build emits exactly those next to the chunks. `--isolation strict` and
  `pipes --workers 2` run from the bundle (tests: `packages/cli/test/bundle.test.ts`).
- **Left external**, as real packages in `node_modules`: `pdfjs-dist` (finds its standard fonts by `require.resolve`, and
  the canvas block in `bundle-standard` recognises it by `/pdfjs-dist/` in the importer's URL, which inlined code would
  not have), `sql.js` (its wasm sits next to its entry), `xz-decompress` (the archive parser resolves it by name at run time and loads
  it afresh for each document, so a bundler cannot inline it: without the package every XZ file read as malformed),
  `@napi-rs/canvas` and `cld3-asm` (native or optional). So the CLI package depends on `sql.js` and `xz-decompress` and has `pdfjs-dist` as an optional peer, as `parser-pdf` does; a package manager that links
  strictly would not otherwise let the bundle find them. Install them as before: PDF needs `pdfjs-dist` installed.

## Which one runs

`bin/ripstream.js` runs the bundle when `bundle/dist/run.js` exists, and `dist` otherwise (a checkout that has only run
`pnpm build`, which is what the tests of `dist` rely on). To run `dist` anyway, set `RIPSTREAM_NO_BUNDLE=1` (any value but
empty or `0`). Output is identical (below); the switch is for diagnosing, not for correctness.

In a checkout, a bundle built before a code change is stale: it keeps running the old code until `pnpm build:bundle` runs
again. Tests that spawn the bin use whichever is there; `bundle-identity.test.ts` fails when the two disagree.

## The compile cache

Before it loads the bundle the stub calls `module.enableCompileCache()`, so V8's compiled code for the bundle is kept and
a second run skips compiling. The directory is, in order:

1. `NODE_COMPILE_CACHE`, if set (Node's own variable);
2. otherwise `ripstream-compile-cache-<uid>` under `os.tmpdir()`, created with mode 0700. If that directory exists but is
   not ours or is a link, the cache is left off: code V8 loads from a cache must not be plantable by another user of a
   shared `/tmp`.

It is never inside the package. A directory that cannot be written (read-only disk, no space, a path under a file) only
costs the speed-up: `enableCompileCache` reports a status and does not throw, and the stub ignores any error besides
(tested). Entries are keyed by Node version and file content, so an upgrade or a new build starts a new set. The cache is
about 1.5 MiB after one run, and is written when the process exits normally. Enabling it does not set `NODE_COMPILE_CACHE`, so
the isolation children it starts do not use it unless you set that variable yourself.

The first run with an empty cache is slower, once: 188 ms against 144 ms for `parse` of a small text file (below).

## Measured

`node scripts/bench-cli-start.ts 30` (this is what produced the table). `ripstream parse <file>` as a fresh process,
30 spawns each after 3 warm-up rounds, dist and bundle interleaved so that machine noise hits both, both started through
`bin/ripstream.js` (dist with `RIPSTREAM_NO_BUNDLE=1`; the bundle with a warm compile cache). Milliseconds, median
(p25-p75, p95). Apple M2 Pro, macOS, Node 24.18; `node -e ''` takes 57 on the same machine. The inputs are the smallest
of their kind: a one-line text file, a one-line JSON file, the smallest `.docx` fixture, a one-page PDF.

| input | dist | bundle + cache | bundle / dist |
|---|---|---|---|
| txt | 231 (223-238, 254) | 144 (141-146, 151) | 0.62 |
| json | 222 (217-229, 239) | 140 (138-145, 152) | 0.63 |
| docx | 249 (241-256, 277) | 157 (153-163, 184) | 0.63 |
| pdf | 281 (276-295, 304) | 193 (189-196, 209) | 0.69 |

Empty compile cache, `parse` of the text file, 10 runs: median 188, range 183-196.

From the spike (tikajs-cp6g, same shape, text file, p50): dist 265, dist with the compile cache alone 232, split bundle
170, split bundle with cache 144. The bundle does most of the work (file resolution and reading, not parsing: 486 modules
against 11); the cache takes off about 25 ms more. These measure start-up. Parsing a large document costs what it
cost, so they do not change throughput.

## Checks

- `packages/cli/test/cold-start.test.ts`: `dist` (and source) load no isolation, pipes, server, language or networking code
  for a plain `parse`.
- `packages/cli/test/bundle-cold-start.test.ts`: the same for the bundle, from its chunk graph (the first test's URL check
  cannot see hashed chunks): the entry's static imports hold none of those packages, and a run loads only that graph.
- `packages/cli/test/bundle-identity.test.ts`: `parse` and `parse -r` print the same bytes and exit with the same code on
  `dist` and the bundle, over the first fixture of each extension and a generated PDF (the spike compared 145 files, 870
  runs, none different).
- `bundle-budget.json` has a `cli-bundle` line (KiB of `bundle/dist`; not part of `total`, which counts `dist`);
  `pnpm bundle:check` enforces it once the bundle is built.
- All of the bundle tests skip, saying so, when the bundle is not built.

Not covered: Windows, and several processes sharing one cache directory at the same moment (Node's cache writes are
file-by-file; not tested here).
