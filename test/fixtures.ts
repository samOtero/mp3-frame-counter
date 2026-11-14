interface FrameOptions {
  bitrateIndex?: number;
  sampleRateIndex?: number;
  byteLength?: number;
  padding?: boolean;
  mono?: boolean;
  crcProtected?: boolean;
}

// Structural fixtures: valid header/length combinations with dummy audio payloads.
// Lengths are supplied explicitly rather than calculated by the parser under test.
export function makeFrame({
  bitrateIndex = 9,
  sampleRateIndex = 0,
  byteLength = 417,
  padding = false,
  mono = false,
  crcProtected = false,
}: FrameOptions = {}): Buffer {
  const frame = Buffer.alloc(byteLength);
  frame[0] = 0xff;
  frame[1] = crcProtected ? 0xfa : 0xfb;
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding ? 2 : 0);
  frame[3] = mono ? 0xc0 : 0;
  return frame;
}

export function makeInformationFrame(marker = 'Xing', mono = false): Buffer {
  const frame = makeFrame({ mono });
  const offset = mono ? 21 : 36;
  frame.write(marker, offset, 'latin1');
  frame.writeUInt32BE(1, offset + 4);
  frame.writeUInt32BE(999999, offset + 8); // Intentionally wrong: never trust this count.
  return frame;
}

export function makeId3Tag(body: Buffer, version = 4, footer = false): Buffer {
  const header = Buffer.alloc(10);
  header.write('ID3');
  header[3] = version;
  header[5] = footer ? 0x10 : 0;
  for (let index = 0; index < 4; index += 1) {
    header[6 + index] = (body.length >>> (7 * (3 - index))) & 0x7f;
  }

  if (!footer) {
    return Buffer.concat([header, body]);
  }
  const tagFooter = Buffer.from(header);
  tagFooter.write('3DI');
  return Buffer.concat([header, body, tagFooter]);
}

export function makeId3v1Tag(): Buffer {
  const tag = Buffer.alloc(128);
  tag.write('TAG');
  return tag;
}

export function makeId3v1ExtendedTag(): Buffer {
  const tag = Buffer.alloc(227);
  tag.write('TAG+');
  return tag;
}

export function makeLyrics3Tag(lyrics = 'test lyrics', version: 1 | 2 = 2): Buffer {
  const text = Buffer.from(lyrics, 'latin1');
  const begin = Buffer.from('LYRICSBEGIN');
  if (version === 1) {
    return Buffer.concat([begin, text, Buffer.from('LYRICSEND')]);
  }

  // One LYR field with a five-digit value size; the outer six-digit size includes
  // LYRICSBEGIN and the field, but excludes the size digits and LYRICS200.
  const field = Buffer.from(`LYR${text.length.toString().padStart(5, '0')}`);
  const body = Buffer.concat([begin, field, text]);
  return Buffer.concat([body, Buffer.from(`${body.length.toString().padStart(6, '0')}LYRICS200`)]);
}

export function makeApeTag(value: Buffer = Buffer.from('test title'), hasHeader = false): Buffer {
  // One text item: value length, item flags, null-terminated key, and value.
  const itemHeader = Buffer.alloc(8);
  itemHeader.writeUInt32LE(value.length, 0);
  const body = Buffer.concat([itemHeader, Buffer.from('Title\0'), value]);
  const footer = Buffer.alloc(32);
  footer.write('APETAGEX');
  footer.writeUInt32LE(2000, 8);
  footer.writeUInt32LE(body.length + 32, 12);
  footer.writeUInt32LE(1, 16);
  footer.writeUInt32LE(hasHeader ? 0x80000000 : 0, 20);

  if (!hasHeader) {
    return Buffer.concat([body, footer]);
  }
  const header = Buffer.from(footer);
  header.writeUInt32LE(0xa0000000, 20);
  return Buffer.concat([header, body, footer]);
}

interface MultipartPart {
  fieldname: string;
  filename?: string;
  body: Buffer;
}

export function makeMultipart(parts: MultipartPart[]) {
  const boundary = 'mp3-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldname}"${filename}\r\n\r\n`));
    chunks.push(part.body, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}
