import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  type ContentHandler,
  LimitExceededError,
  Metadata,
  OutputLimitContentHandler,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { MboxParser, RtfParser } from "../src/index.ts";

// tikajs-kpkn: mbox and rtf used to buffer the whole input, then the whole text, before the first write, so the
// output cap and the size limits fired only after the work was done (50 MB mbox: 744 MB RSS; 20 MB rtf: 975 MB).
// These tests count the bytes the parser pulled from the input before it threw, which is deterministic, unlike RSS.

const encoder = new TextEncoder();

/** An input that never ends and counts the bytes handed to the parser. It fails the test if read to the end. */
function endlessInput(chunk: Uint8Array, maxChunks = 5_000): {
  source: AsyncGenerator<Uint8Array>;
  pulled: () => number;
} {
  let bytes = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < maxChunks; index++) {
      bytes += chunk.byteLength;
      yield chunk;
    }
    throw new Error("the parser read an endless input to its end");
  }
  return { source: source(), pulled: () => bytes };
}

function messages(count: number, label: string): string {
  let out = "";
  for (let index = 0; index < count; index++) {
    out += `From a${index}@example.com Mon Jan  1 00:00:00 2024\nFrom: A <a@example.com>\nSubject: ${label}\nContent-Type: text/plain\n\nbody ${label} ${index}\n`;
  }
  return out;
}

async function parseMbox(
  input: AsyncGenerator<Uint8Array> | Uint8Array,
  options: { outputLimit?: number; ctx?: ParseContext } = {},
): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(input);
  const body = new BodyContentHandler();
  const handler = options.outputLimit === undefined ? body : new OutputLimitContentHandler(body, options.outputLimit);
  const metadata = new Metadata();
  try {
    await new MboxParser().parse(stream, handler, metadata, options.ctx ?? new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: body.toString(), metadata };
}

test("mbox reaches the output cap after reading a bounded part of an endless mailbox", async () => {
  const chunk = encoder.encode(messages(10, "endless"));
  const input = endlessInput(chunk);
  await assert.rejects(parseMbox(input.source, { outputLimit: 1_000 }), LimitExceededError);
  // 1,000 output characters is a few chunks of 10 messages; the old reader pulled every chunk first.
  assert.ok(input.pulled() <= 10 * chunk.byteLength, `pulled ${input.pulled()} bytes`);
});

test("mbox rejects one message over the per-message limit, reading no further than the limit plus a chunk", async () => {
  // No line starts with "From ", so the whole input is one message that never ends.
  const line = encoder.encode("X-Header: " + "a".repeat(1000) + "\n");
  const input = endlessInput(line);
  const cap = 64 * 1024;
  const ctx = new ParseContext({ limits: { maxEmbeddedResourceBytes: cap } });
  await assert.rejects(parseMbox(input.source, { ctx }), LimitExceededError);
  assert.ok(input.pulled() <= cap + 64 * 1024 + line.byteLength, `pulled ${input.pulled()} bytes`);
});

test("mbox gives the same output wherever the input is cut into chunks", async () => {
  // CRLF line ends, a lone CR, 8-bit bytes and a blank-only preamble: the places a chunk boundary can hurt.
  const text = "\r\n  \r\n" + messages(3, "cut").replace(/\n/g, "\r\n") + "From x@y Tue Jan  2 00:00:00 2024\nSubject: lone\rcr\n\ncafé\n";
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
  const whole = await parseMbox(bytes);
  assert.equal(whole.metadata.get("Message:Count"), "4");
  for (let cut = 1; cut < bytes.length; cut++) {
    async function* twoChunks(): AsyncGenerator<Uint8Array> {
      yield bytes.subarray(0, cut);
      yield bytes.subarray(cut);
    }
    const split = await parseMbox(twoChunks());
    assert.equal(split.text, whole.text, `cut at ${cut}`);
    assert.equal(split.metadata.get("Message:Count"), "4", `cut at ${cut}`);
  }
});

test("an input with no mail message is still refused before any output", async () => {
  await assert.rejects(parseMbox(encoder.encode("From a@b Mon Jan  1 00:00:00 2024\n\n  \n")), /Not an mbox bundle/);
});

const FIRST_FROM = "From a@example.com Mon Jan  1 00:00:00 2024\n";
const SECOND_FROM = "From c@example.com Tue Jan  2 00:00:00 2024\n";

/** One message of exactly `bytes` bytes (counting each line end as one byte), after its "From " line. */
function messageOfBytes(bytes: number): string {
  const fixed = "Subject: s\nContent-Type: text/plain\n\n"; // 37 bytes
  return fixed + "x".repeat(bytes - fixed.length - 1) + "\n";
}

