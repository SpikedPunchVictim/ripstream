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
  /** Columns to read the page's glyphs into, kept from one page to the next (createGapBuffers) so that each page does not allocate its own. */
  readonly buffers?: GapBuffers;
}

export const MAX_GLYPHS = 200_000;
const SPACE_TOLERANCE = 0.5;
const CHAR_TOLERANCE = Math.fround(0.3);

type Matrix = [number, number, number, number, number, number];

/** What every glyph of one show operator shares: a page of 10,000 glyphs is a few hundred runs, and its glyphs are a range of `Columns`. */
interface Run {
  stat: FontStat;
  /** The font's glyph space in ems (0.001), and its size on the page. */
  unit: number;
  size: number;
  ux: number;
  uy: number;
  em: number;
  /** The glyphs of the run are [start, end) of `Columns`. */
  start: number;
  end: number;
}

/** What a font's glyphs add up to on the page. */
interface FontStat {
  /** The first space glyph shown in the font (0 until there is one), the widths of the glyphs that are not whitespace, and how many. */
  space: number;
  sum: number;
  count: number;
  /** What PDFBox takes for the font's space, in glyph units, once the page is read. */
  width: number;
}

/** The columns respaced reads a page's glyphs into (see createGapBuffers); what is in them is its own. */
export interface GapBuffers {
  /** The glyphs of the page read last. */
  readonly count: number;
}

/**
 * The glyphs one page shows, a column each (a page of text is thousands of glyphs, and an object apiece is most of what reading it
 * costs). The columns are overwritten by each page, so one set serves a whole document, and only one call at a time may use it.
 */
interface Columns extends GapBuffers {
  count: number;
  /** The text of a glyph whose text is not one character; the character code of one that is. */
  text: string[];
  code: Uint16Array;
  width: Float64Array;
  x: Float64Array;
  y: Float64Array;
  flags: Uint8Array;
  /** PDFBox puts a word separator before it: 1 yes, 0 no, -1 not on the line of the glyph before. */
  sep: Int8Array;
  runs: Run[];
  stats: Map<string, FontStat>;
}

/** A whitespace glyph: pdf.js writes no item for it. */
const BLANK = 1;
/** Inside the page's box, so in an item. */
const SHOWN = 2;
/** Its text is more than one character (see `text`). */
const MULTI = 4;
/** Its text ends with a space. */
const ENDS = 8;
/** Its text is empty. */
const EMPTY = 16;

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

export function createGapBuffers(): GapBuffers {
  return columns(0);
}

function columns(capacity: number): Columns {
  return {
    count: 0,
    text: new Array<string>(capacity),
    code: new Uint16Array(capacity),
    width: new Float64Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    flags: new Uint8Array(capacity),
    sep: new Int8Array(capacity),
    runs: [],
    stats: new Map(),
  };
}

