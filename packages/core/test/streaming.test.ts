import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  MediaType,
  ParseTimeoutError,
  Ripstream,
  type Detector,
  type Parser,
} from "../src/index.ts";

test("cancelling the output stream aborts parsing", async () => {
  let aborted = false;
  const parser: Parser = {
    getSupportedTypes(): ReadonlySet<MediaType> {
      return new Set();
    },
    async parse(stream, handler, _metadata, ctx): Promise<void> {
      handler.startDocument?.();
      handler.startElement?.(
        "",
        "body",
        "body",
        new AttributesImpl([]),
      );
      try {
        for (let index = 0; index < 1_000; index++) {
          ctx.throwIfAborted();
          await handler.characters?.("x".repeat(100), 0, 100);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      } finally {
        aborted = ctx.signal.aborted;
        handler.endElement?.("", "body", "body");
        handler.endDocument?.();
      }
    },
  };
  const detector: Detector = {
    async detect(): Promise<MediaType> {
      return MediaType.TEXT_PLAIN;
    },
  };
  const ripstream = new Ripstream({ detector, parser });
  const reader = ripstream
    .parseToStream(new TextEncoder().encode("ignored"))
    .getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel();
  await waitFor(() => aborted);
  assert.equal(aborted, true);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

test("aborting the parse signal stops the parser", async () => {
  const controller = new AbortController();
  let observed = false;
  const parser: Parser = {
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler, _metadata, ctx) {
      handler.startDocument?.();
      handler.startElement?.("", "body", "body", new AttributesImpl([]));
      try {
        for (let index = 0; index < 100; index++) {
          ctx.throwIfAborted();
          await handler.characters?.("x", 0, 1);
          await new Promise((resolve) => setTimeout(resolve, 2));
          controller.abort();
        }
      } finally {
        observed = ctx.signal.aborted;
      }
    },
  };
  const ripstream = new Ripstream({
    detector: { async detect() { return MediaType.TEXT_PLAIN; } },
    parser,
  });
  await assert.rejects(
    ripstream.parseToString(new Uint8Array([1]), { signal: controller.signal }),
  );
  assert.equal(observed, true);
});

test("a stalled consumer hits the timeout, errors the stream and releases resources", async () => {
  let closed = false;
  const parser: Parser = {
    name: "Chatty",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler, _metadata, ctx) {
      ctx.resources.add({ close: () => { closed = true; } });
      handler.startDocument?.();
      handler.startElement?.("", "body", "body", new AttributesImpl([]));
      for (;;) {
        ctx.throwIfAborted();
        await handler.characters?.("x", 0, 1);
      }
    },
  };
  const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };
  const ripstream = new Ripstream({ detector, parser });
  const stream = ripstream.parseToStream(new Uint8Array([1]), {
    limits: { maxParseMillis: 50, maxOutputChars: -1 },
  });
  await waitFor(() => closed);
  const reader = stream.getReader();
  await assert.rejects(async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  }, ParseTimeoutError);
});
