import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/**
 * A scripted stand-in for the spawned child, for the `spawnFn` seam: the test
 * decides exactly when 'exit', frames and 'close' happen, which real processes
 * cannot do deterministically (the exit-versus-pipe-data ordering is a race in
 * the kernel and in libuv).
 */

/** Above Linux's pid_max (2^22) and macOS's 99999: kill(-pid) is always ESRCH, so the supervisor's group kills are harmless. */
export const NO_SUCH_PID = 4_194_305;

export interface FakeChild extends EventEmitter {
  pid: number;
  /** What the supervisor passed to spawn(). */
  spawnOptions: SpawnOptions;
  /** Everything written to the child's stdin. */
  stdinWrites: Uint8Array[];
  /** Emit the leader's 'exit'. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Write to the child's fd 3 / stderr. */
  writeFd3(data: string | Uint8Array): void;
  writeStderr(data: string | Uint8Array): void;
  /** End the fd-3 pipe and emit 'close', as Node does once the stdio streams have ended. */
  close(): void;
  /** True once the supervisor destroyed (or ended) that pipe. */
  fd3Destroyed(): boolean;
  stderrDestroyed(): boolean;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface FakeChildOptions {
  /** Send the ready frame on its own (default true). */
  readonly autoReady?: boolean;
  /** Called once the supervisor has written and ended stdin (i.e. after ready was accepted). */
  readonly onInput?: (child: FakeChild) => void;
  /** Called right after the child exists, before anything is emitted. */
  readonly onSpawn?: (child: FakeChild) => void;
}

export function fakeSpawn(options: FakeChildOptions = {}): { spawnFn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: SpawnFn = (_file, _args, spawnOptions) => {
    const emitter = new EventEmitter();
    const fd3 = new PassThrough();
    const stderr = new PassThrough();
    const stdinWrites: Uint8Array[] = [];
    const child = emitter as FakeChild;
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdinWrites.push(chunk);
        callback();
      },
      final(callback) {
        callback();
        setImmediate(() => options.onInput?.(child));
      },
    });
    Object.assign(child, {
      pid: NO_SUCH_PID,
      spawnOptions,
      stdinWrites,
      stdin,
      stderr,
      stdio: [stdin, null, stderr, fd3],
      unref: () => {},
      exit: (code: number | null, signal: NodeJS.Signals | null = null) => child.emit("exit", code, signal),
      writeFd3: (data: string | Uint8Array) => {
        fd3.write(data);
      },
      writeStderr: (data: string | Uint8Array) => {
        stderr.write(data);
      },
      close: () => {
        fd3.end();
        child.emit("close", null, null);
      },
      fd3Destroyed: () => fd3.destroyed,
      stderrDestroyed: () => stderr.destroyed,
    });
    children.push(child);
    options.onSpawn?.(child);
    if (options.autoReady !== false) setImmediate(() => child.writeFd3('{"t":"ready","pid":1}\n'));
    return child as unknown as ChildProcess;
  };
  return { spawnFn, children };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export { delay };
