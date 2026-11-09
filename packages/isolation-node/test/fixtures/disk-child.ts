import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomFillSync } from "node:crypto";
import { initChildProcess, readInput, sendFrame } from "../../src/child-io.ts";

/**
 * Test child for the disk tests (L6). It talks the real child protocol like fixtures/child.ts, and every mode works
 * in process.env.TMPDIR, the private directory the supervisor made for the call. argv[2] selects the behaviour:
 *
 *   tmpdir-report            answers with what the child sees: its TMPDIR, os.tmpdir(), cwd and the directory's mode
 *   spool <mb> <then>        writes <mb> MiB of incompressible data plus a nested file, then <then>:
 *                            done | error | crash | hang
 *   sparse <gib> <ms>        a hole of <gib> GiB (allocates nothing), then <ms> of waiting so the poll can look, then done
 *   many-files <n>           <n> empty files in the directory, then hangs
 */
initChildProcess({});
const mode = process.argv[2];
const tmp = process.env.TMPDIR ?? "";
const ready = (): void => sendFrame({ t: "ready", pid: process.pid });
const hangForever = (): void => {
  setInterval(() => {}, 1000);
};
const reply = (metadata: Record<string, string[]>, text: string): void => {
  sendFrame({ t: "meta", metadata });
  sendFrame({ t: "text", chunk: text });
  sendFrame({ t: "done" });
};

switch (mode) {
  case "tmpdir-report": {
    ready();
    await readInput();
    writeFileSync(join(tmp, "probe.txt"), "writable");
    const report = {
      tmpdir: tmp,
      osTmpdir: tmpdir(),
      cwd: process.cwd(),
      mode: statSync(tmp).mode & 0o777,
      files: readdirSync(tmp),
    };
    reply({}, JSON.stringify(report));
    break;
  }
  case "spool": {
    ready();
    await readInput();
    const mb = Number(process.argv[3] ?? 1);
    const then = process.argv[4] ?? "done";
    const chunk = randomFillSync(Buffer.alloc(1024 * 1024));
    const fd = openSync(join(tmp, "spool.bin"), "w");
    for (let i = 0; i < mb; i++) writeSync(fd, chunk);
    closeSync(fd);
    mkdirSync(join(tmp, "nested", "deep"), { recursive: true });
    writeFileSync(join(tmp, "nested", "deep", "x.txt"), "x");
    if (then === "done") reply({ files: readdirSync(tmp) }, "spooled");
    else if (then === "error") sendFrame({ t: "error", kind: "malformed", message: "child says no" });
    else if (then === "crash") process.exit(7);
    else hangForever();
    break;
  }
  case "sparse": {
    ready();
    await readInput();
    const gib = Number(process.argv[3] ?? 1);
    const waitMs = Number(process.argv[4] ?? 300);
    const fd = openSync(join(tmp, "hole.bin"), "w");
    ftruncateSync(fd, gib * 1024 ** 3);
    const stats = fstatSync(fd);
    closeSync(fd);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    // What the filesystem really allocated for the hole; the test skips itself if that is not (almost) nothing.
    reply({ size: [String(stats.size)], allocated: [String(stats.blocks * 512)] }, "sparse");
    break;
  }
  case "many-files": {
    ready();
    await readInput();
    const n = Number(process.argv[3] ?? 10_001);
    for (let i = 0; i < n; i++) writeFileSync(join(tmp, `f${i}`), "");
    hangForever();
    break;
  }
  default:
    process.stderr.write(`unknown disk test child mode: ${String(mode)}\n`);
    process.exit(2);
}
