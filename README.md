# MP3 File Analysis API

An API for uploading an MP3 file and retrieving its total audio frame count.
Designed for MPEG Version 1 Audio Layer 3 files. Built with Fastify and TypeScript.

## Requirements

- Node.js 22.13+ (22.x) or 24+
- npm

## Install and run

```bash
npm install
npm run dev
```

The development server listens at http://127.0.0.1:3000 and restarts when source
files change.

## Call the POST endpoint

Run these commands from the repository root to upload the included `sample.mp3`.

macOS / Linux:

```bash
curl -i http://127.0.0.1:3000/file-upload -F "file=@sample.mp3"
```

Windows PowerShell:

```powershell
curl.exe -i http://127.0.0.1:3000/file-upload -F "file=@sample.mp3"
```

To test another MP3, replace `sample.mp3` with its filename or path, keeping the
`file=@` prefix. A filename alone is resolved from the directory where you run
the command.

Expected response for the included sample: HTTP `200 OK` with this JSON body.
The frame count will vary for other files:

```json
{ "frameCount": 6089 }
```

Send exactly one file using the multipart field name `file`, with no additional
form fields. The maximum file size is 10 MiB. The filename and MIME type are not
used to determine whether its contents are valid MP3 frame data.

The parser skips leading ID3v2 tags and these trailing metadata formats:

- ID3v1/ID3v1.1, including the optional 227-byte `TAG+` extension immediately before it.
- Lyrics3v1 and Lyrics3v2.
- Appended ID3v2.4, identified by its `3DI` footer.
- APEv2, with or without its optional header.

Trailing tags can be combined. Tag boundaries and declared sizes are checked
before excluding them from the audio region; metadata values are not extracted.
Lyrics3v1 has no size field, so its opening-marker search is bounded to allow at
most 5,100 lyric bytes.

The parser then walks MPEG-1 Layer III frame headers to calculate the count. An
initial Xing/Info information frame is excluded from the audio frame count,
matching the sample's MediaInfo result. The count stored in that tag is not used.

Error responses use JSON with a message describing the problem.

| HTTP code | Status                 | Meaning                                                                                                              |
| --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `400`     | Bad Request            | The file is missing, invalid, or incomplete; the upload is malformed; or additional files/form fields were provided. |
| `404`     | Not Found              | The requested route does not exist.                                                                                  |
| `413`     | Content Too Large      | The uploaded file exceeds the 10 MiB limit.                                                                          |
| `415`     | Unsupported Media Type | The request does not use `multipart/form-data`.                                                                      |
| `500`     | Internal Server Error  | An unexpected server failure occurred.                                                                               |

Uploads to `/file-upload` are buffered in memory before parsing, so memory usage grows
with the file size and number of concurrent uploads. Unexpected bytes between
frames or after the recognized metadata are rejected; the parser does not
attempt to repair corrupt files or decode audio.

Free-format MP3 files (bitrate index `0`) are not supported and return HTTP
`400 Bad Request` with the message `Free-format MP3 bitrate is not supported.`
These can still be MPEG-1 Layer III files, but their headers do not specify a
bitrate from the standard lookup table, so the current parser cannot calculate
their frame lengths from the header alone.

A future version could support free-format files by searching for subsequent
compatible frame headers, inferring the frame length from their spacing, and
validating that spacing across further frames while accounting for padding.
This would need additional checks and tests to avoid mistaking matching bytes
inside audio data for real frame boundaries.

## Streaming upload endpoint

`POST /file-upload-stream` parses the upload as chunks arrive, without saving a
temporary file or collecting the complete upload in memory. It uses the same
multipart field, 10 MiB upload limit, JSON response and HTTP error statuses as
`/file-upload`. The included sample returns `{ "frameCount": 6089 }` on both.

macOS / Linux:

```bash
curl -i http://127.0.0.1:3000/file-upload-stream -F "file=@sample.mp3"
```

Windows PowerShell:

```powershell
curl.exe -i http://127.0.0.1:3000/file-upload-stream -F "file=@sample.mp3"
```

