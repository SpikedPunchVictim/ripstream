declare module "lz4js" {
  export function compress(data: Uint8Array | number[]): Uint8Array;
  export function decompress(data: Uint8Array | number[]): Uint8Array;
}
