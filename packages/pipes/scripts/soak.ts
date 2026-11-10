import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemFetcher, FileSystemPipesIterator, MemoryEmitter, PipesEngine } from "../src/index.ts";

const seconds = Number(process.argv[2] ?? "60");
const directory = mkdtempSync(join(tmpdir(), "ripstream-soak-"));
for (let index = 0; index < 50; index++) {
  writeFileSync(join(directory, `f${index}.txt`), `soak text ${index}`.repeat(20));
}
const started = Date.now();
const engine = new PipesEngine({
  iterator: new FileSystemPipesIterator({ basePath: directory, fetcherId: "fs" }),
  fetchers: { fs: new FileSystemFetcher({ basePath: directory }) },
  emitter: new MemoryEmitter(),
  mode: "CONTENT_ONLY",
  concurrency: 4,
});
let runs = 0;
try {
  while (Date.now() - started < seconds * 1000) {
    await engine.run();
    runs++;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ seconds, runs, stats: engine.stats }));
