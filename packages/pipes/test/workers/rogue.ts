import { parentPort, threadId } from "node:worker_threads";
import type { TaskMessage } from "../../src/parse-worker-codec.ts";

// A worker that does not keep to the protocol, as the filename says; any other filename is answered properly.
const port = parentPort!;
port.on("message", (task: TaskMessage) => {
  const result = { metadata: [["thread", [String(threadId)]]], text: "" };
  switch (task.options.filename) {
    case "wrong-id":
      port.postMessage({ t: "done", id: task.id + 1000, op: "parse", result });
      return;
    case "garbage":
      port.postMessage("garbage");
      return;
    case "bad-media":
      port.postMessage({
        t: "done",
        id: task.id,
        op: "parseRecursive",
        records: [{ metadata: [], content: "", embeddedResourcePath: "/", depth: 0, mediaType: { type: 5 }, exception: null }],
      });
      return;
    default:
      port.postMessage({ t: "done", id: task.id, op: task.op, result });
  }
});
port.postMessage({ t: "ready" });
