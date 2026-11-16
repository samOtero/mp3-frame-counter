import { Mp3ParseError } from './parse-error.js';

export function readId3v2Header(header: Buffer) {
  if (header.length < 10) throw new Mp3ParseError('Incomplete ID3v2 header.');
  const version = header.readUInt8(3);
  const revision = header.readUInt8(4);
  const flags = header.readUInt8(5);
  const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : 0xf0;
  if (header.toString('latin1', 0, 3) !== 'ID3' || version < 2 || version > 4
    || revision === 0xff || (flags & ~allowedFlags) !== 0) {
    throw new Mp3ParseError('Invalid or unsupported ID3v2 header.');
  }
  return { version, bodySize: readSynchsafeSize(header, 6), hasFooter: version === 4 && (flags & 0x10) !== 0 };
}

export function checkId3v2Footer(header: Buffer, footer: Buffer): void {
  if (footer.length !== 10 || footer.toString('latin1', 0, 3) !== '3DI'
    || !footer.subarray(3).equals(header.subarray(3, 10))) {
    throw new Mp3ParseError('Invalid ID3v2 footer.');
  }
}

export function readSynchsafeSize(file: Buffer, offset: number): number {
  let size = 0;
  for (let index = 0; index < 4; index += 1) {
    const byte = file.readUInt8(offset + index);
    if ((byte & 0x80) !== 0) throw new Mp3ParseError('Invalid ID3v2 tag size.');
    size = size * 128 + byte;
  }
  return size;
}

export function readApeFooter(footer: Buffer) {
  if (footer.length !== 32 || footer.toString('latin1', 0, 8) !== 'APETAGEX') {
    throw new Mp3ParseError('Invalid APEv2 footer.');
  }
  const size = footer.readUInt32LE(12);
  const itemCount = footer.readUInt32LE(16);
  const flags = footer.readUInt32LE(20);
  if (footer.readUInt32LE(8) !== 2000 || size < 32 || (flags & 0x7ffffffe) !== 0
    || !footer.subarray(24).equals(Buffer.alloc(8)) || itemCount > Math.floor((size - 32) / 11)) {
    throw new Mp3ParseError('Invalid or incomplete APEv2 tag.');
  }
  return { size, hasHeader: (flags & 0x80000000) !== 0 };
}

export function checkApeHeader(header: Buffer, footer: Buffer): void {
  if (header.toString('latin1', 0, 8) !== 'APETAGEX'
    || !header.subarray(8, 20).equals(footer.subarray(8, 20))
    || header.readUInt32LE(20) !== ((footer.readUInt32LE(20) | 0x20000000) >>> 0)
    || !header.subarray(24).equals(footer.subarray(24))) {
    throw new Mp3ParseError('APEv2 header and footer do not match.');
  }
}
