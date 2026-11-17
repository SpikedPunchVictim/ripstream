import { parentPort } from "node:worker_threads";
import { createRipstream, type ParseLimits } from "../../../src/index.ts";

/**
 * A Worker that hosts a standard Ripstream, the shape docs/worker-hosting.md describes: build it once, parse what the
 * parent posts with the limits the parent names (every limit is settable in a Worker), and post the answer or the typed
 * failure as plain data. `oom` and `spin` provoke the two ways a Worker dies under a document, for the tests of the
 * parent's mapping.
 */
type Task =
  | { readonly id: number; readonly op: "parse"; readonly bytes: Uint8Array; readonly limits?: Partial<ParseLimits> }
  | { readonly id: number; readonly op: "oom" }
  | { readonly id: number; readonly op: "spin" };

const port = parentPort;
if (port === null) throw new Error("worker-host runs in a worker thread");
const ripstream = createRipstream();

function plain(error: unknown): Record<string, unknown> {
  const e = error as { name?: string; message?: string; code?: string; limit?: string; observed?: number; max?: number };
  return { name: e.name, message: e.message, code: e.code, limit: e.limit, observed: e.observed, max: e.max };
}

port.on("message", async (task: Task) => {
  if (task.op === "oom") {
    const hold: number[][] = [];
    for (;;) hold.push(new Array<number>(1_000_000).fill(1));
  }
  if (task.op === "spin") {
    port.postMessage({ id: task.id, spinning: true });
    for (;;); // eslint-disable-line no-empty
  }
  try {
    const result = await ripstream.parse(task.bytes, task.limits === undefined ? {} : { limits: task.limits });
    port.postMessage({ id: task.id, ok: true, text: result.text });
  } catch (error) {
    port.postMessage({ id: task.id, ok: false, error: plain(error) });
  }
});
port.postMessage({ ready: true });