/** The glyphs the operator list shows, in order, with where each is. Null when the page uses what this does not read (vertical text). */
function glyphsOf(input: GapInput): Columns | null {
  const { list, ops } = input;
  const table: string[] = [];
  for (const name of [
    "save", "restore", "transform", "beginText", "setCharSpacing", "setWordSpacing", "setHScale", "setLeading", "setFont", "setTextRise",
    "moveText", "setLeadingMoveText", "setTextMatrix", "nextLine", "showText", "showSpacedText", "paintFormXObjectBegin", "paintFormXObjectEnd",
  ]) table[ops[name] ?? -1] = name;
  // The most glyphs there can be, to size the columns with: a show operator's operands are glyphs and kerning numbers.
  let room = 0;
  for (let index = 0; index < list.fnArray.length && room < MAX_GLYPHS; index++) {
    const name = table[list.fnArray[index]!];
    if (name !== "showText" && name !== "showSpacedText") continue;
    const length = list.argsArray[index]?.[0]?.length;
    if (typeof length === "number" && length > 0) room += Math.ceil(length);
  }
  room = Math.min(room, MAX_GLYPHS);
  const glyphs = (input.buffers as Columns | undefined) ?? columns(room);
  if (glyphs.width.length < room) Object.assign(glyphs, columns(Math.max(room, Math.min(glyphs.width.length * 2, MAX_GLYPHS))));
  glyphs.count = 0;
  glyphs.runs = [];
  glyphs.stats = new Map();
  const { text: texts, code: codes, width: widths, x: xs, y: ys, flags: marks, stats, runs } = glyphs;
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
    const left = view?.[0]!;
    const bottom = view?.[1]!;
    const right = view?.[2]!;
    const top = view?.[3]!;
    const ux = run > 0 ? (direction * m[0]) / run : 1;
    const uy = run > 0 ? (direction * m[1]) / run : 0;
    let stat = stats.get(state.font);
    if (stat === undefined) stats.set(state.font, (stat = { space: 0, sum: 0, count: 0, width: 0 }));
    const shared: Run = { stat, unit, size: length, ux, uy, em: Math.abs(size) * run, start: glyphs.count, end: glyphs.count };
    let count = glyphs.count;
    let offset = 0;
    let sum = stat.sum;
    let counted = stat.count;
    const m0 = m[0];
    const m1 = m[1];
    const total = shown.length;
    for (let index = 0; index < total; index++) {
      const glyph = shown[index];
      if (typeof glyph === "number") {
        offset += (-glyph / 1000) * size * th;
        continue;
      }
      const unicode = glyph.unicode;
      const text: string = typeof unicode === "string" ? unicode : "";
      const chars = text.length;
      const single = chars === 1;
      const first = single ? text.charCodeAt(0) : 0;
      let flag = 0;
      let mark = false;
      if (single && first < 0x300) {
        // Below U+0300 there is no mark, and the one format character is U+00AD: the expression is for what is above.
        if (first === 0xad) continue;
        if (first === 32) flag = BLANK | ENDS;
        else if ((first >= 9 && first <= 13) || first === 0xa0) flag = BLANK;
      } else if (chars > 0) {
        const category = CATEGORY.exec(text);
        if (category?.[3] !== undefined) continue;
        flag = category?.[1] !== undefined ? BLANK : 0;
        mark = category?.[2] !== undefined;
        if (!single) {
          flag |= MULTI | (text.charCodeAt(chars - 1) === 32 ? ENDS : 0);
          texts[count] = text;
        }
      } else {
        flag = EMPTY;
        texts[count] = text;
      }
      const raw = glyph.width;
      const width: number = mark ? 0 : (typeof raw === "number" ? raw : Number(raw)) || 0;
      const advance = width * size * unit;
      const x = bx + offset * m0;
      const y = by + offset * m1;
      if (count >= MAX_GLYPHS) return false;
      if (view === undefined || !(x + advance < left || x > right || y < bottom || y > top)) flag |= SHOWN;
      codes[count] = first;
      widths[count] = width;
      xs[count] = x;
      ys[count] = y;
      marks[count++] = flag;
      if ((flag & BLANK) !== 0) {
        if (text === " " && width > 0 && stat.space === 0) stat.space = width;
      } else if (width > 0) {
        sum += width;
        counted++;
      }
      offset += (advance + tc + (glyph.isSpace === true ? tw : 0)) * th;
    }
    stat.sum = sum;
    stat.count = counted;
    shared.end = glyphs.count = count;
    if (count > shared.start) runs.push(shared);
    const t = state.tm;
    state.tm = [t[0], t[1], t[2], t[3], offset * t[0] + t[4], offset * t[1] + t[5]];
    return true;
  };
  for (let index = 0; index < list.fnArray.length; index++) {
    const name = table[list.fnArray[index]!];
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
  return glyphs;
}

/**
 * Sets each glyph's `sep` to what PDFBox's PDFTextStripper decides between it and the glyph before: a word separator or none.
 * What PDFBox takes for a font's space is the one shown, else the font's declared one (see declaredSpace), else the average glyph.
 */
