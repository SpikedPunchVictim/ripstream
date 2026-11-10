import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, type UnpackSettings } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import {
  FileSystemEmitter,
  MemoryEmitter,
  PipesEngine,
  createEngineFromSettings,
  type EmittedDocument,
  type PipeMode,
} from "../src/index.ts";
import { fileSystem, storedZip } from "./helpers.ts";

/*
 * Tika's ParseMode, one input at a time (ParseMode.java and what ParseHandler and EmitHandler do with each):
 * RMETA the list of metadata, a document and then what is embedded in it; CONCATENATE one metadata whose content is the
 * text of all of it; CONTENT_ONLY the same, for an emitter that writes only the content; NO_PARSE what detection finds
 * and no content; UNPACK the RMETA list and the bytes of each embedded document.
 */

/** The layout the engine had before Tika's default (FRICTIONLESS) was adopted: the list, and each document's bytes. */
const REGULAR = { outputFormat: "REGULAR" } as const satisfies UnpackSettings;

async function scratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-modes-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function emitted(mode: PipeMode, directory: string, unpack?: UnpackSettings): Promise<EmittedDocument[]> {
  const emitter = new MemoryEmitter();
  await new PipesEngine({ ...fileSystem(directory), emitter, mode, ...(unpack === undefined ? {} : { unpack }) }).run();
  return emitter.documents;
}

test("every document the engine emits says the mode that made it", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha");
    for (const mode of ["RMETA", "CONCATENATE", "CONTENT_ONLY", "NO_PARSE", "UNPACK"] as const) {
      const documents = await emitted(mode, directory);
      assert.ok(documents.length >= 1, mode);
      assert.ok(documents.every((document) => document.mode === mode), mode);
    }
  });
});

test("NO_PARSE emits what detection knows and no content: the input is not copied", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha text");
    writeFileSync(join(directory, "b.pdf"), "%PDF-1.4\n%not really a pdf\n");
    // Two inputs on parallel workers settle in either order: the test is about what each carries.
    const documents = (await emitted("NO_PARSE", directory)).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      documents.map((document) => [document.id, document.metadata?.["Content-Type"]]),
      [["a.txt", "text/plain"], ["b.pdf", "application/pdf"]],
    );
    for (const document of documents) {
      assert.equal(document.bytes, undefined, "no copy of the input");
      assert.equal(document.text, undefined, "no content");
    }
  });
});

test("NO_PARSE reads nothing from the content: a document no parser could read is still emitted", async () => {
  await scratch(async (directory) => {
    // A truncated zip: parsing it fails, detecting it does not.
    writeFileSync(join(directory, "broken.zip"), Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2, 3));
    const engine = new PipesEngine({ ...fileSystem(directory), emitter: new MemoryEmitter(), mode: "NO_PARSE" });
    await engine.run();
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
  });
});

test("NO_PARSE says what it detected twice: the type, and the type a parser is to be given", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha text");
    const [document] = await emitted("NO_PARSE", directory);
    assert.equal(document?.metadata?.["Content-Type"], "text/plain");
    assert.equal(document?.metadata?.["tk:content-type-parser-override"], "text/plain");
  });
});

/** What a run of `createEngineFromSettings` writes for `doc.txt`, with no ripstream passed: the engine builds its own from the settings. */
async function piped(directory: string, parseMode: PipeMode, parseContext: unknown): Promise<Record<string, unknown>[]> {
  const output = join(directory, "out");
  const input = join(directory, "in");
  const config = {
    fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
    emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json" } } },
    "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
    pipes: { parseMode },
    "parse-context": parseContext,
  };
  assert.equal(await createEngineFromSettings(loadConfig(config).pipes!).run(), 1);
  return JSON.parse(readFileSync(join(output, "doc.txt.json"), "utf8")) as Array<Record<string, unknown>>;
}

/** Tika's NO_PARSE with a digester factory: `_preParse` digests the container, then detects. No parser runs. */
async function noParse(directory: string, parseContext: unknown): Promise<Record<string, unknown>> {
  return (await piped(directory, "NO_PARSE", parseContext))[0] ?? {};
}

test("NO_PARSE with a digester factory digests the document without parsing it, as Tika's _preParse does", async () => {
  await scratch(async (directory) => {
    const content = "alpha text, digested and not parsed";
    mkdirSync(join(directory, "in"));
    writeFileSync(join(directory, "in", "doc.txt"), content);
    const metadata = await noParse(directory, {
      "commons-digester-factory": { digests: [{ algorithm: "MD5" }, { algorithm: "SHA256", encoding: "BASE64" }] },
    });
    assert.equal(metadata["tk:digest:MD5"], createHash("md5").update(content).digest("hex"));
    assert.equal(metadata["tk:digest:SHA-256:BASE64"], createHash("sha256").update(content).digest("base64"));
    assert.equal(metadata["Content-Length"], String(content.length));
    assert.equal(metadata["Content-Type"], "text/plain");
    assert.equal(metadata["tk:content"], undefined, "no content");
  });
});

