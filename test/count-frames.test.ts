import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { countMp3Frames, Mp3ParseError } from '../src/mp3/count-frames.js';
import {
  makeFrame,
  makeId3Tag,
  makeId3v1Tag,
  makeInformationFrame,
} from './fixtures.js';

test('counts the supplied sample as 6089 audio frames, matching MediaInfo', async () => {
  const sample = await readFile(new URL('../sample.mp3', import.meta.url));
  assert.equal(countMp3Frames(sample), 6089);
});

test('counts a single frame without metadata', () => {
  assert.equal(countMp3Frames(makeFrame()), 1);
});

test('uses each frame bitrate and padding instead of assuming a fixed length', () => {
  const file = Buffer.concat([
    makeFrame({ bitrateIndex: 1, byteLength: 104 }), // 32 kbps, 44.1 kHz
    makeFrame({ padding: true, byteLength: 418 }), // 128 kbps with padding
    makeFrame({ bitrateIndex: 10, byteLength: 522 }), // 160 kbps
  ]);
  assert.equal(countMp3Frames(file), 3);
});

for (const [sampleRateIndex, byteLength] of [
  [1, 384],
  [2, 576],
] as const) {
  test(`supports sample-rate index ${sampleRateIndex}`, () => {
    assert.equal(countMp3Frames(makeFrame({ sampleRateIndex, byteLength })), 1);
  });
}

test('does not count sync-looking bytes embedded in an audio payload', () => {
  const frame = makeFrame();
  makeFrame().subarray(0, 4).copy(frame, 50);
  assert.equal(countMp3Frames(Buffer.concat([frame, makeFrame()])), 2);
});

for (const version of [2, 3, 4]) {
  test(`skips ID3v2.${version} metadata, including embedded MPEG-looking bytes`, () => {
    assert.equal(
      countMp3Frames(
        Buffer.concat([makeId3Tag(makeFrame(), version), makeFrame()]),
      ),
      1,
    );
  });
}

test('skips multiple leading ID3 tags and an ID3v2.4 footer', () => {
  const tags = [
    makeId3Tag(Buffer.alloc(130)),
    makeId3Tag(Buffer.alloc(8), 4, true),
  ];
  assert.equal(countMp3Frames(Buffer.concat([...tags, makeFrame()])), 1);
});

test('skips an ID3v1 trailer', () => {
  assert.equal(countMp3Frames(Buffer.concat([makeFrame(), makeId3v1Tag()])), 1);
});

for (const marker of ['Xing', 'Info']) {
  for (const mono of [false, true]) {
    test(`excludes initial ${marker} information frame (${mono ? 'mono' : 'stereo'}) without trusting its count`, () => {
      const file = Buffer.concat([
        makeInformationFrame(marker, mono),
        makeFrame({ mono }),
        makeFrame({ mono }),
      ]);
      assert.equal(countMp3Frames(file), 2);
    });
  }
}

test('counts CRC-protected frames without adding CRC bytes to the frame length', () => {
  assert.equal(
    countMp3Frames(
      Buffer.concat([makeFrame({ crcProtected: true }), makeFrame()]),
    ),
    2,
  );
});

test('recognizes the conventional Xing position in a CRC-protected information frame', () => {
  const info = makeInformationFrame();
  info[1] = 0xfa;
  assert.equal(countMp3Frames(Buffer.concat([info, makeFrame()])), 1);
});

test('only excludes information tags at the expected position in the first frame', () => {
  const frame = makeFrame();
  frame.write('Xing', 50);
  assert.equal(
    countMp3Frames(Buffer.concat([frame, makeInformationFrame()])),
    2,
  );
});

test('rejects an information frame without any audio frames', () => {
  assert.throws(() => countMp3Frames(makeInformationFrame()), /No MPEG-1/);
});

test('rejects empty or unrelated input', () => {
  assert.throws(() => countMp3Frames(Buffer.alloc(0)), /empty/);
  assert.throws(() => countMp3Frames(Buffer.from('not an mp3')), Mp3ParseError);
});

test('rejects a truncated frame instead of returning a partial count', () => {
  const file = Buffer.concat([makeFrame(), makeFrame().subarray(0, 100)]);
  assert.throws(
    () => countMp3Frames(file),
    /Incomplete MPEG frame at byte 417/,
  );
});

test('rejects a partial header or unexpected trailing bytes', () => {
  assert.throws(
    () =>
      countMp3Frames(Buffer.concat([makeFrame(), Buffer.from([0xff, 0xfb])])),
    /Incomplete MPEG header/,
  );
  assert.throws(
    () => countMp3Frames(Buffer.concat([makeFrame(), Buffer.from('junk')])),
    /Invalid MPEG frame header/,
  );
});

for (const headerByte of [0xf3, 0xfd]) {
  test(`rejects unsupported MPEG version/layer (header byte ${headerByte})`, () => {
    const frame = makeFrame();
    frame[1] = headerByte;
    assert.throws(
      () => countMp3Frames(frame),
      /Only MPEG Version 1 Audio Layer 3/,
    );
  });
}

test('rejects reserved bitrate, sample rate and emphasis values', () => {
  for (const [index, value] of [
    [2, 0xf0],
    [2, 0x9c],
    [3, 0x02],
  ] as const) {
    const frame = makeFrame();
    frame[index] = value;
    assert.throws(
      () => countMp3Frames(frame),
      /Invalid MPEG frame header values/,
    );
  }
});

test('rejects unsupported free-format bitrate explicitly', () => {
  assert.throws(
    () => countMp3Frames(makeFrame({ bitrateIndex: 0 })),
    /Free-format/,
  );
});

test('rejects truncated and malformed ID3 tags', () => {
  const invalidSize = makeId3Tag(Buffer.alloc(0));
  invalidSize[6] = 0x80;
  const invalidVersion = makeId3Tag(Buffer.alloc(0));
  invalidVersion[3] = 5;
  const invalidFlags = makeId3Tag(Buffer.alloc(0));
  invalidFlags[5] = 1;
  const invalidFooter = makeId3Tag(Buffer.alloc(0), 4, true);
  invalidFooter[10] = 0;
  for (const file of [
    Buffer.from('ID3'),
    makeId3Tag(Buffer.alloc(20)).subarray(0, 15),
    invalidSize,
    invalidVersion,
    invalidFlags,
    invalidFooter,
  ]) {
    assert.throws(() => countMp3Frames(file), Mp3ParseError);
  }
});

test('rejects malformed Xing flags or fields extending beyond their frame', () => {
  const invalidFlags = makeInformationFrame();
  invalidFlags.writeUInt32BE(0x10, 40);
  assert.throws(() => countMp3Frames(invalidFlags), /Invalid Xing/);
  const shortFrame = makeFrame({ bitrateIndex: 1, byteLength: 104 });
  shortFrame.write('Xing', 36);
  shortFrame.writeUInt32BE(4, 40); // A 100-byte TOC cannot fit in this frame.
  assert.throws(() => countMp3Frames(shortFrame), /Invalid Xing/);
});

test('compares metadata markers byte-for-byte without stripping high bits', () => {
  const id3 = makeId3Tag(Buffer.alloc(0));
  id3[0] = 0xc9; // Must not be decoded as ASCII "I".
  assert.throws(
    () => countMp3Frames(Buffer.concat([id3, makeFrame()])),
    Mp3ParseError,
  );
  const info = makeInformationFrame();
  info[36] = 0xd8; // Must not be decoded as ASCII "X".
  assert.equal(countMp3Frames(Buffer.concat([info, makeFrame()])), 2);
});
