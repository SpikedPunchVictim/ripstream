import assert from "node:assert/strict";
import { test } from "node:test";
import { containmentFor } from "../src/containment.ts";

test("linux enforces everything", () => {
  assert.deepEqual(containmentFor("linux"), {
    processIsolation: true,
    heapLimit: true,
    wallClock: true,
    rssPoll: "proc",
    addressSpaceCap: true,
    cpuLimit: true,
  });
});

test("darwin has no address-space cap and only the weaker ps RSS poll", () => {
  const c = containmentFor("darwin");
  assert.deepEqual([c.addressSpaceCap, c.rssPoll, c.cpuLimit, c.processIsolation], [false, "ps", true, true]);
});

test("an unknown platform has neither the cap nor an RSS poll", () => {
  const c = containmentFor("freebsd");
  assert.deepEqual([c.addressSpaceCap, c.rssPoll], [false, "none"]);
});

test("defaults to the current platform", () => {
  assert.deepEqual(containmentFor(), containmentFor(process.platform));
});
