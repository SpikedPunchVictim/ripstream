import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  XHTMLContentHandler,
  type Parser,
} from "@spikedpunch/ripstream-core";
import {
  Bzip2Parser,
  BrotliParser,
  GzipParser,
  Lz4Parser,
  SnappyParser,
  UnixCompressParser,
  XzParser,
} from "../src/index.ts";

// 1,000,000 zero bytes, compressed with the reference xz / bzip2 / compress tools.
const XZ_ZEROS = "/Td6WFoAAATm1rRGBMDZAcCEPSEBFgAAAAAAAKEm8TzvQj8A0V0AAG/9//+jt/9HPkgVcjlhUbiSKOajhgf57uQegtMvxTo8AUuxfsmKik0vow3Zf6bjjCMRU+BZGMV1iuJ3+LaUfwxqwN50SWTi6VxTsgTY90QMq18NbUbp5cN2iLeWV6y2TeFpHW/7S4gQbELLiD9cAI/QTq8mKJRxHz2PJOFwnqcjX+woy4XRlZiKfiqR8id19xnABphNmP3Yr9WQD8QlU/j1kTYxBaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTlWwUI+ZPDPzYAAAAAMrNVl+7S4eMAAfUBwIQ9ACNg80GxxGf7AgAAAAAEWVo=";
const BZIP2_ZEROS = "QlpoOTFBWSZTWXnTnkgAB6jAQMAAAAIACCAAMMwJqmmVJDapSQ8XckU4UJB5055I";
const Z_ZEROS = "H52QAAIKHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMmypcuXMGPKnEmzps2bOHPq3Mmzp8+fQIMKHUq0qNGjSJMqXcq0qdOnUKNKnUq1qtWrWLNq3cq1q9evYMOKHUu2rNmzaNOqXcu2rdu3cOPKnUu3rt27ePPq3cu3r9+/gAMLHky4sOHDiBMrXsy4sePHkCNLnky5suXLmDNr3sy5s+fPoEOLHk26tOnTqFOrXs26tevXsGPLnk27tu3buHPr3s27t+/fwIMLH068uPHjyJMrX868ufPn0KNLn069uvXr2LNr3869u/fv4MOLH0++vPnz6NOrX8++vfv38OPLn0+/vv37+PPr38+/v///AAYo4IAEFmjggQgmqOCCDDbo4IMQRijhhBRWaOGFGGao4YYcdujhhyCGKOKIJJZo4okopqjiiiy26OKLMMYo44w01mjjjTjmqOOOPPbo449ABinkkEQWaeSRSCap5JJMNunkk1BGKeWUVFZp5ZVYZqnlllx26eWXYIYp5phklmnmmWimqeaabLbp5ptwxinnnHTWaeedeOap55589unnn4AGKuighBZq6KGIJqrooow26uijkEYq6aSUVmrppZhmqummnHbq6aeghirqqKSWauqpqKaq6qqsturqq7DGKuustNZq66245qrrrrz26uuvwAYr7LDEFmvsscgmq+yyzDbr7LPQRivttNRWa+212Gar7bbcduvtt+CGK+645JZr7rnopqvuuuy26+678MYr77z01mvvvfjmq+++/Pbr778AByzwwAQXbPDBCCes8MIMN+zwwxBHLPHEFFds8cUYZ6zxxhx37PHHIIcs8sgkl2zyySinrPLKLLfs8sswxyzzzDTXbPPNOOes88489+zzz0AHLfTQRBdt9NFIJ6300kw37fTTUEct9dRUV2311VhnrfXWXHft9ddghy322GSXbfbZaKet9tpst+3223DHLffcdNdt991456333nz37fffgAcu+OCEF2744YgnrvjijDfu+OOQRy755JRXbvnlmGeu+eacd+7556CHLvropJdu+umop6766qy37vrrsMcu++y012777bjnrvvuvPfu++/ABy/88MQXb/zxyCev/PLMN+/889BHL/301Fdv/fXYZ6/99tx37/334Icv/vjkl2/++einr/767Lfv/vvwxy///PTXb//9+Oev//789+///wAMoAAHSMACGvCACEygAhfIwAY68IEQjKAEJ0jBClrwghjMoAY3yMEOevCDIAyhCEdIwhKa8IQoTKEKV8jCFrrwhTCMoQxnSMMa2vCGOMyhDnfIwx768IdADKIQh0jEIhrxiEhMohKXyMQmOvGJUIyiFKdIxSpa8YpYzKIWt8jFLnrxi2AMoxjHSMYymvGMaEyjGtfIxja68Y1wjKMc50jHOtrxjnjMox73yMc++vGPgAykIAdJyEIa8pCITKQiF8nIRjrykZCMpCQnSclKWvKSmMykJjfJyU568pOgDKUoR0nKUprylKhMpSpXycpWuvKVsIylLGdJy1ra8pa4zKUud8nLXvryl8AMpjCHScxiGvOYyEymMpfJzGY685nQjKY0p0nNalrzmtjMpja3yc1uevOb4AynOMdJznKa85zoTKc618nOdrrznfCMpzznSc962vOe+MynPvfJz376858ADahAB0rQghr0oAhNqEIXytCGOvShEI2oRCdK0Ypa9KIYzahGN8rRjnr0oyANqUhHStKSmvSkKE2pSlfK0pa69KUwjalMZ0rTmtr0pjjNqU53ytOe+vSnQA2qUIdK1KIa9ahITapSl8rUpjr1qVCNqlSnStWqWvWqWM2qVrfK1a569atgDatYx0rWspr1rGhNq1rXyta2uvWtcI2rXOdK17ra9a54zate98rXvvr1r4ANrGAHS9jCGvawiE2sYhfL2MY69rGQjaxkJ0vZylr2spjNrGY3y9nOevazoA2taEdL2tKa9rSoTa1qV8va1rr2tbCNrWxnS9va2va2uM2tbnfL29769rfADa5wh0vc4hr3uMhNrnKXy9zmOve50I2udKdL3epa97rYza52t8vd7nr3u+ANr3jHS97ymve86E2vetfL3va6973wja9850vf+tr3vvjNr373y9/++ve/AA6wgAdM4AIb+MAITrCCF8zgBjv4wRCOsIQnTOEKW/jCGM6whjfM4Q57+MMgDrGIR0ziEpv4xChOsYpXzOIWu/jFMI6xjGdM4xrb+MY4zrGOd8zjHvv4x0AOspCHTOQiG/nISE6ykpfM5CY7+clQjrKUp0zlKlv5yljOspa3zOUue/nLYA6zmMdM5jKb+cxoTrOa18zmNrv5zXCOs5znTOc62/nOeM6znvfM5z77+c+ADrSgB01oeAI=";

