import type {
  ContentHandler,
  IsolatedParseRecord,
  IsolatedParseRequest,
  IsolatedParseResult,
  MediaType,
  Metadata,
  ParseContext,
  Parser,
  Ripstream,
  RipstreamError,
} from "../packages/core/dist/index.js";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const metadata: Metadata;
const first: string | null = metadata.get("dc:title");
const all: readonly string[] = metadata.getAll("dc:title");
// @ts-expect-error metadata keys are strings
metadata.get(1);
metadata.set("meta:page-count", 3);
// @ts-expect-error keys must be strings
metadata.set(1, "x");

declare const parser: Parser;
type ParseReturn = ReturnType<Parser["parse"]>;
type _ParseReturn = Expect<Equal<ParseReturn, Promise<void>>>;

declare const mediaType: MediaType;
type BaseReturn = ReturnType<MediaType["getBaseType"]>;
type _BaseReturn = Expect<Equal<BaseReturn, MediaType>>;

declare const ripstream: Ripstream;
type ParseToString = ReturnType<Ripstream["parseToString"]>;
type _ParseToString = Expect<Equal<ParseToString, Promise<string>>>;

declare const handler: ContentHandler;
type StartElement = ContentHandler["startElement"];
type _StartElement = Expect<Equal<StartElement extends undefined ? never : unknown, unknown>>;

declare const error: RipstreamError;
const code: RipstreamError["code"] = error.code;
void first;
void all;
void code;
void mediaType;
void handler;
void parser;
void ripstream;
void (null as unknown as ParseContext);

// IsolatedParseResult narrows on `kind` (unchecked until the central type-test gate runs).
declare const isolated: IsolatedParseResult;
if (isolated.kind === "text") {
  const isolatedText: string = isolated.text;
  const isolatedMeta: Record<string, readonly string[]> = isolated.metadata;
  // @ts-expect-error records only exist on the "records" arm
  isolated.records;
} else {
  const isolatedRecords: readonly IsolatedParseRecord[] = isolated.records;
  // @ts-expect-error text only exists on the "text" arm
  isolated.text;
}
type _IsolatedKind = Expect<Equal<IsolatedParseResult["kind"], "text" | "records">>;
type _IsolatedOutput = Expect<
  Equal<IsolatedParseRequest["output"], "text" | "records" | undefined>
>;
