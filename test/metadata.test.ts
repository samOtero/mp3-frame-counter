import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { countMp3Frames, Mp3ParseError } from '../src/mp3/count-frames.js';
import {
  makeApeTag,
  makeFrame,
  makeId3Tag,
  makeId3v1ExtendedTag,
  makeId3v1Tag,
  makeLyrics3Tag,
} from './fixtures.js';

test('skips the TAG+ extension together with its following ID3v1 tag', () => {
  const tags = [makeId3v1ExtendedTag(), makeId3v1Tag()];
  assert.equal(
    countMp3Frames(Buffer.concat([makeFrame(), makeFrame(), ...tags])),
    2,
  );
});

test('rejects an orphaned or truncated TAG+ extension', () => {
  const extension = makeId3v1ExtendedTag();
  assert.throws(
    () => countMp3Frames(Buffer.concat([makeFrame(), extension])),
    Mp3ParseError,
  );
  assert.throws(
    () =>
      countMp3Frames(
        Buffer.concat([
          makeFrame(),
          extension.subarray(0, 226),
          makeId3v1Tag(),
        ]),
      ),
    Mp3ParseError,
  );
});

for (const version of [1, 2] as const) {
  for (const withId3v1 of [false, true]) {
    test(`skips Lyrics3v${version} ${withId3v1 ? 'before ID3v1' : 'at the file end'}`, () => {
      const tags = [makeLyrics3Tag('first line\r\nsecond line', version)];
      if (withId3v1) tags.push(makeId3v1Tag());
      assert.equal(
        countMp3Frames(Buffer.concat([makeFrame(), makeFrame(), ...tags])),
        2,
      );
    });
  }
}

test('Lyrics3v1 accepts empty text and the 5100-byte text limit', () => {
  for (const size of [0, 5100]) {
    assert.equal(
      countMp3Frames(
        Buffer.concat([makeFrame(), makeLyrics3Tag('x'.repeat(size), 1)]),
      ),
      1,
    );
  }
});

test('Lyrics3v1 rejects text beyond its bounded search window', () => {
  const tag = makeLyrics3Tag('x'.repeat(5101), 1);
  assert.throws(
    () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
    /Lyrics3v1/,
  );
});

test('Lyrics3v1 chooses its own opening marker rather than a marker in the preceding audio', () => {
  const frame = makeFrame();
  frame.write('LYRICSBEGIN', 50);
  assert.equal(
    countMp3Frames(Buffer.concat([frame, makeLyrics3Tag('lyrics', 1)])),
    1,
  );
});

test('rejects Lyrics3v1 with no opening marker, forbidden bytes, or embedded end markers', () => {
  const tags = [
    Buffer.from('lyrics without a headerLYRICSEND'),
    makeLyrics3Tag('invalid\xfftext', 1),
    makeLyrics3Tag('invalidLYRICSENDtext', 1),
    makeLyrics3Tag('invalidLYRICSBEGINtext', 1),
  ];
  for (const tag of tags) {
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
});

test('Lyrics3v2 handles multi-digit sizes beyond the Lyrics3v1 limit', () => {
  assert.equal(
    countMp3Frames(
      Buffer.concat([makeFrame(), makeLyrics3Tag('x'.repeat(10000), 2)]),
    ),
    1,
  );
});

test('rejects Lyrics3v2 sizes that are not exactly six decimal digits', () => {
  for (const size of ['-00001', '0000 1', '0001a0', '00001\xb0']) {
    const tag = makeLyrics3Tag();
    tag.write(size, tag.length - 15, 'latin1');
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      /Lyrics3v2 tag size/,
    );
  }
});

