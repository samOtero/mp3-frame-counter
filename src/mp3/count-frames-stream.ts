import { Readable } from 'node:stream';
import { EndOfStreamError, fromStream } from 'strtok3';
import type { ITokenizer } from 'strtok3';
import { isInformationFrame, readFrameHeader } from './frame-header.js';
import { Mp3ParseError } from './parse-error.js';
import {
  checkApeHeader,
  checkId3v2Footer,
  readApeFooter,
  readId3v2Header,
} from './tag-headers.js';

const MAX_LYRICS3_TAG_BYTES = 1_000_014;

export async function countMp3FramesStream(
  source: AsyncIterable<Uint8Array>,
): Promise<number> {
  const stream = Readable.from(source, {
    objectMode: false,
    highWaterMark: 64 * 1024,
  });
  const tokenizer = await fromStream(stream, {
    maxBufferSize: MAX_LYRICS3_TAG_BYTES,
  });
  try {
    return await countFrames(tokenizer);
  } catch (error) {
    // Finish consuming an invalid upload so multipart limits/errors are still
    // observed. Close the tokenizer first to discard its buffered lookahead.
    if (error instanceof Mp3ParseError) {
      await tokenizer.close();
      for await (const _chunk of stream) {
        /* Discard the rest of the upload. */
      }
    }
    throw stream.errored ?? error;
  } finally {
    await tokenizer.close();
    stream.destroy();
  }
}

async function countFrames(tokenizer: ITokenizer): Promise<number> {
  let frameCount = 0;
  let firstFrame = true;
  let trailingMetadata = false;

  while (true) {
    const offset = tokenizer.position;
    const prefix = await readUpTo(tokenizer, 4);
    if (prefix.length === 0) break;
    if (prefix.length < 4)
      throw new Mp3ParseError(`Incomplete MPEG header at byte ${offset}.`);
    const marker = prefix.toString('latin1');

    if (marker.startsWith('ID3')) {
      const header = Buffer.concat([
        prefix,
        await readBytes(tokenizer, 6, 'ID3v2 header'),
      ]);
      const tag = readId3v2Header(header);
      if (!firstFrame || trailingMetadata) {
        trailingMetadata = true;
        if (tag.version !== 4 || !tag.hasFooter) {
          throw new Mp3ParseError(
            'Appended ID3v2.4 tags require a matching footer.',
          );
        }
      }
      await skipBytes(tokenizer, tag.bodySize, 'ID3v2 tag');
      if (tag.hasFooter)
        checkId3v2Footer(
          header,
          await readBytes(tokenizer, 10, 'ID3v2 footer'),
        );
    } else if (marker.startsWith('TAG')) {
      trailingMetadata = true;
      await skipId3v1(tokenizer, prefix);
    } else if (marker === 'LYRI') {
      trailingMetadata = true;
      const begin = Buffer.concat([
        prefix,
        await readBytes(tokenizer, 7, 'Lyrics3 opening marker'),
      ]);
      if (begin.toString('latin1') !== 'LYRICSBEGIN')
        throw new Mp3ParseError('Invalid Lyrics3 opening marker.');
      await skipLyrics3(tokenizer);
    } else if (marker === 'APET') {
      trailingMetadata = true;
      await skipApe(tokenizer, prefix);
    } else {
      if (trailingMetadata)
        throw new Mp3ParseError(
          `Unexpected data after trailing metadata at byte ${offset}.`,
        );
      const frame = readFrameHeader(prefix, 0, prefix.length, offset);
      const description = `MPEG frame at byte ${offset}`;
      if (firstFrame) {
        const bytes = Buffer.concat([
          prefix,
          await readBytes(tokenizer, frame.length - 4, description),
        ]);
        if (!isInformationFrame(bytes, 0, frame)) frameCount += 1;
      } else {
        await skipBytes(tokenizer, frame.length - 4, description);
        frameCount += 1;
      }
      firstFrame = false;
    }
  }

  if (tokenizer.position === 0)
    throw new Mp3ParseError('The uploaded file is empty.');
  if (frameCount === 0)
    throw new Mp3ParseError('No MPEG-1 Layer III audio frames were found.');
  return frameCount;
}

async function skipId3v1(tokenizer: ITokenizer, prefix: Buffer): Promise<void> {
  if (prefix.toString('latin1') !== 'TAG+') {
    await skipBytes(tokenizer, 124, 'ID3v1 tag');
    return;
  }
  // TAG+ can also be an ordinary TAG whose title starts with '+'. Look ahead
  // only far enough to check for the extension's required following TAG.
  const rest = await peekBytes(tokenizer, 351);
  const hasExtension =
    rest.length === 351 && rest.toString('latin1', 223, 226) === 'TAG';
  await skipBytes(tokenizer, hasExtension ? 351 : 124, 'ID3v1 tag');
}

