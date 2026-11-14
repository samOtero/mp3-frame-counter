const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES_HZ = [44100, 48000, 32000];

export class Mp3ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp3ParseError';
  }
}

interface FrameHeader {
  length: number;
  mono: boolean;
}

export function countMp3Frames(file: Buffer): number {
  if (file.length === 0) {
    throw new Mp3ParseError('The uploaded file is empty.');
  }

  let offset = skipId3v2Tags(file);
  const audioEnd = skipTrailingTags(file, offset);

  let frameCount = 0;
  let firstFrame = true;

  while (offset < audioEnd) {
    const frame = readFrameHeader(file, offset, audioEnd);

    if (offset + frame.length > audioEnd) {
      throw new Mp3ParseError(`Incomplete MPEG frame at byte ${offset}.`);
    }

    // Match MediaInfo's audio-frame convention without trusting the tag's count.
    if (!firstFrame || !isInformationFrame(file, offset, frame)) {
      frameCount += 1;
    }

    offset += frame.length;
    firstFrame = false;
  }

  if (frameCount === 0) {
    throw new Mp3ParseError('No MPEG-1 Layer III audio frames were found.');
  }

  return frameCount;
}

function skipId3v2Tags(file: Buffer): number {
  let offset = 0;

  while (file.toString('latin1', offset, offset + 3) === 'ID3') {
    offset = readId3v2TagEnd(file, offset, file.length);
  }

  return offset;
}

function readId3v2TagEnd(file: Buffer, offset: number, limit: number): number {
  if (offset + 10 > limit) {
    throw new Mp3ParseError('Incomplete ID3v2 header.');
  }

  const version = file.readUInt8(offset + 3);
  const revision = file.readUInt8(offset + 4);
  const flags = file.readUInt8(offset + 5);
  const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : 0xf0;

  if (file.toString('latin1', offset, offset + 3) !== 'ID3'
    || version < 2 || version > 4 || revision === 0xff || (flags & ~allowedFlags) !== 0) {
    throw new Mp3ParseError('Invalid or unsupported ID3v2 header.');
  }

  const tagSize = readSynchsafeSize(file, offset + 6);
  const hasFooter = version === 4 && (flags & 0x10) !== 0;
  const tagEnd = offset + 10 + tagSize + (hasFooter ? 10 : 0);
  if (tagEnd > limit) {
    throw new Mp3ParseError('Incomplete ID3v2 tag.');
  }

  if (hasFooter) {
    const footer = tagEnd - 10;
    if (file.toString('latin1', footer, footer + 3) !== '3DI'
      || !file.subarray(footer + 3, tagEnd).equals(file.subarray(offset + 3, offset + 10))) {
      throw new Mp3ParseError('Invalid ID3v2 footer.');
    }
  }

  return tagEnd;
}

function readSynchsafeSize(file: Buffer, offset: number): number {
  // ID3 sizes use four 7-bit bytes (a synchsafe integer).
  let size = 0;
  for (let index = 0; index < 4; index += 1) {
    const byte = file.readUInt8(offset + index);
    if ((byte & 0x80) !== 0) {
      throw new Mp3ParseError('Invalid ID3v2 tag size.');
    }
    size = size * 128 + byte;
  }
  return size;
}

function skipTrailingTags(file: Buffer, audioStart: number): number {
  let end = file.length;

  // Peel recognized tags off the end repeatedly, allowing tag combinations.
  while (end > audioStart) {
    if (end - audioStart >= 128 && file.toString('latin1', end - 128, end - 125) === 'TAG') {
      end -= 128;
      // The 227-byte TAG+ extension belongs immediately before ID3v1.
      if (end - audioStart >= 227 && file.toString('latin1', end - 227, end - 223) === 'TAG+') {
        end -= 227;
      }
      continue;
    }

    if (end - audioStart >= 9 && file.toString('latin1', end - 9, end) === 'LYRICS200') {
      end = readLyrics3v2TagStart(file, end, audioStart);
      continue;
    }

    if (end - audioStart >= 9 && file.toString('latin1', end - 9, end) === 'LYRICSEND') {
      end = readLyrics3v1TagStart(file, end, audioStart);
      continue;
    }

    if (end - audioStart >= 10 && file.toString('latin1', end - 10, end - 7) === '3DI') {
      const footer = end - 10;
      const tagSize = readSynchsafeSize(file, footer + 6);
      // ID3v2.4 sizes exclude both the 10-byte header and 10-byte footer.
      const start = end - tagSize - 20;
      if (start < audioStart || file.readUInt8(footer + 3) !== 4
        || (file.readUInt8(footer + 5) & 0x10) === 0) {
        throw new Mp3ParseError('Invalid appended ID3v2.4 tag.');
      }
      if (readId3v2TagEnd(file, start, end) !== end) {
        throw new Mp3ParseError('Appended ID3v2.4 header and footer do not match.');
      }
      end = start;
      continue;
    }

    if (end - audioStart >= 32 && file.toString('latin1', end - 32, end - 24) === 'APETAGEX') {
      end = readApeTagStart(file, end, audioStart);
      continue;
    }

    break;
  }

  return end;
}

