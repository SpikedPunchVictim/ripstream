import { HazardParser } from "@spikedpunch/ripstream-fixture-base";
import { derive } from "./derive.ts";

// No `class` and no getSupportedTypes in this file: only the prototype chain of the exported value shows what it is.
export const FactoryMadeParser = derive(HazardParser);
