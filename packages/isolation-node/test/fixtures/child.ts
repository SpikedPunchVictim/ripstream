import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { initChildProcess, readInput, sendFrame } from "../../src/child-io.ts";

/**
 * Test child for the supervisor and runner tests. argv[2] selects the
 * behaviour; everything speaks the real child protocol through child-io.ts.
 */
const mode = process.argv[2];
// Every real child entry starts with this. The one fixture that does not is the raw case that shows what happens
// to a child that skips it (stderr-spam-unhandled).
if (mode !== "stderr-spam-unhandled") {
  initChildProcess(process.argv[5] === undefined ? {} : { stderrBudgetBytes: Number(process.argv[5]) });
}
const ready = (): void => sendFrame({ t: "ready", pid: process.pid });
const hangForever = (): void => {
  setInterval(() => {}, 1000);
};
/** A grandchild in our process group that inherits stdout, stderr and fd 3 (it holds the pipes open). */
const spawnGrandchild = (): number => {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit", 3],
  });
  return grandchild.pid ?? -1;
};

switch (mode) {
  case "echo": {
    ready();
    const { header, bytes } = await readInput();
    sendFrame({ t: "meta", metadata: { filename: [header.filename ?? ""], path: [header.path ?? ""], output: [header.output] } });
    sendFrame({ t: "text", chunk: Buffer.from(bytes).toString("utf8") });
    sendFrame({ t: "done" });
    break;
  }
  case "records": {
    ready();
    await readInput();
    const record = (depth: number, content: string) => ({
      metadata: { depth: [String(depth)] },
      content,
      embeddedResourcePath: depth === 0 ? "" : "/embedded-1",
      depth,
      mediaType: "text/plain",
      exception: null,
    });
    sendFrame({ t: "record", record: record(0, "outer") });
    sendFrame({ t: "record", record: record(1, "inner") });
    sendFrame({ t: "done" });
    break;
  }
  case "never-ready":
    hangForever();
    break;
  case "read-before-ready": {
    // Only proceeds if the parent wrote to stdin BEFORE ready, which it must never do.
    await readInput();
    ready();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "done" });
    break;
  }
  case "hang":
    ready();
    await readInput();
    hangForever();
    break;
  case "giant-frame": {
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: "x".repeat(1024 * 1024) });
    sendFrame({ t: "done" });
    break;
  }
  case "result-cap": {
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    for (let i = 0; i < 100; i++) sendFrame({ t: "text", chunk: "y".repeat(2000) });
    sendFrame({ t: "done" });
    break;
  }
  case "exit-without-terminal":
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    process.stderr.write("boom-marker: something broke\n");
    process.exit(0);
    break;
  case "oom-long-dump": {
    // V8's fatal-error line comes first, then a native stack dump far longer than the parent's stderr tail
    // window (macOS dumps ~50 frames of long lines): the marker is no longer in the tail when the child dies.
    ready();
    await readInput();
    const frames = Array.from({ length: 200 }, (_, i) => `      ${i}: 0x1066ac998 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace) [/lib/libnode.dylib]\n`);
    process.stderr.write(`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n----- Native stack trace -----\n${frames.join("")}`, () => {
      process.kill(process.pid, "SIGABRT");
    });
    await new Promise(() => {});
    break;
  }
  case "error-frame-malformed":
  case "error-frame-limit": {
    ready();
    await readInput();
    sendFrame({ t: "error", kind: mode === "error-frame-malformed" ? "malformed" : "limit", message: "child says no" });
    break;
  }
  case "protocol-violation":
    ready();
    await readInput();
    sendFrame({ t: "bogus" });
    hangForever();
    break;
  case "done-linger": {
    // done, then stay alive with a grandchild holding the pipes.
    ready();
    await readInput();
    const gc = spawnGrandchild();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: String(gc) });
    sendFrame({ t: "done" });
    hangForever();
    break;
  }
  case "done-exit-grandchild": {
    // done and exit at once, leaving a grandchild that holds stdout/stderr/fd 3 open.
    ready();
    await readInput();
    const gc = spawnGrandchild();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: String(gc) });
    sendFrame({ t: "done" });
    process.exit(0);
    break;
  }
  case "meta-flood": {
    // One meta frame (~2 MB, under the text frame cap) with more keys than the metadata bound allows.
    ready();
    await readInput();
    const metadata: Record<string, string[]> = {};
    for (let i = 0; i < 250_000; i++) metadata[`k${i}`] = [];
    sendFrame({ t: "meta", metadata });
    hangForever();
    break;
  }
  case "second-meta":
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "meta", metadata: {} });
    hangForever();
    break;
  case "record-in-text":
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({
      t: "record",
      record: { metadata: {}, content: "", embeddedResourcePath: "", depth: 0, mediaType: "text/plain", exception: null },
    });
    hangForever();
    break;
  case "text-in-records":
    ready();
    await readInput();
    sendFrame({ t: "text", chunk: "x" });
    hangForever();
    break;
  case "text-flood": {
    // Tiny frames, far more than the frame-count bound the test sets.
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    for (let i = 0; i < 5000; i++) sendFrame({ t: "text", chunk: "x" });
    hangForever();
    break;
  }
  case "trickle": {
    // A partial line written one byte per write (no newline): the parent must accumulate it in O(bytes).
    ready();
    await readInput();
    const one = Buffer.from("a");
    for (let i = 0; i < 200_000; i++) writeSync(3, one);
    hangForever();
    break;
  }
  case "done-then-late": {
    // Result, done, and then junk, all in ONE write: whatever follows the terminal frame must not undo the result.
    ready();
    await readInput();
    const records = process.argv[3] === "records";
    writeSync(
      3,
      records
        ? '{"t":"record","record":{"metadata":{},"content":"IMPORTANT","embeddedResourcePath":"","depth":0,"mediaType":"x","exception":null}}\n{"t":"done"}\nnot json\n'
        : '{"t":"meta","metadata":{"a":["b"]}}\n{"t":"text","chunk":"IMPORTANT CONTENT"}\n{"t":"done"}\n{"t":"text","chunk":"late"}\n',
    );
    process.exit(0);
    break;
  }
  case "stderr-spam": {
    // Floods stderr with writeSync (argv[3] bytes per write, argv[4] bytes in all), swallowing EPIPE, then answers normally.
    // The result metadata says how many writes met a closed pipe: that is what the parent's stderr budget causes.
    ready();
    await readInput();
    const chunk = Buffer.alloc(Number(process.argv[3] ?? 1024), "e");
    const total = Number(process.argv[4] ?? 4 * 1024 * 1024);
    let epipe = 0;
    for (let sent = 0; sent < total; sent += chunk.length) {
      try {
        writeSync(2, chunk);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // macOS reports ENOTCONN, not EPIPE, for the first write after the peer's close.
        if (code === "EPIPE" || code === "ENOTCONN") epipe++;
        else if (code !== "EAGAIN") throw error;
      }
    }
    sendFrame({ t: "meta", metadata: { epipe: [String(epipe)] } });
    sendFrame({ t: "text", chunk: "after-spam" });
    sendFrame({ t: "done" });
    break;
  }
  case "warn-flood": {
    // A chatty but legitimate child: a flood of JS-level warnings (argv[4] bytes, default 1.2 MB, over the parent's
    // stderr budget if nothing limited it), a pause long enough for any EPIPE to surface, then argv[3]:
    //   success -> a normal result; oom -> blows the heap; strlen -> blows the string length limit.
    ready();
    await readInput();
    const total = Number(process.argv[4] ?? 1_200_000);
    const warning = "warning: odd glyph table entry\n";
    for (let sent = 0; sent < total; sent += warning.length) process.stderr.write(warning);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const then = process.argv[3] ?? "success";
    if (then === "oom") {
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array<number>(100_000).fill(Math.random()));
    } else if (then === "strlen") {
      let text = "x";
      for (;;) text += text;
    }
    process.stderr.write("one more warning\n");
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: "after-warnings" });
    sendFrame({ t: "done" });
    break;
  }
  case "stderr-spam-unhandled": {
    // The same flood through process.stderr WITHOUT initChildProcess() and its 'error' listener: the EPIPE becomes an uncaught exception.
    ready();
    await readInput();
    const chunk = "e".repeat(1024);
    for (let i = 0; i < 4096; i++) process.stderr.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 200));
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: "survived" });
    sendFrame({ t: "done" });
    break;
  }
  case "env": {
    // Reports the environment the child really received.
    ready();
    await readInput();
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: JSON.stringify(process.env) });
    sendFrame({ t: "done" });
    break;
  }
  case "stdout-noise": {
    // Writes a marker to stdout three ways. The parent's stdout must never see it.
    ready();
    await readInput();
    console.log("CHILD-STDOUT-MARKER console.log");
    process.stdout.write("CHILD-STDOUT-MARKER process.stdout\n");
    try {
      writeSync(1, "CHILD-STDOUT-MARKER writeSync\n");
    } catch {
      // fd 1 may be closed or /dev/null: either way nothing may reach the parent
    }
    sendFrame({ t: "meta", metadata: {} });
    sendFrame({ t: "text", chunk: "quiet" });
    sendFrame({ t: "done" });
    break;
  }
  case "early-death":
    // ready, then die without ever reading stdin: the parent's write meets a closed pipe.
    ready();
    process.exit(3);
    break;
  case "rss": {
    ready();
    await readInput();
    const keep: Buffer[] = [];
    // ~20 MB every 20 ms up to 800 MB: crosses a 150 MB limit well inside the test budget even with a slow poll.
    const timer = setInterval(() => {
      keep.push(Buffer.alloc(20 * 1024 * 1024, 1));
      if (keep.length >= 40) clearInterval(timer);
    }, 20);
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`unknown test child mode: ${String(mode)}\n`);
    process.exit(2);
}
