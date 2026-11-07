export { OoxmlParser } from "./ooxml.ts";
export { EpubParser, OpenDocumentParser } from "./document.ts";
export { CompoundFile, hasSignature } from "./cfb.ts";
export { WordBinaryParser } from "./word-binary.ts";
export { ExcelBinaryParser } from "./excel-binary.ts";
export { PowerPointBinaryParser } from "./powerpoint-binary.ts";
export { MsgParser } from "./msg.ts";
export { IWork09Parser } from "./iwork.ts";
export { IWork13Parser } from "./iwork13.ts";
export { LegacyOfficeParser } from "./legacy.ts";
export { LegacyFormatParser } from "./legacy-formats.ts";
export { PstParser } from "./pst.ts";
export {
  applyPropertySetMetadata,
  parsePropertySets,
  type PropertySet,
  type PropertyValue,
} from "./property-sets.ts";
