import { parentPort, workerData } from "node:worker_threads";
import type { ParseOptions, ParseRecord, ParseResult } from "@spikedpunch/ripstream-core";
import {
  encodeError,
  encodeParseResult,
  encodeRecords,
  type ParentMessage,
  type TaskMessage,
  type WorkerData,
  type WorkerMessage,
  type WorkerRipstreamSpec,
} from "./parse-worker-codec.ts";

/** What a worker parses with. */
export interface WorkerRipstream {
  parse(source: Uint8Array | { readonly path: string }, options: ParseOptions): Promise<ParseResult>;
  parseRecursive(source: Uint8Array | { readonly path: string }, options: ParseOptions): Promise<readonly ParseRecord[]>;
}

/**
 * The body of a parse worker: builds a ripstream from the spec it was started with, says it is ready (or why it could
 * not build one), and then parses each task the pool sends, one at a time. A task is aborted when the pool says so.
 */
export async function serveParses(build: (spec: WorkerRipstreamSpec) => WorkerRipstream | Promise<WorkerRipstream>): Promise<void> {
  const port = parentPort;
  if (port === null) throw new Error("serveParses runs in a worker thread started by the parse pool");
  const post = (message: WorkerMessage, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

  let ripstream: WorkerRipstream;
  try {
    ripstream = await build((workerData as WorkerData).spec);
  } catch (error) {
    // Nothing is listening on the port, so the thread ends once this is sent.
    post({ t: "init-error", error: encodeError(error) });
    return;
  }

  const running = new Map<number, AbortController>();
  port.on("message", (message: ParentMessage) => {
    if (message.t === "abort") {
      running.get(message.id)?.abort();
      return;
    }
    const controller = new AbortController();
    running.set(message.id, controller);
    void runTask(ripstream, message, controller.signal, post).finally(() => running.delete(message.id));
  });
  post({ t: "ready" });
}

async function runTask(
  ripstream: WorkerRipstream,
  task: TaskMessage,
  signal: AbortSignal,
  post: (message: WorkerMessage, transfer?: ArrayBuffer[]) => void,
): Promise<void> {
  const options: ParseOptions = { ...task.options, signal };
  let message: WorkerMessage;
  let transfer: ArrayBuffer[] = [];
  try {
    if (task.op === "parse") {
      message = { t: "done", id: task.id, op: "parse", result: encodeParseResult(await ripstream.parse(task.input, options)) };
    } else {
      const encoded = encodeRecords(await ripstream.parseRecursive(task.input, options));
      message = { t: "done", id: task.id, op: "parseRecursive", records: encoded.records };
      transfer = encoded.transfer;
    }
  } catch (error) {
    message = { t: "failed", id: task.id, error: encodeError(error) };
  }
  try {
    post(message, transfer);
  } catch (error) {
    // A value structured clone cannot copy (a field added to a record that is not plain data): the task fails with why.
    post({ t: "failed", id: task.id, error: encodeError(error) });
  }
}
