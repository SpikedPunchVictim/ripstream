import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Metadata, loadConfig, type UnpackSettings } from "@spikedpunch/ripstream-core";
import { MemoryEmitter, PipesEngine, createEngineFromSettings, type EmittedDocument } from "../src/index.ts";
import { embeddedKey, resolveUnpack } from "../src/unpack.ts";
import { fileSystem, storedZip } from "./helpers.ts";
import { readZip } from "./fixtures/zip.ts";

/*
 * Pipes' UNPACK mode as Tika's PipesWorker emits it (tikajs-68os.6.7): by default (outputFormat FRICTIONLESS, outputMode
 * ZIPPED) one zip, `<emitKey>-frictionless.zip`, which replaces the `<emitKey>` metadata document, and with the other
 * UnpackConfig settings the same files one by one, or the REGULAR layout.
 */

const ZIP = storedZip({ "one.txt": "first entry", "two.txt": "second entry" });
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function scratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-unpack-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Runs UNPACK over `outer.zip` (and whatever else `files` names) and returns what the emitter was given. */
async function unpacked(
  directory: string,
  unpack?: UnpackSettings,
  extra: Partial<ConstructorParameters<typeof PipesEngine>[0]> = {},
  files: Readonly<Record<string, Uint8Array | string>> = { "outer.zip": ZIP },
): Promise<EmittedDocument[]> {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  const emitter = new MemoryEmitter();
  const engine = new PipesEngine({ ...fileSystem(directory), emitter, mode: "UNPACK", ...(unpack === undefined ? {} : { unpack }), ...extra });
  await engine.run();
  assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: Object.keys(files).length });
  return emitter.documents;
}

interface Manifest {
  name?: string;
  created: string;
  resources: Array<{ name: string; path: string; mediatype: string; bytes: number; hash: string; "tk:embedded-id"?: number; "tk:resource-name"?: string }>;
}

const manifestOf = (entries: ReturnType<typeof readZip>): Manifest => {
  const manifest = entries.find((entry) => entry.name === "datapackage.json");
  assert.ok(manifest, "the package has a datapackage.json");
  return JSON.parse(manifest.data.toString("utf8")) as Manifest;
};

// ---- the default: the Frictionless package ------------------------------------------------------------------------

test("UNPACK with no settings emits one zip at `<emitKey>-frictionless.zip`, and no `<emitKey>` document", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory);
    assert.deepEqual(documents.map((document) => document.id), ["outer.zip-frictionless.zip"]);
    assert.equal(documents[0]?.mode, "UNPACK");
    assert.equal(documents[0]?.text, undefined);
    assert.deepEqual(readZip(documents[0]?.bytes ?? new Uint8Array()).map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/1", "unpacked/2"]);
  });
});

test("the package's files are the embedded documents' bytes, named by id with no suffix (Tika's suffixStrategy NONE)", async () => {
  await scratch(async (directory) => {
    const entries = readZip((await unpacked(directory))[0]?.bytes ?? new Uint8Array());
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
    assert.equal(byName.get("unpacked/1")?.toString("utf8"), "first entry");
    assert.equal(byName.get("unpacked/2")?.toString("utf8"), "second entry");
  });
});

