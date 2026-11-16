import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import test from 'node:test';
import { countMp3Frames } from '../src/mp3/count-frames.js';
import { countMp3FramesStream } from '../src/mp3/count-frames-stream.js';
import { Mp3ParseError } from '../src/mp3/parse-error.js';
import { makeApeTag, makeFrame, makeId3Tag, makeId3v1ExtendedTag, makeId3v1Tag, makeInformationFrame, makeLyrics3Tag } from './fixtures.js';

async function* chunks(file: Buffer, size = 7): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < file.length; offset += size) yield file.subarray(offset, offset + size);
}

function taggedFile(): Buffer {
  return Buffer.concat([
    makeId3Tag(makeFrame(), 3), makeId3Tag(Buffer.alloc(130), 4, true),
    makeInformationFrame(), makeFrame({ bitrateIndex: 1, byteLength: 104 }),
    makeFrame({ padding: true, byteLength: 418 }),
    makeLyrics3Tag('old lyrics', 1), makeApeTag(makeFrame(), true),
    makeLyrics3Tag('LYRICSEND 000011LYRICS200 inside a field', 2),
    makeId3v1ExtendedTag(), makeId3v1Tag(), makeId3Tag(makeFrame(), 4, true),
  ]);
}

for (const size of [1, 7, 417, 65536]) {
  test(`streaming parser agrees with buffered parser using ${size}-byte chunks`, async () => {
    const file = taggedFile();
    assert.equal(await countMp3FramesStream(chunks(file, size)), countMp3Frames(file));
  });
}

test('every possible two-chunk split preserves headers, frames, footers and tag boundaries', async () => {
  const file = taggedFile();
  for (let split = 0; split <= file.length; split += 1) {
    async function* source() {
      yield file.subarray(0, split);
      yield Buffer.alloc(0);
      yield file.subarray(split);
    }
    assert.equal(await countMp3FramesStream(source()), 2, `split at ${split}`);
  }
});

for (const size of [1024, 4096, 65536]) {
  test(`streams the actual sample from disk with ${size}-byte reads`, async () => {
    assert.equal(await countMp3FramesStream(createReadStream(new URL('../sample.mp3', import.meta.url), { highWaterMark: size })), 6089);
  });
}

test('recognizes mono/stereo Xing and Info, CRC and every supported sample rate', async () => {
  for (const mono of [false, true]) {
    for (const marker of ['Xing', 'Info']) {
      const info = makeInformationFrame(marker, mono);
      info[1] = 0xfa;
      const file = Buffer.concat([
        info, makeFrame({ mono, crcProtected: true }),
        makeFrame({ sampleRateIndex: 1, byteLength: 384 }),
        makeFrame({ bitrateIndex: 14, sampleRateIndex: 2, padding: true, byteLength: 1441 }), makeInformationFrame(marker, mono),
      ]);
      assert.equal(await countMp3FramesStream(chunks(file, 1)), 4);
    }
  }
});

test('TAG with a title starting in + is not mistaken for the TAG+ extension', async () => {
  const tag = makeId3v1Tag();
  tag[3] = 0x2b;
  for (const following of [Buffer.alloc(0), makeApeTag(makeFrame(), true)]) {
    assert.equal(await countMp3FramesStream(chunks(Buffer.concat([makeFrame(), tag, following]))), 1);
  }
});

test('Lyrics3v1 accepts empty/maximum text and falls back when text resembles v2 fields', async () => {
  for (const text of ['', 'x'.repeat(5100), 'LYR00100short lyrics', 'LYR00000LYR00000lyrics']) {
    const file = Buffer.concat([makeFrame(), makeLyrics3Tag(text, 1), makeApeTag(Buffer.alloc(6000), true), makeId3v1Tag()]);
    assert.equal(await countMp3FramesStream(chunks(file, 11)), 1);
  }
});

test('Lyrics3v2 skips long field payloads containing apparent frames and tag endings', async () => {
  const text = 'LYRICSEND LYRICSBEGIN 000011LYRICS200 \xff'.repeat(1000);
  const file = Buffer.concat([makeFrame(), makeLyrics3Tag(text, 2), makeId3v1Tag()]);
  assert.equal(await countMp3FramesStream(chunks(file, 17)), 1);
});

test('accepts the maximum six-digit Lyrics3v2 body and rejects a mismatched size', async () => {
  const fields: Buffer[] = [Buffer.from('LYRICSBEGIN')];
  for (let index = 0; index < 9; index++) fields.push(Buffer.from('LYR99999'), Buffer.alloc(99999, 0xff));
  fields.push(Buffer.from('LYR99917'), Buffer.alloc(99917));
  const body = Buffer.concat(fields);
  assert.equal(body.length, 999999);
  const file = Buffer.concat([makeFrame(), body, Buffer.from('999999LYRICS200'), makeId3v1Tag()]);
  assert.equal(await countMp3FramesStream(chunks(file, 65536)), 1);
  file.write('999998', makeFrame().length + body.length);
  await assert.rejects(countMp3FramesStream(chunks(file, 65536)), Mp3ParseError);
});