function capContext(cap: number): ParseContext {
  return new ParseContext({ limits: { maxEmbeddedResourceBytes: cap } });
}

test("mbox accepts a message of exactly the per-message limit and rejects one byte more", async () => {
  const ok = await parseMbox(encoder.encode(FIRST_FROM + messageOfBytes(1000)), { ctx: capContext(1000) });
  assert.equal(ok.metadata.get("Message:Count"), "1");
  await assert.rejects(
    parseMbox(encoder.encode(FIRST_FROM + messageOfBytes(1001)), { ctx: capContext(1000) }),
    LimitExceededError,
  );
});

test("mbox counts a CRLF line end as two bytes of the message", async () => {
  // messageOfBytes(996) has four lines, so with CRLF line ends it is 1,000 bytes.
  const crlf = (bytes: number): Uint8Array => encoder.encode((FIRST_FROM + messageOfBytes(bytes)).replace(/\n/g, "\r\n"));
  const ok = await parseMbox(crlf(996), { ctx: capContext(1000) });
  assert.equal(ok.metadata.get("Message:Count"), "1");
  await assert.rejects(parseMbox(crlf(997), { ctx: capContext(1000) }), LimitExceededError);
});

test("mbox accepts a last message of exactly the limit that has no final line end", async () => {
  const input = FIRST_FROM + messageOfBytes(1000).slice(0, -1) + "y";
  const result = await parseMbox(encoder.encode(input), { ctx: capContext(1000) });
  assert.equal(result.metadata.get("Message:Count"), "1");
  await assert.rejects(parseMbox(encoder.encode(input + "y"), { ctx: capContext(1000) }), LimitExceededError);
});

test("mbox keeps a one-character last line that has no final line end", async () => {
  const input = FIRST_FROM + "Subject: s\nContent-Type: text/plain\n\nfirst line\nz";
  assert.match((await parseMbox(encoder.encode(input))).text, /first line\s+z/);
});

test("mbox counts the size of each message separately", async () => {
  // Ten messages of 300 bytes are 3,000 bytes, three times the limit, but each is under it.
  const input = Array.from({ length: 10 }, () => FIRST_FROM + messageOfBytes(300)).join("");
  const result = await parseMbox(encoder.encode(input), { ctx: capContext(1000) });
  assert.equal(result.metadata.get("Message:Count"), "10");
});

test("mbox accepts a message at the limit when the next From line arrives in pieces", async () => {
  // The first message fills the limit. The next "From " line is dropped, not added to it, wherever it is cut.
  async function* pieces(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(FIRST_FROM + messageOfBytes(1000) + "From c@");
    yield encoder.encode("example.com Tue Jan");
    yield encoder.encode("  2 00:00:00 2024\nSubject: t\n\nsecond\n");
  }
  const result = await parseMbox(pieces(), { ctx: capContext(1000) });
  assert.equal(result.metadata.get("Message:Count"), "2");
  assert.match(result.text, /second/);
});

test("mbox accepts a From line as long as the limit that arrives in pieces", async () => {
  const fromLine = "From c@example.com Tue Jan  2 00:00:00 2024 ".padEnd(1000, "x");
  async function* pieces(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(FIRST_FROM + messageOfBytes(500) + fromLine.slice(0, 400));
    yield encoder.encode(fromLine.slice(400));
    yield encoder.encode("\nSubject: t\n\nsecond\n");
  }
  const result = await parseMbox(pieces(), { ctx: capContext(1000) });
  assert.equal(result.metadata.get("Message:Count"), "2");
});

test("mbox writes a message body without the whitespace around it", async () => {
  const input = FIRST_FROM + "Subject: s\nContent-Type: text/plain\n\n   indented first line\nsecond line\n\n\n";
  const text = (await parseMbox(encoder.encode(input))).text;
  assert.ok(text.includes("\nindented first line\n"), JSON.stringify(text));
});

test("mbox rejects an endless line, reading no further than the limit plus a chunk", async () => {
  const input = endlessInput(encoder.encode("x".repeat(1000)));
  const cap = 64 * 1024;
  await assert.rejects(parseMbox(input.source, { ctx: capContext(cap) }), LimitExceededError);
  assert.ok(input.pulled() <= cap + 1000, `pulled ${input.pulled()} bytes`);
});

test("mbox reads a body line that only looks like a From line as part of the message", async () => {
  const body = "Mail From me to you\nFromage is tasty\nFrom \nlast line\n";
  const input = FIRST_FROM + "Subject: s\nContent-Type: text/plain\n\n" + body;
  const result = await parseMbox(encoder.encode(input));
  assert.equal(result.metadata.get("Message:Count"), "1");
  for (const line of ["Mail From me to you", "Fromage is tasty", "last line"]) {
    assert.ok(result.text.includes(line), `missing ${line}`);
  }
});

