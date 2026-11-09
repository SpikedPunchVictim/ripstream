import { getHeapStatistics } from "node:v8";
import { initChildProcess, readInput, sendFrame } from "../../src/child-io.ts";

/**
 * Test child that reports what it was really given: the input header exactly as the parent sent it, and the node
 * flags it was started with. Answers in the arm the header asks for. argv[2] "hang" makes it stall after reading.
 */
initChildProcess();
sendFrame({ t: "ready", pid: process.pid });
const { header, bytes } = await readInput();
if (process.argv[2] === "hang") setInterval(() => {}, 1000);

const report = JSON.stringify({
  header,
  execArgv: process.execArgv,
  bytes: bytes.length,
  heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)),
});
if (header.output === "records") {
  sendFrame({
    t: "record",
    record: { metadata: {}, content: report, embeddedResourcePath: "/report", depth: 0, mediaType: "application/json", exception: null },
  });
} else {
  sendFrame({ t: "meta", metadata: {} });
  sendFrame({ t: "text", chunk: report });
}
sendFrame({ t: "done" });