test("datapackage.json names the package after the fetch key's file name and describes every file with its sha256", async () => {
  await scratch(async (directory) => {
    const entries = readZip((await unpacked(directory))[0]?.bytes ?? new Uint8Array());
    const manifest = manifestOf(entries);
    assert.equal(manifest.name, "outer.zip");
    assert.match(manifest.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(manifest.resources.map((resource) => resource.path), ["rmeta.json", "unpacked/1", "unpacked/2"]);
    for (const resource of manifest.resources) {
      const file = entries.find((entry) => entry.name === resource.path);
      assert.equal(resource.hash, sha256(file?.data ?? new Uint8Array()), resource.path);
      assert.equal(resource.bytes, file?.data.length, resource.path);
    }
    assert.deepEqual(
      manifest.resources.slice(1).map((resource) => [resource["tk:embedded-id"], resource["tk:resource-name"], resource.mediatype.startsWith("text/plain")]),
      [[1, "one.txt", true], [2, "two.txt", true]],
    );
  });
});

test("rmeta.json is the metadata list the RMETA mode emits for the same document", async () => {
  await scratch(async (directory) => {
    const entries = readZip((await unpacked(directory))[0]?.bytes ?? new Uint8Array());
    const rmeta = entries.find((entry) => entry.name === "rmeta.json")?.data.toString("utf8") ?? "";
    const emitter = new MemoryEmitter();
    await new PipesEngine({ ...fileSystem(directory), emitter, mode: "RMETA" }).run();
    // Two parses of the same bytes differ in how long each took, and in nothing else.
    const withoutTimings = (text: string): unknown =>
      (JSON.parse(text) as Array<Record<string, unknown>>).map(({ "tk:parse-time-millis": _taken, ...rest }) => rest);
    assert.deepEqual(withoutTimings(rmeta), withoutTimings(emitter.documents[0]?.text ?? "[]"));
    assert.equal((JSON.parse(rmeta) as unknown[]).length, 3, "the container and both entries");
  });
});

test("a document with nothing embedded still gets a package: datapackage.json and rmeta.json", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory, undefined, {}, { "a.txt": "alpha" });
    assert.deepEqual(documents.map((document) => document.id), ["a.txt-frictionless.zip"]);
    assert.deepEqual(readZip(documents[0]?.bytes ?? new Uint8Array()).map((entry) => entry.name), ["datapackage.json", "rmeta.json"]);
  });
});

test("the zip is written as it is: no extension and no compression are added by the emitter's settings", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "outer.zip"), ZIP);
    const config = {
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", compression: "GZIP" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode: "UNPACK" },
    };
    const engine = createEngineFromSettings(loadConfig(config).pipes!);
    await engine.run();
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
    assert.deepEqual(readdirSync(output), ["outer.zip-frictionless.zip"]);
    assert.deepEqual(readZip(readFileSync(join(output, "outer.zip-frictionless.zip"))).map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/1", "unpacked/2"]);
  });
});

// ---- the settings --------------------------------------------------------------------------------------------------

test("a configuration's parse-context unpack-config reaches the engine: DIRECTORY with a package root", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "outer.zip"), ZIP);
    const config = {
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: output } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode: "UNPACK" },
      "parse-context": { "unpack-config": { outputMode: "DIRECTORY", packageRoot: "pkg" } },
    };
    const engine = createEngineFromSettings(loadConfig(config).pipes!);
    await engine.run();
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 1 });
    assert.deepEqual(readdirSync(join(output, "pkg")).sort(), ["datapackage.json", "rmeta.json", "unpacked"]);
    assert.deepEqual(readdirSync(join(output, "pkg", "unpacked")).sort(), ["1", "2"]);
    assert.equal(readFileSync(join(output, "pkg", "unpacked", "2"), "utf8"), "second entry");
  });
});

test("DIRECTORY emits the unpacked files, then datapackage.json, then rmeta.json, under the emit key by default", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory, { outputMode: "DIRECTORY" });
    assert.deepEqual(documents.map((document) => document.id), [
      "outer.zip/unpacked/1",
      "outer.zip/unpacked/2",
      "outer.zip/datapackage.json",
      "outer.zip/rmeta.json",
    ]);
    assert.ok(documents.every((document) => document.mode === "UNPACK" && document.bytes !== undefined));
  });
});

test("DIRECTORY with an empty package root emits at the emitter's root", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory, { outputMode: "DIRECTORY", packageRoot: "" });
    assert.deepEqual(documents.map((document) => document.id), ["unpacked/1", "unpacked/2", "datapackage.json", "rmeta.json"]);
  });
});

test("includeMetadata false leaves rmeta.json out of the package", async () => {
  await scratch(async (directory) => {
    const entries = readZip((await unpacked(directory, { includeMetadata: false }))[0]?.bytes ?? new Uint8Array());
    assert.deepEqual(entries.map((entry) => entry.name), ["datapackage.json", "unpacked/1", "unpacked/2"]);
    assert.deepEqual(manifestOf(entries).resources.map((resource) => resource.path), ["unpacked/1", "unpacked/2"]);
  });
});

