import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WARNINGS_PER_RESULT, type ParseWarning } from "@spikedpunch/ripstream-core";
import { FrameReader, type FrameEvent } from "../src/frames.ts";

/** The warnings on the frames (tikajs-icjf): a child's list is checked field by field, and a hostile one is a protocol violation. */

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const feed = (r: FrameReader, text: string): FrameEvent[] => r.push(new TextEncoder().encode(text));
const violations = (events: FrameEvent[]): string[] => events.flatMap((e) => (e.type === "violation" ? [e.kind] : []));

const READY = { t: "ready", pid: 42 };
const DONE = { t: "done" };
const RECORD = { metadata: {}, content: "x", embeddedResourcePath: "/a", depth: 0, mediaType: "application/pdf", exception: null };

const WARNINGS: ParseWarning[] = [
  { kind: "image-only", pages: 1, of: 2, pageNumbers: [2], chars: 3 },
  { kind: "partial", reason: "entries-failed", failed: 1, of: 2, path: "/a.zip" },
];

const textReader = (): FrameReader => new FrameReader({ maxTotalBytes: 10_000_000, output: "text" });
const recordsReader = (): FrameReader => new FrameReader({ maxTotalBytes: 10_000_000, output: "records" });

test("the warnings of a text result arrive on the result", () => {
  const r = textReader();
  const events = feed(r, line(READY) + line({ t: "meta", metadata: {}, warnings: WARNINGS }) + line(DONE));
  assert.deepEqual(violations(events), []);
  const result = r.result();
  assert.deepEqual(result.kind === "text" ? result.warnings : null, WARNINGS);
});

test("a text result without warnings has none on it", () => {
  const r = textReader();
  feed(r, line(READY) + line({ t: "meta", metadata: {} }) + line(DONE));
  const result = r.result();
  assert.equal(result.kind === "text" ? result.warnings : "wrong kind", undefined);
});

test("the warnings of a record arrive on the record", () => {
  const r = recordsReader();
  const events = feed(r, line(READY) + line({ t: "record", record: { ...RECORD, warnings: WARNINGS } }) + line(DONE));
  assert.deepEqual(violations(events), []);
  const result = r.result();
  assert.deepEqual(result.kind === "records" ? result.records[0]?.warnings : null, WARNINGS);
});

const hostile: [string, unknown][] = [
  ["not a list", "none"],
  ["an unknown kind", [{ kind: "scary" }]],
  ["an unknown field", [{ kind: "truncated", limit: "outputChars", extra: true }]],
  ["a negative count", [{ kind: "partial", reason: "pages-failed", failed: -1, of: 2 }]],
  ["more than a result can carry", Array.from({ length: MAX_WARNINGS_PER_RESULT + 1 }, () => ({ kind: "truncated", limit: "outputChars" }))],
];

for (const [label, warnings] of hostile) {
  test(`a meta frame whose warnings are ${label} is a protocol violation`, () => {
    const r = textReader();
    feed(r, line(READY));
    assert.deepEqual(violations(feed(r, line({ t: "meta", metadata: {}, warnings }))), ["protocol"]);
  });

  test(`a record whose warnings are ${label} is a protocol violation`, () => {
    const r = recordsReader();
    feed(r, line(READY));
    assert.deepEqual(violations(feed(r, line({ t: "record", record: { ...RECORD, warnings } }))), ["protocol"]);
  });
}
