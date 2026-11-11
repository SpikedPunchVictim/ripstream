import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaType,
  MetricsCollector,
  Ripstream,
  type Detector,
  type Parser,
} from "../src/index.ts";
import { BodyContentHandler, ParseContext, RipstreamInputStream, XHTMLContentHandler, Metadata } from "../src/index.ts";

const detector: Detector = { async detect() { return MediaType.TEXT_PLAIN; } };
const parser: Parser = {
  getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
  async parse(stream, handler) {
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    await xhtml.element("p", "ok");
    await xhtml.endDocument();
  },
};

test("emits parse lifecycle events and metrics", async () => {
  const metrics = new MetricsCollector();
  const ripstream = new Ripstream({ detector, parser, eventSink: metrics });
  await ripstream.parseToString(new TextEncoder().encode("x"), { filename: "a.txt" });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.started, 1);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 0);
});

test("counts a media type once however its charset parameter reads", () => {
  const metrics = new MetricsCollector();
  metrics.emit({ type: "end", mediaType: "text/plain; charset=windows-1252" });
  metrics.emit({ type: "end", mediaType: "text/plain; charset=UTF-8" });
  metrics.emit({ type: "end", mediaType: "text/plain" });
  metrics.emit({ type: "end", mediaType: "application/pdf" });
  assert.deepEqual(metrics.snapshot().byMediaType, { "text/plain": 3, "application/pdf": 1 });
});

test("records failures", async () => {
  const metrics = new MetricsCollector();
  const failing: Parser = {
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse() { throw new Error("nope"); },
  };
  const ripstream = new Ripstream({ detector, parser: failing, eventSink: metrics });
  await assert.rejects(ripstream.parseToString(new Uint8Array([1])));
  assert.equal(metrics.snapshot().failed, 1);
});
