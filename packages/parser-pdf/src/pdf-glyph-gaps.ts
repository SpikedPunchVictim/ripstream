import { needsSpace, type PdfTextItem } from "./pdf-lines.ts";

/**
 * Word spacing as PDFBox decides it (tikajs-4c5k). pdf.js writes its own " " into `item.str` for any gap of 0.102 to 0.6 em and
 * none for a smaller one; Tika's PDFBox spaces glyphs when the gap exceeds min(0.5 x the font's space width, 0.3 x the average
 * glyph width), so 'N H S 2 0 1 2' (pdf.js) is 'NHS2012' in Tika. The gap is not in the text items, so the page's operator list
 * is walked for each glyph's position and advance, and the gaps pdf.js decided are decided again. Only whitespace between two
 * glyphs that touch no space glyph changes; any mismatch between the glyphs and the items gives up (null) and the page is
 * left as pdf.js has it.
 */

export interface OperatorList {
  readonly fnArray: ArrayLike<number>;
  // pdf.js's operands: arrays of numbers and glyph objects, depending on the operator.
  readonly argsArray: ArrayLike<any>;
}
export interface GlyphFont {
  readonly name?: string;
  readonly vertical?: boolean;
  readonly fontMatrix?: readonly number[];
  /** Simple fonts only: the glyph widths by character code (pdf.js's fontExtraProperties). */
  readonly composite?: boolean;
  readonly widths?: ArrayLike<number>;
}
export interface GapInput {
  readonly list: OperatorList;
  /** pdf.js's `OPS` table. */
  readonly ops: Readonly<Record<string, number>>;
  /** The font pdf.js loaded under this name; undefined when it has none. */
  readonly font: (name: string) => GlyphFont | undefined;
  /** The page's visible box: pdf.js leaves out text outside it. */
  readonly view?: readonly number[] | undefined;
}

export const MAX_GLYPHS = 200_000;
const SPACE_TOLERANCE = 0.5;
const CHAR_TOLERANCE = Math.fround(0.3);

type Matrix = [number, number, number, number, number, number];

/** What every glyph of one show operator shares: a page of 10,000 glyphs is a few hundred runs, so a glyph holds a run and not a copy of it. */
interface Run {
  font: string;
  /** The font's glyph space in ems (0.001), and its size on the page. */
  unit: number;
  size: number;
  ux: number;
  uy: number;
  em: number;
}

interface Glyph {
  text: string;
  /** A whitespace glyph: pdf.js writes no item for it. */
  blank: boolean;
  /** Inside the page's box, so in an item. */
  shown: boolean;
  width: number;
  x: number;
  y: number;
  run: Run;
  /** PDFBox puts a word separator before it: 1 yes, 0 no, -1 not on the line of the glyph before. */
  sep: number;
}

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

interface State {
  ctm: Matrix;
  tm: Matrix;
  tlm: Matrix;
  font: string;
  size: number;
  tc: number;
  tw: number;
  th: number;
  leading: number;
  rise: number;
}

const CATEGORY = /^(\s)|(\p{Mn})|(\p{Cf})$/u;

