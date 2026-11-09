import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { RssPoller, pageSizeBytes, sampleRssMb } from "../src/rss.ts";

const measurable = process.platform === "linux" || process.platform === "darwin";

test("sampleRssMb reads this process on a supported platform", { skip: !measurable }, async () => {
  const mb = await sampleRssMb(process.pid);
  assert.ok(mb !== null && mb > 10 && mb < 100_000, `rss ${String(mb)}`);
});

test("sampleRssMb is null for a process that does not exist", { skip: !measurable }, async () => {
  assert.equal(await sampleRssMb(2 ** 22 - 3), null);
});

test("sampleRssMb is null on a platform with no measurement", async () => {
  assert.equal(await sampleRssMb(process.pid, "win32"), null);
});

test("pageSizeBytes matches getconf PAGESIZE", { skip: process.platform !== "linux" }, () => {
  assert.equal(pageSizeBytes(), Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim()));
});

test("RssPoller refuses a platform it cannot measure", () => {
  assert.throws(() => new RssPoller({ pid: 1, platform: "win32", limitMb: 1, pollMs: 20, onOverLimit: () => {} }), /no RSS/);
});

test("RssPoller fires onOverLimit once, then stops sampling", { skip: !measurable }, async () => {
  const hits: number[] = [];
  const poller = new RssPoller({
    pid: process.pid,
    platform: process.platform,
    limitMb: 1,
    pollMs: 20,
    onOverLimit: (rss) => hits.push(rss),
  });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, process.platform === "darwin" ? 600 : 150));
  poller.stop();
  assert.equal(hits.length, 1);
  assert.ok(poller.stats().rssAtLimitMb === hits[0]);
});

test("RssPoller samples at its interval (self-correcting) and reports the MEASURED interval", { skip: process.platform !== "linux" }, async () => {
  const poller = new RssPoller({ pid: process.pid, platform: "linux", limitMb: 1e9, pollMs: 20, onOverLimit: () => {} });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  poller.stop();
  const stats = poller.stats();
  assert.ok(stats.samples >= 10, `only ${stats.samples} samples in 500 ms`);
  assert.ok(stats.medianIntervalMs >= 15 && stats.medianIntervalMs <= 40, `median interval ${stats.medianIntervalMs} ms`);
  assert.equal(stats.effectiveIntervalMs, 20);
});

test("on darwin the poll interval is never below 250 ms", { skip: process.platform !== "darwin" }, () => {
  const poller = new RssPoller({ pid: process.pid, platform: "darwin", limitMb: 1e9, pollMs: 20, onOverLimit: () => {} });
  assert.equal(poller.stats().effectiveIntervalMs, 250);
});

test("stop() is idempotent and a stopped poller never fires", { skip: !measurable }, async () => {
  let fired = 0;
  const poller = new RssPoller({ pid: process.pid, platform: process.platform, limitMb: 1, pollMs: 20, onOverLimit: () => fired++ });
  poller.stop();
  poller.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fired, 0);
});
