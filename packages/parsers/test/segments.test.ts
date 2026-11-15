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

test("a short csv is text, as in Tika, and its segments are still cells: row, col and the header as the label (tikajs-e0sm)", async () => {
  const csv = new TextEncoder().encode("id,cn passport,lt code\n0,n/a,n/a\n1,S5230,3880\n2,n/a,n/a\n");
  const asText = await ripstream.parseRecursive(csv, { filename: "short.csv", segments: true });
  assert.equal(asText[0]!.mediaType.toString(), "text/plain");
  const cell = leafSegments(asText[0]!.segments!).find((segment) => segment.text === "S5230")!;
  assert.deepEqual([cell.location, cell.labels], ["row=3;col=2", ["cn passport"]]);
  assert.equal(asText[0]!.content.slice(cell.start, cell.end), "S5230");
  // The table path of a csv.delimiter parser gives the same cell.
  const asTable = await createRipstream({ csv: { delimiter: "," } }).parseRecursive(csv, { filename: "short.csv", segments: true });
  const tableCell = leafSegments(asTable[0]!.segments!).find((segment) => segment.text === "S5230")!;
  assert.deepEqual([tableCell.location, tableCell.labels], [cell.location, cell.labels]);
});

test("a short csv's text and metadata are the same with segments on and off (tikajs-e0sm)", async () => {
  const csv = new TextEncoder().encode('a,b\n1,"x\ny"\n\n2,3\n');
  const plain = await ripstream.parseRecursive(csv, { filename: "t.csv" });
  const withSegments = await ripstream.parseRecursive(csv, { filename: "t.csv", segments: true });
  assert.equal(withSegments[0]!.content, plain[0]!.content);
  const keys = (record: ParseRecord): string => JSON.stringify([...record.metadata.names()].filter((name) => name !== "tk:parse-time-millis").sort());
  assert.equal(keys(withSegments[0]!), keys(plain[0]!));
});

test("a short csv's quoted multiline cell is one cell, and the rows after it keep their numbers (tikajs-e0sm)", async () => {
  const csv = new TextEncoder().encode('id,note\n1,"line one\nline two"\n\n2,"say ""hi"""\n3,plain\n');
  const [record] = await ripstream.parseRecursive(csv, { filename: "q.csv", segments: true });
  const cells = leafSegments(record!.segments!).map((segment) => [segment.location, segment.text, segment.labels.join("|")]);
  assert.deepEqual(cells, [
    ["row=1;col=1", "id", ""],
    ["row=1;col=2", "note", ""],
    ["row=2;col=1", "1", "id"],
    ["row=2;col=2", "line one\nline two", "note"],
    ["row=3;col=1", "2", "id"],
    ["row=3;col=2", 'say ""hi""', "note"],
    ["row=4;col=1", "3", "id"],
    ["row=4;col=2", "plain", "note"],
  ]);
});

test("a short csv declared text/csv uses the delimiter its columns have; a .tsv already had cells (tikajs-e0sm)", async () => {
  const semicolons = new TextEncoder().encode("name;card\nann;4111\nbob;5500\n");
  const [semi] = await ripstream.parseRecursive(semicolons, { filename: "s.csv", segments: true });
  const card = leafSegments(semi!.segments!).find((segment) => segment.text === "5500")!;
  assert.deepEqual([card.location, card.labels], ["row=3;col=2", ["card"]]);
  const tabs = new TextEncoder().encode("name\tcard\nann\t4111\n");
  const [tsv] = await ripstream.parseRecursive(tabs, { filename: "t.tsv", segments: true });
  const tab = leafSegments(tsv!.segments!).find((segment) => segment.text === "4111")!;
  assert.deepEqual([tab.location, tab.labels], ["row=2;col=2", ["card"]]);
});

test("text that is not declared csv keeps its line segments (tikajs-e0sm)", async () => {
  const text = new TextEncoder().encode("id,card\n1,4111\n");
  const [record] = await ripstream.parseRecursive(text, { filename: "notes.txt", segments: true });
  assert.deepEqual(record!.segments!.map((segment) => segment.location), ["line=1", "line=2"]);
});

test("a csv read as text has the cells, rows, columns and labels of the same csv read as a table (tikajs-e0sm)", async () => {
  const samples = [
    "a,b,c\n1,2,3\n4,5,6\n",
    'h1,h2\n"x, y",z\n"multi\nline","q ""uoted"""\n\n  7  ,8\n',
    "only\nrows\nhere",
    'id,note\r\n1,"a\r\nb"\r\n2,\r\n',
    "a,b\n,\n1,\n,2\n",
    "a,b,c\n1,2\n3,4,5,6\n",
    '"a","b"\n"1","2"',
  ];
  const asTable = createRipstream({ csv: { delimiter: "," } });
  const cells = (records: readonly ParseRecord[]): string[] =>
    leafSegments(records[0]!.segments!).map((segment) => `${segment.location} ${segment.labels.join("|")} ${segment.text.replace(/""/g, '"').replace(/\r?\n/g, " ")}`);
  for (const sample of samples) {
    const bytes = new TextEncoder().encode(sample);
    const text = await ripstream.parseRecursive(bytes, { filename: "t.csv", segments: true });
    const table = await asTable.parseRecursive(bytes, { filename: "t.csv", segments: true });
    // Tika's sniffer reads some of these as tables already; either way the cells agree.
    assert.deepEqual(cells(text), cells(table), JSON.stringify(sample));
  }
});
