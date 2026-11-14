import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { MAX_UPLOAD_BYTES } from '../src/routes/file-upload.js';
import { makeApeTag, makeFrame, makeId3Tag, makeId3v1ExtendedTag, makeId3v1Tag, makeLyrics3Tag, makeMultipart } from './fixtures.js';

function createApp(t: TestContext) {
  const app = buildApp({ logger: false });
  t.after(() => app.close());
  return app;
}

test('POST sample upload returns the exact JSON count and content type', async (t) => {
  const app = createApp(t);
  const sample = await readFile(new URL('../sample.mp3', import.meta.url));
  const response = await app.inject({
    method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'file', filename: 'sample.mp3', body: sample }]),
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^application\/json/);
  assert.deepEqual(response.json(), { frameCount: 6089 });
});

test('validates bytes rather than requiring a trusted filename or MIME type', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'file', filename: 'upload.bin', body: makeFrame() }]),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { frameCount: 1 });
});

test('counts audio correctly when uploaded files have combined trailing tags', async (t) => {
  const app = createApp(t);
  const body = Buffer.concat([
    makeFrame(), makeFrame(), makeApeTag(Buffer.from('title'), true),
    makeId3Tag(Buffer.alloc(130), 4, true), makeId3v1Tag(),
  ]);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'file', filename: 'tagged.mp3', body }]),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { frameCount: 2 });
});

test('returns 400 for trailing metadata whose declared size exceeds the file', async (t) => {
  const app = createApp(t);
  const tag = makeApeTag();
  tag.writeUInt32LE(0xffffffff, tag.length - 20);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'file', filename: 'broken.mp3', body: Buffer.concat([makeFrame(), tag]) }]),
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /APEv2/);
});

test('uploads with Lyrics3 and extended ID3v1 return only the audio frame count', async (t) => {
  const app = createApp(t);
  for (const version of [1, 2] as const) {
    const body = Buffer.concat([
      makeFrame(), makeLyrics3Tag('lyrics', version), makeId3v1ExtendedTag(), makeId3v1Tag(),
    ]);
    const response = await app.inject({ method: 'POST', url: '/file-upload',
      ...makeMultipart([{ fieldname: 'file', filename: 'lyrics.mp3', body }]),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { frameCount: 1 });
  }
});

test('returns 400 for invalid Lyrics3 metadata', async (t) => {
  const app = createApp(t);
  const tag = makeLyrics3Tag();
  tag.write('999999', tag.length - 15);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'file', filename: 'broken.mp3', body: Buffer.concat([makeFrame(), tag]) }]),
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Lyrics3v2/);
});

test('rejects requests that are not multipart', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload' });
  assert.equal(response.statusCode, 415);
  assert.match(response.json().error, /multipart\/form-data/);
});

test('rejects a multipart upload with no file', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload', ...makeMultipart([]) });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /required/);
});

test('rejects a file using the wrong field name', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'audio', filename: 'sample.mp3', body: makeFrame() }]),
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /field name "file"/);
});

test('rejects multiple files instead of returning a count for just the first', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([
      { fieldname: 'file', filename: 'first.mp3', body: makeFrame() },
      { fieldname: 'file', filename: 'second.mp3', body: makeFrame() },
    ]),
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /exactly one file/);
});

test('rejects additional form fields, including fields after the file', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([
      { fieldname: 'file', filename: 'sample.mp3', body: makeFrame() },
      { fieldname: 'description', body: Buffer.from('extra field') },
    ]),
  });
  assert.equal(response.statusCode, 400);
});

test('rejects uploads above the size limit', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    ...makeMultipart([{ fieldname: 'file', filename: 'large.mp3', body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) }]),
  });
  assert.equal(response.statusCode, 413);
  assert.match(response.json().error, /10 MiB/);
});

test('returns useful JSON errors for empty, invalid and truncated MP3 uploads', async (t) => {
  const app = createApp(t);
  for (const body of [Buffer.alloc(0), Buffer.from('not an MP3'), makeFrame().subarray(0, 100)]) {
    const response = await app.inject({ method: 'POST', url: '/file-upload',
      ...makeMultipart([{ fieldname: 'file', filename: 'invalid.mp3', body }]),
    });
    assert.equal(response.statusCode, 400);
    assert.match(String(response.headers['content-type']), /^application\/json/);
    assert.equal(typeof response.json().error, 'string');
  }
});

test('rejects a malformed multipart body', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    headers: { 'content-type': 'multipart/form-data; boundary=broken' },
    payload: '--broken\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nincomplete',
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: 'The multipart upload is malformed or incomplete.' });
});

test('rejects multipart requests with a missing boundary', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'POST', url: '/file-upload',
    headers: { 'content-type': 'multipart/form-data' }, payload: 'invalid upload',
  });
  assert.equal(response.statusCode, 400);
});

test('health endpoint still works', async (t) => {
  const app = createApp(t);
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});
