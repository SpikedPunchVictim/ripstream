import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ExcludeFieldMetadataFilter,
  IncludeFieldMetadataFilter,
  RemoveByMimeMetadataFilter,
  loadConfig,
  rmetaObjects,
  type EmitMetadataFilters,
  type Metadata,
} from "@spikedpunch/ripstream-core";
import {
  FileSystemEmitter,
  MemoryEmitter,
  PipesEngine,
  createEngineFromSettings,
  type EmittedDocument,
  type PipeMode,
  type PipesResult,
} from "../src/index.ts";
import { fileSystem, storedZip } from "./helpers.ts";

/*
 * Metadata filters on pipes' emit (tikajs-68os.9.2.6), as Tika's EmitHandler runs them: after the parse and before the
 * emitter, on every mode, the parse-context chain if there is one, else for CONTENT_ONLY the content and the container
 * exception, else the configured chain.
 */

const REGULAR = { outputFormat: "REGULAR" } as const;
const DIRECTORY = { outputFormat: "FRICTIONLESS", outputMode: "DIRECTORY", packageRoot: "pkg" } as const;

async function scratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-filters-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const include = (...names: string[]) => new IncludeFieldMetadataFilter({ include: names });
const exclude = (...names: string[]) => new ExcludeFieldMetadataFilter({ exclude: names });

async function emit(
  directory: string,
  mode: PipeMode,
  metadataFilters?: EmitMetadataFilters,
  extra: Record<string, unknown> = {},
): Promise<EmittedDocument[]> {
  const emitter = new MemoryEmitter();
  await new PipesEngine({
    ...fileSystem(directory),
    emitter,
    mode,
    ...(metadataFilters === undefined ? {} : { metadataFilters }),
    ...extra,
  }).run();
  return emitter.documents;
}

const zipOfTwo = (directory: string): void =>
  writeFileSync(join(directory, "outer.zip"), storedZip({ "one.txt": "first entry", "two.txt": "second entry" }));

test("RMETA: no filters leaves the list as the parse made it", async () => {
  await scratch(async (directory) => {
    zipOfTwo(directory);
    const [document] = await emit(directory, "RMETA");
    assert.deepEqual(document?.objects, rmetaObjects(document?.records ?? []));
    assert.equal(document?.text, JSON.stringify(document?.objects));
  });
});

test("RMETA: the configured chain is run on every document of the list, and the text is what it left", async () => {
  await scratch(async (directory) => {
    zipOfTwo(directory);
    const [document] = await emit(directory, "RMETA", { configured: include("Content-Type", "tk:content") });
    assert.equal(document?.objects?.length, 3);
    for (const object of document?.objects ?? []) assert.deepEqual(Object.keys(object).filter((key) => key !== "Content-Type" && key !== "tk:content"), []);
    assert.equal(document?.objects?.[0]?.["Content-Type"], "application/zip");
    assert.match(String(document?.objects?.[1]?.["tk:content"]), /first entry/);
    assert.deepEqual(JSON.parse(document?.text ?? "null"), document?.objects);
    assert.equal(document?.records?.length, 3, "the records are the parse, before the filters");
  });
});

test("RMETA: a filter that removes documents from the list removes them from what is emitted", async () => {
  await scratch(async (directory) => {
    zipOfTwo(directory);
    const [document] = await emit(directory, "RMETA", { configured: new RemoveByMimeMetadataFilter({ mimes: ["text/plain"] }) });
    assert.equal(document?.objects?.length, 1);
    assert.equal(document?.objects?.[0]?.["Content-Type"], "application/zip");
    assert.equal((JSON.parse(document?.text ?? "[]") as unknown[]).length, 1);
  });
});

test("RMETA: the parse-context chain is the one that runs when there is one; the configured chain does not run beside it", async () => {
  await scratch(async (directory) => {
    zipOfTwo(directory);
    const [document] = await emit(directory, "RMETA", { configured: include("Content-Type"), parseContext: include("tk:embedded-depth") });
    assert.deepEqual(document?.objects, [{ "tk:embedded-depth": "0" }, { "tk:embedded-depth": "1" }, { "tk:embedded-depth": "1" }]);
  });
});

test("CONCATENATE: the content is tk:content for the filter, so dropping it drops the text", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha");
    const [plain] = await emit(directory, "CONCATENATE");
    assert.equal(plain?.text?.trim(), "alpha");
    const [dropped] = await emit(directory, "CONCATENATE", { configured: exclude("tk:content") });
    assert.equal(dropped?.text, "");
    assert.equal(dropped?.metadata?.["tk:content"], undefined);
    assert.equal(dropped?.metadata?.["Content-Type"], plain?.metadata?.["Content-Type"]);
    const [only] = await emit(directory, "CONCATENATE", { configured: include("tk:content") });
    assert.equal(only?.text, plain?.text);
    assert.deepEqual(only?.metadata, {});
  });
});