test("includeOriginal adds the container as unpacked/0", async () => {
  await scratch(async (directory) => {
    const entries = readZip((await unpacked(directory, { includeOriginal: true }))[0]?.bytes ?? new Uint8Array());
    assert.deepEqual(entries.map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/0", "unpacked/1", "unpacked/2"]);
    assert.deepEqual([...(entries.find((entry) => entry.name === "unpacked/0")?.data ?? [])], [...ZIP]);
  });
});

test("packageName sets the package's name; a blank one leaves the name out", async () => {
  await scratch(async (directory) => {
    assert.equal(manifestOf(readZip((await unpacked(directory, { packageName: "My Package" }))[0]?.bytes ?? new Uint8Array())).name, "my-package");
    assert.equal(manifestOf(readZip((await unpacked(directory, { packageName: "" }))[0]?.bytes ?? new Uint8Array())).name, undefined);
  });
});

test("the files of a package are named by the last segment of their key: padded id, a CUSTOM base and an EXISTING suffix", async () => {
  await scratch(async (directory) => {
    const unpack: UnpackSettings = { keyBaseStrategy: "CUSTOM", emitKeyBase: "a/b", embeddedIdPrefix: "_", zeroPadName: 3, suffixStrategy: "EXISTING" };
    const entries = readZip((await unpacked(directory, unpack))[0]?.bytes ?? new Uint8Array());
    assert.deepEqual(entries.map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/b_001.txt", "unpacked/b_002.txt"]);
  });
});

test("maxUnpackBytes of the settings holds: an embedded document past it is in rmeta.json and has no file", async () => {
  await scratch(async (directory) => {
    const big = storedZip({ "small.txt": "tiny", "big.txt": "x".repeat(500) });
    const documents = await unpacked(directory, { maxUnpackBytes: 100 }, {}, { "outer.zip": big });
    const entries = readZip(documents[0]?.bytes ?? new Uint8Array());
    assert.deepEqual(entries.map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/1"]);
    const list = JSON.parse(entries.find((entry) => entry.name === "rmeta.json")?.data.toString("utf8") ?? "[]") as unknown[];
    assert.equal(list.length, 3, "the container and both entries are listed");
  });
});

// ---- REGULAR -------------------------------------------------------------------------------------------------------

test("REGULAR with includeOriginal emits the container's bytes as embedded document 0", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory, { outputFormat: "REGULAR", includeOriginal: true });
    assert.deepEqual(documents.map((document) => document.id), ["outer.zip", "outer.zip-embed/0", "outer.zip-embed/1", "outer.zip-embed/2"]);
    assert.deepEqual([...(documents[1]?.bytes ?? [])], [...ZIP]);
  });
});

test("REGULAR names embedded documents by the same settings: padded id, CUSTOM base, EXISTING suffix", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory, {
      outputFormat: "REGULAR",
      keyBaseStrategy: "CUSTOM",
      emitKeyBase: "files/doc",
      zeroPadName: 2,
      suffixStrategy: "EXISTING",
    });
    assert.deepEqual(documents.map((document) => document.id), ["outer.zip", "files/doc-01.txt", "files/doc-02.txt"]);
  });
});

test("DETECTED asks for the extension of the media type each embedded document has", async () => {
  await scratch(async (directory) => {
    const asked: Array<string | null> = [];
    const documents = await unpacked(
      directory,
      { outputFormat: "REGULAR", suffixStrategy: "DETECTED" },
      {
        extensionOf: (type) => {
          asked.push(type);
          return ".dat";
        },
      },
    );
    assert.deepEqual(documents.map((document) => document.id), ["outer.zip", "outer.zip-embed/1.dat", "outer.zip-embed/2.dat"]);
    assert.equal(asked.length, 2);
  });
});

test("DETECTED with no registry given is .bin for every type", async () => {
  await scratch(async (directory) => {
    const documents = await unpacked(directory, { outputFormat: "REGULAR", suffixStrategy: "DETECTED" });
    assert.deepEqual(documents.map((document) => document.id), ["outer.zip", "outer.zip-embed/1.bin", "outer.zip-embed/2.bin"]);
  });
});

// ---- the shorthand config ------------------------------------------------------------------------------------------

