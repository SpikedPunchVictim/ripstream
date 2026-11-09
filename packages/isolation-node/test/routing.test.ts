import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MediaType } from "@spikedpunch/ripstream-core";
import {
  DEFAULT_IN_PROCESS_MAX_BYTES,
  DEFAULT_IN_PROCESS_TYPES,
  DETECT_PREFIX_BYTES,
  routeRequest,
  type RouteOptions,
} from "../src/routing.ts";
import { fakeRipstream, type FakeRipstream } from "./fixtures/fake-ripstream.ts";

const bytes = (length: number, fill = 0x61): Uint8Array => new Uint8Array(length).fill(fill);

function route(ripstream: FakeRipstream, overrides: Partial<RouteOptions> = {}): Promise<"in-process" | "isolate"> {
  const input = overrides.input ?? bytes(10);
  return routeRequest({
    ripstream,
    input,
    size: input instanceof Uint8Array ? input.length : 10,
    inProcessTypes: DEFAULT_IN_PROCESS_TYPES,
    ...overrides,
  });
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripstream-routing-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("allowlisted plain-text types route in-process", async () => {
  for (const type of ["text/plain", "text/csv", "text/tab-separated-values", "text/html", "application/xhtml+xml", "text/markdown", "application/json"]) {
    assert.equal(await route(fakeRipstream({ type })), "in-process", type);
  }
});

test("a media type with parameters is matched on its base type", async () => {
  assert.equal(await route(fakeRipstream({ type: "text/plain; charset=UTF-8" })), "in-process");
  assert.equal(await route(fakeRipstream({ type: "text/html; charset=windows-1252" })), "in-process");
});

test("everything else is isolated: containers, binaries, documents, unknown", async () => {
  for (const type of [
    "application/zip",
    "application/pdf",
    "application/octet-stream",
    "application/x-empty",
    "application/x-sqlite3",
    "image/jpeg",
    "image/heic",
    "audio/mpeg",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/x-tar",
    "application/vnd.apache.parquet",
    "text/x-unknown-subtype", // text/* is NOT a wildcard on the allowlist
  ]) {
    assert.equal(await route(fakeRipstream({ type })), "isolate", type);
  }
});

test("the allowlist is exactly the set passed in", async () => {
  assert.equal(await route(fakeRipstream({ type: "text/plain" }), { inProcessTypes: new Set() }), "isolate");
  assert.equal(await route(fakeRipstream({ type: "application/zip" }), { inProcessTypes: new Set(["application/zip"]) }), "in-process");
});

test("fail closed: a detector that throws isolates", async () => {
  const ripstream = fakeRipstream({ detect: () => Promise.reject(new Error("detector blew up")) });
  assert.equal(await route(ripstream), "isolate");
});

test("fail closed: a detector that throws synchronously isolates", async () => {
  const ripstream = fakeRipstream({
    detect: () => {
      throw new Error("sync boom");
    },
  });
  assert.equal(await route(ripstream), "isolate");
});

test("fail closed: an answer that is not a media type isolates", async () => {
  for (const answer of [null, undefined, "text/plain", {}, { getBaseType: () => "text/plain" }]) {
    const ripstream = fakeRipstream({ detect: () => Promise.resolve(answer as unknown as MediaType) });
    assert.equal(await route(ripstream), "isolate", String(answer));
  }
});

test("fail closed: a detector that hangs is abandoned at the timeout and its signal is aborted", async () => {
  const ripstream = fakeRipstream({ detect: () => new Promise<MediaType>(() => {}) });
  const started = performance.now();
  assert.equal(await route(ripstream, { detectTimeoutMs: 40 }), "isolate");
  assert.ok(performance.now() - started < 1000, "must not wait for the detector");
  assert.equal(ripstream.detectCalls[0]?.signal?.aborted, true);
});

test("an abort ends the detection wait at once instead of waiting for the detect timeout", async () => {
  const ripstream = fakeRipstream({ detect: () => new Promise<MediaType>(() => {}) });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller left")), 20);
  const started = performance.now();
  assert.equal(await route(ripstream, { detectTimeoutMs: 30_000, signal: controller.signal }), "isolate");
  assert.ok(performance.now() - started < 1000, `waited ${performance.now() - started} ms`);
  assert.equal(ripstream.detectCalls[0]?.signal?.aborted, true, "the detector is told to stop");
});

test("an already-aborted signal routes to isolate without calling the detector", async () => {
  const ripstream = fakeRipstream({ type: "text/plain" });
  assert.equal(await route(ripstream, { signal: AbortSignal.abort() }), "isolate");
  assert.equal(ripstream.detectCalls.length, 0);
});

test("fail closed: a slow detector that answers after the timeout does not route in-process", async () => {
  const ripstream = fakeRipstream({
    detect: () => new Promise<MediaType>((resolve) => setTimeout(() => resolve(MediaType.TEXT_PLAIN), 200)),
  });
  assert.equal(await route(ripstream, { detectTimeoutMs: 30 }), "isolate");
});

test("detection sees only a 64 KiB prefix of inline bytes", async () => {
  assert.equal(DETECT_PREFIX_BYTES, 64 * 1024);
  const ripstream = fakeRipstream({ type: "text/plain" });
  const input = bytes(DETECT_PREFIX_BYTES * 3);
  assert.equal(await route(ripstream, { input, size: input.length }), "in-process");
  const seen = ripstream.detectCalls[0]?.source;
  assert.ok(seen instanceof Uint8Array);
  assert.equal(seen.length, DETECT_PREFIX_BYTES);
});

test("a short inline input is detected whole", async () => {
  const ripstream = fakeRipstream({ type: "text/plain" });
  await route(ripstream, { input: bytes(100) });
  assert.equal((ripstream.detectCalls[0]?.source as Uint8Array).length, 100);
});

test("a { path } input is read for its first 64 KiB only", async () => {
  const path = join(dir, "big.bin");
  const content = new Uint8Array(DETECT_PREFIX_BYTES * 4);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  await writeFile(path, content);
  const ripstream = fakeRipstream({ type: "text/plain" });
  assert.equal(await route(ripstream, { input: { path }, size: content.length }), "in-process");
  const seen = ripstream.detectCalls[0]?.source;
  assert.ok(seen instanceof Uint8Array, "the prefix is handed over as bytes, not as the path");
  assert.deepEqual(new Uint8Array(seen), content.subarray(0, DETECT_PREFIX_BYTES));
});

test("a short { path } file is detected whole", async () => {
  const path = join(dir, "short.txt");
  await writeFile(path, "hello");
  const ripstream = fakeRipstream({ type: "text/plain" });
  await route(ripstream, { input: { path }, size: 5 });
  assert.equal(Buffer.from(ripstream.detectCalls[0]?.source as Uint8Array).toString(), "hello");
});

test("fail closed: an unreadable { path } isolates and detection is not attempted", async () => {
  const ripstream = fakeRipstream({ type: "text/plain" });
  assert.equal(await route(ripstream, { input: { path: join(dir, "missing.txt") }, size: 10 }), "isolate");
  assert.equal(ripstream.detectCalls.length, 0);
});

test("the filename is passed to detection", async () => {
  const ripstream = fakeRipstream({ type: "text/plain" });
  await route(ripstream, { filename: "notes.txt" });
  assert.equal(ripstream.detectCalls[0]?.filename, "notes.txt");
  const without = fakeRipstream({ type: "text/plain" });
  await route(without);
  assert.equal(without.detectCalls[0]?.filename, undefined);
});

test("an input over the in-process size cap is isolated without detection", async () => {
  const ripstream = fakeRipstream({ type: "text/plain" });
  assert.equal(await route(ripstream, { size: DEFAULT_IN_PROCESS_MAX_BYTES + 1 }), "isolate");
  assert.equal(ripstream.detectCalls.length, 0);
  assert.equal(await route(ripstream, { size: DEFAULT_IN_PROCESS_MAX_BYTES }), "in-process");
  assert.equal(await route(fakeRipstream({ type: "text/plain" }), { size: 101, inProcessMaxBytes: 100 }), "isolate");
});

test("polyglot: the verdict follows the prefix, so the root must restrict the in-process parsers", async () => {
  // Plain text for 64 KiB, then a ZIP local-file-header and binary: detection never sees the tail.
  const input = new Uint8Array(DETECT_PREFIX_BYTES + 4096).fill(0x61);
  input.set([0x50, 0x4b, 0x03, 0x04], DETECT_PREFIX_BYTES);
  const ripstream = fakeRipstream({
    detect: async (source) => ((source as Uint8Array).length <= DETECT_PREFIX_BYTES ? MediaType.TEXT_PLAIN : MediaType.APPLICATION_ZIP),
  });
  assert.equal(await route(ripstream, { input }), "in-process");
});

test("DEFAULT_IN_PROCESS_TYPES: the explicit plain-text set", () => {
  assert.deepEqual([...DEFAULT_IN_PROCESS_TYPES].sort(), [
    "application/json",
    "application/ld+json",
    "application/manifest+json",
    "application/xhtml+xml",
    "application/xml",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
    "text/x-yaml",
    "text/xml",
  ]);
});

test("DEFAULT_IN_PROCESS_TYPES: nothing a hazard parser (exifr, sql.js, pdfjs, music-metadata, hyparquet) or a container handles", () => {
  const hazardous = [
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-tar",
    "application/octet-stream",
    "application/x-sqlite3",
    "application/vnd.apache.parquet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.text",
    "application/epub+zip",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/svg+xml",
    "audio/mpeg",
    "video/mp4",
    "message/rfc822",
  ];
  for (const type of hazardous) assert.equal(DEFAULT_IN_PROCESS_TYPES.has(type), false, type);
  for (const type of DEFAULT_IN_PROCESS_TYPES) {
    assert.match(type, /^(text\/|application\/(json|ld\+json|manifest\+json|xhtml\+xml|xml)$)/, type);
  }
});
