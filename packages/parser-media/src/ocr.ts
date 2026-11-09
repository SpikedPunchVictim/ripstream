import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  MissingDependencyError,
  ParseTimeoutError,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

const DEFAULT_TIMEOUT_MS = 60_000;
/** Longest delay setTimeout honors; larger values fire immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export interface TesseractOcrOptions {
  /** Executable to spawn. Defaults to "tesseract". */
  readonly command?: string;
  /** Wall-clock budget for one tesseract run, in milliseconds. Defaults to 60000. */
  readonly timeoutMs?: number;
}

/** Optional Tesseract CLI OCR integration; not registered by default. */
export class TesseractOcrParser implements Parser {
  readonly name = "TesseractOCRParser";
  readonly capabilities = { unsafe: true } as const;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: TesseractOcrOptions = {}) {
    const { command = "tesseract", timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    if (typeof command !== "string" || command.length === 0) {
      throw new RangeError("command must be a non-empty string");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`timeoutMs must be a positive safe integer, got ${timeoutMs}`);
    }
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["image/png", "image/jpeg", "image/tiff", "image/bmp", "image/webp"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const directory = await mkdtemp(join(tmpdir(), "ripstream-ocr-"));
    const path = join(directory, "input.png");
    try {
      await writeFile(path, data);
      const text = await runTesseract(this.command, path, this.timeoutMs, ctx);
      metadata.set("ocr:engine", "tesseract");
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) await xhtml.element("p", line);
      }
      await xhtml.endDocument();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/**
 * Runs tesseract on `path` and resolves with its stdout. Kills the process
 * and rejects on abort, timeout, or output over the cap.
 */
function runTesseract(
  command: string,
  path: string,
  timeoutMs: number,
  ctx: ParseContext,
): Promise<string> {
  return new Promise((resolve, reject) => {
    ctx.throwIfAborted(); // rejects before spawning
    const child = spawn(command, [path, "stdout"], {
      // Not detached: tesseract stays in the caller's process group, so an isolation
      // supervisor that kills the group takes it along.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    };
    const fail = (error: unknown): void =>
      settle(() => {
        child.kill("SIGKILL");
        reject(error);
      });
    const onAbort = (): void => {
      try {
        ctx.throwIfAborted();
      } catch (error) {
        fail(error);
      }
    };
    const timer = setTimeout(
      () => fail(new ParseTimeoutError(`Tesseract OCR timed out after ${timeoutMs} ms`)),
      Math.min(timeoutMs, MAX_TIMER_MS),
    );
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new LimitExceededError(`Tesseract output exceeded ${MAX_STDOUT_BYTES} bytes`));
      } else {
        stdout.push(chunk);
      }
    });
    // Keep draining stderr past the cap so the child never blocks on a full pipe.
    child.stderr.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, MAX_STDERR_BYTES - stderrBytes));
      stderrBytes += kept.length;
      if (kept.length > 0) stderr.push(kept);
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      fail(
        cause.code === "ENOENT"
          ? new MissingDependencyError("tesseract", "Tesseract OCR")
          : cause,
      );
    });
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8"));
        } else {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          reject(new MalformedDocumentError(`Tesseract failed: ${detail}`));
        }
      });
    });
  });
}
