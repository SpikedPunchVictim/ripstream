import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "@spikedpunch/ripstream-core";
import { createEngineFromSettings } from "../src/index.ts";
import { fakeAzureBlob } from "./fixtures/fake-azure-blob.ts";
import { fakeGcs } from "./fixtures/fake-gcs.ts";
import { fakeSearch, type FakeSearch } from "./fixtures/fake-search.ts";
import { fakeSolr } from "./fixtures/fake-solr.ts";

/*
 * The GCS, Azure Blob and Solr components and the Elasticsearch and OpenSearch reporters (tikajs-68os.31 to .34), from a
 * Tika-shaped configuration through `loadConfig` and `createEngineFromSettings`, run against the fake servers the
 * components' own tests use. What each component does is tested there; this tests that a configuration reaches it.
 * Nothing here ran against GCS, Azure, Solr, Elasticsearch or OpenSearch.
 */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CLIENT_EMAIL = "tika@my-project.iam.gserviceaccount.com";

/** A directory with two files in `in/`, removed afterwards. */
async function withFiles(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cloud-"));
  try {
    mkdirSync(join(directory, "in"));
    writeFileSync(join(directory, "in", "a.txt"), "alpha text");
    writeFileSync(join(directory, "in", "b.txt"), "beta text");
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const textOf = (value: Buffer | undefined): string => (value === undefined ? "" : value.toString("utf8"));

// ---- GCS -----------------------------------------------------------------------------------------------------------

test("gcs-fetcher, gcs-emitter and gcs-pipes-iterator read objects of a bucket and write the metadata back, from a configuration", async () => {
  await withFiles(async (directory) => {
    const gcs = await fakeGcs("docs-bucket", { publicKey, clientEmail: CLIENT_EMAIL });
    try {
      const keyFile = join(directory, "key.json");
      writeFileSync(keyFile, JSON.stringify({ type: "service_account", client_email: CLIENT_EMAIL, private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: gcs.tokenUrl }));
      gcs.objects.set("in/a.txt", Buffer.from("alpha text"));
      gcs.objects.set("in/b.txt", Buffer.from("beta text"));
      const connection = { projectId: "my-project", bucket: "docs-bucket" };
      const config = loadConfig({
        fetchers: { gf: { "gcs-fetcher": connection } },
        emitters: { ge: { "gcs-emitter": { ...connection, prefix: "out" } } },
        "pipes-iterator": { "gcs-pipes-iterator": { ...connection, prefix: "in/", fetcherId: "gf", emitterId: "ge" } },
      });
      const engine = createEngineFromSettings(config.pipes!, { gcs: { endpoint: gcs.url, env: { GOOGLE_APPLICATION_CREDENTIALS: keyFile } } });
      await engine.run();
      assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });
      assert.deepEqual([...gcs.objects.keys()].sort(), ["in/a.txt", "in/b.txt", "out/in/a.txt.json", "out/in/b.txt.json"]);
      assert.match(textOf(gcs.objects.get("out/in/a.txt.json")), /alpha text/);
      assert.match(textOf(gcs.objects.get("out/in/b.txt.json")), /beta text/);
    } finally {
      await gcs.close();
    }
  });
});

// ---- Azure Blob ----------------------------------------------------------------------------------------------------

test("az-blob-fetcher, az-blob-emitter and az-blob-pipes-iterator read blobs of a container and write the metadata back, from a configuration", async () => {
  const sas = "sv=2022-11-02&sp=rlcw&sig=sealed";
  const azure = await fakeAzureBlob("docs", { sas });
  try {
    azure.blobs.set("in/a.txt", Buffer.from("alpha text"));
    azure.blobs.set("in/b.txt", Buffer.from("beta text"));
    const connection = { sasToken: sas, endpoint: azure.url, container: "docs" };
    const config = loadConfig({
      fetchers: { af: { "az-blob-fetcher": connection } },
      emitters: { ae: { "az-blob-emitter": { ...connection, prefix: "out" } } },
      "pipes-iterator": { "az-blob-pipes-iterator": { ...connection, prefix: "in/", fetcherId: "af", emitterId: "ae" } },
    });
    const engine = createEngineFromSettings(config.pipes!);
    await engine.run();
    assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });
    assert.deepEqual([...azure.blobs.keys()].sort(), ["in/a.txt", "in/b.txt", "out/in/a.txt.json", "out/in/b.txt.json"]);
    assert.match(textOf(azure.blobs.get("out/in/b.txt.json")), /beta text/);
  } finally {
    await azure.close();
  }
});

// ---- Solr ----------------------------------------------------------------------------------------------------------

