// Run by permission.test.ts under the permission flags: what each attempt did, as JSON.
import cp from "node:child_process";
import fs from "node:fs";
import { Worker } from "node:worker_threads";

const [callDir, outside] = process.argv.slice(2);
const attempt = (f) => {
  try {
    f();
    return "allowed";
  } catch (e) {
    return e.code ?? e.name;
  }
};
console.log(
  JSON.stringify({
    writeCallDir: attempt(() => fs.writeFileSync(`${callDir}/ok.txt`, "x")),
    writeOutside: attempt(() => fs.writeFileSync(outside, "x")),
    readOutside: attempt(() => fs.readFileSync(outside)),
    spawn: attempt(() => cp.execFileSync("echo", ["hi"])),
    worker: attempt(() => new Worker("1", { eval: true })),
  }),
);