function readLyrics3v2TagStart(file: Buffer, end: number, audioStart: number): number {
  // The six decimal size digits precede LYRICS200 and exclude this 15-byte tail.
  if (end - audioStart < 15) {
    throw new Mp3ParseError('Incomplete Lyrics3v2 tag.');
  }
  const sizeOffset = end - 15;
  const sizeText = file.toString('latin1', sizeOffset, sizeOffset + 6);
  if (!/^[0-9]{6}$/.test(sizeText)) {
    throw new Mp3ParseError('Invalid Lyrics3v2 tag size.');
  }

  const tagSize = Number(sizeText);
  const start = sizeOffset - tagSize;
  if (tagSize < 11 || start < audioStart
    || file.toString('latin1', start, start + 11) !== 'LYRICSBEGIN') {
    throw new Mp3ParseError('Invalid or incomplete Lyrics3v2 tag.');
  }

  return start;
}

function readLyrics3v1TagStart(file: Buffer, end: number, audioStart: number): number {
  // There is no size field: search only enough bytes for the opening marker and
  // up to 5100 lyric bytes, never the whole audio file.
  const textEnd = end - 9;
  const searchStart = Math.max(audioStart, textEnd - 5100 - 11);
  const window = file.subarray(searchStart, textEnd);
  const markerOffset = window.lastIndexOf('LYRICSBEGIN');
  if (markerOffset === -1) {
    throw new Mp3ParseError('Invalid or oversized Lyrics3v1 tag.');
  }

  const start = searchStart + markerOffset;
  const text = file.subarray(start + 11, textEnd);
  // Lyrics3v1 text cannot contain 0xff or either of its boundary markers.
  if (text.indexOf(0xff) !== -1 || text.indexOf('LYRICSEND') !== -1) {
    throw new Mp3ParseError('Invalid Lyrics3v1 tag text.');
  }

  return start;
}

function readApeTagStart(file: Buffer, end: number, audioStart: number): number {
  const footer = end - 32;
  const version = file.readUInt32LE(footer + 8);
  const tagSize = file.readUInt32LE(footer + 12);
  const itemCount = file.readUInt32LE(footer + 16);
  const flags = file.readUInt32LE(footer + 20);
  const hasHeader = (flags & 0x80000000) !== 0;

  // APE size includes the footer but excludes an optional 32-byte header.
  const start = end - tagSize - (hasHeader ? 32 : 0);
  if (version !== 2000 || tagSize < 32 || start < audioStart
    || (flags & 0x7ffffffe) !== 0
    || !file.subarray(footer + 24, end).equals(Buffer.alloc(8))
    || itemCount > Math.floor((tagSize - 32) / 11)) {
    throw new Mp3ParseError('Invalid or incomplete APEv2 tag.');
  }

  if (hasHeader) {
    // The header matches the footer except for its "is header" flag.
    if (file.toString('latin1', start, start + 8) !== 'APETAGEX'
      || !file.subarray(start + 8, start + 20).equals(file.subarray(footer + 8, footer + 20))
      || file.readUInt32LE(start + 20) !== ((flags | 0x20000000) >>> 0)
      || !file.subarray(start + 24, start + 32).equals(file.subarray(footer + 24, end))) {
      throw new Mp3ParseError('APEv2 header and footer do not match.');
    }
  }

  return start;
}

function readFrameHeader(file: Buffer, offset: number, audioEnd: number): FrameHeader {
  if (offset + 4 > audioEnd) {
    throw new Mp3ParseError(`Incomplete MPEG header at byte ${offset}.`);
  }

  const header = file.readUInt32BE(offset);
  if (header >>> 21 !== 0x7ff) {
    throw new Mp3ParseError(`Invalid MPEG frame header at byte ${offset}.`);
  }

  const version = (header >>> 19) & 0b11;
  const layer = (header >>> 17) & 0b11;
  if (version !== 0b11 || layer !== 0b01) {
    throw new Mp3ParseError('Only MPEG Version 1 Audio Layer 3 is supported.');
  }

  const bitrateIndex = (header >>> 12) & 0b1111;
  const sampleRateIndex = (header >>> 10) & 0b11;
  const bitrateKbps = BITRATES_KBPS[bitrateIndex];
  const sampleRate = SAMPLE_RATES_HZ[sampleRateIndex];

  if (bitrateIndex === 0) {
    throw new Mp3ParseError('Free-format MP3 bitrate is not supported.');
  }
  if (bitrateKbps === undefined || sampleRate === undefined || (header & 0b11) === 0b10) {
    throw new Mp3ParseError(`Invalid MPEG frame header values at byte ${offset}.`);
  }

  const padding = (header >>> 9) & 1;
  return {
    // This is the total frame size, including its header and any CRC bytes.
    length: Math.floor((144000 * bitrateKbps) / sampleRate) + padding,
    mono: ((header >>> 6) & 0b11) === 0b11,
  };
}

function isInformationFrame(file: Buffer, offset: number, frame: FrameHeader): boolean {
  // Xing/Info uses the conventional offset of 21 bytes (mono) or 36 (stereo).
  const tagOffset = offset + (frame.mono ? 21 : 36);
  const frameEnd = offset + frame.length;
  if (tagOffset + 4 > frameEnd) {
    return false;
  }

  const marker = file.toString('latin1', tagOffset, tagOffset + 4);
  if (marker !== 'Xing' && marker !== 'Info') {
    return false;
  }

  if (tagOffset + 8 > frameEnd) {
    throw new Mp3ParseError('Incomplete Xing/Info information tag.');
  }

  const flags = file.readUInt32BE(tagOffset + 4);
  const requiredBytes = 8 + ((flags & 1) ? 4 : 0) + ((flags & 2) ? 4 : 0)
    + ((flags & 4) ? 100 : 0) + ((flags & 8) ? 4 : 0);
  if ((flags & ~0x0f) !== 0 || tagOffset + requiredBytes > frameEnd) {
    throw new Mp3ParseError('Invalid Xing/Info information tag.');
  }

  return true;
}
