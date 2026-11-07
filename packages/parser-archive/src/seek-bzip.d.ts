declare module "seek-bzip" {
  const bzip: {
    decode(input: Uint8Array | Buffer): Uint8Array;
  };
  export default bzip;
}
