import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The real parse worker entry, with the URL of every module the thread loads appended to POOL_TEST_LOADED_LOG: for the
 * test that a worker never loads the canvas pdf.js asks for.
 */

const log = process.env["POOL_TEST_LOADED_LOG"];
if (log === undefined) throw new Error("load-probe needs POOL_TEST_LOADED_LOG");
registerHooks({
  load(url, context, nextLoad) {
    appendFileSync(log, `${url}\n`);
    return nextLoad(url, context);
  },
});
await import("../../src/parse-worker.ts");
