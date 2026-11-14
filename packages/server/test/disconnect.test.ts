import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { MediaType, Metadata, type ParseOptions, type ParseRecord } from "@spikedpunch/ripstream-core";
import { createRipstreamServer, type RipstreamServerOptions, type ServerRipstream } from "../src/index.ts";

/*
 * A client that goes away must give back what it held: its place in the queue, its concurrency slot and its body
 * reservation. The gate has a few ways to hold a request past its client, and every one of them ends the same way, with
 * a server whose slots are all taken by requests nobody is waiting for.
 */

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function record(bytes?: Uint8Array): ParseRecord {
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/octet-stream");
  return {
    metadata,
    content: "",
    embeddedResourcePath: "/",
    depth: 0,
    mediaType: MediaType.TEXT_PLAIN,
    exception: null,
    ...(bytes === undefined ? {} : { bytes }),
  };
}

/** An engine whose parse waits on `hold` (or on the request's own signal) and records the signals it was given. */
function engine(hold: Gate | null, signals: AbortSignal[] = [], embedded: readonly Uint8Array[] = []): ServerRipstream {
  const enter = async (options: ParseOptions | undefined): Promise<void> => {
    if (options?.signal !== undefined) signals.push(options.signal);
    if (hold === null) return;
    await new Promise<void>((resolve, reject) => {
      void hold.promise.then(resolve);
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
  };
  const metadata = (): Metadata => new Metadata();
  return {
    async detect(_source, options) {
      await enter(options);
      return MediaType.TEXT_PLAIN;
    },
    async parse(_source, options) {
      await enter(options);
      return { metadata: metadata(), text: "fake text" };
    },
    async parseRecursive(_source, options) {
      await enter(options);
      return [record(), ...embedded.map((bytes, index) => ({ ...record(bytes), metadata: embeddedMetadata(index + 1) }))];
    },
  };
}

function embeddedMetadata(id: number): Metadata {
  const metadata = new Metadata();
  metadata.set("Content-Type", "application/octet-stream");
  metadata.set("tk:embedded-id", String(id));
  return metadata;
}

async function withServer<T>(options: RipstreamServerOptions, run: (port: number) => Promise<T>): Promise<T> {
  const instance = createRipstreamServer({ log: () => undefined, ...options });
  const port = await instance.listen();
  try {
    return await run(port);
  } finally {
    await instance.close();
  }
}

function raw(port: number, text: string): Socket {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  socket.write(text);
  return socket;
}

interface StatusBody {
  readonly active: number;
  readonly queued: number;
}

async function status(port: number): Promise<StatusBody> {
  return (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as StatusBody;
}

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a client that disconnects while queued gives back its place at once", async () => {
  const hold = gate();
  await withServer({ ripstream: engine(hold), maxConcurrent: 1, maxQueue: 5 }, async (port) => {
    const a = raw(port, "PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello");
    await until(async () => (await status(port)).active === 1, "A to take the slot");
    const b = raw(port, "PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nworld");
    await until(async () => (await status(port)).queued === 1, "B to queue");
    b.destroy();
    await until(async () => (await status(port)).queued === 0, "B to leave the queue");
    hold.open();
    a.destroy();
  });
});

test("a slot is not lost to a client that disconnected while queued", async () => {
  const hold = gate();
  await withServer({ ripstream: engine(hold), maxConcurrent: 1, maxQueue: 5, requestTimeoutMs: 4000 }, async (port) => {
    const a = raw(port, "PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello");
    await until(async () => (await status(port)).active === 1, "A to take the slot");
    const b = raw(port, "PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nworld");
    await until(async () => (await status(port)).queued === 1, "B to queue");
    b.destroy();
    await sleep(100); // the server has seen the connection close
    hold.open();
    await until(async () => (await status(port)).active === 0, "the slot to come back");
    const third = await fetch(`http://127.0.0.1:${port}/tika`, { method: "PUT", body: "third" });
    assert.equal(third.status, 200);
    a.destroy();
  });
});

test("the parse of a request whose client disconnects is cancelled and its slot freed", async () => {
  const hold = gate();
  const signals: AbortSignal[] = [];
  await withServer({ ripstream: engine(hold, signals), maxConcurrent: 1 }, async (port) => {
    const a = raw(port, "PUT /tika HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello");
    await until(async () => signals.length === 1, "the parse to start");
    assert.equal(signals[0]?.aborted, false);
    a.destroy();
    await until(async () => (await status(port)).active === 0, "the slot to come back");
    assert.equal(signals[0]?.aborted, true, "the parse was told to stop");
  });
});

test("the server does not idle-time-out an upload it has not started to read", async () => {
  const hold = gate();
  await withServer({ ripstream: engine(hold), maxConcurrent: 1, maxQueue: 5, idleTimeoutMillis: 300 }, async (port) => {
    const a = fetch(`http://127.0.0.1:${port}/tika`, { method: "PUT", body: "first" });
    await until(async () => (await status(port)).active === 1, "A to take the slot");
    // Larger than the socket buffers can take, so the upload is unfinished for as long as the server does not read it.
    const body = randomBytes(24 * 1024 * 1024);
    const second = new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "PUT", path: "/tika", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(body);
    });
    await until(async () => (await status(port)).queued === 1, "B to queue");
    await sleep(900); // three idle periods
    hold.open();
    assert.equal((await a).status, 200);
    assert.equal(await second, 200);
  });
});

test("a /unpack download the client abandons under backpressure frees its slot", async () => {
  const embedded = Array.from({ length: 4 }, () => randomBytes(8 * 1024 * 1024));
  await withServer({ ripstream: engine(null, [], embedded), maxConcurrent: 1, requestTimeoutMs: 20_000 }, async (port) => {
    const client = raw(port, "PUT /unpack HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello");
    let received = 0;
    await new Promise<void>((resolve) =>
      client.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 4096) {
          client.pause(); // stop reading: the server's writes back up
          resolve();
        }
      }),
    );
    await sleep(300);
    assert.equal((await status(port)).active, 1, "the server is waiting to write the rest");
    client.destroy();
    await until(async () => (await status(port)).active === 0, "the slot to come back");
  });
});
