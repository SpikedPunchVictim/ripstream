export interface TikaRootXml {
  readonly localName: string;
  readonly namespaceURI?: string;
}

export interface TikaMatch {
  readonly type: string;
  readonly value: string;
  readonly offset: string;
  readonly mask?: string;
  readonly minShouldMatch?: number;
  readonly children?: readonly TikaMatch[];
}

export interface TikaMagic {
  readonly priority: number;
  readonly matches: readonly TikaMatch[];
}

export interface TikaMimeEntry {
  readonly type: string;
  readonly description?: string;
  readonly aliases: readonly string[];
  readonly globs: readonly string[];
  /** Java regular expressions that must match the whole file name (Tika's `<glob isregex="true">`). */
  readonly regexGlobs?: readonly string[];
  readonly supertype?: string;
  readonly rootXml: readonly TikaRootXml[];
  readonly magic: readonly TikaMagic[];
}