The parser uses [strtok3](https://github.com/Borewit/strtok3) for generic binary
stream reading, peeking and skipping across chunk boundaries. MPEG header
interpretation, metadata validation and frame counting are implemented in this
project. It processes one audio frame at a time and skips ID3v2 and headered
APEv2 bodies using their declared sizes. Its working memory is bounded rather
than proportional to the file size. It retains the
current incoming chunk, small header/frame buffers, and bounded lookahead for
ambiguous metadata prefixes. Lyrics3 lookahead can retain up to 1,000,014 bytes
(the maximum six-digit Lyrics3v2 body size plus its 15-byte ending), with
additional stream and bookkeeping overhead. ID3v1 extension lookahead is at
most 351 bytes. Neither requires buffering the rest of the upload. The
tokenizer's buffer/lookahead limit is configured explicitly.

Both endpoints support the metadata formats listed above, with these streaming
differences:

- APEv2 requires both a header and a matching footer. Footer-only APEv2 is not
  supported; unsupported trailing data returns `400 Bad Request`. Use
  `/file-upload` for files with footer-only APEv2 tags.
- Lyrics3v2 field lengths are checked while reading forward, in addition to
  checking the final tag size. The buffered parser checks the outer boundaries.

The streaming endpoint also excludes an initial Xing/Info frame and rejects
free-format bitrate. It waits for the complete upload and multipart validation
before returning a count. Invalid MP3 uploads are consumed through the upload
limit so transport failures and oversize files are still reported appropriately.

## Check the health endpoint

macOS / Linux:

```bash
curl -i http://127.0.0.1:3000/health
```

Windows PowerShell:

```powershell
curl.exe -i http://127.0.0.1:3000/health
```

Expected: HTTP `200 OK`, a JSON content type, and this body:

```json
{ "status": "ok" }
```

## Formatting, linting and commit hooks

`npm install` enables the pre-commit hook through Husky. Before each commit,
lint-staged runs ESLint with automatic fixes on staged TypeScript and JavaScript
files, then formats them with Prettier. Staged JSON and Markdown files are also
formatted. Successful fixes are included in the commit; remaining lint errors
block it. Partially staged files keep their unstaged changes separate.

ESLint uses the recommended JavaScript and TypeScript rules. Prettier applies a
consistent style with single quotes and LF line endings. Generated output,
dependencies and the sample MP3 are excluded from formatting.

| Command                | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run lint`         | Check the project with ESLint.                                      |
| `npm run lint:fix`     | Apply available ESLint fixes.                                       |
| `npm run format`       | Format supported project files with Prettier.                       |
| `npm run format:check` | Check formatting without changing files.                            |
| `npm run check`        | Run linting, formatting checks, type-checking, tests and the build. |

## Test, type-check and build

```bash
npm test
npm run typecheck
npm run build
npm start
```

Stop the development server with Ctrl+C before starting the compiled server,
since both use port 3000. The build outputs JavaScript to `dist/`.

Tests cover the supplied sample and structural fixtures with known frame counts,
variable bitrate, padding, leading/trailing metadata and tag combinations,
invalid/truncated input, and upload errors.
Streaming tests additionally cover arbitrary chunk boundaries, agreement with
the buffered parser, file streams, generated large metadata bodies, and the
streaming endpoint's narrower APEv2 support.
The structural fixtures test frame boundaries; their dummy payloads are not
intended to be playable audio.

Format references: [MPEG audio frame header layout (MP3'Tech, hosted by FFmpeg)](https://samples.ffmpeg.org/A-codecs/sf/mpeg_header.html),
[MPEG frame length explanation (DataVoyage)](https://www.datavoyage.com/mpgscript/mpeghdr.htm),
[ID3v2.4 tag structure](https://github.com/id3/ID3v2.4/blob/master/id3v2.40-structure.txt),
[ID3v1 TAG+ extension layout (Rust id3)](https://docs.rs/id3/latest/src/id3/v1.rs.html),
[Lyrics3v1](https://id3.org/Lyrics3), [Lyrics3v2](https://id3.org/Lyrics3v2),
[APEv2 header/footer structure and sizes (TagLib)](https://taglib.org/api/classTagLib_1_1APE_1_1Footer.html),
[MPEG frame length calculation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c),
and [Xing/Info frame handling](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mp3dec.c).
