import { Metadata } from "@spikedpunch/ripstream-core";
import { runChildMain, type ChildRipstream } from "@spikedpunch/ripstream-isolation-node";

/**
 * Child entry for the server's hostile end-to-end test: the REAL runChildMain around a scripted pipeline that
 * behaves by the request's filename. The server never sees any of this, only the child's verdict.
 *
 *   ok.txt     parses fine
 *   oom.bin    allocates until the heap is exhausted
 *   hang.bin   never settles
 *   abort.bin  aborts the process
 */
async function behave(filename: string): Promise<string> {
  switch (filename) {
    case "ok.txt":
      return "fine";
    case "oom.bin": {
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array<number>(100_000).fill(Math.random()));
    }
    case "hang.bin":
      return new Promise<string>(() => {});
    case "abort.bin":
      return process.abort();
    default:
      throw new Error(`unknown fixture file ${filename}`);
  }
}

const ripstream: ChildRipstream = {
  async parse(_source, options) {
    const text = await behave(options?.filename ?? "");
    const metadata = new Metadata();
    metadata.set("Content-Type", "text/plain");
    return { metadata, text };
  },
  async parseRecursive() {
    throw new Error("the hostile fixture only answers text requests");
  },
};

await runChildMain({ ripstream });
