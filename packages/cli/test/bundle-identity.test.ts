import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { test } from "node:test";
import { BUNDLE_ENTRY, DIST_ENTRY, ROOT, SKIP_WITHOUT_BUNDLE } from "./bundle-support.ts";

/*
 * Output identity: the bundle is the same program as `dist`, so `parse` and `parse -r` must print the same bytes and exit
 * with the same code on both. The subset is deterministic: the first file (by name) of each extension under the parsers'
 * fixtures, plus a generated PDF (pdf.js is external, so it is the format most likely to differ). The spike (tikajs-cp6g)
 * compared all 145 fixture files, 870 runs, and found none different; this keeps a sample of that cheap enough to run.
 * A difference after a code change usually means the bundle is stale: `pnpm build && pnpm build:bundle`.
 */

const FIXTURES = join(ROOT, "packages/parsers/test/fixtures");
const MAX_FILE_BYTES = 300_000;
const CONCURRENCY = 6;

function allFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...allFiles(path));
    else files.push(path);
  }
  return files;
}

/** The first file of each kind: its extension, or its directory for the extensionless ones (mail, executables). JSON files are the declarative fixtures' own definitions, not documents. */
function sample(): string[] {
  const firstOfKind = new Map<string, string>();
  for (const path of allFiles(FIXTURES)) {
    const extension = extname(path).toLowerCase();
    if (extension === ".json" || statSync(path).size > MAX_FILE_BYTES) continue;
    const kind = extension === "" ? `dir:${relative(FIXTURES, path).split("/")[0]}` : extension;
    if (!firstOfKind.has(kind)) firstOfKind.set(kind, path);
  }
  return [...firstOfKind.values()];
}

/** One page of text, written by hand: enough for pdf.js to read (it repairs the cross-reference table it lacks). */
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 10 50 Td (hello pdf identity) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF
`;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(entry: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env: { ...process.env, RIPSTREAM_ISOLATION: undefined, RIPSTREAM_WORKERS: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("latin1"), stderr: Buffer.concat(err).toString("latin1") }));
  });
}

/** Timings and temporary paths vary from run to run; everything else must match byte for byte. */
function normalise(text: string): string {
  return text.replace(/"[^"\n]*(?:Millis|millis|Time|time)[^"\n]*":\s*[^,\n}]+/g, "").replace(/\/(?:var|tmp|private)[^"\s]*/g, "<tmp>");
}

async function inBatches<T>(items: readonly T[], body: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await body(item);
    }),
  );
}

test("parse and parse -r print the same on the bundle as on dist, over a sample of the fixtures", { skip: SKIP_WITHOUT_BUNDLE }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ripstream-identity-"));
  try {
    const pdf = join(dir, "generated.pdf");
    writeFileSync(pdf, PDF);
    const files = [...sample(), pdf];
    assert.ok(files.length >= 30, `the sample reads the fixtures (${files.length} files)`);
    const different: string[] = [];
    let compared = 0;
    await inBatches(
      files.flatMap((file) => [["parse", "-r", file], ["parse", file]] as const),
      async (args) => {
        const [expected, actual] = await Promise.all([run(DIST_ENTRY, args), run(BUNDLE_ENTRY, args)]);
        compared++;
        const same = actual.code === expected.code && normalise(actual.stdout) === normalise(expected.stdout) && normalise(actual.stderr) === normalise(expected.stderr);
        if (!same) different.push(`${args.slice(0, -1).join(" ")} ${basename(args.at(-1)!)}: exit ${String(expected.code)} vs ${String(actual.code)}`);
      },
    );
    assert.equal(compared, files.length * 2);
    assert.deepEqual(different.sort(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
