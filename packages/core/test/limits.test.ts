import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  BodyContentHandler,
  OutputLimitContentHandler,
  LimitExceededError,
  MediaType,
  ParseTimeoutError,
  Ripstream,
  type Detector,
  type Parser,
} from "../src/index.ts";

const detector: Detector = {
  async detect(): Promise<MediaType> {
    return MediaType.TEXT_PLAIN;
  },
};

function bodyParser(write: (handler: Parameters<Parser["parse"]>[1]) => Promise<void>): Parser {
  return {
    getSupportedTypes(): ReadonlySet<MediaType> {
      return new Set([MediaType.TEXT_PLAIN]);
    },
    async parse(_stream, handler, _metadata, ctx): Promise<void> {
      ctx.throwIfAborted();
      handler.startDocument?.();
      handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await write(handler);
      handler.endElement?.("", "body", "body");
      handler.endDocument?.();
    },
  };
}

test("rejects output above maxOutputChars", async () => {
  const parser = bodyParser(async (handler) => {
    await handler.characters?.("abcdefghij", 0, 10);
  });
  const ripstream = new Ripstream({ detector, parser });
  await assert.rejects(
    ripstream.parseToString(new Uint8Array([1]), {
      limits: { maxOutputChars: 5 },
    }),
    LimitExceededError,
  );
});

test("times out parsers that observe cancellation", async () => {
  const parser: Parser = {
    getSupportedTypes(): ReadonlySet<MediaType> {
      return new Set([MediaType.TEXT_PLAIN]);
    },
    async parse(_stream, _handler, _metadata, ctx): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        ctx.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
  const ripstream = new Ripstream({ detector, parser });
  await assert.rejects(
    ripstream.parseToString(new Uint8Array([1]), {
      limits: { maxParseMillis: 20 },
    }),
    ParseTimeoutError,
  );
});

test("rejects NaN and non-sentinel negative maxOutputChars", async () => {
  const ripstream = new Ripstream({ detector, parser: bodyParser(async () => {}) });
  for (const bad of [Number.NaN, -2, -100]) {
    await assert.rejects(
      ripstream.parseToString(new Uint8Array([1]), { limits: { maxOutputChars: bad } }),
      (error: unknown) => error instanceof RangeError && /maxOutputChars/.test(error.message),
    );
  }
});

test("OutputLimitContentHandler rejects invalid limits but keeps -1 unlimited", () => {
  const delegate = new BodyContentHandler();
  assert.throws(() => new OutputLimitContentHandler(delegate, Number.NaN), RangeError);
  assert.throws(() => new OutputLimitContentHandler(delegate, -5), RangeError);
  assert.doesNotThrow(() => new OutputLimitContentHandler(delegate, -1));
});

test("Ripstream.parse truncates root metadata values at maxMetadataValueChars", async () => {
  const parser: Parser = {
    getSupportedTypes(): ReadonlySet<MediaType> {
      return new Set([MediaType.TEXT_PLAIN]);
    },
    async parse(_stream, _handler, metadata): Promise<void> {
      metadata.set("title", "x".repeat(50));
    },
  };
  const ripstream = new Ripstream({ detector, parser });
  const result = await ripstream.parse(new Uint8Array([1]), {
    limits: { maxMetadataValueChars: 10 },
  });
  assert.equal(result.metadata.get("title"), "x".repeat(10));
});
