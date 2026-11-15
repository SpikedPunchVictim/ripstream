import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer, type ServerMimeType } from "../src/index.ts";
import { readZip, storedZip } from "./fixtures/zip.ts";

/*
 * `?segments=true` on /rmeta and /unpack (tikajs-5wd0): each record that has segments carries them as `tk:segments`, a string of
 * JSON, as `parse -r --segments` and the pipes engine write them (docs/segments.md). Off by default, and then the answer is what
 * it was. It is a query parameter, as the limits and the preset are; it needs a text or body handler.
 */

const registry: ServerMimeType[] = [
  { type: "application/zip", extensions: [".zip"] },
  { type: "text/plain", extensions: [".txt"] },
];

async function withServer<T>(run: (base: string) => Promise<T>, options: Parameters<typeof createRipstreamServer>[0] = {}): Promise<T> {
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, mimeTypes: registry, ...options });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

const container = storedZip({ "a.txt": "first line\nsecond line\n", "b.csv": "id,card\n1,4111\n2,5500\n" });
const put = (base: string, path: string, body: Uint8Array | string = container): Promise<Response> =>
  fetch(`${base}${path}`, { method: "PUT", body });

type Rmeta = Array<Record<string, unknown>>;

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly labels: readonly string[];
  readonly location: string;
}

const segmentsOf = (object: Record<string, unknown>): Segment[] => {
  assert.equal(typeof object["tk:segments"], "string");
  return JSON.parse(object["tk:segments"] as string) as Segment[];
};

/** The answer without the one value that is the clock's. */
const stable = (rmeta: Rmeta): string => JSON.stringify(rmeta.map(({ "tk:parse-time-millis": _time, ...rest }) => rest));

test("/rmeta?segments=true adds tk:segments to each record, with offsets into its tk:content", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/rmeta?segments=true");
    assert.equal(response.status, 200);
    const rmeta = (await response.json()) as Rmeta;
    const text = rmeta.find((object) => object["tk:resource-name"] === "a.txt")!;
    const lines = segmentsOf(text);
    assert.deepEqual(lines.map((segment) => segment.location), ["line=1", "line=2"]);
    assert.equal((text["tk:content"] as string).slice(lines[1]!.start, lines[1]!.end), "second line");
    // A csv read as text gets its cells, with the header as the label (tikajs-e0sm).
    const csv = rmeta.find((object) => object["tk:resource-name"] === "b.csv")!;
    const cell = segmentsOf(csv).find((segment) => (csv["tk:content"] as string).slice(segment.start, segment.end) === "5500")!;
    assert.deepEqual([cell.location, cell.labels], ["row=3;col=2", ["card"]]);
  });
});

test("/rmeta answers what it did without segments: no key, and the same as ?segments=false", async () => {
  await withServer(async (base) => {
    const plain = (await (await put(base, "/rmeta")).json()) as Rmeta;
    const off = (await (await put(base, "/rmeta?segments=false")).json()) as Rmeta;
    assert.ok(plain.every((object) => object["tk:segments"] === undefined));
    assert.equal(stable(off), stable(plain));
    // With segments the only difference is the key.
    const on = (await (await put(base, "/rmeta?segments=true")).json()) as Rmeta;
    assert.equal(stable(on.map(({ "tk:segments": _segments, ...rest }) => rest)), stable(plain));
  });
});

test("/rmeta/body takes segments; a handler whose content they cannot point into is a 400 before the document is read", async () => {
  await withServer(async (base) => {
    assert.equal((await put(base, "/rmeta/body?segments=true")).status, 200);
    assert.equal((await put(base, "/rmeta/text?segments=true")).status, 200);
    for (const path of ["/rmeta/html", "/rmeta/xml", "/rmeta/markdown", "/rmeta/ignore"]) {
      const response = await put(base, `${path}?segments=true`);
      assert.equal(response.status, 400, path);
      assert.match(await response.text(), /segments need a text or body handler/, path);
      assert.equal((await put(base, path)).status, 200, `${path} without segments`);
    }
  });
});

test("a preset's handler is held to the same rule", async () => {
  await withServer(
    async (base) => {
      assert.equal((await put(base, "/rmeta?preset=markup&segments=true")).status, 400);
      assert.equal((await put(base, "/rmeta?preset=plain&segments=true")).status, 200);
    },
    { presets: { markup: { handler: "html" }, plain: { handler: "text" } } },
  );
});

test("segments takes true or false, once, and only on /rmeta and /unpack", async () => {
  await withServer(async (base) => {
    for (const bad of ["yes", "1", "", "TRUE "]) {
      const response = await put(base, `/rmeta?segments=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 400, bad);
      assert.match(await response.text(), /Invalid segments: expected true or false/);
    }
    assert.equal((await put(base, "/rmeta?segments=true&segments=true")).status, 400);
    for (const path of ["/tika", "/meta", "/detect", "/rmeta/text?bogus=1"]) {
      const response = await put(base, `${path}${path.includes("?") ? "&" : "?"}segments=true`);
      assert.equal(response.status, 400, path);
      assert.match(await response.text(), /Unknown query parameter/);
    }
    assert.equal((await put(base, "/rmeta?segments=TRUE")).status, 200);
  });
});

test("/unpack?segments=true writes them into rmeta.json of the package", async () => {
  await withServer(async (base) => {
    const entries = readZip(new Uint8Array(await (await put(base, "/unpack?segments=true")).arrayBuffer()));
    const rmeta = JSON.parse(entries.find((entry) => entry.name === "rmeta.json")!.data.toString("utf8")) as Rmeta;
    assert.ok(rmeta.some((object) => typeof object["tk:segments"] === "string"));
    const plain = readZip(new Uint8Array(await (await put(base, "/unpack")).arrayBuffer()));
    const plainRmeta = JSON.parse(plain.find((entry) => entry.name === "rmeta.json")!.data.toString("utf8")) as Rmeta;
    assert.ok(plainRmeta.every((object) => object["tk:segments"] === undefined));
    assert.deepEqual(entries.map((entry) => entry.name), plain.map((entry) => entry.name));
    assert.equal((await put(base, "/unpack/all/html?segments=true")).status, 400);
  });
});