test('rejects Lyrics3v2 sizes that are too small, oversized, or overlap leading metadata', () => {
  for (const size of ['000000', '000010', '999999']) {
    const tag = makeLyrics3Tag();
    tag.write(size, tag.length - 15, 'latin1');
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
  const file = Buffer.concat([
    makeId3Tag(Buffer.alloc(8)),
    makeFrame(),
    makeLyrics3Tag(),
  ]);
  file.write(
    (file.length - 15).toString().padStart(6, '0'),
    file.length - 15,
    'latin1',
  );
  assert.throws(() => countMp3Frames(file), /Lyrics3v2/);
});

test('rejects incomplete Lyrics3 tags and mismatched opening markers', () => {
  for (const version of [1, 2] as const) {
    const tag = makeLyrics3Tag('lyrics', version);
    const badOpening = Buffer.from(tag);
    badOpening[0] = 0;
    for (const broken of [badOpening, tag.subarray(0, tag.length - 1)]) {
      assert.throws(
        () => countMp3Frames(Buffer.concat([makeFrame(), broken])),
        Mp3ParseError,
      );
    }
  }
  assert.throws(
    () => countMp3Frames(Buffer.from('LYRICS200')),
    /Incomplete Lyrics3v2/,
  );
});

test('handles every supported trailer together without changing the real sample count', async () => {
  const sample = await readFile(new URL('../sample.mp3', import.meta.url));
  const tags = [
    makeLyrics3Tag('old lyrics', 1),
    makeApeTag(Buffer.from('title'), true),
    makeLyrics3Tag('new lyrics', 2),
    makeId3v1ExtendedTag(),
    makeId3v1Tag(),
    makeId3Tag(Buffer.alloc(130), 4, true),
  ];
  assert.equal(countMp3Frames(Buffer.concat([sample, ...tags])), 6089);
});

test('does not treat TAG+ or Lyrics3 text markers inside audio as trailing tags', () => {
  const frame = makeFrame();
  frame.write('TAG+', 60);
  frame.write('LYRICSBEGIN', 90);
  frame.write('LYRICSEND', 120);
  frame.write('LYRICS200', 150);
  assert.equal(countMp3Frames(frame), 1);
});

test('does not count extended ID3v1 or Lyrics3 metadata-only files as audio', () => {
  const tags = [
    Buffer.concat([makeId3v1ExtendedTag(), makeId3v1Tag()]),
    makeLyrics3Tag('lyrics', 1),
    makeLyrics3Tag('lyrics', 2),
  ];
  for (const tag of tags) {
    assert.throws(
      () => countMp3Frames(tag),
      /No MPEG-1 Layer III audio frames/,
    );
  }
});

for (const bodyLength of [0, 127, 128, 130]) {
  test(`skips appended ID3v2.4 with a ${bodyLength}-byte body`, () => {
    const tag = makeId3Tag(Buffer.alloc(bodyLength), 4, true);
    assert.equal(
      countMp3Frames(Buffer.concat([makeFrame(), makeFrame(), tag])),
      2,
    );
  });
}

for (const hasHeader of [false, true]) {
  test(`skips APEv2 with ${hasHeader ? 'a header and footer' : 'only a footer'}`, () => {
    // MPEG-looking bytes in metadata values must not be counted as audio frames.
    const tag = makeApeTag(makeFrame(), hasHeader);
    assert.equal(
      countMp3Frames(Buffer.concat([makeFrame(), makeFrame(), tag])),
      2,
    );
  });
}

test('handles combinations of trailing tags in different orders', () => {
  const id3v1 = makeId3v1Tag();
  const id3v2 = makeId3Tag(Buffer.alloc(130), 4, true);
  const ape = makeApeTag(Buffer.from('title'), true);
  const orders = [
    [ape, id3v1],
    [id3v2, id3v1],
    [id3v1, ape],
    [id3v2, ape, id3v1],
    [ape, id3v1, id3v2],
    [id3v2, id3v2],
  ];
  for (const tags of orders) {
    const leading = makeId3Tag(Buffer.alloc(8));
    assert.equal(
      countMp3Frames(
        Buffer.concat([leading, makeFrame(), makeFrame(), ...tags]),
      ),
      2,
    );
  }
});

test('the real sample retains its count when trailing metadata is added', async () => {
  const sample = await readFile(new URL('../sample.mp3', import.meta.url));
  const tags = [
    makeApeTag(Buffer.from('title'), true),
    makeId3Tag(Buffer.alloc(130), 4, true),
    makeId3v1Tag(),
  ];
  assert.equal(countMp3Frames(Buffer.concat([sample, ...tags])), 6089);
});

test('rejects appended ID3 tags with invalid size encodings or boundaries', () => {
  const invalidSize = makeId3Tag(Buffer.alloc(20), 4, true);
  invalidSize[invalidSize.length - 4] = 0x80;
  const oversized = makeId3Tag(Buffer.alloc(20), 4, true);
  oversized.fill(0x7f, oversized.length - 4);
  const mismatchedSize = makeId3Tag(Buffer.alloc(20), 4, true);
  mismatchedSize.fill(0, mismatchedSize.length - 4);
  for (const tag of [invalidSize, oversized, mismatchedSize]) {
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
});

test('rejects appended ID3 tags with inconsistent header/footer fields', () => {
  for (const [footerByte, value] of [
    [3, 3],
    [4, 1],
    [5, 0],
  ] as const) {
    const tag = makeId3Tag(Buffer.alloc(20), 4, true);
    tag[tag.length - 10 + footerByte] = value;
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
  const missingHeaderFlag = makeId3Tag(Buffer.alloc(20), 4, true);
  missingHeaderFlag[5] = 0;
  assert.throws(
    () => countMp3Frames(Buffer.concat([makeFrame(), missingHeaderFlag])),
    Mp3ParseError,
  );
});

test('rejects appended ID3 without its matching header or complete footer', () => {
  const tag = makeId3Tag(Buffer.alloc(20), 4, true);
  for (const broken of [
    tag.subarray(10),
    tag.subarray(0, tag.length - 1),
    makeId3Tag(Buffer.alloc(20)),
  ]) {
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), broken])),
      Mp3ParseError,
    );
  }
});

