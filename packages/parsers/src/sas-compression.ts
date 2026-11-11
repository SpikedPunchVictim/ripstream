import { MalformedDocumentError, UnsupportedFormatError } from "@spikedpunch/ripstream-core";

/*
 * The two row compressions of SAS7BDAT: RLE (the literal "SASYZCRL" in the first text block) and RDC (Ross Data Compression,
 * "SASYZCR2"). Neither is in the Tika tree, where parso reads them; no file of either kind was available. This is written
 * from the algorithms as they are remembered from the pandas and ReadStat readers, and is not checked against a file.
 *
 * Each function is given the length the row must come to (the row length of the file) and returns exactly that many bytes
 * or throws: nothing is written past that length, so the output is bounded by it and not by anything the input says.
 */

const BLANK = 0x20;
const AT_SIGN = 0x40;
const NUL = 0x00;

/** A writer that refuses to go past the length it was made for. */
class Output {
  readonly bytes: Uint8Array;
  length = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }

  fill(value: number, count: number): void {
    this.#room(count);
    this.bytes.fill(value, this.length, this.length + count);
    this.length += count;
  }

  copy(from: Uint8Array, start: number, count: number): void {
    this.#room(count);
    this.bytes.set(from.subarray(start, start + count), this.length);
    this.length += count;
  }

  /** Bytes already written, `distance` back, which may overlap the ones being written. */
  repeat(distance: number, count: number): void {
    if (distance > this.length) throw new MalformedDocumentError("SAS7BDAT RDC data refers to before its start");
    this.#room(count);
    for (let index = 0; index < count; index++) {
      this.bytes[this.length] = this.bytes[this.length - distance]!;
      this.length++;
    }
  }

  finish(what: string): Uint8Array {
    if (this.length !== this.bytes.length) throw new MalformedDocumentError(`SAS7BDAT ${what} data is shorter than its row`);
    return this.bytes;
  }

  #room(count: number): void {
    if (this.length + count > this.bytes.length) throw new MalformedDocumentError("SAS7BDAT compressed data is longer than its row");
  }
}

function need(input: Uint8Array, position: number, count: number): void {
  if (position + count > input.length) throw new MalformedDocumentError("SAS7BDAT compressed data ends inside a command");
}

/**
 * RLE: each command is a byte whose high nibble is the command and whose low nibble is a length, then what the command
 * needs. 0x80 to 0xB0 copy 1, 17, 33 or 49 bytes (and the nibble more); 0xC0 repeats the byte after it 3 times and the
 * nibble more; 0xD0, 0xE0 and 0xF0 insert 2 '@', blanks or NULs and the nibble more; 0x50, 0x60 and 0x70 insert 17 of those
 * and the byte after the command and the nibble times 256 more; 0x00 copies 64 bytes and the byte after the command more.
 *
 * 0x10, 0x20 and 0x40, and a 0x00 with a low nibble, are given different lengths by the sources this was remembered from,
 * so they are refused as unsupported rather than guessed at.
 */
export function rleDecompress(input: Uint8Array, rowLength: number): Uint8Array {
  const out = new Output(rowLength);
  let position = 0;
  while (position < input.length) {
    const control = input[position++]!;
    const command = control >> 4;
    const nibble = control & 0x0f;
    switch (command) {
      case 0x0:
        if (nibble !== 0) throw unsupported(control);
        need(input, position, 1);
        position = copyRun(out, input, position + 1, input[position]! + 64);
        break;
      case 0x1:
      case 0x2:
      case 0x4:
        throw unsupported(control);
      case 0x5:
      case 0x6:
      case 0x7: {
        need(input, position, 1);
        const count = nibble * 256 + input[position++]! + 17;
        out.fill(command === 0x5 ? AT_SIGN : command === 0x6 ? BLANK : NUL, count);
        break;
      }
      case 0x8:
        position = copyRun(out, input, position, nibble + 1);
        break;
      case 0x9:
        position = copyRun(out, input, position, nibble + 17);
        break;
      case 0xa:
        position = copyRun(out, input, position, nibble + 33);
        break;
      case 0xb:
        position = copyRun(out, input, position, nibble + 49);
        break;
      case 0xc:
        need(input, position, 1);
        out.fill(input[position++]!, nibble + 3);
        break;
      case 0xd:
        out.fill(AT_SIGN, nibble + 2);
        break;
      case 0xe:
        out.fill(BLANK, nibble + 2);
        break;
      case 0xf:
        out.fill(NUL, nibble + 2);
        break;
      default:
        throw new MalformedDocumentError(`SAS7BDAT RLE command 0x${control.toString(16)} is not defined`);
    }
  }
  return out.finish("RLE");
}

function unsupported(control: number): UnsupportedFormatError {
  return new UnsupportedFormatError(
    `SAS7BDAT RLE command 0x${control.toString(16)} is not read: the sources this reader was written from disagree on its length`,
  );
}

/** Copies `count` input bytes from `position`, which the caller has moved past the command; returns the position after them. */
function copyRun(out: Output, input: Uint8Array, position: number, count: number): number {
  need(input, position, count);
  out.copy(input, position, count);
  return position + count;
}

/**
 * RDC: a 16-bit control word, most significant byte first, tells for each of the next 16 items whether it is a literal
 * byte (bit clear) or a command (bit set), most significant bit first. A command byte has its command in the high nibble
 * and a count in the low one: 0 repeats the next byte 3 and the count more times; 1 repeats the byte after the next one,
 * 19 and the count and the next byte times 16 more times; 2 copies 16 and the byte after the offset more bytes; 3 to 15
 * copy that many bytes. The copies come from `offset` bytes back in the output, which is the count plus 3 and the next
 * byte times 16.
 */
export function rdcDecompress(input: Uint8Array, rowLength: number): Uint8Array {
  const out = new Output(rowLength);
  let position = 0;
  let controlBits = 0;
  let controlMask = 0;
  while (position < input.length) {
    controlMask >>= 1;
    if (controlMask === 0) {
      need(input, position, 2);
      controlBits = (input[position]! << 8) | input[position + 1]!;
      position += 2;
      controlMask = 0x8000;
      // A control word that ends the input has no items after it.
      if (position >= input.length) break;
    }
    if ((controlBits & controlMask) === 0) {
      out.fill(input[position++]!, 1);
      continue;
    }
    position = rdcCommand(out, input, position);
  }
  return out.finish("RDC");
}

function rdcCommand(out: Output, input: Uint8Array, start: number): number {
  let position = start;
  const control = input[position++]!;
  const command = control >> 4;
  const count = control & 0x0f;
  if (command === 0) {
    need(input, position, 1);
    out.fill(input[position++]!, count + 3);
  } else if (command === 1) {
    need(input, position, 2);
    const repeats = count + (input[position]! << 4) + 19;
    out.fill(input[position + 1]!, repeats);
    position += 2;
  } else if (command === 2) {
    need(input, position, 2);
    const distance = count + 3 + (input[position]! << 4);
    out.repeat(distance, input[position + 1]! + 16);
    position += 2;
  } else {
    need(input, position, 1);
    out.repeat(count + 3 + (input[position]! << 4), command);
    position += 1;
  }
  return position;
}
