import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError, ParseTimeoutError } from "@spikedpunch/ripstream-core";
import { InlineChannel } from "../src/pdf-channel.ts";
import type { PdfRequest, PdfResponse } from "../src/pdf-session.ts";

const READY: PdfResponse = {
  type: "ready",
  info: {},
  xmp: {},
  numPages: 1,
  attachments: [],
};

class FakeSession {
  disposed = 0;
  handled: PdfRequest[] = [];
  open: () => Promise<PdfResponse> = () => new Promise(() => undefined);
  handle: (request: PdfRequest) => Promise<PdfResponse> = (request) => {
    this.handled.push(request);
    return Promise.resolve({ type: "closed" });
  };

  dispose(): Promise<void> {
    this.disposed++;
    return Promise.resolve();
  }
}

test("inline channel gives up on a session that never answers", async () => {
  const channel = new InlineChannel(new FakeSession());
  await assert.rejects(channel.next(20), ParseTimeoutError);
  await channel.stop();
});

test("inline channel stops a waiting reader at once and disposes the session", async () => {
  const session = new FakeSession();
  const channel = new InlineChannel(session);
  const waiting = channel.next();
  const stopping = channel.stop();
  await assert.rejects(waiting, MalformedDocumentError);
  await stopping;
  await channel.stop(); // repeating it is safe
  assert.ok(session.disposed > 0, "the session must be disposed");
  await assert.rejects(channel.next(), MalformedDocumentError);
});

test("inline channel delivers the open response, then request responses in order", async () => {
  const session = new FakeSession();
  session.open = () => Promise.resolve(READY);
  const channel = new InlineChannel(session);
  assert.deepEqual(await channel.next(), READY);

  channel.post({ type: "page", index: 1 });
  channel.post({ type: "close" });
  assert.deepEqual(await channel.next(), { type: "closed" });
  assert.deepEqual(await channel.next(), { type: "closed" });
  assert.deepEqual(session.handled, [
    { type: "page", index: 1 },
    { type: "close" },
  ]);
  await channel.stop();
});

test("inline channel yields to the event loop before handling a request", async () => {
  const session = new FakeSession();
  session.open = () => Promise.resolve(READY);
  const channel = new InlineChannel(session);
  await channel.next();

  channel.post({ type: "page", index: 1 });
  await Promise.resolve();
  assert.equal(session.handled.length, 0, "microtasks alone must not run the request");
  await channel.next();
  assert.equal(session.handled.length, 1);
  await channel.stop();
});

test("inline channel drops a response that arrives after stop", async () => {
  const session = new FakeSession();
  let answer: (response: PdfResponse) => void = () => undefined;
  session.open = () => new Promise((resolve) => (answer = resolve));
  const channel = new InlineChannel(session);
  await channel.stop();
  answer(READY);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(channel.next(), MalformedDocumentError);
});

test("inline channel reports a crashing session as a malformed document", async () => {
  const session = new FakeSession();
  session.open = () => Promise.reject(new Error("pdf.js exploded"));
  const channel = new InlineChannel(session);
  await assert.rejects(channel.next(), (error: Error) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.equal((error.cause as Error).message, "pdf.js exploded");
    return true;
  });
  await channel.stop();
});