test("CONTENT_ONLY: the configured chain is not consulted; the content and the container exception are what is kept", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha");
    const [document] = await emit(directory, "CONTENT_ONLY", { configured: exclude("tk:content") });
    assert.equal(document?.text?.trim(), "alpha", "the configured chain drops tk:content, and CONTENT_ONLY does not run it");
    assert.deepEqual(document?.metadata, {}, "nothing but the content and the container exception is kept");
  });
});

test("CONTENT_ONLY: a parse-context chain replaces the default, and can drop the content", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha");
    const [dropped] = await emit(directory, "CONTENT_ONLY", { configured: include("tk:content"), parseContext: exclude("tk:content") });
    assert.equal(dropped?.text, "");
    assert.equal(dropped?.metadata?.["Content-Type"], "text/plain", "the default no longer strips what the chain keeps");
  });
});

test("CONTENT_ONLY: the container exception of a document that could not be read is kept", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "broken.pdf"), "%PDF-1.4\nthis is not a pdf at all");
    const [document] = await emit(directory, "CONTENT_ONLY", {}, {});
    const kept = (await emit(directory, "CONTENT_ONLY", { configured: exclude("Content-Type") }))[0];
    assert.deepEqual(Object.keys(kept?.metadata ?? {}), Object.keys(document?.metadata ?? {}));
    for (const key of Object.keys(kept?.metadata ?? {})) assert.equal(key, "tk:exception:container-exception");
  });
});

test("NO_PARSE: what detection found out is filtered like any other metadata", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "a.txt"), "alpha");
    const [document] = await emit(directory, "NO_PARSE", { configured: include("Content-Type") });
    assert.deepEqual(document?.metadata, { "Content-Type": "text/plain" });
  });
});

test("UNPACK, REGULAR: the list is filtered, and each embedded document's bytes still go with the document they came from", async () => {
  await scratch(async (directory) => {
    zipOfTwo(directory);
    // Neither the ids nor the documents are left in the list: the bytes are still the entries'.
    const documents = await emit(directory, "UNPACK", { configured: new RemoveByMimeMetadataFilter({ mimes: ["text/plain"] }) }, { unpack: REGULAR });
    const list = documents[0];
    assert.equal(list?.objects?.length, 1);
    const bytes = documents.filter((document) => document.bytes !== undefined);
    assert.deepEqual(bytes.map((document) => [document.id, Buffer.from(document.bytes!).toString()]), [
      ["outer.zip-embed/1", "first entry"],
      ["outer.zip-embed/2", "second entry"],
    ]);
    const stripped = await emit(directory, "UNPACK", { configured: exclude("tk:embedded-id", "tk:embedded-id-path") }, { unpack: REGULAR });
    assert.deepEqual(
      stripped.filter((document) => document.bytes !== undefined).map((document) => [document.id, Buffer.from(document.bytes!).toString()]),
      [["outer.zip-embed/1", "first entry"], ["outer.zip-embed/2", "second entry"]],
    );
  });
});

test("UNPACK, REGULAR: the list a file emitter writes is the filtered one", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    zipOfTwo(input);
    await new PipesEngine({
      ...fileSystem(input),
      emitter: new FileSystemEmitter({ basePath: output, fileExtension: "json" }),
      mode: "UNPACK",
      unpack: REGULAR,
      metadataFilters: { configured: include("Content-Type") },
    }).run();
    const list = JSON.parse(readFileSync(join(output, "outer.zip.json"), "utf8")) as Array<Record<string, string>>;
    assert.equal(list.length, 3);
    for (const object of list) assert.deepEqual(Object.keys(object), ["Content-Type"]);
  });
});

test("UNPACK, FRICTIONLESS: rmeta.json is the filtered list", async () => {
  await scratch(async (directory) => {
    zipOfTwo(directory);
    const documents = await emit(directory, "UNPACK", { configured: include("Content-Type") }, { unpack: DIRECTORY });
    const rmeta = documents.find((document) => document.id === "pkg/rmeta.json");
    assert.deepEqual(JSON.parse(Buffer.from(rmeta?.bytes ?? new Uint8Array()).toString("utf8")), [
      { "Content-Type": "application/zip" },
      { "Content-Type": "text/plain" },
      { "Content-Type": "text/plain" },
    ]);
    assert.ok(documents.some((document) => document.id === "pkg/unpacked/1"), "the files are still in the package");
  });
});

