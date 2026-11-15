import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError, Metadata, type IsolatedComponents } from "@spikedpunch/ripstream-core";
import type { ChildInput, InputHeader } from "../src/child-io.ts";
import { runChildMain, type ChildMainIo, type ChildRipstream, type FatalOrigin } from "../src/child-main.ts";

/**
 * runChildMain's serve loop (a reused child, warm.ts) with its I/O injected: one "ready", then one answer per request
 * until the parent closes stdin. The process-level behaviour is in warm.test.ts.
 */

type Frame = Record<string, unknown> & { t: string };

const header = (overrides: Partial<InputHeader> = {}): InputHeader => ({ v: 1, output: "text", byteLength: 0, ...overrides });
const message = (text: string, overrides: Partial<InputHeader> = {}): ChildInput => {
  const bytes = new TextEncoder().encode(text);
  return { header: header({ byteLength: bytes.length, ...overrides }), bytes };
};

interface Serving {
  readonly frames: Frame[];
  readonly exits: number[];
  /** Hands the loop its next request (null: stdin closed) or makes the read fail. */
  give(next: ChildInput | null | Error): void;
  /** Resolves once the loop waits for its next request. */
  waiting(): Promise<void>;
  fatal(reason: unknown, origin?: FatalOrigin): void;
  readonly outcome: Promise<number | string | undefined>;
}

function serve(ripstream: ChildRipstream | ((components: IsolatedComponents | undefined) => ChildRipstream)): Serving {
  const frames: Frame[] = [];
  const exits: number[] = [];
  const queue: (ChildInput | null | Error)[] = [];
  let pending: ((next: ChildInput | null | Error) => void) | null = null;
  let waiters: (() => void)[] = [];
  let fatalHandler: Parameters<ChildMainIo["onFatal"]>[0] | undefined;
  const io: ChildMainIo = {
    initChildProcess: () => {},
    onFatal: (handler) => {
      fatalHandler = handler;
    },
    exit: (code) => {
      exits.push(code);
    },
    readInput: () => Promise.reject(new Error("a serving child must not use readInput")),
    serving: () => true,
    nextInput: () =>
      new Promise<ChildInput | null>((resolve, reject) => {
        const settle = (next: ChildInput | null | Error): void => (next instanceof Error ? reject(next) : resolve(next));
        const queued = queue.shift();
        if (queued !== undefined) {
          settle(queued);
          return;
        }
        pending = settle;
        for (const waiter of waiters) waiter();
        waiters = [];
      }),
    sendFrame: (frame) => {
      frames.push(frame as Frame);
    },
  };
  const before = process.exitCode;
  const outcome = runChildMain({ ripstream, io }).then(() => {
    const code = process.exitCode;
    process.exitCode = before;
    return code;
  });
  return {
    frames,
    exits,
    give: (next) => {
      if (pending !== null) {
        const settle = pending;
        pending = null;
        settle(next);
      } else {
        queue.push(next);
      }
    },
    waiting: () => (pending !== null ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    fatal: (reason, origin = "uncaughtException") => {
      if (fatalHandler === undefined) throw new Error("no fault handler installed");
      fatalHandler(reason, origin);
    },
    outcome,
  };
}

function echoing(): { ripstream: ChildRipstream; options: Record<string, unknown>[] } {
  const options: Record<string, unknown>[] = [];
  const ripstream: ChildRipstream = {
    parse: async (source, parseOptions) => {
      options.push(parseOptions as Record<string, unknown>);
      const text = new TextDecoder().decode(source as Uint8Array);
      if (text === "throw") throw new MalformedDocumentError("bad");
      return { metadata: new Metadata(), text };
    },
    parseRecursive: async () => [],
  };
  return { ripstream, options };
}

const types = (frames: readonly Frame[]): string[] => frames.map((frame) => frame.t);

test("serve: one ready, then accepted/meta/text/done per request, then exit code 0 when stdin closes", async () => {
  const { ripstream } = echoing();
  const s = serve(ripstream);
  s.give(message("one"));
  s.give(message("two"));
  s.give(null);
  assert.equal(await s.outcome, 0);
  assert.deepEqual(types(s.frames), ["ready", "accepted", "meta", "text", "done", "accepted", "meta", "text", "done"]);
  assert.deepEqual(
    s.frames.filter((f) => f.t === "text").map((f) => f["chunk"]),
    ["one", "two"],
  );
  assert.deepEqual(s.exits, []);
});

test("serve: a failed request is answered with its error frame and the loop goes on (the parent decides)", async () => {
  const { ripstream } = echoing();
  const s = serve(ripstream);
  s.give(message("throw"));
  s.give(message("after"));
  s.give(null);
  assert.equal(await s.outcome, 0);
  assert.deepEqual(types(s.frames), ["ready", "accepted", "error", "accepted", "meta", "text", "done"]);
});

test("serve: a message that cannot be read is answered with an error frame and ends the loop", async () => {
  const { ripstream } = echoing();
  const s = serve(ripstream);
  s.give(message("ok"));
  s.give(new RangeError("input header is 70000 bytes, the maximum is 65536"));
  await s.outcome;
  assert.deepEqual(types(s.frames), ["ready", "accepted", "meta", "text", "done", "error"]);
});

test("serve: nothing of one request's options reaches the next", async () => {
  const { ripstream, options } = echoing();
  const s = serve(ripstream);
  s.give(message("first", { filename: "secret-name.eml", emailHeaders: true, truncateOutput: true, maxOutputChars: 7 }));
  s.give(message("second"));
  s.give(null);
  await s.outcome;
  assert.equal(options[0]!["filename"], "secret-name.eml");
  assert.equal(options[0]!["emailHeaders"], true);
  assert.equal(options[1]!["filename"], undefined);
  assert.equal(options[1]!["emailHeaders"], undefined);
  assert.equal(options[1]!["onOutputLimit"], undefined);
  assert.equal((options[1]!["limits"] as Record<string, unknown> | undefined)?.["maxOutputChars"], undefined);
});

test("serve: the ripstream is built once per distinct components", async () => {
  const built: unknown[] = [];
  const { ripstream } = echoing();
  const s = serve((components) => {
    built.push(components ?? null);
    return ripstream;
  });
  const a: IsolatedComponents = { parsers: [{ name: "default-parser" }] } as unknown as IsolatedComponents;
  const b: IsolatedComponents = { parsers: [{ name: "other-parser" }] } as unknown as IsolatedComponents;
  s.give(message("1", { components: a }));
  s.give(message("2", { components: a }));
  s.give(message("3", { components: b }));
  s.give(message("4", { components: b }));
  s.give(null);
  await s.outcome;
  assert.equal(built.length, 2);
});

test("serve: a fault while waiting for the next request is a crash frame of a new request, then exit 1", async () => {
  const { ripstream } = echoing();
  const s = serve(ripstream);
  s.give(message("one"));
  await s.waiting();
  await new Promise((resolve) => setImmediate(resolve));
  s.fatal(new TypeError("leftover timer"));
  assert.deepEqual(types(s.frames), ["ready", "accepted", "meta", "text", "done", "error"]);
  assert.equal(s.frames[5]!["kind"], "crash");
  assert.deepEqual(s.exits, [1]);
  s.give(null);
  await s.outcome;
});
