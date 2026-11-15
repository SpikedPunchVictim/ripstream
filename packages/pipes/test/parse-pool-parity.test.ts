import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { metadataJson, type InputSource, type Metadata, type ParseOptions, type ParseRecord, type ParseResult } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { loadFixtures, runFixture, type FixtureInput } from "../../parsers/test/fixture-runner.ts";
import { WorkerParsePool } from "../src/parse-pool.ts";
import { createParsePool } from "../src/workers.ts";

/*
 * Parity (tikajs-ow39): a document parsed on a pool worker gives what the same document parsed in this thread gives,
 * text, metadata, records and failures alike. The corpus is the declarative fixtures of packages/parsers (smoke/ and
 * repros/) and inputs above the 1 MiB at which a parse spills to a temporary file.
 */

const pool = await createParsePool({ workers: 2 });
after(() => pool.close());
const local = createRipstream();

const scratch = await mkdtemp(join(tmpdir(), "ripstream-parity-"));
after(() => rm(scratch, { recursive: true, force: true }));

/** A failure as the caller sees it: its class, name and message (the stack is the thread's own). */
function failure(error: unknown): unknown {
  return error instanceof Error ? { failed: error.constructor.name, name: error.name, message: error.message } : { failed: String(error) };
}

/** The metadata, less how long the parse took: the one value two runs of the same parse need not share. */
function untimed(metadata: Metadata): unknown {
  const { "tk:parse-time-millis": _, ...rest } = metadataJson(metadata) as Record<string, unknown>;
  return rest;
}

async function parsed(run: () => Promise<ParseResult>): Promise<unknown> {
  try {
    const result = await run();
    return { text: result.text, metadata: untimed(result.metadata) };
  } catch (error) {
    return failure(error);
  }
}

function record(entry: ParseRecord): unknown {
  return {
    path: entry.embeddedResourcePath,
    pathParts: entry.pathParts,
    depth: entry.depth,
    mediaType: entry.mediaType.toString(),
    content: entry.content,
    metadata: untimed(entry.metadata),
    exception: entry.exception === null ? null : failure(entry.exception),
    bytes: entry.bytes === undefined ? undefined : Array.from(entry.bytes),
  };
}

async function parsedRecursively(run: () => Promise<readonly ParseRecord[]>): Promise<unknown> {
  try {
    return (await run()).map(record);
  } catch (error) {
    return failure(error);
  }
}

async function assertSame(input: InputSource, options: ParseOptions): Promise<void> {
  assert.deepEqual(await parsed(() => pool.parse(input, options)), await parsed(() => local.parse(input, options)), "parse");
  assert.deepEqual(
    await parsedRecursively(() => pool.parseRecursive(input, options)),
    await parsedRecursively(() => local.parseRecursive(input, options)),
    "parseRecursive",
  );
}

function bytesOf(input: FixtureInput, fixturePath: string): Promise<Uint8Array> | Uint8Array {
  if (input.text !== undefined) return new TextEncoder().encode(input.text);
  if (input.base64 !== undefined) return new Uint8Array(Buffer.from(input.base64, "base64"));
  return readFile(resolve(dirname(fixturePath), input.file!)).then((buffer) => new Uint8Array(buffer));
}

const root = fileURLToPath(new URL("../../parsers/test/fixtures", import.meta.url));
for (const loaded of ["smoke", "repros"].flatMap((directory) => loadFixtures(join(root, directory)))) {
  // Detection runs in this thread whether or not there is a pool.
  if (loaded.fixture.operation === "detect") continue;
  test(`fixture ${loaded.name} gives the same on a worker`, async () => {
    await runFixture(pool as unknown as Parameters<typeof runFixture>[0], loaded);
    const options: ParseOptions = {
      ...loaded.fixture.options,
      ...(loaded.fixture.input.filename === undefined ? {} : { filename: loaded.fixture.input.filename }),
    };
    await assertSame(await bytesOf(loaded.fixture.input, loaded.path), options);
  });
}

/** About 1.5 MiB: above the size at which a parse spills its input to a temporary file. */
const LARGE = new TextEncoder().encode(Array.from({ length: 100_000 }, (_, index) => `line ${index} of a large text`).join("\n"));

test("an input above 1 MiB gives the same on a worker, as bytes and as a path", async () => {
  assert.ok(LARGE.byteLength > 1024 * 1024);
  await assertSame(LARGE, { filename: "large.txt" });
  const path = join(scratch, "large.txt");
  await writeFile(path, LARGE);
  await assertSame({ path }, { filename: "large.txt" });
});

test("a large input in a container gives the same records on a worker", async () => {
  // A stored (uncompressed) zip with the large text and a small one beside it.
  const entries = [
    { name: "large.txt", data: LARGE },
    { name: "small.txt", data: new TextEncoder().encode("small entry") },
  ];
  await assertSame(storedZip(entries), { filename: "two.zip" });
});

/**
 * The canvas pdf.js would load is blocked in each thread that loads the PDF parser (block-canvas.ts). A worker is its
 * own thread with its own module hooks, so this checks the block holds there: the real worker entry, with every module
 * it loads written down, parses a PDF.
 */
test("a worker that parses a PDF never loads @napi-rs/canvas", async () => {
  const log = join(scratch, "loaded.txt");
  await writeFile(log, "");
  process.env["POOL_TEST_LOADED_LOG"] = log;
  const probe = await WorkerParsePool.start({ spec: {}, size: 1, entry: new URL("./workers/load-probe.ts", import.meta.url), tempRoot: scratch });
  delete process.env["POOL_TEST_LOADED_LOG"];
  try {
    const result = await probe.parse(helloPdf(), { filename: "hello.pdf" });
    assert.match(result.text, /hello from a worker/);
  } finally {
    await probe.close();
  }
  const loaded = (await readFile(log, "utf8")).split("\n");
  assert.ok(loaded.some((url) => url.includes("/pdfjs-dist/")), "the worker loaded pdf.js, so the block was in the way");
  assert.deepEqual(loaded.filter((url) => url.includes("napi-rs")), []);
});

/** A one-page PDF that says "hello from a worker" in Helvetica. */
function helloPdf(): Uint8Array {
  const content = "BT /F1 12 Tf 20 100 Td (hello from a worker) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A zip whose entries are stored, not deflated. */
function storedZip(entries: readonly { readonly name: string; readonly data: Uint8Array }[]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, Buffer.from(entry.data));
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + entry.data.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
