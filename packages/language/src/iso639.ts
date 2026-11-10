/**
 * ISO 639-3 to ISO 639-1, for `PUT /language`. Tika answers with the two-letter code ("en"), and keeps the
 * three-letter one for a language that has none (`LanguageResource.toIso1`); so does this.
 */

/** The 182 languages with a two-letter code, by their three-letter (639-2/T, which 639-3 shares) code. */
const TWO_LETTER: Readonly<Record<string, string>> = {
  aar: "aa", abk: "ab", afr: "af", aka: "ak", amh: "am", ara: "ar",
  arg: "an", asm: "as", ava: "av", ave: "ae", aym: "ay", aze: "az",
  bak: "ba", bam: "bm", bel: "be", ben: "bn", bis: "bi", bod: "bo",
  bos: "bs", bre: "br", bul: "bg", cat: "ca", ces: "cs", cha: "ch",
  che: "ce", chu: "cu", chv: "cv", cor: "kw", cos: "co", cre: "cr",
  cym: "cy", dan: "da", deu: "de", div: "dv", dzo: "dz", ell: "el",
  eng: "en", epo: "eo", est: "et", eus: "eu", ewe: "ee", fao: "fo",
  fas: "fa", fij: "fj", fin: "fi", fra: "fr", fry: "fy", ful: "ff",
  gla: "gd", gle: "ga", glg: "gl", glv: "gv", grn: "gn", guj: "gu",
  hat: "ht", hau: "ha", heb: "he", her: "hz", hin: "hi", hmo: "ho",
  hrv: "hr", hun: "hu", hye: "hy", ibo: "ig", ido: "io", iii: "ii",
  iku: "iu", ile: "ie", ina: "ia", ind: "id", ipk: "ik", isl: "is",
  ita: "it", jav: "jv", jpn: "ja", kal: "kl", kan: "kn", kas: "ks",
  kat: "ka", kau: "kr", kaz: "kk", khm: "km", kik: "ki", kin: "rw",
  kir: "ky", kom: "kv", kon: "kg", kor: "ko", kua: "kj", kur: "ku",
  lao: "lo", lat: "la", lav: "lv", lim: "li", lin: "ln", lit: "lt",
  ltz: "lb", lub: "lu", lug: "lg", mah: "mh", mal: "ml", mar: "mr",
  mkd: "mk", mlg: "mg", mlt: "mt", mon: "mn", mri: "mi", msa: "ms",
  mya: "my", nau: "na", nav: "nv", nbl: "nr", nde: "nd", ndo: "ng",
  nep: "ne", nld: "nl", nno: "nn", nob: "nb", nor: "no", nya: "ny",
  oci: "oc", oji: "oj", ori: "or", orm: "om", oss: "os", pan: "pa",
  pli: "pi", pol: "pl", por: "pt", pus: "ps", que: "qu", roh: "rm",
  ron: "ro", run: "rn", rus: "ru", sag: "sg", san: "sa", sin: "si",
  slk: "sk", slv: "sl", sme: "se", smo: "sm", sna: "sn", snd: "sd",
  som: "so", sot: "st", spa: "es", sqi: "sq", srd: "sc", srp: "sr",
  ssw: "ss", sun: "su", swa: "sw", swe: "sv", tah: "ty", tam: "ta",
  tat: "tt", tel: "te", tgk: "tg", tgl: "tl", tha: "th", tir: "ti",
  ton: "to", tsn: "tn", tso: "ts", tuk: "tk", tur: "tr", uig: "ug",
  ukr: "uk", urd: "ur", uzb: "uz", ven: "ve", vie: "vi", vol: "vo",
  wln: "wa", wol: "wo", xho: "xh", yid: "yi", yor: "yo", zha: "za",
  zho: "zh", zul: "zu",
};

/**
 * What franc names by an individual language of a macrolanguage that has a two-letter code: Standard Arabic is `arb`,
 * and Tika's detector says `ar`. Tika's `toIso1` does not know these, because its detector never says them.
 */
const MACROLANGUAGE: Readonly<Record<string, string>> = {
  arb: "ar", cmn: "zh", pes: "fa", zsm: "ms", swh: "sw", uzn: "uz", azj: "az", ekk: "et", lvs: "lv", khk: "mn", npi: "ne", plt: "mg", ydd: "yi", als: "sq", pbu: "ps",
};

/** The two-letter code for a three-letter one, or the code itself when there is none (and for `und`). */
export function toIso6391(code: string): string {
  if (code.length !== 3) return code;
  return TWO_LETTER[code] ?? MACROLANGUAGE[code] ?? code;
}
