import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer } from "../src/index.ts";

/*
 * A body over `maxBodyBytes` is answered 413. What happens to the connection is the part a client feels: Tika's server
 * (Jetty) reads past a body it refuses, so the next request on the connection works. So does this one, for a body a
 * little over the cap; a body far over it closes the connection with `Connection: close` rather than reading it all.
 */

const CAP = 1024 * 1024;
const MiB = 1024 * 1024;

interface Answer {
  readonly status: number;
  readonly connection: string | undefined;
  readonly reusedSocket: boolean;
  readonly body: string;
}

async function withServer<T>(run: (port: number, agent: http.Agent) => Promise<T>): Promise<T> {
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, maxBodyBytes: CAP });
  const port = await instance.listen();
  // One socket at a time, kept alive: a request that finds the connection dead fails instead of opening another.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    return await run(port, agent);
  } finally {
    agent.destroy();
    await instance.close();
  }
}

/** One request; `write` supplies the body, or leaves it unfinished to be sent no further. */
function request(
  port: number,
  agent: http.Agent,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders,
  write?: (req: http.ClientRequest) => void,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          connection: res.headers.connection,
          reusedSocket: req.reusedSocket,
          body: Buffer.concat(chunks).toString(),
        });
        req.destroy();
      });
    });
    req.on("error", reject);
    if (write === undefined) req.end();
    else write(req);
  });
}

const version = (port: number, agent: http.Agent): Promise<Answer> => request(port, agent, "GET", "/version", {});

test("a body a little over the cap is refused with 413 and the connection carries the next request", async () => {
  await withServer(async (port, agent) => {
    const body = Buffer.alloc(2 * MiB, 97);
    const refused = await request(port, agent, "PUT", "/tika", { "content-length": body.length }, (req) => req.end(body));
    assert.equal(refused.status, 413);
    assert.match(refused.body, /Request exceeds 1048576 bytes/);
    assert.notEqual(refused.connection, "close");

    const next = await version(port, agent);
    assert.equal(next.status, 200);
    assert.equal(next.reusedSocket, true, "the second request used the connection the 413 was answered on");
  });
});

test("/language, which keeps only the start of a body, refuses one over the cap the same way", async () => {
  await withServer(async (port, agent) => {
    const body = Buffer.alloc(2 * MiB, 97);
    const refused = await request(port, agent, "PUT", "/language", { "content-length": body.length }, (req) => req.end(body));
    assert.equal(refused.status, 413);
    assert.match(refused.body, /Request exceeds 1048576 bytes/);
    assert.notEqual(refused.connection, "close");
    const next = await version(port, agent);
    assert.equal(next.status, 200);
    assert.equal(next.reusedSocket, true, "the connection the 413 was answered on carries the next request");

    const chunk = Buffer.alloc(512 * 1024, 97);
    const chunked = await request(port, agent, "PUT", "/language", {}, (req) => {
      for (let i = 0; i < 6; i++) req.write(chunk);
      req.end();
    });
    assert.equal(chunked.status, 413);
    assert.equal((await version(port, agent)).reusedSocket, true);
  });
});

test("a chunked body over the cap, whose size is not announced, is refused the same way", async () => {
  await withServer(async (port, agent) => {
    const chunk = Buffer.alloc(512 * 1024, 97);
    const refused = await request(port, agent, "PUT", "/tika", {}, (req) => {
      for (let i = 0; i < 6; i++) req.write(chunk);
      req.end();
    });
    assert.equal(refused.status, 413);
    assert.notEqual(refused.connection, "close");
    const next = await version(port, agent);
    assert.equal(next.status, 200);
    assert.equal(next.reusedSocket, true);
  });
});

test("a body announced far over the cap is refused unread, closing the connection cleanly", async () => {
  await withServer(async (port, agent) => {
    // The client announces 64 MiB and sends a kilobyte: the server answers without waiting for the rest.
    const refused = await request(port, agent, "PUT", "/tika", { "content-length": 64 * MiB }, (req) => req.write(Buffer.alloc(1024, 97)));
    assert.equal(refused.status, 413);
    assert.equal(refused.connection, "close");

    const next = await version(port, agent);
    assert.equal(next.status, 200);
    assert.equal(next.reusedSocket, false, "a new connection: the refused one is gone");
  });
});

test("a body within the cap is parsed, and the connection is reused", async () => {
  await withServer(async (port, agent) => {
    const body = Buffer.from("within the cap");
    const first = await request(port, agent, "PUT", "/tika", { "content-length": body.length }, (req) => req.end(body));
    assert.equal(first.status, 200);
    assert.match(first.body, /within the cap/);
    const second = await version(port, agent);
    assert.equal(second.reusedSocket, true);
  });
});
