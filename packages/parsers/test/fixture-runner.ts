import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Metadata, ParseOptions, ParseRecord } from "@spikedpunch/ripstream-core";
import type { createRipstream } from "../src/index.ts";

/**
 * Declarative parser fixtures: one JSON file = input + options + assertions. See CLAUDE.md "Fixtures".
 *
 * Fields an assertion can read: `text` (parse), `mediaType` (detect), `metadata.<key>` (parse; everything after the
 * first "metadata." is the key, so keys with dots or colons work). A metadata key that is not set reads as absent.
 *
 * `operation: "parseRecursive"` reads one record of `parseRecursive` by its index, the container first:
 * `records.<i>.text`, `records.<i>.path` (embeddedResourcePath), `records.<i>.pathParts` (the parts as JSON, e.g.
 * `[{"kind":"root","name":"a.zip"},{"kind":"entry","name":"data/b.csv"}]`), `records.<i>.mediaType` and
 * `records.<i>.metadata.<key>`. A record past the end reads as absent.
 *
 * With `options.segments: true` (parseRecursive only), `records.<i>.segments` reads the record's segments, one line
 * each: `<location> | <text> | <labels joined by " > ">`, the text with backslash, CR, LF and tab written as \\, \r,
 * \n and \t. Such a fixture also checks, whatever its assertions, that every segment's text is its slice of the
 * content and that each record's content is the same as with segments off.
 *
 * With `options.emailHeaders: true` a fixture also checks, whatever its assertions, that nothing but the text changed: the
 * metadata is what it is without the option, and each content is the content it has without the option with a header
 * block (header lines and a blank line) put in, at the start of a `parse` text (or no block at all, when the message has
 * no header to show).
 */
export type Assertion =
  | { readonly type: "equals" | "contains" | "not_contains" | "matches"; readonly field: string; readonly value: string }
  | { readonly type: "min_length" | "max_length"; readonly field: string; readonly value: number }
  | { readonly type: "absent"; readonly field: string };

export interface FixtureInput {
  /** Exactly one of text (UTF-8), base64, file (path relative to the fixture). */
  readonly text?: string;
  readonly base64?: string;
  readonly file?: string;
  readonly filename?: string;
}

export interface Fixture {
  readonly description: string;
  readonly tags?: readonly string[];
  readonly operation?: "parse" | "detect" | "parseRecursive";
  readonly input: FixtureInput;
  readonly options?: Pick<ParseOptions, "contentType" | "onDocumentFailure" | "onOutputLimit" | "limits" | "segments" | "emailHeaders">;
  readonly assertions: readonly Assertion[];
}

export interface LoadedFixture {
  readonly name: string;
  readonly path: string;
  readonly fixture: Fixture;
}

/** What assertions read from: a parse result (text + metadata) or a detect result (mediaType). */
export interface FieldView {
  readonly text?: string;
  readonly mediaType?: string;
  readonly metadata?: Metadata;
  readonly records?: readonly ParseRecord[];
}

const STRING_TYPES = ["equals", "contains", "not_contains", "matches"];
const NUMBER_TYPES = ["min_length", "max_length"];

function fail(path: string, message: string): never {
  throw new Error(`fixture ${path}: ${message}`);
}

/** Checks the shape of a parsed fixture file, so a typo fails at load with the file named. */
export function validateFixture(raw: unknown, path: string): Fixture {
  const f = raw as Partial<Fixture> | null;
  if (typeof f !== "object" || f === null) return fail(path, "must be a JSON object");
  if (typeof f.description !== "string" || f.description === "") fail(path, "description is required");
  if (f.operation !== undefined && f.operation !== "parse" && f.operation !== "detect" && f.operation !== "parseRecursive") {
    fail(path, `operation must be "parse", "detect" or "parseRecursive", got ${JSON.stringify(f.operation)}`);
  }
  const input = f.input;
  if (typeof input !== "object" || input === null) return fail(path, "input is required");
  const sources = (["text", "base64", "file"] as const).filter((k) => input[k] !== undefined);
  if (sources.length !== 1) fail(path, `input needs exactly one of text, base64, file; got ${sources.length}`);
  if (!Array.isArray(f.assertions) || f.assertions.length === 0) fail(path, "assertions must be a non-empty array");
  for (const a of f.assertions as Assertion[]) {
    if (typeof a.field !== "string") fail(path, `assertion needs a field: ${JSON.stringify(a)}`);
    if (STRING_TYPES.includes(a.type)) {
      if (typeof (a as { value?: unknown }).value !== "string") fail(path, `${a.type} on ${a.field} needs a string value`);
    } else if (NUMBER_TYPES.includes(a.type)) {
      if (typeof (a as { value?: unknown }).value !== "number") fail(path, `${a.type} on ${a.field} needs a number value`);
    } else if (a.type !== "absent") {
      fail(path, `unknown assertion type ${JSON.stringify((a as { type: unknown }).type)}`);
    }
  }
  return f as Fixture;
}

