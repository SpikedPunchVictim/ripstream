import { registerHooks } from "node:module";

/**
 * pdf.js loads the native `@napi-rs/canvas` when it is imported, to polyfill DOMMatrix, ImageData and Path2D for
 * rendering. The parser never renders: text and metadata extraction do not touch the canvas, and pdf.js only warns that
 * rendering may be broken. The load costs about 1.2 GiB of address space plus roughly 65 MiB per visible core, and it
 * is native image code that would run on untrusted bytes. The hook is scoped to requests made FROM pdfjs-dist, so a
 * canvas the application itself loads is left alone.
 */
const PDFJS_CANVAS = "@napi-rs/canvas";

export function isPdfjsCanvasRequest(specifier: string, parentURL: string | undefined): boolean {
  return specifier === PDFJS_CANVAS && parentURL !== undefined && parentURL.includes("/pdfjs-dist/");
}

let blocked = false;

/** Makes `@napi-rs/canvas` unresolvable for pdfjs-dist in this process. Called once, when the parser module loads. */
export function blockPdfjsCanvas(): void {
  if (blocked) return;
  blocked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isPdfjsCanvasRequest(specifier, context.parentURL)) {
        throw Object.assign(new Error(`Cannot find module '${specifier}' (blocked for pdfjs-dist: the parser does not render)`), {
          code: "MODULE_NOT_FOUND",
        });
      }
      return nextResolve(specifier, context);
    },
  });
}