test("mbox reads the same text from CRLF and LF line ends", async () => {
  const lf = messages(3, "ends");
  assert.equal((await parseMbox(encoder.encode(lf.replace(/\n/g, "\r\n")))).text, (await parseMbox(encoder.encode(lf))).text);
});

test("mbox gives the same output when the input arrives one byte at a time", async () => {
  const bytes = encoder.encode("\r\n" + messages(2, "bytes").replace(/\n/g, "\r\n") + "From x@y Tue Jan  2 00:00:00 2024\nSubject: tail\n\nlast");
  async function* oneByte(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < bytes.length; index++) yield bytes.subarray(index, index + 1);
  }
  const whole = await parseMbox(bytes);
  const split = await parseMbox(oneByte());
  assert.equal(split.text, whole.text);
  assert.equal(split.metadata.get("Message:Count"), "3");
});

test("mbox gives the same output for a chunk larger than the latin1 conversion step", async () => {
  // One message of 4,000 distinct body lines is over 3 conversion steps of 8192 bytes.
  const body = Array.from({ length: 4000 }, (_, index) => `line number ${index}`).join("\n");
  const bytes = encoder.encode(FIRST_FROM + "Subject: s\nContent-Type: text/plain\n\n" + body + "\n");
  assert.ok(bytes.length > 3 * 8192);
  async function* small(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < bytes.length; index += 1000) yield bytes.subarray(index, index + 1000);
  }
  const whole = await parseMbox(bytes);
  for (const index of [0, 1000, 3999]) assert.ok(whole.text.includes(`line number ${index}\n`), `missing ${index}`);
  assert.equal((await parseMbox(small())).text, whole.text);
});

/** Records the events it is given, by name. */
function recordingHandler(events: string[]): ContentHandler {
  return {
    startDocument: () => void events.push("startDocument"),
    endDocument: () => void events.push("endDocument"),
    startElement: () => void events.push("startElement"),
    endElement: () => void events.push("endElement"),
    characters: () => void events.push("characters"),
  };
}

async function parseMboxInto(handler: ContentHandler, bytes: Uint8Array): Promise<void> {
  const stream = await RipstreamInputStream.from(bytes);
  try {
    await new MboxParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
}

test("mbox gives the handler no event at all for an input with no message", async () => {
  const events: string[] = [];
  await assert.rejects(
    parseMboxInto(recordingHandler(events), encoder.encode("From a@b Mon Jan  1 00:00:00 2024\n\n  \n")),
    /Not an mbox bundle/,
  );
  assert.deepEqual(events, []);
});

test("mbox starts the document once, with the first message, and ends it last", async () => {
  const events: string[] = [];
  await parseMboxInto(recordingHandler(events), encoder.encode(messages(2, "events")));
  assert.equal(events[0], "startDocument");
  assert.equal(events[events.length - 1], "endDocument");
  assert.equal(events.filter((event) => event === "startDocument").length, 1);
});

function rtfOfLength(length: number): Uint8Array {
  const head = "{\\rtf1 ";
  return encoder.encode(head + "a".repeat(length - head.length - 1) + "}");
}

async function parseRtf(
  input: AsyncGenerator<Uint8Array> | Uint8Array,
  limit: number,
): Promise<string> {
  const stream = await RipstreamInputStream.from(input);
  const body = new BodyContentHandler();
  const ctx = new ParseContext({ limits: { maxEmbeddedResourceBytes: limit } });
  try {
    await new RtfParser().parse(stream, body, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return body.toString();
}

test("rtf rejects an endless input at the size limit, reading no further than the limit plus a chunk", async () => {
  const chunk = encoder.encode("{\\rtf1 " + "a".repeat(8 * 1024));
  const input = endlessInput(chunk);
  const cap = 256 * 1024;
  await assert.rejects(parseRtf(input.source, cap), LimitExceededError);
  assert.ok(input.pulled() <= cap + chunk.byteLength, `pulled ${input.pulled()} bytes`);
});

test("rtf accepts a document of exactly the size limit and rejects one byte more", async () => {
  assert.match(await parseRtf(rtfOfLength(1000), 1000), /^a+$/m);
  await assert.rejects(parseRtf(rtfOfLength(1001), 1000), LimitExceededError);
});

function rtfText(length: number): string {
  return Array.from({ length }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
}

test("rtf keeps all of its text across the 8192-character output pieces", async () => {
  for (const length of [8191, 8192, 8193, 16384, 20000]) {
    const text = rtfText(length);
    assert.equal((await parseRtf(encoder.encode(`{\\rtf1 ${text}}`), 1_000_000)).trim(), text, `length ${length}`);
  }
});
