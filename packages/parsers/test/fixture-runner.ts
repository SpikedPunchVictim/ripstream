import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Metadata, ParseOptions } from "@spikedpunch/ripstream-core";
import type { createRipstream } from "../src/index.ts";

/**
 * Declarative parser fixtures: one JSON file = input + options + assertions. See CLAUDE.md "Fixtures".
 *
 * Fields an assertion can read: `text` (parse), `mediaType` (detect), `metadata.<key>` (parse; everything after the
 * first "metadata." is the key, so keys with dots or colons work). A metadata key that is not set reads as absent.
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
  readonly operation?: "parse" | "detect";
  readonly input: FixtureInput;
  readonly options?: Pick<ParseOptions, "contentType" | "onDocumentFailure" | "onOutputLimit" | "limits">;
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
  if (f.operation !== undefined && f.operation !== "parse" && f.operation !== "detect") {
    fail(path, `operation must be "parse" or "detect", got ${JSON.stringify(f.operation)}`);
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
  if (field === "text" || field === "mediaType") {
    const value = view[field];
    if (value === undefined) throw new Error(`field ${field} is not available for this operation`);
    return value;
  }
  if (field.startsWith("metadata.")) {
    if (view.metadata === undefined) throw new Error(`field ${field} is not available for this operation`);
    return view.metadata.get(field.slice("metadata.".length)) ?? undefined;
  }
  throw new Error(`unknown field ${JSON.stringify(field)}: use text, mediaType or metadata.<key>`);
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
  } else {
    const result = await ripstream.parse(bytes, options);
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