function read(view: FieldView, field: string): string | undefined {
  if (field.startsWith("records.")) return readRecord(view, field);
  if (field === "text" || field === "mediaType") {
    const value = view[field];
    if (value === undefined) throw new Error(`field ${field} is not available for this operation`);
    return value;
  }
  if (field.startsWith("metadata.")) {
    if (view.metadata === undefined) throw new Error(`field ${field} is not available for this operation`);
    return view.metadata.get(field.slice("metadata.".length)) ?? undefined;
  }
  throw new Error(`unknown field ${JSON.stringify(field)}: use text, mediaType, metadata.<key> or records.<i>.<field>`);
}

/** `records.<i>.<field>` of a parseRecursive view. */
function readRecord(view: FieldView, field: string): string | undefined {
  if (view.records === undefined) throw new Error(`field ${field} is not available for this operation`);
  const match = /^records\.(\d+)\.(.+)$/.exec(field);
  if (match === null) throw new Error(`field ${field}: expected records.<index>.<field>`);
  const record = view.records[Number(match[1])];
  if (record === undefined) return undefined;
  const rest = match[2]!;
  if (rest.startsWith("metadata.")) return record.metadata.get(rest.slice("metadata.".length)) ?? undefined;
  switch (rest) {
    case "text": return record.content;
    case "path": return record.embeddedResourcePath;
    case "pathParts": return record.pathParts === undefined ? undefined : JSON.stringify(record.pathParts);
    case "mediaType": return record.mediaType.toString();
    case "segments": return record.segments === undefined ? undefined : renderSegments(record.segments);
    default: throw new Error(`field ${field}: use text, path, pathParts, mediaType, segments or metadata.<key> of a record`);
  }
}

function renderSegments(segments: NonNullable<ParseRecord["segments"]>): string {
  const escape = (text: string): string =>
    text.replace(/[\\\r\n\t]/g, (char) => ({ "\\": "\\\\", "\r": "\\r", "\n": "\\n", "\t": "\\t" })[char]!);
  return segments.map((segment) => `${segment.location} | ${escape(segment.text)} | ${segment.labels.join(" > ")}`).join("\n");
}

/** What holds for any parse with segments: each is its slice of the content, and the content is as without them. */
async function checkSegmentInvariants(
  ripstream: ReturnType<typeof createRipstream>,
  bytes: Uint8Array,
  options: ParseOptions,
  records: readonly ParseRecord[],
): Promise<void> {
  const plain = await ripstream.parseRecursive(bytes, { ...options, segments: false });
  assert.deepEqual(records.map((record) => record.content), plain.map((record) => record.content), "content with segments on vs off");
  for (const record of records) {
    for (const segment of record.segments ?? []) {
      assert.equal(record.content.slice(segment.start, segment.end), segment.text, `segment ${segment.location} is its slice`);
    }
  }
}

const HEADER_BLOCK = /^(?:(?:Subject|From|To|CC|BCC|Date): [^\n]+\n)+\n/m;

/**
 * What holds for any parse with emailHeaders: the metadata is the same, and the content is the content without it with
 * a header block put in. `atStart`: where the block is (`parse`: the first thing in the text; a `parseRecursive` record
 * has its title and markup whitespace first, as without the option).
 */
function checkEmailHeaderInvariants(
  withBlock: { text: string; metadata?: Metadata },
  plain: { text: string; metadata?: Metadata },
  atStart: boolean,
  label: string,
): void {
  if (withBlock.metadata !== undefined && plain.metadata !== undefined) {
    assert.deepEqual(metadataEntries(withBlock.metadata), metadataEntries(plain.metadata), `${label}: metadata with emailHeaders vs without`);
  }
  if (withBlock.text === plain.text) return;
  const block = HEADER_BLOCK.exec(withBlock.text);
  assert.notEqual(block, null, `${label}: the content with emailHeaders has a header block`);
  const at = (block as RegExpExecArray).index;
  if (atStart) assert.equal(at, 0, `${label}: the header block is the first thing in the text`);
  const without = withBlock.text.slice(0, at) + withBlock.text.slice(at + (block as RegExpExecArray)[0].length);
  assert.equal(without, plain.text, `${label}: the content without the header block is the content without emailHeaders`);
}

