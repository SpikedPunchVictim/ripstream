import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { RipstreamError } from "@spikedpunch/ripstream-core";
import { readBody, readBodyPrefix, readRawBody } from "../src/request-body.ts";

const MiB = 1024 * 1024;

/*
 * `/language` looks at the first 400,000 bytes of a body and ignores the rest, so it asks for that much and no more:
 * the rest is counted against the cap and dropped as it arrives, not held until the request ends.
 */

type Reader = (request: http.IncomingMessage) => Promise<Uint8Array>;

/** Sends `body` in `chunk`-byte pieces to a server that reads it with `read`; resolves with what `read` made of it. */
async function through(read: Reader, body: Uint8Array, headers: http.OutgoingHttpHeaders = {}, chunk = 64 * 1024): Promise<Uint8Array | Error> {
  let outcome!: Uint8Array | Error;
  let settled!: () => void;
  const read_ = new Promise<void>((resolve) => (settled = resolve));
  const server = http.createServer((request, response) => {
    read(request).then(
      (bytes) => (outcome = bytes),
      (error: unknown) => (outcome = error instanceof Error ? error : new Error(String(error))),
    ).finally(() => {
      settled();
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "PUT", headers, agent: false }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      // A server that stops reading an oversized body may hang up on the client's writes; what it made of the body is
      // what is asserted, not how the client's side of the connection ended.
      req.on("error", () => resolve());
      for (let at = 0; at < body.length; at += chunk) req.write(body.subarray(at, at + chunk));
      req.end();
    });
    await read_;
  } finally {
    server.close();
    server.closeAllConnections();
  }
  return outcome;
}

const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => index % 251);

test("a body longer than the part wanted comes back as its start", async () => {
  const body = bytes(300_000);
  const got = await through((request) => readRawBody(request, 1_000_000, 100_000), body);
  assert.ok(got instanceof Uint8Array);
  assert.equal(got.length, 100_000);
  assert.deepEqual(got, body.subarray(0, 100_000), "the start, across the chunks it arrived in");
});

test("a body no longer than the part wanted comes back whole", async () => {
  const body = bytes(50_000);
  const got = await through((request) => readRawBody(request, 1_000_000, 100_000), body);
  assert.deepEqual(got, body);
});

test("the part wanted need not end on a chunk boundary", async () => {
  const body = bytes(10_000);
  const got = await through((request) => readRawBody(request, 1_000_000, 2_500), body, {}, 1_000);
  assert.deepEqual(got, body.subarray(0, 2_500));
});

test("a body over the cap is refused however little of it is wanted", async () => {
  const got = await through((request) => readRawBody(request, 100_000, 10), bytes(300_000));
  assert.ok(got instanceof RipstreamError);
  assert.equal(got.code, "REQUEST_TOO_LARGE");
});

test("a body at the cap is not refused", async () => {
  const body = bytes(100_000);
  const got = await through((request) => readRawBody(request, 100_000, 10), body);
  assert.deepEqual(got, body.subarray(0, 10));
});

test("readBodyPrefix keeps the start of a body that is not gzip", async () => {
  const body = bytes(300_000);
  assert.deepEqual(await through((request) => readBodyPrefix(request, 1_000_000, 100_000), body), body.subarray(0, 100_000));
});

test("a body over the cap is read to its end when that is within what can be drained, and not read on past that", async () => {
  const seen: Record<string, boolean> = {};
  const probe = (name: string): Reader => (request) =>
    readRawBody(request, 100_000, 10).finally(() => {
      seen[name] = request.complete;
    });
  assert.ok((await through(probe("within"), Buffer.alloc(3 * MiB, 97))) instanceof RipstreamError);
  assert.ok((await through(probe("past"), Buffer.alloc(20 * MiB, 97))) instanceof RipstreamError);
  assert.deepEqual(seen, { within: true, past: false });
});

test("without a part wanted the whole body is kept, as it was", async () => {
  const body = bytes(300_000);
  assert.deepEqual(await through((request) => readRawBody(request, 1_000_000), body), body);
});

test("a gzip body is inflated whole, under the cap on what it inflates to", async () => {
  const body = bytes(300_000);
  const gz = gzipSync(body);
  const got = await through((request) => readBodyPrefix(request, 1_000_000, 100_000), gz, { "content-encoding": "gzip" });
  assert.deepEqual(got, body);
  const bomb = await through((request) => readBodyPrefix(request, 100_000, 10), gzipSync(Buffer.alloc(400_000)), { "content-encoding": "gzip" });
  assert.ok(bomb instanceof RipstreamError);
  assert.equal(bomb.code, "REQUEST_TOO_LARGE");
});

test("readBody keeps the whole of a body, gzip or not", async () => {
  const body = bytes(200_000);
  assert.deepEqual(await through((request) => readBody(request, 1_000_000), body), body);
  assert.deepEqual(await through((request) => readBody(request, 1_000_000), gzipSync(body), { "content-encoding": "gzip" }), body);
});