test("NO_PARSE with skipContainerDocumentDigest digests nothing, and still says what the fetcher stage knows", async () => {
  await scratch(async (directory) => {
    mkdirSync(join(directory, "in"));
    writeFileSync(join(directory, "in", "doc.txt"), "alpha text");
    const metadata = await noParse(directory, { "commons-digester-factory": { digests: [{ algorithm: "MD5" }], skipContainerDocumentDigest: true } });
    assert.deepEqual(Object.keys(metadata).filter((key) => key.startsWith("tk:digest:")), []);
    assert.equal(metadata["Content-Type"], "text/plain");
    assert.equal(metadata["Content-Length"], "10");
    assert.equal(metadata["tk:resource-name"], "doc.txt");
  });
});

test("NO_PARSE without a digester factory has the name and length the fetcher stage knows, and the type, and no digest", async () => {
  await scratch(async (directory) => {
    mkdirSync(join(directory, "in"));
    writeFileSync(join(directory, "in", "doc.txt"), "alpha text");
    const metadata = await noParse(directory, {});
    assert.deepEqual(metadata, {
      "tk:resource-name": "doc.txt",
      "Content-Length": "10",
      "Content-Type": "text/plain",
      "tk:content-type-parser-override": "text/plain",
    });
  });
});

// RMETA is the recursive parse, CONCATENATE the plain one: the two paths a ripstream digests on (CONTENT_ONLY and UNPACK write other layouts).
for (const mode of ["RMETA", "CONCATENATE"] as const) {
  test(`${mode} with a digester factory digests, with the ripstream the engine builds from its settings`, async () => {
    await scratch(async (directory) => {
      const content = "alpha text, digested by the parser";
      mkdirSync(join(directory, "in"));
      writeFileSync(join(directory, "in", "doc.txt"), content);
      const records = await piped(directory, mode, { "commons-digester-factory": { digests: [{ algorithm: "MD5" }, { algorithm: "SHA256", encoding: "BASE32" }] } });
      const container = records[0] ?? {};
      assert.equal(container["tk:digest:MD5"], createHash("md5").update(content).digest("hex"), mode);
      assert.match(String(container["tk:digest:SHA-256:BASE32"]), /^[A-Z2-7]{52}=*$/, mode);
    });
  });
}

test("a ripstream the caller passes digests as it was built: the settings' digest is for the one the engine makes", async () => {
  await scratch(async (directory) => {
    mkdirSync(join(directory, "in"));
    writeFileSync(join(directory, "in", "doc.txt"), "alpha text");
    const output = join(directory, "out");
    const input = join(directory, "in");
    const config = {
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode: "RMETA" },
      "parse-context": { "commons-digester-factory": { digests: [{ algorithm: "MD5" }] } },
    };
    const plain = createRipstream();
    assert.equal(await createEngineFromSettings(loadConfig(config).pipes!, { ripstream: plain }).run(), 1);
    const [record] = JSON.parse(readFileSync(join(output, "doc.txt.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(record?.["tk:digest:MD5"], undefined);
  });
});

test("CONCATENATE: one metadata with the content of the document and of what is embedded in it", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "outer.zip"), storedZip({ "one.txt": "first entry", "two.txt": "second entry" }));
    const [document] = await emitted("CONCATENATE", directory);
    assert.equal(document?.id, "outer.zip");
    assert.match(document?.text ?? "", /first entry/);
    assert.match(document?.text ?? "", /second entry/);
    assert.equal(document?.records, undefined, "not a list of records");
    assert.equal(document?.metadata?.["tk:content-handler-type"], "TEXT");
  });
});

test("CONCATENATE written by the file-system emitter is Tika's one-element JSON list with tk:content", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "alpha");
    await new PipesEngine({
      ...fileSystem(input),
      emitter: new FileSystemEmitter({ basePath: output, fileExtension: "json" }),
      mode: "CONCATENATE",
    }).run();
    const list = JSON.parse(readFileSync(join(output, "a.txt.json"), "utf8")) as Array<Record<string, string>>;
    assert.equal(list.length, 1);
    assert.match(list[0]?.["tk:content"] ?? "", /alpha/);
    assert.equal(list[0]?.["tk:content-handler-type"], "TEXT");
  });
});

