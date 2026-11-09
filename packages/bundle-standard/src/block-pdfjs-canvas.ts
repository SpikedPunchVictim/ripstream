import { registerHooks } from "node:module";

/**
 * pdf.js loads the native `@napi-rs/canvas` the moment it is imported (to polyfill DOMMatrix, ImageData and Path2D
 * for rendering). The parser never renders, so in an isolation child the load buys nothing and costs a lot: about
 * 1.2 GiB of address space plus 65 MiB per visible core, which on a 6 GiB `ulimit -v` left V8 too little and made
 * PDFs fail "out of memory" at 200 MiB of RSS (arm64, native CI runner). It is also native image code that would run
 * on untrusted bytes.
 *
 * Text and metadata extraction do not touch the canvas; pdf.js only warns that rendering may be broken, and the
 * child's stdout is discarded. The block is scoped to requests made FROM pdfjs-dist, so a canvas the application
 * itself loads is left alone, and it can be taken off again.
 */
const PDFJS_CANVAS = "@napi-rs/canvas";

/** True for pdf.js asking for the canvas: the parent URL is a file inside a `pdfjs-dist` package directory. */
export function isPdfjsCanvasRequest(specifier: string, parentURL: string | undefined): boolean {
  return specifier === PDFJS_CANVAS && parentURL !== undefined && parentURL.includes("/pdfjs-dist/");
}

export interface CanvasBlock {
  /** Lets pdf.js load the canvas again (for requests made after this call). */
  deregister(): void;
}

/** Makes `@napi-rs/canvas` unresolvable for pdfjs-dist in this process. Call before pdf.js is first imported. */
export function blockPdfjsCanvas(): CanvasBlock {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isPdfjsCanvasRequest(specifier, context.parentURL)) {
        throw Object.assign(new Error(`Cannot find module '${specifier}' (blocked for pdfjs-dist in an isolation child)`), {
          code: "MODULE_NOT_FOUND",
        });
      }
      return nextResolve(specifier, context);
    },
  });
}