test("the shorthand config keeps the REGULAR layout its flat sink was made for", async () => {
  await scratch(async (directory) => {
    const { createEngine } = await import("../src/index.ts");
    writeFileSync(join(directory, "outer.zip"), ZIP);
    const engine = createEngine({ source: { type: "filesystem", path: directory }, mode: "UNPACK" });
    await engine.run();
    assert.ok(existsSync(directory));
    assert.equal(engine.stats.emitted, 1);
  });
});

// ---- the naming, one rule at a time (AbstractUnpackHandler.getEmitKey) -----------------------------------------------

const metadata = (fields: Record<string, string>): Metadata => new Metadata(fields);
const keyOf = (unpack: UnpackSettings, fields: Record<string, string> = {}, extensionOf = (): string => ".bin"): string =>
  embeddedKey("dir/doc.zip", 7, metadata(fields), resolveUnpack(unpack), extensionOf);

test("embeddedKey: `<emitKey>-embed/<id>` by default, and the id padded with zeros when asked", () => {
  assert.equal(keyOf({}), "dir/doc.zip-embed/7");
  assert.equal(keyOf({ zeroPadName: 4 }), "dir/doc.zip-embed/0007");
  assert.equal(keyOf({ zeroPadName: 1 }), "dir/doc.zip-embed/7");
  assert.equal(keyOf({ zeroPadName: 4 }).endsWith("0007"), true);
});

test("embeddedKey: a CUSTOM key base is `<emitKeyBase><embeddedIdPrefix><id>`, the prefix `-` unless set", () => {
  assert.equal(keyOf({ keyBaseStrategy: "CUSTOM", emitKeyBase: "out/x" }), "out/x-7");
  assert.equal(keyOf({ keyBaseStrategy: "CUSTOM", emitKeyBase: "out/x", embeddedIdPrefix: "/" }), "out/x/7");
  assert.equal(keyOf({ keyBaseStrategy: "CUSTOM" }), "-7");
  assert.equal(keyOf({ emitKeyBase: "ignored" }), "dir/doc.zip-embed/7", "a DEFAULT key base ignores emitKeyBase");
});

test("embeddedKey: EXISTING takes the suffix of the resource name, lower case, when it is 1 to 4 ASCII letters or digits", () => {
  const key = (name: string): string => keyOf({ suffixStrategy: "EXISTING" }, { "tk:resource-name": name });
  assert.equal(key("Report.PDF"), "dir/doc.zip-embed/7.pdf");
  assert.equal(key("dir\\sub/inner.docx"), "dir/doc.zip-embed/7.docx");
  assert.equal(key("archive.tar.gz"), "dir/doc.zip-embed/7.gz");
  assert.equal(key("data.abcde"), "dir/doc.zip-embed/7", "five characters after the dot is too long");
  assert.equal(key("data.é"), "dir/doc.zip-embed/7", "ASCII only");
  assert.equal(key("noextension"), "dir/doc.zip-embed/7");
  assert.equal(key("dir.d/noext"), "dir/doc.zip-embed/7", "a dot in a directory is not a suffix");
  assert.equal(keyOf({ suffixStrategy: "EXISTING" }), "dir/doc.zip-embed/7", "no resource name");
});

test("embeddedKey: DETECTED asks the registry, with an OCR routing type as the image type, and is .bin for no type", () => {
  const asked: string[] = [];
  const registry = (type: string | null): string => {
    asked.push(String(type));
    return ".img";
  };
  assert.equal(keyOf({ suffixStrategy: "DETECTED" }, { "Content-Type": "image/ocr-png" }, registry), "dir/doc.zip-embed/7.img");
  assert.deepEqual(asked, ["image/png"]);
  assert.equal(keyOf({ suffixStrategy: "DETECTED" }, {}, registry), "dir/doc.zip-embed/7.bin");
  assert.equal(asked.length, 1, "the registry is not asked about a document with no type");
});

test("embeddedKey: NONE adds nothing, whatever the document is", () => {
  assert.equal(keyOf({ suffixStrategy: "NONE" }, { "tk:resource-name": "a.pdf", "Content-Type": "application/pdf" }), "dir/doc.zip-embed/7");
});