test('peeks through many small Lyrics3v2 fields and preserves the following tags', async () => {
  const body = Buffer.from(`LYRICSBEGIN${'LYR00000'.repeat(40000)}`);
  const ending = Buffer.from(`${body.length.toString().padStart(6, '0')}LYRICS200`);
  const file = Buffer.concat([makeFrame(), body, ending, makeId3v1Tag(), makeApeTag(Buffer.alloc(10), true)]);
  assert.equal(await countMp3FramesStream(chunks(file, 4096)), 1);
});

test('streams large declared ID3 and headered APE bodies without constructing whole tags', async () => {
  const block = Buffer.alloc(65536, 0xff);
  const bodySize = block.length * 256; // 16 MiB per tag, generated incrementally.
  const id3 = makeId3Tag(Buffer.alloc(0));
  for (let index = 0; index < 4; index++) id3[6 + index] = (bodySize >>> (7 * (3 - index))) & 0x7f;
  const ape = makeApeTag(Buffer.alloc(0), true);
  const header = Buffer.from(ape.subarray(0, 32));
  const footer = Buffer.from(ape.subarray(-32));
  header.writeUInt32LE(bodySize + 32, 12);
  footer.writeUInt32LE(bodySize + 32, 12);
  async function* source() {
    yield id3;
    for (let i = 0; i < 256; i++) yield block;
    yield makeFrame();
    yield header;
    for (let i = 0; i < 256; i++) yield block;
    yield footer;
  }
  assert.equal(await countMp3FramesStream(source()), 1);
});

test('rejects footer-only APEv2 while the buffered parser still accepts it', async () => {
  const file = Buffer.concat([makeFrame(), makeApeTag(makeFrame())]);
  assert.equal(countMp3Frames(file), 1);
  await assert.rejects(countMp3FramesStream(chunks(file)), Mp3ParseError);
});

test('rejects incomplete and corrupt audio rather than returning a partial count', async () => {
  const badFlags = makeInformationFrame();
  badFlags.writeUInt32BE(0x10, 40);
  const badVersion = makeFrame();
  badVersion[1] = 0xf3;
  const invalidBitrate = makeFrame({ bitrateIndex: 15 });
  const files = [
    Buffer.alloc(0), Buffer.from('not MP3'), makeInformationFrame(), badFlags,
    badVersion, invalidBitrate, makeFrame({ bitrateIndex: 0 }),
    makeFrame().subarray(0, 100), Buffer.concat([makeFrame(), Buffer.from([0xff, 0xfb])]),
    Buffer.concat([makeFrame(), makeId3v1Tag(), makeFrame()]),
    Buffer.concat([makeFrame(), Buffer.from('junk')]),
  ];
  for (const file of files) await assert.rejects(countMp3FramesStream(chunks(file, 1)), Mp3ParseError);
});

test('rejects malformed/truncated trailers and metadata without audio', async () => {
  const badId3 = makeId3Tag(Buffer.alloc(20), 4, true);
  badId3[badId3.length - 4] = 0x80;
  const badApe = makeApeTag(Buffer.alloc(10), true);
  badApe.writeUInt32LE(1, badApe.length - 8);
  const mismatchedApe = makeApeTag(Buffer.alloc(10), true);
  mismatchedApe.writeUInt32LE(2, mismatchedApe.length - 16);
  const badLyrics = makeLyrics3Tag();
  badLyrics.write('999999', badLyrics.length - 15);
  const tags = [
    badId3, badApe, mismatchedApe, badLyrics,
    makeId3Tag(Buffer.alloc(20)), makeId3v1ExtendedTag(),
    makeLyrics3Tag('x'.repeat(5101), 1), makeLyrics3Tag('bad\xfftext', 1),
    makeLyrics3Tag('badLYRICSENDtext', 1),
    makeApeTag(Buffer.alloc(0), true).subarray(0, -1),
    makeId3Tag(Buffer.alloc(20), 4, true).subarray(0, -1),
  ];
  for (const tag of tags) await assert.rejects(countMp3FramesStream(chunks(Buffer.concat([makeFrame(), tag]))), Mp3ParseError);
  for (const tag of [makeId3v1Tag(), makeLyrics3Tag(), makeApeTag(Buffer.alloc(0), true), makeId3Tag(Buffer.alloc(0))]) {
    await assert.rejects(countMp3FramesStream(chunks(tag)), /No MPEG-1/);
  }
});

test('propagates interrupted source errors during audio, lookahead and invalid-input draining', async () => {
  const failure = new Error('connection interrupted');
  for (const prefix of [
    Buffer.from('invalid'), makeFrame().subarray(0, 100),
    Buffer.concat([makeFrame(), Buffer.from('LYRICSBEGINlyrics')]),
  ]) {
    let closed = false;
    async function* source() {
      try {
        yield prefix;
        throw failure;
      } finally {
        closed = true;
      }
    }
    await assert.rejects(countMp3FramesStream(source()), (error) => error === failure);
    assert.equal(closed, true);
  }
});
