import { ContentHandlerDecorator } from "../content-handler.ts";
import type { Metadata } from "../metadata.ts";
import { writeXmpPacket } from "../metadata-utils.ts";

/** Emits an XMP packet for the document metadata at end of document. */
export class XmpContentHandler extends ContentHandlerDecorator {
  readonly #metadata: Metadata;

  constructor(
    delegate: ConstructorParameters<typeof ContentHandlerDecorator>[0],
    metadata: Metadata,
  ) {
    super(delegate);
    this.#metadata = metadata;
  }

  override async endDocument(): Promise<void> {
    const packet = writeXmpPacket(this.#metadata);
    await super.characters(packet, 0, packet.length);
    await super.endDocument();
  }
}