/** Every name and its values but the parse's own clock, which differs between two parses of the same bytes. */
function metadataEntries(metadata: Metadata): Array<[string, readonly string[]]> {
  return [...metadata.names()].filter((name) => name !== "tk:parse-time-millis").sort().map((name) => [name, metadata.getAll(name)]);
}

/** Throws an AssertionError naming the field and assertion when it does not hold. */
export function check(view: FieldView, a: Assertion): void {
  const actual = read(view, a.field);
  const label = `${a.field} ${a.type}`;
  if (a.type === "absent") {
    assert.equal(actual, undefined, `${label}: expected the field to be absent`);
    return;
  }
  assert.notEqual(actual, undefined, `${label}: field is absent`);
  const got = actual as string;
  switch (a.type) {
    case "equals": assert.equal(got, a.value, label); break;
    case "contains": assert.ok(got.includes(a.value), `${label}: ${JSON.stringify(a.value)} not found in ${JSON.stringify(got.slice(0, 200))}`); break;
    case "not_contains": assert.ok(!got.includes(a.value), `${label}: ${JSON.stringify(a.value)} found in ${JSON.stringify(got.slice(0, 200))}`); break;
    case "matches": assert.match(got, new RegExp(a.value), label); break;
    case "min_length": assert.ok(got.length >= a.value, `${label}: length ${got.length} < ${a.value}`); break;
    case "max_length": assert.ok(got.length <= a.value, `${label}: length ${got.length} > ${a.value}`); break;
  }
}

function bytesOf(input: FixtureInput, fixturePath: string): Uint8Array {
  if (input.text !== undefined) return new TextEncoder().encode(input.text);
  if (input.base64 !== undefined) return Buffer.from(input.base64, "base64");
  return readFileSync(resolve(dirname(fixturePath), input.file as string));
}

/** Runs one fixture against a ripstream instance; throws on the first failed assertion. */
export async function runFixture(ripstream: ReturnType<typeof createRipstream>, loaded: LoadedFixture): Promise<void> {
  const { fixture, path } = loaded;
  const bytes = bytesOf(fixture.input, path);
  const options: ParseOptions = {
    ...fixture.options,
    ...(fixture.input.filename === undefined ? {} : { filename: fixture.input.filename }),
  };
  let view: FieldView;
  if (fixture.operation === "detect") {
    view = { mediaType: (await ripstream.detect(bytes, options)).toString() };
  } else if (fixture.operation === "parseRecursive") {
    const records = await ripstream.parseRecursive(bytes, options);
    if (options.segments === true) await checkSegmentInvariants(ripstream, bytes, options, records);
    if (options.emailHeaders === true) {
      const plain = await ripstream.parseRecursive(bytes, { ...options, emailHeaders: false });
      assert.equal(records.length, plain.length, "record count with emailHeaders on vs off");
      records.forEach((record, index) =>
        checkEmailHeaderInvariants({ text: record.content, metadata: record.metadata }, { text: plain[index]!.content, metadata: plain[index]!.metadata }, false, `record ${index}`),
      );
    }
    view = { records };
  } else {
    const result = await ripstream.parse(bytes, options);
    if (options.emailHeaders === true) {
      checkEmailHeaderInvariants(result, await ripstream.parse(bytes, { ...options, emailHeaders: false }), true, "parse");
    }
    view = { text: result.text, metadata: result.metadata };
  }
  for (const a of fixture.assertions) check(view, a);
}

/** Every *.json under `root`, recursively, validated; name is the path relative to `root` without ".json". */
export function loadFixtures(root: string): LoadedFixture[] {
  const out: LoadedFixture[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json")) {
        const fixture = validateFixture(JSON.parse(readFileSync(path, "utf8")), path);
        out.push({ name: path.slice(root.length + 1).replace(/\.json$/, ""), path, fixture });
      }
    }
  };
  walk(root);
  return out;
}
