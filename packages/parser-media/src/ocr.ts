import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MalformedDocumentError,
  MediaType,
  MissingDependencyError,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** Optional Tesseract CLI OCR integration; not registered by default. */
export class TesseractOcrParser implements Parser {
  readonly name = "TesseractOCRParser";
  readonly capabilities = { unsafe: true } as const;

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
    _ctx: ParseContext,
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
      const text = await runTesseract(path);
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

function runTesseract(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", [path, "stdout"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (error += chunk));
    child.on("error", (cause) => {
      reject(new MissingDependencyError("tesseract", "Tesseract OCR"));
      void cause;
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new MalformedDocumentError(`Tesseract failed: ${error.trim()}`));
    });
  });
}
