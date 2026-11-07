import { createRipstream } from "@spikedpunch/ripstream-parsers";

const ripstream = createRipstream();
const bytes = new TextEncoder().encode("Hello from ripstream");
const result = await ripstream.parse(bytes, { filename: "hello.txt" });
console.log(result.metadata.get("Content-Type"));
console.log(result.text);
