// Q5: can the work unit cross a process, queue or HTTP boundary? (throwaway spike, tikajs-68os.6.2; `node wire.mjs`)
import { fork } from "node:child_process";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const closure = { id: "a.docx", open: async () => new Uint8Array([1]) };
const tuple = { id: "a.docx", fetcher: "fs", fetchKey: "a.docx", emitter: "out", emitKey: "a.docx", onParseException: "EMIT" };

const tryIt = (label, fn) => {
  try { console.log(label.padEnd(34), fn()); } catch (e) { console.log(label.padEnd(34), `THROWS ${e.name}: ${e.message.split("\n")[0]}`); }
};
for (const [name, item] of [["closure item", closure], ["tuple", tuple]]) {
  tryIt(`${name}: JSON (HTTP body, queue)`, () => JSON.stringify(item));
  tryIt(`${name}: structuredClone (worker)`, () => JSON.stringify(Object.keys(structuredClone(item))));
}
if (process.argv[2] === "child") {
  process.on("message", (m) => { process.send(Object.keys(m)); process.exit(0); });
} else {
  for (const [name, item] of [["closure item", closure], ["tuple", tuple]]) {
    await new Promise((resolve) => {
      const child = fork(fileURLToPath(import.meta.url), ["child"]);
      child.on("message", (keys) => { console.log(`${name}: child_process IPC`.padEnd(34), JSON.stringify(keys)); resolve(); });
      child.send(item);
    });
  }
}
