import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  BodyContentHandler,
  DEFAULT_LIMITS,
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

/*
 * The total-metadata cap. Core capped each metadata value (1,000,000 characters) but not their sum, so a document with
 * ~10 MiB of metadata parsed in-process and was refused only when isolated (tikajs-vaak). Every route into a parse
 * now carries the cap, and the default is the one isolation sizes its frames for.
 */

const lotsOfMetadata: Parser = {
  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.TEXT_PLAIN]);
  },
  async parse(_stream, _handler, metadata): Promise<void> {
    for (let i = 0; i < 10; i++) metadata.add(`k${i}`, "x".repeat(100));
  },
};

test("DEFAULT_LIMITS.maxMetadataTotalChars is 2,000,000, twice the per-value cap", () => {
  assert.equal(DEFAULT_LIMITS.maxMetadataTotalChars, 2_000_000);
  assert.equal(DEFAULT_LIMITS.maxMetadataTotalChars, 2 * DEFAULT_LIMITS.maxMetadataValueChars);
});

test("Ripstream.parse refuses root metadata past maxMetadataTotalChars", async () => {
  const ripstream = new Ripstream({ detector, parser: lotsOfMetadata });
  await assert.rejects(
    ripstream.parse(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 500 } }),
    LimitExceededError,
  );
  const ok = await ripstream.parse(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 2000 } });
  assert.equal(ok.metadata.size(), 10);
});

test("Ripstream.parse with the default limits accepts a 1,000,000-character value plus 500,000 more", async () => {
  const parser: Parser = {
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, _handler, metadata): Promise<void> {
      metadata.set("a", "x".repeat(1_000_000));
      metadata.set("b", "y".repeat(500_000));
    },
  };
  const result = await new Ripstream({ detector, parser }).parse(new Uint8Array([1]));
  assert.equal(result.metadata.get("a")?.length, 1_000_000);
});

test("Ripstream.parse with the default limits refuses 3,000,000 characters of metadata", async () => {
  const parser: Parser = {
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, _handler, metadata): Promise<void> {
      for (const key of ["a", "b", "c"]) metadata.set(key, "x".repeat(1_000_000));
    },
  };
  await assert.rejects(new Ripstream({ detector, parser }).parse(new Uint8Array([1])), LimitExceededError);
});

test("Ripstream.parseRecursive refuses metadata past maxMetadataTotalChars", async () => {
  const ripstream = new Ripstream({ detector, parser: lotsOfMetadata });
  await assert.rejects(
    ripstream.parseRecursive(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 500 } }),
    LimitExceededError,
  );
  const records = await ripstream.parseRecursive(new Uint8Array([1]), { limits: { maxMetadataTotalChars: 2000 } });
  assert.equal(records[0]?.metadata.getAll("k9").length, 1);
});