const sink: Parser = {
  getSupportedTypes: () => new Set(),
  async parse(stream, handler) {
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    let length = 0;
    for await (const chunk of stream) length += chunk.byteLength;
    await xhtml.element("p", String(length));
    await xhtml.endDocument();
  },
};

// Ratio check disabled so the absolute output cap is what trips.
function boundedContext(): ParseContext {
  const context = new ParseContext({
    limits: { maxEmbeddedResourceBytes: 100_000, maxDecompressionRatio: 1e9 },
  });
  context.set(CONTEXT_KEYS.PARSER, sink);
  return context;
}

async function parseWith(
  parser: Parser,
  bytes: Uint8Array,
  context: ParseContext,
): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await parser.parse(stream, handler, new Metadata(), context);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

const zeros = new Uint8Array(1_000_000);
const b64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "base64"));

test("gzip bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(
    parseWith(new GzipParser(), gzipSync(zeros), boundedContext()),
    LimitExceededError,
  );
});

test("brotli bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(
    parseWith(new BrotliParser(), brotliCompressSync(zeros), boundedContext()),
    LimitExceededError,
  );
});

test("bzip2 bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(
    parseWith(new Bzip2Parser(), b64(BZIP2_ZEROS), boundedContext()),
    LimitExceededError,
  );
});

test("xz bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(
    parseWith(new XzParser(), b64(XZ_ZEROS), boundedContext()),
    LimitExceededError,
  );
});

test("lz4 bomb fails with LimitExceededError at the output cap", async () => {
  const lz4 = (await import("lz4js")) as unknown as {
    default?: { compress(value: Uint8Array): Uint8Array };
    compress?(value: Uint8Array): Uint8Array;
  };
  const compress = lz4.default?.compress ?? lz4.compress!;
  await assert.rejects(
    parseWith(new Lz4Parser(), compress(zeros), boundedContext()),
    LimitExceededError,
  );
});

test("snappy frames beyond the output cap fail with LimitExceededError", async () => {
  const snappy = (await import("snappyjs")) as unknown as {
    default?: { compress(value: Uint8Array): Uint8Array };
    compress?(value: Uint8Array): Uint8Array;
  };
  const compress = snappy.default?.compress ?? snappy.compress!;
  const packed = compress(new Uint8Array(65536));
  const frame = new Uint8Array([0, (packed.length + 4) & 0xff, ((packed.length + 4) >> 8) & 0xff, 0, 0, 0, 0, 0, ...packed]);
  const parts = [new Uint8Array([0xff, 6, 0, 0, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59])];
  for (let index = 0; index < 4; index++) parts.push(frame);
  await assert.rejects(
    parseWith(new SnappyParser(), Buffer.concat(parts), boundedContext()),
    LimitExceededError,
  );
});

test("snappy chunk declaring a huge uncompressed length is rejected without allocating", async () => {
  // varint preamble 0xffffffff07 (~2 GiB) followed by a literal tag.
  const chunk = [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x07, 0x00, 0x41];
  const bytes = new Uint8Array([0xff, 6, 0, 0, 0x73, 0x4e, 0x61, 0x50, 0x70, 0x59, 0, chunk.length, 0, 0, ...chunk]);
  await assert.rejects(parseWith(new SnappyParser(), bytes, boundedContext()));
});

test("unix compress bomb fails with LimitExceededError at the output cap", async () => {
  await assert.rejects(
    parseWith(new UnixCompressParser(), b64(Z_ZEROS), boundedContext()),
    LimitExceededError,
  );
});
