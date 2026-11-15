import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MalformedDocumentError, MediaType, Metadata, type ParseRecord } from "@spikedpunch/ripstream-core";
import { sendFrame } from "../../src/child-io.ts";
import { runChildMain, type ChildRipstream } from "../../src/child-main.ts";

/**
 * Child entry for the reuse tests (warm.test.ts): the REAL runChildMain around a fake pipeline. Unlike hostile-main.ts
 * the behaviour comes from each request's INPUT ("command" or "command:arg"), so one serving child can be told to
 * behave well, then badly. Every answer names the process and how many requests it has parsed, which is how the tests
 * tell a reused child from a fresh one.
 */

let parsed = 0;
/** Memory a "retain" request keeps for the life of the process (the RSS ceiling test). */
const retained: Buffer[] = [];
/** What a "plant" request left behind in module state, for "peek" to show (the fixture's own state, not a parser's). */
let planted = "";

function commandOf(source: unknown): { command: string; arg: string } {
  const text = source instanceof Uint8Array ? new TextDecoder().decode(source) : "";
  const colon = text.indexOf(":");
  return colon === -1 ? { command: text, arg: "" } : { command: text.slice(0, colon), arg: text.slice(colon + 1) };
}

function burn(ms: number): void {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) x = (x + Math.sqrt(x + 1)) % 1e9;
  if (x < 0) throw new Error("unreachable");
}

interface Answer {
  readonly text: string;
  readonly metadata?: Record<string, string>;
  readonly exception?: Error;
}

async function behave(source: unknown, options: unknown): Promise<Answer> {
  parsed += 1;
  const { command, arg } = commandOf(source);
  switch (command) {
    case "ok":
      return { text: "ok" };
    case "options":
      return { text: JSON.stringify(options) };
    case "big":
      return { text: "x".repeat(Number(arg)) };
    case "slow":
      await new Promise((resolve) => setTimeout(resolve, Number(arg)));
      return { text: "slow-ok" };
    case "burn":
      burn(Number(arg));
      return { text: "burnt" };
    case "throw":
      throw new MalformedDocumentError("bad document");
    case "exception":
      return { text: "partial", exception: new MalformedDocumentError("an embedded part failed") };
    case "tk-key":
      return { text: "partial", metadata: { "tk:exception:embedded-exception": "boom" } };
    case "uncaught":
      // A crash outside the request's chain: runChildMain sends a "crash" error frame, then exits 1.
      setTimeout(() => {
        throw new TypeError("parser timer failure");
      }, 5);
      return new Promise<Answer>(() => {});
    case "segv":
      process.kill(process.pid, "SIGSEGV");
      return new Promise<Answer>(() => {});
    case "hang-sync":
      for (;;) {
        // never yields
      }
    case "hang-async":
      return new Promise<Answer>(() => {});
    case "oom": {
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array<number>(100_000).fill(Math.random()));
    }
    case "spill":
      // Left behind in TMPDIR (the parent's call directory): the parent must retire this child.
      writeFileSync(join(tmpdir(), `spill-${process.pid}.bin`), "document bytes");
      return { text: "spilled" };
    case "spill-clean": {
      const file = join(tmpdir(), `spill-${process.pid}.bin`);
      writeFileSync(file, "document bytes");
      unlinkSync(file);
      return { text: "cleaned" };
    }
    case "retain":
      retained.push(Buffer.alloc(Number(arg) * 1024 * 1024, 1));
      return { text: "retained" };
    case "stderr":
      process.stderr.write("e".repeat(Number(arg)));
      return { text: "noisy" };
    case "late":
      // A frame after the answer: nobody asked for it.
      setTimeout(() => sendFrame({ t: "text", chunk: "late" }), 20);
      return { text: "answered" };
    case "exit-later":
      setTimeout(() => process.exit(0), 50);
      return { text: "leaving" };
    case "plant":
      planted = arg;
      return { text: "planted" };
    case "peek":
      return { text: `planted=${planted}` };
    default:
      throw new Error(`unknown fixture command ${JSON.stringify(command)}`);
  }
}

function metadataFor(answer: Answer): Metadata {
  const metadata = new Metadata();
  metadata.set("Content-Type", "text/plain");
  metadata.set("pid", String(process.pid));
  metadata.set("parsed", String(parsed));
  for (const [key, value] of Object.entries(answer.metadata ?? {})) metadata.set(key, value);
  return metadata;
}

const ripstream: ChildRipstream = {
  parse: async (source, options) => {
    const answer = await behave(source, options);
    return { metadata: metadataFor(answer), text: answer.text, ...(answer.exception === undefined ? {} : { exception: answer.exception }) };
  },
  parseRecursive: async (source, options) => {
    const answer = await behave(source, options);
    const record = (depth: number, content: string): ParseRecord => ({
      metadata: metadataFor(answer),
      content,
      embeddedResourcePath: depth === 0 ? "/doc" : `/doc/part-${depth}`,
      depth,
      mediaType: MediaType.TEXT_PLAIN,
      exception: null,
    });
    return [record(0, answer.text), record(1, "inner")];
  },
};

await runChildMain({ ripstream });
