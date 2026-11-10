/*
 * The run that test/resume.test.ts kills. Not a test: it runs a pipe over a directory with a checkpoint, and at the
 * chosen input it stops, so the parent can kill it at a point it knows.
 *
 *   node resume-child.ts <input dir> <output dir> <checkpoint file> <hang-at> <where> <onExists>
 *
 * where is "emit" (the emitter never answers for the input at `hang-at`, so nothing of it is written) or "report" (the
 * reporter never answers for it, so it is emitted but not recorded). It prints HANG when it is waiting.
 */
import { CheckpointStore, FileSystemEmitter, PipesEngine, type EmittedDocument, type Emitter } from "../src/index.ts";
import { fileSystem } from "./helpers.ts";

const [input, output, checkpointPath, hangAt, where, onExists] = process.argv.slice(2) as [string, string, string, string, "emit" | "report", "EXCEPTION" | "SKIP" | "REPLACE"];
const stuck = (): Promise<never> => {
  console.log("HANG");
  // A promise that never settles does not keep the process alive: without a timer the event loop empties and node
  // ends the run by itself (exit code 13) before the parent's kill arrives.
  setInterval(() => undefined, 60_000);
  return new Promise<never>(() => undefined);
};

const files = new FileSystemEmitter({ basePath: output, fileExtension: "txt", onExists });
const emitter: Emitter = {
  async emit(document: EmittedDocument) {
    if (where === "emit" && document.id === hangAt) await stuck();
    await files.emit(document);
  },
};

await new PipesEngine({
  ...fileSystem(input),
  emitter,
  mode: "CONTENT_ONLY",
  concurrency: 1,
  checkpoint: await CheckpointStore.open(checkpointPath),
  reporter: {
    async report(result) {
      if (where === "report" && result.id === hangAt) await stuck();
    },
  },
}).run();
console.log("DONE");
