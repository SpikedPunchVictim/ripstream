import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import {
  AbortError,
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  MissingDependencyError,
  ParseContext,
  ParseTimeoutError,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { TesseractOcrParser } from "../src/index.ts";

const skipFake = process.platform === "win32" ? "fake tesseract is a POSIX shell script" : false;
const fakeTest = { skip: skipFake, timeout: 15_000 };

test("Tesseract parser advertises image OCR types", () => {
  const types = new TesseractOcrParser().getSupportedTypes();
  assert.ok(types.has(MediaType.parse("image/png")!));
  assert.ok(types.has(MediaType.parse("image/jpeg")!));
});

test("Tesseract parser rejects invalid options with RangeError", () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    const create = (): TesseractOcrParser => new TesseractOcrParser({ timeoutMs });
    assert.throws(create, RangeError, `timeoutMs=${timeoutMs}`);
  }
  assert.throws(() => new TesseractOcrParser({ command: "" }), RangeError);
});

/** Runs `body` as the fake `tesseract`; `dir` is where the script can leave files for the test. */
async function withFakeTesseract(
  body: (dir: string) => string,
  run: (command: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ripstream-fake-tesseract-"));
  try {
    const command = join(dir, "tesseract");
    await writeFile(command, `#!/bin/sh\n${body(dir)}\n`);
    await chmod(command, 0o755);
    await run(command, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ocr(
  parser: TesseractOcrParser,
  signal?: AbortSignal,
): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3]));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(
      stream,
      handler,
      metadata,
      new ParseContext(signal === undefined ? {} : { signal }),
    );
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

async function readNumber(path: string, waitMs = 5_000): Promise<number> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (Number.isInteger(value) && value > 0) return value;
    assert.ok(Date.now() < deadline, `${path} was not written within ${waitMs} ms`);
    await sleep(10);
  }
}

async function assertDead(pid: number, label: string, waitMs = 2_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH", `${label} (${pid})`);
      return;
    }
    assert.ok(Date.now() < deadline, `${label} (${pid}) still running after ${waitMs} ms`);
    await sleep(20);
  }
}

// Records its pid, then becomes `sleep`, so tests can prove the process is killed.
const sleeper = (dir: string): string => `
echo "$1" > "${dir}/input"
echo $$ > "${dir}/pid"
exec sleep 30`;

async function assertTreeDead(dir: string): Promise<void> {
  await assertDead(await readNumber(join(dir, "pid")), "tesseract");
}

async function assertTempDirRemoved(dir: string): Promise<void> {
  const input = (await readFile(join(dir, "input"), "utf8")).trim();
  await assert.rejects(access(dirname(input)), { code: "ENOENT" });
}

test("abort kills the tesseract process and rejects", fakeTest, async () => {
  await withFakeTesseract(sleeper, async (command, dir) => {
    const controller = new AbortController();
    const outcome = assert.rejects(
      ocr(new TesseractOcrParser({ command }), controller.signal),
      (error) => error instanceof AbortError,
    );
    await readNumber(join(dir, "pid")); // child is running
    const abortedAt = Date.now();
    controller.abort();
    await outcome;
    assert.ok(Date.now() - abortedAt < 2_000, "parse did not settle within 2 s of abort");
    await assertTreeDead(dir);
    await assertTempDirRemoved(dir);
  });
});

test("abort rejects with an Error reason as given", fakeTest, async () => {
  await withFakeTesseract(sleeper, async (command, dir) => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const outcome = assert.rejects(
      ocr(new TesseractOcrParser({ command }), controller.signal),
      (error) => error === reason,
    );
    await readNumber(join(dir, "pid"));
    controller.abort(reason);
    await outcome;
    await assertTreeDead(dir);
  });
});

test("an already-aborted signal rejects without spawning", fakeTest, async () => {
  await withFakeTesseract(
    (dir) => `touch "${dir}/marker"`,
    async (command, dir) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        ocr(new TesseractOcrParser({ command }), controller.signal),
        (error) => error instanceof AbortError,
      );
      await sleep(200); // a spawned script would have written the marker by now
      await assert.rejects(access(join(dir, "marker")), { code: "ENOENT" });
    },
  );
});

test("timeoutMs kills tesseract and rejects naming the budget", fakeTest, async () => {
  await withFakeTesseract(sleeper, async (command, dir) => {
    const startedAt = Date.now();
    await assert.rejects(
      ocr(new TesseractOcrParser({ command, timeoutMs: 200 })),
      (error) =>
        error instanceof ParseTimeoutError &&
        /tesseract/i.test(error.message) &&
        error.message.includes("200"),
    );
    assert.ok(Date.now() - startedAt < 2_000, "parse did not settle within 2 s");
    await assertTreeDead(dir);
    await assertTempDirRemoved(dir);
  });
});

test("stderr in the failure message is bounded", fakeTest, async () => {
  await withFakeTesseract(
    () => `head -c 1048576 /dev/zero | tr '\\0' 'x' >&2\nexit 1`,
    async (command) => {
      await assert.rejects(ocr(new TesseractOcrParser({ command })), (error) => {
        assert.ok(error instanceof MalformedDocumentError);
        assert.ok(error.message.length > 1_000, "stderr should still be reported");
        assert.ok(error.message.length < 70 * 1024, `message is ${error.message.length} chars`);
        return true;
      });
    },
  );
});

test("stdout beyond the cap kills tesseract (LimitExceededError)", fakeTest, async () => {
  await withFakeTesseract(
    (dir) => `echo $$ > "${dir}/pid"\nhead -c 9437184 /dev/zero | tr '\\0' 'x'\nsleep 30`,
    async (command, dir) => {
      await assert.rejects(
        ocr(new TesseractOcrParser({ command })),
        (error) => error instanceof LimitExceededError,
      );
      await assertDead(await readNumber(join(dir, "pid")), "tesseract");
    },
  );
});

test("tesseract output is emitted as paragraphs", fakeTest, async () => {
  await withFakeTesseract(
    // Succeeds only when called as `tesseract <existing input file> stdout`.
    () => `[ -f "$1" ] && [ "$2" = "stdout" ] || exit 2\nprintf 'Hello OCR\\n\\nsecond line\\n'`,
    async (command) => {
      const { text, metadata } = await ocr(new TesseractOcrParser({ command }));
      assert.match(text, /Hello OCR/);
      assert.match(text, /second line/);
      assert.equal(metadata.get("ocr:engine"), "tesseract");
    },
  );
});

test("a missing tesseract command is a MissingDependencyError", async () => {
  await assert.rejects(
    ocr(new TesseractOcrParser({ command: "ripstream-no-such-tesseract-binary" })),
    (error) => error instanceof MissingDependencyError,
  );
});
