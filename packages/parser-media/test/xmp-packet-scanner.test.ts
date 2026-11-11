import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { MAX_XMP_PACKET_BYTES, scanXmpPacket } from "../src/xmp-packet-scanner.ts";

/*
 * Ported from Tika 4.2.0's XMPPacketScanner (tika-parser-xmp-commons), read from that source; not run against a Tika.
 * Its byte matcher is reproduced as it is, including that a failed partial match does not restart at the byte that
 * failed it (tikajs-68os.44).
 */

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);
const HEADER = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>';
const TRAILER = '<?xpacket end="w"?>';

async function* chunksOf(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function scan(value: string | Uint8Array, chunk = 1 << 20, max?: number): Promise<string | null> {
  const bytes = typeof value === "string" ? text(value) : value;
  const packet = await scanXmpPacket(chunksOf(bytes, chunk), max);
  return packet === null ? null : new TextDecoder().decode(packet);
}

test("the packet is what lies between the header's ?> and the trailer's <?xpacket", async () => {
  assert.equal(await scan(`junk${HEADER}<x:xmpmeta>a</x:xmpmeta>${TRAILER}tail`), "<x:xmpmeta>a</x:xmpmeta>");
});

test("a stream with no packet header gives null", async () => {
  assert.equal(await scan("no packet here <?xpacket"), null);
});

test("an empty stream gives null", async () => {
  assert.equal(await scan(""), null);
});

test("the result does not depend on how the stream is cut into chunks", async () => {
  const input = `\u0000\u0001junk${HEADER}<a b="c">d</a>${TRAILER}`;
  for (const size of [1, 2, 3, 7, 16]) assert.equal(await scan(input, size), '<a b="c">d</a>', `chunks of ${size}`);
});

test("only the first packet is read", async () => {
  assert.equal(await scan(`${HEADER}first${TRAILER}${HEADER}second${TRAILER}`), "first");
});

test("a header with no ?> is an invalid packet header", async () => {
  await assert.rejects(scan('<?xpacket begin="abc'), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.match(error.message, /Invalid XMP packet header/);
    return true;
  });
});

test("a packet with no trailer is not properly terminated", async () => {
  await assert.rejects(scan(`${HEADER}<a>never closed by a trailer</a>`), (error: unknown) => {
    assert.ok(error instanceof MalformedDocumentError);
    assert.match(error.message, /not properly terminated/);
    return true;
  });
});

test("a partial match of the trailer inside the packet is kept in it", async () => {
  assert.equal(await scan(`${HEADER}<a>x<?xpa y<?x z</a>${TRAILER}`), "<a>x<?xpa y<?x z</a>");
});

test("a failed partial match does not restart at the byte that failed it, as Tika's skipAfter does", async () => {
  // "<<?xpacket begin=": the second "<" fails the match started by the first and is not tried as a new start.
  assert.equal(await scan(`<<?xpacket begin="" id=""?>payload${TRAILER}`), null);
  // The same inside the packet: "<<?xpacket" does not end it, so the scan runs on to the next trailer.
  assert.equal(await scan(`${HEADER}a<<?xpacket b${TRAILER}`), "a<<?xpacket b");
});

test("a packet of exactly the cap is read and one byte more is refused", async () => {
  assert.equal(await scan(`${HEADER}12345${TRAILER}`, 1 << 20, 5), "12345");
  await assert.rejects(scan(`${HEADER}123456${TRAILER}`, 1 << 20, 5), LimitExceededError);
});

test("the default cap is 64 MiB: a packet over it is refused, with only the packet held", async () => {
  const body = new Uint8Array(64 * 1024 * 1024 + 1).fill(0x61);
  const head = text(HEADER);
  const input = new Uint8Array(head.length + body.length + TRAILER.length);
  input.set(head, 0);
  input.set(body, head.length);
  input.set(text(TRAILER), head.length + body.length);
  await assert.rejects(scan(input, 1 << 20), LimitExceededError);
});

// Mutation hardening of the scanner's buffer and cap.

/** A packet of `length` bytes in 1 MiB chunks, header and trailer around it, without holding it whole. */
async function* packetOf(length: number): AsyncGenerator<Uint8Array> {
  yield text(HEADER);
  const chunk = new Uint8Array(1 << 20).fill(0x61);
  for (let left = length; left > 0; left -= chunk.length) yield chunk.subarray(0, Math.min(left, chunk.length));
  yield text(TRAILER);
}

test("a packet that outgrows the capture buffer is returned whole, in whatever chunks it comes", async () => {
  const body = Array.from({ length: 10_000 }, (_, i) => String.fromCharCode(0x61 + (i % 26))).join("");
  for (const size of [1, 4096, 4097, 1 << 20]) assert.equal(await scan(`${HEADER}${body}${TRAILER}`, size), body, `chunks of ${size}`);
});

test("a packet of several megabytes is read with the default cap", async () => {
  const packet = await scanXmpPacket(packetOf(5 * 1024 * 1024));
  assert.equal(packet?.length, 5 * 1024 * 1024);
});

test("a packet of exactly 64 MiB is read and the cap is that many bytes", async () => {
  assert.equal(MAX_XMP_PACKET_BYTES, 64 * 1024 * 1024);
  const packet = await scanXmpPacket(packetOf(MAX_XMP_PACKET_BYTES));
  assert.equal(packet?.length, MAX_XMP_PACKET_BYTES);
});

test("a header end that is not found because of a doubled ? leaves the header unterminated, as in Tika", async () => {
  await assert.rejects(scan(`<?xpacket begin="x"??>payload${TRAILER}`), MalformedDocumentError);
});

test("a partial match of the header that fails is not part of any packet", async () => {
  assert.equal(await scan(`<?xpacket begin <?xpack ${HEADER}in${TRAILER}`), "in");
});

test("the trailer is the whole of <?xpacket: a longer or shorter lookalike inside the packet is kept", async () => {
  assert.equal(await scan(`${HEADER}a<?xpackez b${TRAILER}`), "a<?xpackez b");
  assert.equal(await scan(`${HEADER}ab<?xpacket?>`), "ab");
});