function decideSeparators(glyphs: Columns, standard: (font: string) => number | undefined): void {
  for (const [name, stat] of glyphs.stats) stat.width = stat.space > 0 ? stat.space : stat.count > 0 ? standard(name) ?? stat.sum / stat.count : 0;
  const { text, width, x, y, flags, sep } = glyphs;
  let previous = -1;
  let average = -1;
  let lastSpace = -1;
  let previousAlong = 0;
  let previousAdvance = 0;
  let previousUx = 0;
  let previousUy = 0;
  let previousEm = 0;
  let previousX = 0;
  let previousY = 0;
  // PDFBox computes in 32-bit floats, and a gap that equals its threshold (a Courier gap of 0.18 em) goes by the rounding.
  const f = Math.fround;
  for (const run of glyphs.runs) {
    const { unit, size, ux, uy, em } = run;
    // A run's space advance is the same for each of its glyphs, and so is the threshold from the second on (the glyph before is in the run).
    const spaceWidth = f(f(run.stat.width * unit) * size);
    const threshold = (before: number): number => (spaceWidth > 0 ? f(f(before < 0 ? spaceWidth : f(f(spaceWidth + before) / 2)) * SPACE_TOLERANCE) : Infinity);
    const alongRun = ux * ux + uy * uy > 0.99;
    const limitRun = 0.5 * Math.max(em, em);
    // The first glyph is measured against the run before; the rest against one of their own.
    const deltaRest = threshold(spaceWidth);
    let deltaSpace = threshold(lastSpace);
    let parallel = previousUx * ux + previousUy * uy > 0.99;
    let limit = 0.5 * Math.max(previousEm, em);
    for (let index = run.start; index < run.end; index++) {
      const advance = f(f(width[index]! * unit) * size);
      const mean = (flags[index]! & MULTI) === 0 ? advance : f(advance / text[index]!.length);
      average = average < 0 ? mean : f(f(average + mean) / 2);
      const gx = x[index]!;
      const gy = y[index]!;
      const along = f(gx * ux + gy * uy);
      let separator = -1;
      if (previous >= 0) {
        const across = (gy - previousY) * ux - (gx - previousX) * uy;
        if (parallel && Math.abs(across) <= limit) {
          const expected = f(f(previousAlong + previousAdvance) + Math.min(f(average * CHAR_TOLERANCE), deltaSpace));
          separator = expected < along && (flags[previous]! & ENDS) === 0 ? 1 : 0;
        }
      }
      sep[index] = separator;
      deltaSpace = deltaRest;
      parallel = alongRun;
      limit = limitRun;
      previous = index;
      previousX = gx;
      previousY = gy;
      previousAlong = along;
      previousAdvance = advance;
    }
    lastSpace = spaceWidth;
    previousUx = ux;
    previousUy = uy;
    previousEm = em;
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
  if (glyphs === null || glyphs.count === 0) return null;
  const names = new Map<string, number | undefined>();
  decideSeparators(glyphs, (font) => {
    if (!names.has(font)) names.set(font, declaredSpace(input.font(font)));
    return names.get(font);
  });
  const { text: texts, code: codes, flags, sep, count } = glyphs;
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
    // The item's text with the whitespace between glyphs as decided: `out` holds the text before `copied`, and is only built where it differs.
    let out = "";
    let copied = 0;
    let changed = false;
    // The whitespace since the last glyph is text[gap, at).
    let gap = 0;
    let before = -2;
    let at = 0;
    while (at < text.length) {
      const char = text.charCodeAt(at);
      if (char === 32 || (char >= 9 && char <= 13) || char === 160) {
        at++;
        continue;
      }
      let width = 0;
      for (; next < count; next++) {
        const flag = flags[next]!;
        if ((flag & (BLANK | SHOWN | EMPTY)) !== SHOWN) continue;
        const single = (flag & MULTI) === 0;
        if (single && char === codes[next]) {
          width = 1;
          break;
        }
        const candidate = single ? String.fromCharCode(codes[next]!) : texts[next]!;
        const plain = text.startsWith(candidate, at) ? candidate : candidate.normalize("NFKC");
        if (!text.startsWith(plain, at)) return null;
        width = plain.length;
        break;
      }
      if (next >= count) return null;
      const separator = sep[next]!;
      if (before < 0) {
        const [one, two] = [result[last], result[last + 1]];
        // No item between the two, or only a whitespace one, and no space glyph or line break.
        const joined = last >= 0 && next === lastGlyph + 1 && separator >= 0 && one!.hasEOL !== true && (result.length === last + 1 || (result.length === last + 2 && /^\s+$/.test(two!.str ?? "x") && two!.hasEOL !== true));
        if (joined) {
          const space = result.length === last + 2;
          if (space && separator === 0) result.pop();
          if (!(space && separator === 1) && (separator === 1) !== needsSpace(one, item)) result[last] = { ...one!, gapAfter: separator === 1 };
        }
      } else if (next === before + 1 && separator >= 0) {
        const between = at - gap;
        // pdf.js's whitespace (none, or one space) is kept where it is what PDFBox decided.
        if (!(separator === 1 ? between === 1 && text.charCodeAt(gap) === 32 : between === 0)) {
          out += text.slice(copied, gap) + (separator === 1 ? " " : "");
          copied = at;
          changed = true;
        }
      }
      at += width;
      gap = at;
      before = next++;
    }
    if (changed) out += text.slice(copied);
    last = result.push(changed ? { ...item, str: out } : item) - 1;
    lastGlyph = before;
  }
  return result;
}
