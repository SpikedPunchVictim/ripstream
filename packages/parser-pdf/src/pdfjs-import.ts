/**
 * pdf.js reports through `console.log` (`Warning: ...`, so on stdout, where a command line tool's output goes), and
 * three of its warnings come out while its module loads: `Cannot load "@napi-rs/canvas"` and `Cannot polyfill
 * DOMMatrix/ImageData/Path2D`, which are the blocked canvas (block-canvas.ts) and not a problem for text extraction. Its
 * verbosity can only be set once it is loaded, so those are dropped here, for as long as `load` takes. Everything else
 * written meanwhile reaches the real `console.log`. The warnings of a document are dropped by `verbosity: 0` in
 * the options of `getDocument` (pdf-session.ts).
 */
const PDFJS_WARNING = "Warning: ";

let active = 0;
let original: typeof console.log | undefined;

function filtered(...args: unknown[]): void {
  if (typeof args[0] === "string" && args[0].startsWith(PDFJS_WARNING)) return;
  original?.apply(console, args);
}

export async function importWithoutPdfjsWarnings<T>(load: () => Promise<T>): Promise<T> {
  if (active++ === 0) {
    original = console.log;
    console.log = filtered;
  }
  try {
    return await load();
  } finally {
    // Not when something else has replaced console.log since: that is not ours to put back.
    if (--active === 0 && console.log === filtered) console.log = original!;
  }
}
