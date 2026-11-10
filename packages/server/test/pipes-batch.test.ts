import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer } from "../src/index.ts";

/*
 * /pipes parses a batch, and one bad input does not end it (tikajs-68os.6.1): the answer says what each input came to.
 */

interface PipesAnswer {
  count: number;
  stats: { fetched: number; emitted: number; failed: number; byStatus: Record<string, number> };
  failures: Array<{ id: string; status: string; category: string; message?: string }>;
  failuresOmitted?: number;
}

async function withPipes<T>(
  root: string,
  run: (post: (body: unknown) => Promise<Response>) => Promise<T>,
  options: Parameters<typeof createRipstreamServer>[0] = {},
): Promise<T> {
  const instance = createRipstreamServer({
    ripstream: createRipstream(),
    log: () => undefined,
    authenticate: () => true,
    pipes: { sourceRoot: root },
    ...options,
  });
  const port = await instance.listen();
  try {
    return await run((body) =>
      fetch(`http://127.0.0.1:${port}/pipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    await instance.close();
  }
}

test("a batch with a corrupt file and one over the output limit answers for every input", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-server-pipes-batch-"));
  try {
    writeFileSync(join(root, "a.txt"), "first document");
    writeFileSync(join(root, "b-corrupt.docx"), "PK\u0003\u0004 this is not a zip file at all");
    writeFileSync(join(root, "c-long.txt"), "x".repeat(5000));
    writeFileSync(join(root, "d.txt"), "last document");

    await withPipes(
      root,
      async (post) => {
        const response = await post({ source: { type: "filesystem", path: "." }, concurrency: 2 });
        assert.equal(response.status, 200, "the run finished: a failed input is not a failed request");
        const answer = (await response.json()) as PipesAnswer;
        assert.equal(answer.count, 3, "everything that could be emitted was, the corrupt document with its failure");
        assert.equal(answer.stats.fetched, 4);
        assert.equal(answer.stats.emitted, 3);
        assert.equal(answer.stats.failed, 1, "a recorded parse exception is a success, as Tika counts it");
        assert.deepEqual(answer.stats.byStatus, { EMIT_SUCCESS: 2, EMIT_SUCCESS_PARSE_EXCEPTION: 1, PAYLOAD_LIMIT_EXCEEDED: 1 });
        assert.equal(answer.failures.length, 1);
        assert.equal(answer.failures[0]?.id, "c-long.txt");
        assert.equal(answer.failures[0]?.status, "PAYLOAD_LIMIT_EXCEEDED");
        assert.equal(answer.failures[0]?.category, "TASK_EXCEPTION");
        assert.match(answer.failures[0]?.message ?? "", /LimitExceededError/);
        assert.equal(answer.failuresOmitted, undefined);
      },
      { maxLimits: { maxOutputChars: 1000 } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run of more failures than the answer lists says how many it left out", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-server-pipes-many-"));
  try {
    for (let index = 0; index < 1005; index++) writeFileSync(join(root, `f${String(index).padStart(4, "0")}.txt`), "0123456789");
    await withPipes(
      root,
      async (post) => {
        const answer = (await (await post({ source: { type: "filesystem", path: "." }, concurrency: 4 })).json()) as PipesAnswer;
        assert.equal(answer.count, 0);
        assert.equal(answer.stats.failed, 1005);
        assert.equal(answer.failures.length, 1000);
        assert.equal(answer.failuresOmitted, 5);
      },
      { maxLimits: { maxOutputChars: 5 } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run with no failures lists none", async () => {
  const root = mkdtempSync(join(tmpdir(), "ripstream-server-pipes-clean-"));
  try {
    writeFileSync(join(root, "a.txt"), "fine");
    await withPipes(root, async (post) => {
      const answer = (await (await post({ source: { type: "filesystem", path: "." } })).json()) as PipesAnswer;
      assert.deepEqual(answer.failures, []);
      assert.equal(answer.count, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
