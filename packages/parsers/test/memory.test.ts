import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "../src/index.ts";

const MB = 1024 * 1024;

test("32 MB document parses without unbounded memory growth", async () => {
  const ripstream = createRipstream();
  const data = new Uint8Array(32 * MB).fill(0x61);
  const before = process.memoryUsage().rss;
  const result = await ripstream.parseToString(data, {
    filename: "large.txt",
    limits: { maxOutputChars: data.length * 2 },
  });
  const delta = process.memoryUsage().rss - before;
  assert.equal(result.length, data.length + 1);
  assert.ok(
    delta < 300 * MB,
    `RSS grew ${(delta / MB).toFixed(1)} MB while parsing 32 MB`,
  );
});

test("streaming output discards chunks without retaining them", async () => {
  const ripstream = createRipstream();
  const data = new Uint8Array(32 * MB).fill(0x62);
  const before = process.memoryUsage().rss;
  let bytes = 0;
  for await (const chunk of ripstream.parseToStream(data, {
    filename: "large.txt",
    limits: { maxOutputChars: data.length * 2 },
  })) {
    bytes += chunk.byteLength;
  }
  const delta = process.memoryUsage().rss - before;
  assert.ok(bytes > 0);
  assert.ok(
    delta < 300 * MB,
    `RSS grew ${(delta / MB).toFixed(1)} MB while streaming 32 MB`,
  );
});
