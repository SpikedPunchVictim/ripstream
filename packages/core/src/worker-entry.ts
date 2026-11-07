import { parentPort, workerData } from "node:worker_threads";

interface Job {
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly payload: unknown;
}

const port = parentPort;
const job = workerData as Job;

if (port !== null) {
  void (async () => {
    try {
      const module = (await import(job.moduleUrl)) as Record<string, unknown>;
      const handler = module[job.exportName];
      if (typeof handler !== "function") {
        throw new Error(`Worker export ${job.exportName} is not a function`);
      }
      const result = await (handler as (payload: unknown) => unknown)(job.payload);
      port.postMessage({ ok: true, result });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    } finally {
      port.close();
    }
  })();
}