async function skipApe(tokenizer: ITokenizer, prefix: Buffer): Promise<void> {
  const header = Buffer.concat([
    prefix,
    await readBytes(tokenizer, 28, 'APEv2 header'),
  ]);
  // Validate the header using the shared footer rules with its header flag cleared.
  const expectedFooter = Buffer.from(header);
  expectedFooter.writeUInt32LE(
    (header.readUInt32LE(20) & ~0x20000000) >>> 0,
    20,
  );
  const tag = readApeFooter(expectedFooter);
  if (!tag.hasHeader || (header.readUInt32LE(20) & 0x20000000) === 0) {
    throw new Mp3ParseError(
      'The streaming endpoint requires APEv2 tags to have a header and footer.',
    );
  }
  await skipBytes(tokenizer, tag.size - 32, 'APEv2 tag');
  const footer = await readBytes(tokenizer, 32, 'APEv2 footer');
  readApeFooter(footer);
  checkApeHeader(header, footer);
}

// Both Lyrics3 versions begin with LYRICSBEGIN. Try v2's field lengths first,
// peeking without advancing so v1 text that resembles a field can fall back.
// LYRICSBEGIN has already been consumed. Grow lookahead geometrically so many
// small fields do not repeatedly copy the entire prefix on every field read.
async function skipLyrics3(tokenizer: ITokenizer): Promise<void> {
  const maxLookahead = MAX_LYRICS3_TAG_BYTES - 11;
  let lookahead: Buffer = Buffer.alloc(0);
  let inspected = 0;
  async function take(length: number): Promise<Buffer> {
    const required = inspected + length;
    if (required > maxLookahead)
      throw new Mp3ParseError('Invalid Lyrics3v2 tag size.');
    if (required > lookahead.length) {
      const size = Math.min(
        maxLookahead,
        Math.max(required, lookahead.length * 2, 5109),
      );
      lookahead = await peekBytes(tokenizer, size);
    }
    if (required > lookahead.length)
      throw new Mp3ParseError('Incomplete Lyrics3 tag.');
    const bytes = lookahead.subarray(inspected, required);
    inspected = required;
    return bytes;
  }

  try {
    let bodySize = 11;
    while (true) {
      const field = await take(8);
      const text = field.toString('latin1');
      if (/^[0-9]{6}LY$/.test(text)) {
        const ending = await take(7);
        if (
          ending.toString('latin1') !== 'RICS200' ||
          Number(text.slice(0, 6)) !== bodySize
        ) {
          throw new Mp3ParseError('Invalid Lyrics3v2 footer or size.');
        }
        await skipBytes(tokenizer, inspected, 'Lyrics3v2 tag');
        return;
      }
      if (!/^[0-9]{5}$/.test(text.slice(3)))
        throw new Mp3ParseError('Invalid Lyrics3v2 field size.');
      const size = Number(text.slice(3));
      if (bodySize + 8 + size > 999999)
        throw new Mp3ParseError('Invalid Lyrics3v2 tag size.');
      await take(size);
      bodySize += 8 + size;
    }
  } catch (error) {
    if (!(error instanceof Mp3ParseError)) throw error;
    // v1 permits up to 5100 lyric bytes followed by its nine-byte ending.
    const bytes = await peekBytes(tokenizer, 5109);
    const end = bytes.indexOf('LYRICSEND');
    const text = bytes.subarray(0, end);
    if (
      end < 0 ||
      end > 5100 ||
      text.indexOf(0xff) !== -1 ||
      text.indexOf('LYRICSBEGIN') !== -1
    ) {
      throw new Mp3ParseError('Invalid, incomplete or oversized Lyrics3 tag.');
    }
    await skipBytes(tokenizer, end + 9, 'Lyrics3v1 tag');
  }
}

async function readUpTo(
  tokenizer: ITokenizer,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const count = await tokenizer.readBuffer(bytes, { mayBeLess: true });
  return bytes.subarray(0, count);
}

async function readBytes(
  tokenizer: ITokenizer,
  length: number,
  description: string,
): Promise<Buffer> {
  const bytes = await readUpTo(tokenizer, length);
  if (bytes.length !== length)
    throw new Mp3ParseError(`Incomplete ${description}.`);
  return bytes;
}

async function peekBytes(
  tokenizer: ITokenizer,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const count = await tokenizer.peekBuffer(bytes, { mayBeLess: true });
  return bytes.subarray(0, count);
}

async function skipBytes(
  tokenizer: ITokenizer,
  length: number,
  description: string,
): Promise<void> {
  try {
    const count = await tokenizer.ignore(length);
    if (count !== length) throw new EndOfStreamError();
  } catch (error) {
    if (error instanceof EndOfStreamError)
      throw new Mp3ParseError(`Incomplete ${description}.`);
    throw error;
  }
}
