import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { leafSegments, parseSegmentLocation, type ParseOptions, type ParseRecord } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";
import { loadFixtures } from "./fixture-runner.ts";

const ripstream = createRipstream();
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const segmentFiles = join(fixtures, "segments", "files");

/** The input of every fixture, with the options it is parsed with. */
function fixtureInputs(): { readonly name: string; readonly bytes: Uint8Array; readonly options: ParseOptions }[] {
  return loadFixtures(fixtures)
    .filter(({ fixture }) => fixture.operation !== "detect")
    .map(({ name, path, fixture }) => {
      const { input } = fixture;
      const bytes = input.text !== undefined
        ? new TextEncoder().encode(input.text)
        : input.base64 !== undefined
          ? Buffer.from(input.base64, "base64")
          : readFileSync(resolve(dirname(path), input.file!));
      const { segments: _segments, ...options } = fixture.options ?? {};
      return { name, bytes, options: { ...options, ...(input.filename === undefined ? {} : { filename: input.filename }) } };
    });
}

async function outcome(bytes: Uint8Array, options: ParseOptions): Promise<readonly ParseRecord[] | string> {
  try {
    return await ripstream.parseRecursive(bytes, options);
  } catch (error) {
    return `threw ${(error as Error).name}`;
  }
}

test("parity: every fixture input parses to the same content with segments on as off, each segment its slice", async () => {
  let segments = 0;
  for (const { name, bytes, options } of fixtureInputs()) {
    const off = await outcome(bytes, options);
    const on = await outcome(bytes, { ...options, segments: true });
    if (typeof off === "string" || typeof on === "string") {
      assert.equal(on, off, `${name}: the same failure`);
      continue;
    }
    assert.deepEqual(on.map((record) => record.content), off.map((record) => record.content), `${name}: content`);
    for (const record of on) {
      assert.ok(record.segments !== undefined, `${name}: segments on every record`);
      let previous = -1;
      for (const segment of record.segments!) {
        assert.equal(record.content.slice(segment.start, segment.end), segment.text, `${name} ${segment.location}: slice`);
        assert.ok(segment.start >= previous, `${name}: in content order`);
        assert.ok(/\S/.test(segment.text), `${name} ${segment.location}: not blank`);
        assert.ok(segment.labels.every((label) => typeof label === "string" && label.length > 0), `${name}: labels`);
        parseSegmentLocation(segment.location);
        previous = segment.start;
        segments++;
      }
    }
  }
  assert.ok(segments > 1000, `only ${segments} segments over all the fixtures`);
});

test("round trip: (path, location) names exactly one segment, and finds every planted value again", async () => {
  for (const file of readdirSync(segmentFiles).filter((name) => name !== "make.py")) {
    const filename = file.replace(/\.txt$/, "");
    const records = await ripstream.parseRecursive(readFileSync(join(segmentFiles, file)), { filename, segments: true });
    const byAddress = new Map<string, string>();
    for (const record of records) {
      for (const segment of record.segments!) {
        const address = `${record.embeddedResourcePath}#${segment.location}`;
        assert.ok(!byAddress.has(address), `${file}: ${address} names two segments`);
        byAddress.set(address, segment.text);
      }
    }
    const planted = records.flatMap((record) =>
      [...record.content.matchAll(/PLANTED-[A-Z0-9-]+/g)].map((match) => ({ record, value: match[0], at: match.index })),
    );
    assert.ok(planted.length > 0, `${file}: has planted values`);
    for (const { record, value, at } of planted) {
      // The innermost segment that holds the value: a cell rather than its row.
      const holder = record.segments!
        .filter((segment) => segment.start <= at && at + value.length <= segment.end)
        .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
      assert.ok(holder !== undefined, `${file}: ${value} is in no segment`);
      const found = byAddress.get(`${record.embeddedResourcePath}#${holder.location}`);
      assert.ok(found?.includes(value), `${file}: ${holder.location} does not lead back to ${value}`);
    }
  }
});

test("leafSegments: no two overlap, together they hold every character, and a planted value's segment carries its column header", async () => {
  const headers = new Map([["vendors.xlsx", "Tax ID"], ["customers.csv", "tax_id"], ["vendors.tsv", "tax_id"]]);
  for (const file of readdirSync(segmentFiles).filter((name) => name !== "make.py")) {
    const filename = file.replace(/\.txt$/, "");
    const records = await ripstream.parseRecursive(readFileSync(join(segmentFiles, file)), { filename, segments: true });
    for (const record of records) {
      const leaves = leafSegments(record.segments!);
      for (let index = 1; index < leaves.length; index++) {
        assert.ok(leaves[index]!.start >= leaves[index - 1]!.end, `${file}: ${leaves[index]!.location} overlaps ${leaves[index - 1]!.location}`);
      }
      // JSON text has its punctuation outside every segment: only its scalars are segments.
      if (!file.endsWith(".json.txt")) {
        assert.equal(
          leaves.map((segment) => segment.text).join("").replace(/\s+/g, ""),
          record.content.replace(/\s+/g, ""),
          `${file}: the leaves hold the text`,
        );
      }
      const header = headers.get(file);
      if (header === undefined) continue;
      const planted = leaves.find((segment) => segment.text.startsWith("PLANTED-"));
      assert.ok(planted !== undefined, `${file}: a leaf holds the planted value`);
      assert.equal(planted.labels.at(-1), header, `${file}: ${planted.location} is labelled by its column header`);
    }
  }
});

test("a short csv is text, as in Tika: lines without labels; csv.delimiter reads it as a table with the header as the label (tikajs-xlne)", async () => {
  const csv = new TextEncoder().encode("id,cn passport,lt code\n0,n/a,n/a\n1,S5230,3880\n2,n/a,n/a\n");
  const asText = await ripstream.parseRecursive(csv, { filename: "short.csv", segments: true });
  const line = asText[0]!.segments!.find((segment) => segment.text.includes("S5230"))!;
  assert.deepEqual([line.location, line.labels], ["line=3", []]);
  const asTable = await createRipstream({ csv: { delimiter: "," } }).parseRecursive(csv, { filename: "short.csv", segments: true });
  const cell = leafSegments(asTable[0]!.segments!).find((segment) => segment.text === "S5230")!;
  assert.deepEqual([cell.location, cell.labels], ["row=3;col=2", ["cn passport"]]);
});
