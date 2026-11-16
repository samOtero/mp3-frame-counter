import { Mp3ParseError } from './parse-error.js';

const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES_HZ = [44100, 48000, 32000];

export interface FrameHeader {
  length: number;
  mono: boolean;
}

export function readFrameHeader(file: Buffer, offset: number, audioEnd: number, byteOffset = offset): FrameHeader {
  if (offset + 4 > audioEnd) {
    throw new Mp3ParseError(`Incomplete MPEG header at byte ${byteOffset}.`);
  }

  const header = file.readUInt32BE(offset);
  if (header >>> 21 !== 0x7ff) {
    throw new Mp3ParseError(`Invalid MPEG frame header at byte ${byteOffset}.`);
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
    throw new Mp3ParseError(`Invalid MPEG frame header values at byte ${byteOffset}.`);
  }

  const padding = (header >>> 9) & 1;
  return {
    // This is the total frame size, including its header and any CRC bytes.
    length: Math.floor((144000 * bitrateKbps) / sampleRate) + padding,
    mono: ((header >>> 6) & 0b11) === 0b11,
  };
}

export function isInformationFrame(file: Buffer, offset: number, frame: FrameHeader): boolean {
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