test("a filter that fails fails the input it was running on, and the run goes on", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "bad.txt"), "bad");
    writeFileSync(join(directory, "good.txt"), "good");
    const poison = {
      filter(list: Metadata[]): void {
        if (list[0]?.get("tk:content")?.includes("bad") === true) throw new Error("filter failed on bad.txt");
      },
    };
    const results: PipesResult[] = [];
    const emitter = new MemoryEmitter();
    const engine = new PipesEngine({
      ...fileSystem(directory),
      emitter,
      mode: "CONCATENATE",
      ordered: true,
      metadataFilters: { configured: poison },
      reporter: { report: (result) => void results.push(result) },
    });
    await engine.run();
    assert.deepEqual(emitter.documents.map((document) => document.id), ["good.txt"]);
    const bad = results.find((result) => result.id === "bad.txt");
    assert.notEqual(bad?.status, "EMIT_SUCCESS");
    assert.match(bad?.message ?? "", /filter failed on bad\.txt/);
  });
});

/** What a run of the settings writes for `doc.txt`. */
async function written(directory: string, parseMode: PipeMode, sections: Record<string, unknown>, extension = "json"): Promise<string> {
  const input = join(directory, "in");
  const output = join(directory, "out");
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, "doc.txt"), "alpha text");
  const config = {
    fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
    emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: extension } } },
    "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
    pipes: { parseMode },
    ...sections,
  };
  assert.equal(await createEngineFromSettings(loadConfig(config).pipes!).run(), 1);
  return readFileSync(join(output, `doc.txt.${extension}`), "utf8");
}

const FILTERS = [{ "include-field-metadata-filter": { include: ["Content-Type", "tk:content"] } }];

test("a configuration's metadata-filters section reaches the engine: the file written is the filtered list", async () => {
  await scratch(async (directory) => {
    const list = JSON.parse(await written(directory, "RMETA", { "metadata-filters": FILTERS })) as Array<Record<string, string>>;
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0] ?? {}).sort(), ["Content-Type", "tk:content"]);
    assert.equal(list[0]?.["Content-Type"], "text/plain");
    assert.match(list[0]?.["tk:content"] ?? "", /alpha text/);
  });
});

test("a configuration with no metadata-filters, or an empty list, filters nothing", async () => {
  await scratch(async (directory) => {
    const none = JSON.parse(await written(directory, "RMETA", {})) as Array<Record<string, string>>;
    assert.ok(Object.keys(none[0] ?? {}).length > 3);
  });
  await scratch(async (directory) => {
    const empty = JSON.parse(await written(directory, "RMETA", { "metadata-filters": [] })) as Array<Record<string, string>>;
    assert.ok(Object.keys(empty[0] ?? {}).length > 3);
  });
});

test("a parse-context metadata-filters list replaces the top-level one, and an empty one replaces nothing", async () => {
  await scratch(async (directory) => {
    const replaced = JSON.parse(
      await written(directory, "RMETA", {
        "metadata-filters": FILTERS,
        "parse-context": { "metadata-filters": [{ "include-field-metadata-filter": { include: ["tk:embedded-depth"] } }] },
      }),
    ) as Array<Record<string, string>>;
    assert.deepEqual(replaced, [{ "tk:embedded-depth": "0" }]);
  });
  await scratch(async (directory) => {
    const kept = JSON.parse(await written(directory, "RMETA", { "metadata-filters": FILTERS, "parse-context": { "metadata-filters": [] } })) as Array<
      Record<string, string>
    >;
    assert.deepEqual(Object.keys(kept[0] ?? {}).sort(), ["Content-Type", "tk:content"]);
  });
});

test("CONTENT_ONLY through a configuration: the top-level chain does not touch the content written", async () => {
  await scratch(async (directory) => {
    const text = await written(directory, "CONTENT_ONLY", { "metadata-filters": [{ "exclude-field-metadata-filter": { exclude: ["tk:content"] } }] }, "txt");
    assert.equal(text.trim(), "alpha text");
  });
});

test("CONTENT_ONLY through a configuration: a parse-context chain that drops tk:content writes no content", async () => {
  await scratch(async (directory) => {
    const text = await written(
      directory,
      "CONTENT_ONLY",
      { "parse-context": { "metadata-filters": [{ "exclude-field-metadata-filter": { exclude: ["tk:content"] } }] } },
      "txt",
    );
    assert.equal(text, "");
  });
});

test("a run's own filters replace the configuration's", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    mkdirSync(input);
    writeFileSync(join(input, "doc.txt"), "alpha text");
    const config = {
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { mem: { "file-system-emitter": { basePath: join(directory, "out") } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "mem" } },
      pipes: { parseMode: "RMETA" },
      "metadata-filters": FILTERS,
    };
    const engine = createEngineFromSettings(loadConfig(config).pipes!, { metadataFilters: { configured: include("tk:embedded-depth") } });
    await engine.run();
    const written = JSON.parse(readFileSync(join(directory, "out", "doc.txt"), "utf8")) as unknown;
    assert.deepEqual(written, [{ "tk:embedded-depth": "0" }]);
    assert.deepEqual(readdirSync(join(directory, "out")), ["doc.txt"]);
  });
});