/** The glyphs the operator list shows, in order, with where each is. Null when the page uses what this does not read (vertical text). */
function glyphsOf(input: GapInput): Glyph[] | null {
  const { list, ops } = input;
  const result: Glyph[] = [];
  let state: State = { ctm: [1, 0, 0, 1, 0, 0], tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0], font: "", size: 0, tc: 0, tw: 0, th: 1, leading: 0, rise: 0 };
  const stack: State[] = [];
  const fonts = new Map<string, GlyphFont | undefined>();
  const move = (x: number, y: number): void => {
    const m = state.tlm;
    state.tlm = [m[0], m[1], m[2], m[3], x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    state.tm = state.tlm;
  };
  const show = (shown: ArrayLike<any>): boolean => {
    let font = fonts.get(state.font);
    if (!fonts.has(state.font)) fonts.set(state.font, (font = input.font(state.font)));
    if (font === undefined || font.vertical === true) return false;
    const unit = font.fontMatrix?.[0] ?? 0.001;
    const { size, th, tc, tw } = state;
    // Text space to the page: the glyph shown `offset` along the line is at (bx, by) + offset x (m0, m1), the way pdf.js reads it.
    const m = multiply(state.ctm, state.tm);
    const bx = m[4] + state.rise * m[2];
    const by = m[5] + state.rise * m[3];
    const run = Math.hypot(m[0], m[1]);
    const length = Math.abs(size * th) * run;
    const direction = Math.sign(size * th) || 1;
    const view = input.view;
    const ux = run > 0 ? (direction * m[0]) / run : 1;
    const uy = run > 0 ? (direction * m[1]) / run : 0;
    const shared: Run = { font: state.font, unit, size: length, ux, uy, em: Math.abs(size) * run };
    let offset = 0;
    for (let index = 0; index < shown.length; index++) {
      const glyph = shown[index];
      if (typeof glyph === "number") {
        offset += (-glyph / 1000) * size * th;
        continue;
      }
      const text: string = typeof glyph.unicode === "string" ? glyph.unicode : "";
      const first = text.length === 1 ? text.charCodeAt(0) : 0;
      // Printable ASCII is neither whitespace nor a mark: the common case skips the expression.
      const category = first > 32 && first < 127 ? null : CATEGORY.exec(text);
      if (category?.[3] !== undefined) continue;
      const width: number = category?.[2] !== undefined ? 0 : Number(glyph.width) || 0;
      const x = bx + offset * m[0];
      const y = by + offset * m[1];
      if (result.length >= MAX_GLYPHS) return false;
      result.push({
        text,
        blank: category?.[1] !== undefined,
        shown: view === undefined || !(x + width * size * unit < view[0]! || x > view[2]! || y < view[1]! || y > view[3]!),
        width,
        x,
        y,
        run: shared,
        sep: -1,
      });
      offset += (width * size * unit + tc + (glyph.isSpace === true ? tw : 0)) * th;
    }
    const t = state.tm;
    state.tm = [t[0], t[1], t[2], t[3], offset * t[0] + t[4], offset * t[1] + t[5]];
    return true;
  };
  const code = (name: string): number => ops[name] ?? -1;
  const table = new Map<number, string>();
  for (const name of [
    "save", "restore", "transform", "beginText", "setCharSpacing", "setWordSpacing", "setHScale", "setLeading", "setFont", "setTextRise",
    "moveText", "setLeadingMoveText", "setTextMatrix", "nextLine", "showText", "showSpacedText", "paintFormXObjectBegin", "paintFormXObjectEnd",
  ]) table.set(code(name), name);
  for (let index = 0; index < list.fnArray.length; index++) {
    const name = table.get(list.fnArray[index]!);
    if (name === undefined) continue;
    const args = list.argsArray[index] ?? [];
    switch (name) {
      case "save":
      case "paintFormXObjectBegin":
        stack.push({ ...state });
        if (name === "paintFormXObjectBegin" && Array.isArray(args[0]) && args[0].length === 6) state.ctm = multiply(state.ctm, args[0] as Matrix);
        break;
      case "restore":
      case "paintFormXObjectEnd":
        state = stack.pop() ?? state;
        break;
      case "transform":
        state.ctm = multiply(state.ctm, args as Matrix);
        break;
      case "beginText":
        state.tm = state.tlm = [1, 0, 0, 1, 0, 0];
        break;
      case "setCharSpacing":
        state.tc = Number(args[0]) || 0;
        break;
      case "setWordSpacing":
        state.tw = Number(args[0]) || 0;
        break;
      case "setHScale":
        state.th = (Number(args[0]) || 0) / 100;
        break;
      case "setLeading":
        state.leading = Number(args[0]) || 0;
        break;
      case "setFont":
        state.font = String(args[0]);
        state.size = Number(args[1]) || 0;
        break;
      case "setTextRise":
        state.rise = Number(args[0]) || 0;
        break;
      case "moveText":
        move(Number(args[0]) || 0, Number(args[1]) || 0);
        break;
      case "setLeadingMoveText":
        state.leading = -(Number(args[1]) || 0);
        move(Number(args[0]) || 0, Number(args[1]) || 0);
        break;
      case "setTextMatrix":
        state.tm = state.tlm = args.slice(0, 6) as Matrix;
        break;
      case "nextLine":
        move(0, -state.leading);
        break;
      default:
        if (!show(args[0] ?? [])) return null;
    }
  }
  return result;
}

/** What PDFBox takes for the width of a font's space, in glyph units: the one shown, else the font's declared one (see declaredSpace), else the average glyph. */
function spaceWidths(glyphs: Glyph[], standard: (font: string) => number | undefined): Map<string, number> {
  const space = new Map<string, number>();
  const total = new Map<string, [number, number]>();
  // The font of the run the glyph is in, and its totals once a glyph of it has counted: a run is many glyphs, a map lookup is not free.
  let counted: Run | undefined;
  let sum: [number, number] | undefined;
  for (const glyph of glyphs) {
    const run = glyph.run;
    if (run !== counted) {
      counted = run;
      sum = total.get(run.font);
    }
    if (glyph.blank) {
      if (glyph.text === " " && glyph.width > 0 && !space.has(run.font)) space.set(run.font, glyph.width);
    } else if (glyph.width > 0) {
      if (sum === undefined) total.set(run.font, (sum = [0, 0]));
      sum[0] += glyph.width;
      sum[1]++;
    }
  }
  for (const [font, [sum, count]] of total) if (!space.has(font)) space.set(font, standard(font) ?? sum / count);
  return space;
}

