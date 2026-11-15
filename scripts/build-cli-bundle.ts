// Builds the CLI's code-split bundle into packages/cli/bundle (git-ignored), from the `dist` that `pnpm build` makes.
// Why, the layout and the numbers: docs/cli-startup.md. Run with `pnpm build:bundle` after `pnpm build`.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "packages/cli/bundle");

// The CLI itself plus every file the code finds next to itself with `new URL("./name.js", import.meta.url)`. Those have
// to be entries (not chunks) with exactly these names, in the same directory as the chunks that look for them:
//   isolation-child   bundle-standard/src/isolation.ts   isolationChildPath()
//   probe-child       isolation-node/src/probe.ts        the isolation self-test
//   parse-worker      pipes/src/workers.ts               createParsePool()
const entries = [
  "packages/cli/dist/run.js",
  "packages/bundle-standard/dist/isolation-child.js",
  "packages/isolation-node/dist/probe-child.js",
  "packages/pipes/dist/parse-worker.js",
].map((entry) => join(root, entry));

// Packages left as real files in node_modules because they find their own assets or must be seen by name:
//   pdfjs-dist       standard fonts via require.resolve, and the canvas block (bundle-standard block-pdfjs-canvas.ts) matches
//                    "/pdfjs-dist/" in the importer's URL; inlined, it would silently stop blocking the native canvas
//   @napi-rs/canvas  native addon (only pdf.js asks for it)
//   sql.js           its wasm sits next to its entry file
//   cld3-asm         optional backend, imported by name when asked for
const external = ["pdfjs-dist", "@napi-rs/canvas", "sql.js", "cld3-asm"];

const missing = entries.filter((entry) => !existsSync(entry));
if (missing.length > 0) {
  console.error(`build-cli-bundle: not built yet (run \`pnpm build\` first):\n${missing.map((m) => `  ${m}`).join("\n")}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
const result = await build({
  entryPoints: entries,
  outdir: join(out, "dist"),
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  // Not minified: parsing code a command never runs costs less than minifying costs back, and names stay readable in stack traces.
  // Names are kept because error class names end up in metadata (`.name`).
  keepNames: true,
  // Dependencies written as CommonJS call `require`, which an ES module does not have.
  banner: { js: "import{createRequire as __ripstreamRequire}from'node:module';const require=__ripstreamRequire(import.meta.url);" },
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  metafile: true,
  logLevel: "warning",
});

// The language model, read as `../data/langdetect-*.bin` from the module that holds charsoup: `data/` next to `dist/`.
const modelDirectory = join(root, "packages/language/data");
mkdirSync(join(out, "data"), { recursive: true });
for (const file of readdirSync(modelDirectory)) copyFileSync(join(modelDirectory, file), join(out, "data", file));

const files = Object.keys(result.metafile.outputs);
const bytes = files.reduce((sum, file) => sum + statSync(join(root, file)).size, 0);
console.log(`cli bundle: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB of code in packages/cli/bundle/dist`);
