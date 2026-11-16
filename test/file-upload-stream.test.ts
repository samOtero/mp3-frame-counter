import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { MAX_UPLOAD_BYTES } from '../src/routes/file-upload.js';
import { processUploadedFile } from '../src/uploads/process-upload.js';
import {
  makeApeTag,
  makeFrame,
  makeId3Tag,
  makeId3v1Tag,
  makeLyrics3Tag,
  makeMultipart,
} from './fixtures.js';

const url = '/file-upload-stream';
function createApp(t: TestContext) {
  const app = buildApp({ logger: false });
  t.after(() => app.close());
  return app;
}

test('streaming endpoint returns the sample count and JSON content type', async (t) => {
  const app = createApp(t);
  const sample = await readFile(new URL('../sample.mp3', import.meta.url));
  const response = await app.inject({
    method: 'POST',
    url,
    ...makeMultipart([
      { fieldname: 'file', filename: 'sample.mp3', body: sample },
    ]),
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^application\/json/);
  assert.deepEqual(response.json(), { frameCount: 6089 });
});

test('multipart boundaries, frame headers and tags can arrive across separate request chunks', async (t) => {
  const app = createApp(t);
  const body = Buffer.concat([
    makeId3Tag(makeFrame()),
    makeFrame(),
    makeLyrics3Tag('lyrics', 1),
    makeApeTag(makeFrame(), true),
    makeId3v1Tag(),
  ]);
  const upload = makeMultipart([
    { fieldname: 'file', filename: 'upload.bin', body },
  ]);
  async function* chunks() {
    for (let offset = 0; offset < upload.payload.length; offset += 3)
      yield upload.payload.subarray(offset, offset + 3);
  }
  const response = await app.inject({
    method: 'POST',
    url,
    headers: upload.headers,
    payload: Readable.from(chunks()),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { frameCount: 1 });
});

test('streaming endpoint rejects footer-only APE while the original endpoint keeps supporting it', async (t) => {
  const app = createApp(t);
  const upload = makeMultipart([
    {
      fieldname: 'file',
      filename: 'tagged.mp3',
      body: Buffer.concat([makeFrame(), makeApeTag()]),
    },
  ]);
  const original = await app.inject({
    method: 'POST',
    url: '/file-upload',
    ...upload,
  });
  const streamed = await app.inject({ method: 'POST', url, ...upload });
  assert.equal(original.statusCode, 200);
  assert.equal(streamed.statusCode, 400);
});

test('streaming endpoint enforces multipart format, field names and exactly one part', async (t) => {
  const app = createApp(t);
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 415);
  for (const parts of [
    [],
    [{ fieldname: 'audio', filename: 'a.mp3', body: makeFrame() }],
    [
      { fieldname: 'file', filename: 'a.mp3', body: makeFrame() },
      { fieldname: 'file', filename: 'b.mp3', body: makeFrame() },
    ],
    [
      { fieldname: 'file', filename: 'a.mp3', body: makeFrame() },
      { fieldname: 'extra', body: Buffer.from('value') },
    ],
    [
      { fieldname: 'extra', body: Buffer.from('value') },
      { fieldname: 'file', filename: 'a.mp3', body: makeFrame() },
    ],
  ]) {
    const response = await app.inject({
      method: 'POST',
      url,
      ...makeMultipart(parts),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(typeof response.json().error, 'string');
  }
});

test('streaming endpoint returns JSON errors for empty, corrupt and truncated MP3s', async (t) => {
  const app = createApp(t);
  for (const body of [
    Buffer.alloc(0),
    Buffer.from('not MP3'),
    makeFrame().subarray(0, 100),
  ]) {
    const response = await app.inject({
      method: 'POST',
      url,
      ...makeMultipart([{ fieldname: 'file', filename: 'bad.mp3', body }]),
    });
    assert.equal(response.statusCode, 400);
    assert.match(
      String(response.headers['content-type']),
      /^application\/json/,
    );
    assert.equal(typeof response.json().error, 'string');
  }
});

test('streaming endpoint rejects oversize uploads even when invalid data occurs first', async (t) => {
  const app = createApp(t);
  for (const firstByte of [0, 0xff]) {
    const body = Buffer.alloc(MAX_UPLOAD_BYTES + 1, firstByte);
    const response = await app.inject({
      method: 'POST',
      url,
      ...makeMultipart([{ fieldname: 'file', filename: 'large.mp3', body }]),
    });
    assert.equal(response.statusCode, 413);
    assert.match(response.json().error, /10 MiB/);
  }
});

test(
  'streaming endpoint rejects malformed multipart and missing boundaries without hanging',
  { timeout: 5000 },
  async (t) => {
    const app = createApp(t);
    for (const request of [
      {
        headers: { 'content-type': 'multipart/form-data' },
        payload: 'invalid',
      },
      {
        headers: { 'content-type': 'multipart/form-data; boundary=broken' },
        payload:
          '--broken\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nincomplete',
      },
      {
        headers: { 'content-type': 'multipart/form-data; boundary=broken' },
        payload: Buffer.concat([
          Buffer.from(
            '--broken\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\n',
          ),
          makeFrame(),
        ]),
      },
    ]) {
      const response = await app.inject({ method: 'POST', url, ...request });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /multipart.*malformed or incomplete/);
    }
  },
);

test('unexpected consumer failures remain server errors rather than malformed upload errors', async (t) => {
  const app = createApp(t);
  const failure = new Error('unexpected parser failure');
  // Register within the multipart plugin's scope through an onRoute hook.
  app.addHook('onRoute', (route) => {
    if (route.url === url) {
      route.handler = async (request) =>
        processUploadedFile(request, async () => {
          throw failure;
        });
    }
  });
  const response = await app.inject({
    method: 'POST',
    url,
    ...makeMultipart([
      { fieldname: 'file', filename: 'a.mp3', body: makeFrame() },
    ]),
  });
  assert.equal(response.statusCode, 500);
});