/** Sets each glyph's `sep` to what PDFBox's PDFTextStripper decides between it and the glyph before: a word separator or none. */
function decideSeparators(glyphs: Glyph[], standard: (font: string) => number | undefined): void {
  const space = spaceWidths(glyphs, standard);
  let previous: Glyph | undefined;
  let average = -1;
  let lastSpace = -1;
  // PDFBox computes in 32-bit floats, and a gap that equals its threshold (a Courier gap of 0.18 em) goes by the rounding.
  const f = Math.fround;
  const advance = (glyph: Glyph, width: number): number => f(f(width * glyph.run.unit) * glyph.run.size);
  const along = (glyph: Glyph): number => f(glyph.x * glyph.run.ux + glyph.y * glyph.run.uy);
  // A run's space advance is the same for each of its glyphs.
  let counted: Run | undefined;
  let spaceWidth = 0;
  for (const glyph of glyphs) {
    const run = glyph.run;
    if (run !== counted) {
      counted = run;
      spaceWidth = advance(glyph, space.get(run.font) ?? 0);
    }
    const deltaSpace = spaceWidth > 0 ? f(f(lastSpace < 0 ? spaceWidth : f(f(spaceWidth + lastSpace) / 2)) * SPACE_TOLERANCE) : Infinity;
    const mean = f(advance(glyph, glyph.width) / Math.max(1, glyph.text.length));
    average = average < 0 ? mean : f(f(average + mean) / 2);
    if (previous !== undefined) {
      const across = (glyph.y - previous.y) * run.ux - (glyph.x - previous.x) * run.uy;
      const parallel = previous.run.ux * run.ux + previous.run.uy * run.uy > 0.99;
      if (parallel && Math.abs(across) <= 0.5 * Math.max(previous.run.em, run.em)) {
        const expected = f(f(along(previous) + advance(previous, previous.width)) + Math.min(f(average * CHAR_TOLERANCE), deltaSpace));
        glyph.sep = expected < along(glyph) && !previous.text.endsWith(" ") ? 1 : 0;
      }
    }
    lastSpace = spaceWidth;
    previous = glyph;
  }
}

/** The width of a font's space (glyph units) when the page never shows it: the font's width for character 32, else a standard font's. */
function declaredSpace(font: GlyphFont | undefined): number | undefined {
  const width = font?.composite === true ? 0 : Number(font?.widths?.[32]);
  if (width > 0) return width;
  const base = (font?.name ?? "").replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (/^(helvetica|arial)/.test(base)) return 278;
  if (/^times/.test(base)) return 250;
  if (/^courier/.test(base)) return 600;
  return undefined;
}

/**
 * The items with the whitespace between glyphs as PDFBox puts it, or null when the glyphs and the items do not line up (the
 * caller keeps the items it has). Between two items, pdf.js's whitespace item goes when PDFBox has no separator there, and an
 * item that PDFBox joins to (or parts from) the one before carries `gapAfter` where lines() would decide otherwise.
 */
export function respaced(items: PdfTextItem[], input: GapInput): PdfTextItem[] | null {
  const glyphs = glyphsOf(input);
  if (glyphs === null || glyphs.length === 0) return null;
  const names = new Map<string, number | undefined>();
  decideSeparators(glyphs, (font) => {
    if (!names.has(font)) names.set(font, declaredSpace(input.font(font)));
    return names.get(font);
  });
  let next = 0;
  const result: PdfTextItem[] = [];
  // The last item with glyphs: its place in `result` and the place of its last glyph.
  let last = -1;
  let lastGlyph = -2;
  for (const item of items) {
    const text = item.str;
    if (typeof text !== "string" || !/\S/.test(text)) {
      result.push(item);
      continue;
    }
    if (item.dir === "rtl") return null;
    let out = "";
    let pending = "";
    let before = -2;
    let at = 0;
    while (at < text.length) {
      const char = text.charCodeAt(at);
      if (char === 32 || (char >= 9 && char <= 13) || char === 160) {
        pending += text[at++];
        continue;
      }
      let glyph: Glyph | undefined;
      let width = 0;
      for (; next < glyphs.length; next++) {
        const candidate = glyphs[next]!;
        if (candidate.blank || !candidate.shown || candidate.text === "") continue;
        const plain = text.startsWith(candidate.text, at) ? candidate.text : candidate.text.normalize("NFKC");
        if (!text.startsWith(plain, at)) return null;
        glyph = candidate;
        width = plain.length;
        break;
      }
      if (glyph === undefined) return null;
      if (before < 0) {
        out += pending;
        const [one, two] = [result[last], result[last + 1]];
        // No item between the two, or only a whitespace one, and no space glyph or line break.
        const joined = last >= 0 && next === lastGlyph + 1 && glyph.sep >= 0 && one!.hasEOL !== true && (result.length === last + 1 || (result.length === last + 2 && /^\s+$/.test(two!.str ?? "x") && two!.hasEOL !== true));
        if (joined) {
          const space = result.length === last + 2;
          if (space && glyph.sep === 0) result.pop();
          if (!(space && glyph.sep === 1) && (glyph.sep === 1) !== needsSpace(one, item)) result[last] = { ...one!, gapAfter: glyph.sep === 1 };
        }
      } else out += next === before + 1 && glyph.sep >= 0 ? (glyph.sep === 1 ? " " : "") : pending;
      out += text.slice(at, at + width);
      at += width;
      pending = "";
      before = next++;
    }
    out += pending;
    last = result.push(out === text ? item : { ...item, str: out }) - 1;
    lastGlyph = before;
  }
  return result;
}