test("solr-pipes-iterator takes its work from one collection and solr-emitter indexes the parse in another, from a configuration", async () => {
  await withFiles(async (directory) => {
    const queue = await fakeSolr("queue");
    const results = await fakeSolr("results");
    try {
      queue.docs.set("1", { id: "1", path: "in/a.txt", parsing_id: 0 });
      queue.docs.set("2", { id: "2", path: "in/b.txt", parsing_id: 0 });
      const config = loadConfig({
        fetchers: { fsf: { "file-system-fetcher": { basePath: directory } } },
        emitters: { se: { "solr-emitter": { solrCollection: "results", solrUrls: [results.url] } } },
        "pipes-iterator": {
          "solr-pipes-iterator": { solrCollection: "queue", solrUrls: [queue.url], idField: "path", parsingIdField: "parsing_id", failCountField: "fail_count", sizeFieldName: "size", fetcherId: "fsf", emitterId: "se" },
        },
      });
      const engine = createEngineFromSettings(config.pipes!);
      await engine.run();
      assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });
      assert.deepEqual([...results.docs.keys()].sort(), ["in/a.txt", "in/b.txt"]);
      assert.match(String(results.docs.get("in/a.txt")?.["Content-Type"]), /^text\/plain/);
    } finally {
      await queue.close();
      await results.close();
    }
  });
});

// ---- the reporters ---------------------------------------------------------------------------------------------------

async function withSearch(run: (search: FakeSearch) => Promise<void>): Promise<void> {
  const search = await fakeSearch();
  try {
    await run(search);
  } finally {
    await search.close();
  }
}

const fileSystemPipeline = (directory: string) => ({
  fetchers: { fsf: { "file-system-fetcher": { basePath: join(directory, "in") } } },
  emitters: { fse: { "file-system-emitter": { basePath: join(directory, "out") } } },
  "pipes-iterator": { "file-system-pipes-iterator": { basePath: join(directory, "in"), fetcherId: "fsf", emitterId: "fse" } },
});

test("es-pipes-reporter and opensearch-pipes-reporter record how each input ended, from a configuration", async () => {
  await withFiles(async (directory) => {
    mkdirSync(join(directory, "out"));
    await withSearch(async (search) => {
      const config = loadConfig({
        ...fileSystemPipeline(directory),
        "pipes-reporters": {
          "es-pipes-reporter": { esUrl: `${search.url}/es-status`, keyPrefix: "rs_", includeRouting: true, apiKey: "a2V5" },
          "opensearch-pipes-reporter": { openSearchUrl: `${search.url}/os-status`, excludes: ["FETCH_EXCEPTION"], httpClientConfig: { userName: "admin", password: "pw" } },
        },
      });
      const engine = createEngineFromSettings(config.pipes!);
      await engine.run();
      assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });

      const sent = (path: string) => search.requests.filter((request) => request.url === path);
      assert.equal(sent("/es-status/_bulk").length, 2);
      assert.equal(sent("/os-status/_bulk").length, 2);
      const es = sent("/es-status/_bulk").map((request) => request.body.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, Record<string, string>>));
      assert.deepEqual(es.map(([action]) => action?.update?._id).sort(), ["a.txt", "b.txt"]);
      assert.deepEqual(es.map(([action]) => action?.update?.routing).sort(), ["a.txt", "b.txt"]);
      for (const [, document] of es) assert.equal(document?.doc?.rs_parse_status, "EMIT_SUCCESS");
      for (const request of sent("/es-status/_bulk")) assert.equal(request.headers.authorization, "ApiKey a2V5");
      for (const request of sent("/os-status/_bulk")) {
        assert.equal(request.headers.authorization, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
        assert.match(request.body, /"parse_status":"EMIT_SUCCESS"/);
      }
    });
  });
});

test("a reporter's includes keep the results it records: no result of this run is one it names, so nothing is sent", async () => {
  await withFiles(async (directory) => {
    mkdirSync(join(directory, "out"));
    await withSearch(async (search) => {
      const config = loadConfig({ ...fileSystemPipeline(directory), "pipes-reporters": { "es-pipes-reporter": { esUrl: `${search.url}/status`, includes: ["EMIT_EXCEPTION"] } } });
      const engine = createEngineFromSettings(config.pipes!);
      await engine.run();
      assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 });
      assert.equal(search.requests.length, 0);
    });
  });
});

test("the run's search transport replaces the network of the settings' reporters", async () => {
  await withFiles(async (directory) => {
    mkdirSync(join(directory, "out"));
    const urls: string[] = [];
    const config = loadConfig({ ...fileSystemPipeline(directory), "pipes-reporters": { "es-pipes-reporter": { esUrl: "https://es.example/status" } } });
    const engine = createEngineFromSettings(config.pipes!, {
      search: {
        fetchImpl: (async (url: string) => {
          urls.push(url);
          return new Response('{"errors":false}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    await engine.run();
    assert.deepEqual(urls, ["https://es.example/status/_bulk", "https://es.example/status/_bulk"]);
  });
});

test("a report the index refuses ends the run, as a reporter that throws does", async () => {
  await withFiles(async (directory) => {
    mkdirSync(join(directory, "out"));
    await withSearch(async (search) => {
      search.answer(403, '{"error":"forbidden"}', 2);
      const config = loadConfig({ ...fileSystemPipeline(directory), "pipes-reporters": { "opensearch-pipes-reporter": { openSearchUrl: `${search.url}/status` } } });
      await assert.rejects(createEngineFromSettings(config.pipes!).run(), /opensearch-pipes-reporter _bulk 403/);
    });
  });
});