test("CONTENT_ONLY written by the file-system emitter is the raw content, nothing else", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "alpha");
    await new PipesEngine({
      ...fileSystem(input),
      emitter: new FileSystemEmitter({ basePath: output, fileExtension: "txt" }),
      mode: "CONTENT_ONLY",
    }).run();
    assert.equal(readFileSync(join(output, "a.txt.txt"), "utf8").trim(), "alpha");
  });
});

test("RMETA written by the file-system emitter is the list /rmeta answers", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "outer.zip"), storedZip({ "one.txt": "first entry" }));
    await new PipesEngine({
      ...fileSystem(input),
      emitter: new FileSystemEmitter({ basePath: output, fileExtension: "json" }),
      mode: "RMETA",
    }).run();
    const list = JSON.parse(readFileSync(join(output, "outer.zip.json"), "utf8")) as Array<Record<string, string>>;
    assert.equal(list.length, 2, "the zip and its one entry");
    assert.equal(list[0]?.["Content-Type"], "application/zip");
    assert.match(list[1]?.["tk:content"] ?? "", /first entry/);
  });
});

test("UNPACK, REGULAR: the RMETA list at the emit key and each embedded document's bytes under `<emit key>-embed/<id>`", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "outer.zip"), storedZip({ "one.txt": "first entry", "two.txt": "second entry" }));
    await new PipesEngine({
      ...fileSystem(input),
      emitter: new FileSystemEmitter({ basePath: output, fileExtension: "json" }),
      mode: "UNPACK",
      unpack: REGULAR,
    }).run();
    assert.deepEqual(readdirSync(output).sort(), ["outer.zip-embed", "outer.zip.json"]);
    // The embedded files keep the name their key gives them: no `.json`.
    assert.deepEqual(readdirSync(join(output, "outer.zip-embed")).sort(), ["1", "2"]);
    assert.equal(readFileSync(join(output, "outer.zip-embed", "1"), "utf8"), "first entry");
    assert.equal(readFileSync(join(output, "outer.zip-embed", "2"), "utf8"), "second entry");
    const list = JSON.parse(readFileSync(join(output, "outer.zip.json"), "utf8")) as Array<Record<string, string>>;
    assert.equal(list.length, 3, "the container and its two entries");
  });
});

test("UNPACK: the bytes are the entries' own, not their extracted text", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "outer.zip"), storedZip({ "bin.dat": "\u0000\u0001\u0002 raw" }));
    const documents = await emitted("UNPACK", directory, REGULAR);
    const bytes = documents.filter((document) => document.bytes !== undefined);
    assert.equal(bytes.length, 1);
    assert.equal(bytes[0]?.id, "outer.zip-embed/1");
    assert.deepEqual([...(bytes[0]?.bytes ?? [])], [...Buffer.from("\u0000\u0001\u0002 raw")]);
  });
});

test("UNPACK keeps no more bytes than unpackBytes: an embedded document past it is in the list and has no bytes document", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "outer.zip"), storedZip({ "small.txt": "tiny", "big.txt": "x".repeat(500) }));
    const emitter = new MemoryEmitter();
    await new PipesEngine({ ...fileSystem(directory), emitter, mode: "UNPACK", unpack: REGULAR, unpackBytes: 100 }).run();
    const bytes = emitter.documents.filter((document) => document.bytes !== undefined);
    assert.deepEqual(bytes.map((document) => document.bytes?.length), [4]);
    assert.equal(emitter.documents[0]?.records?.length, 3, "the container and both entries are listed");
  });
});

test("UNPACK of a document with nothing embedded emits only its own metadata", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha");
    const documents = await emitted("UNPACK", directory, REGULAR);
    assert.deepEqual(documents.map((document) => document.id), ["a.txt"]);
  });
});

test("a Tika-shaped configuration with the emitter's own settings: extension, compression and a rerun", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(join(input, "sub"), { recursive: true });
    writeFileSync(join(input, "sub", "a.txt"), "alpha");
    const config = {
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", compression: "GZIP", onExists: "EXCEPTION" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode: "RMETA" },
    };
    const first = createEngineFromSettings(loadConfig(config).pipes!);
    assert.equal(await first.run(), 1);
    assert.deepEqual(readdirSync(join(output, "sub")), ["a.txt.json.gz"]);
    // Tika's default onExists is EXCEPTION: running into the same output again is a result per input, not a silent overwrite.
    const second = createEngineFromSettings(loadConfig(config).pipes!);
    await second.run();
    assert.deepEqual(second.stats.byStatus, { EMIT_EXCEPTION: 1 });
    assert.equal(second.stats.failed, 1);
    assert.deepEqual(readdirSync(join(output, "sub")), ["a.txt.json.gz"], "the first run's file is left whole");
  });
});