test('rejects APE sizes smaller than a footer or extending beyond the audio boundary', () => {
  for (const size of [0, 31, 0xffffffff]) {
    const tag = makeApeTag();
    tag.writeUInt32LE(size, tag.length - 32 + 12);
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
  const leading = makeId3Tag(Buffer.alloc(8));
  const tag = makeApeTag();
  const file = Buffer.concat([leading, makeFrame(), tag]);
  file.writeUInt32LE(file.length, file.length - 32 + 12);
  assert.throws(() => countMp3Frames(file), Mp3ParseError);
});

test('rejects invalid APE footer versions, flags, reserved bytes and item counts', () => {
  for (const [field, value] of [
    [8, 1000],
    [20, 0x10000000],
    [20, 0x20000000],
    [20, 0x40000000],
    [24, 1],
    [16, 1000000],
  ] as const) {
    const tag = makeApeTag();
    tag.writeUInt32LE(value, tag.length - 32 + field);
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
});

test('rejects missing or mismatched APE headers', () => {
  const missingHeader = makeApeTag();
  missingHeader.writeUInt32LE(0x80000000, missingHeader.length - 32 + 20);
  assert.throws(
    () => countMp3Frames(Buffer.concat([makeFrame(), missingHeader])),
    Mp3ParseError,
  );

  for (const [field, value] of [
    [8, 1999],
    [12, 100],
    [16, 0],
    [20, 0x80000000],
    [24, 1],
  ] as const) {
    const tag = makeApeTag(Buffer.from('title'), true);
    tag.writeUInt32LE(value, field);
    assert.throws(
      () => countMp3Frames(Buffer.concat([makeFrame(), tag])),
      Mp3ParseError,
    );
  }
});

test('rejects incomplete APE footers and arbitrary data after metadata', () => {
  const tag = makeApeTag();
  assert.throws(
    () =>
      countMp3Frames(
        Buffer.concat([makeFrame(), tag.subarray(0, tag.length - 1)]),
      ),
    Mp3ParseError,
  );
  assert.throws(
    () =>
      countMp3Frames(Buffer.concat([makeFrame(), tag, Buffer.from('junk')])),
    Mp3ParseError,
  );
});

test('does not count a metadata-only file as audio', () => {
  for (const tag of [
    makeId3v1Tag(),
    makeApeTag(),
    makeApeTag(Buffer.alloc(0), true),
    makeId3Tag(Buffer.alloc(0), 4, true),
  ]) {
    assert.throws(
      () => countMp3Frames(tag),
      /No MPEG-1 Layer III audio frames/,
    );
  }
});

test('does not treat metadata markers inside an audio payload as trailing tags', () => {
  const frame = makeFrame();
  frame.write('APETAGEX', 60);
  frame.write('3DI', 90);
  frame.write('TAG', 120);
  assert.equal(countMp3Frames(frame), 1);
});
