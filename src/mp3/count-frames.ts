import { isInformationFrame, readFrameHeader } from './frame-header.js';
import { Mp3ParseError } from './parse-error.js';
import { checkApeHeader, checkId3v2Footer, readApeFooter, readId3v2Header, readSynchsafeSize } from './tag-headers.js';
export { Mp3ParseError } from './parse-error.js';

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

  const header = file.subarray(offset, offset + 10);
  const { bodySize: tagSize, hasFooter } = readId3v2Header(header);
  const tagEnd = offset + 10 + tagSize + (hasFooter ? 10 : 0);
  if (tagEnd > limit) {
    throw new Mp3ParseError('Incomplete ID3v2 tag.');
  }

  if (hasFooter) {
    checkId3v2Footer(header, file.subarray(tagEnd - 10, tagEnd));
  }

  return tagEnd;
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
  const footerBytes = file.subarray(footer, end);
  const { size: tagSize, hasHeader } = readApeFooter(footerBytes);

  // APE size includes the footer but excludes an optional 32-byte header.
  const start = end - tagSize - (hasHeader ? 32 : 0);
  if (start < audioStart) {
    throw new Mp3ParseError('Invalid or incomplete APEv2 tag.');
  }

  if (hasHeader) {
    checkApeHeader(file.subarray(start, start + 32), footerBytes);
  }

  return start;
}
