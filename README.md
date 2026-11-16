# MP3 File Analysis API

An API for uploading an MP3 file and retrieving its audio frame count. Supports MPEG Version 1 Audio Layer 3 files. Built with Fastify and TypeScript.

## Getting started

Requires Node.js 22.13+ within 22.x, or Node.js 24+, and npm.

```bash
npm install
npm run dev
```

The development server runs at `http://127.0.0.1:3000` and restarts when source files change.

In a second terminal, upload the included `sample.mp3` from the repository root:

**macOS / Linux**

```bash
curl -i http://127.0.0.1:3000/file-upload -F "file=@sample.mp3"
```

**Windows PowerShell**

```powershell
curl.exe -i http://127.0.0.1:3000/file-upload -F "file=@sample.mp3"
```

To use streaming, change the endpoint to `/file-upload-stream`. To upload another file, replace `sample.mp3` with its filename or path, keeping the `file=@` prefix.

The included sample returns HTTP `200 OK` with JSON:

```json
{ "frameCount": 6089 }
```

The count will vary for other files.

## API

| Method | Endpoint              | Description                              |
| ------ | --------------------- | ---------------------------------------- |
| `POST` | `/file-upload`        | Buffers the upload before parsing.       |
| `POST` | `/file-upload-stream` | Parses the upload as chunks arrive.      |
| `GET`  | `/health`             | Returns the application's health status. |

Send exactly one file using the multipart field `file`, with no additional fields. Both upload endpoints accept files up to **10 MiB**, validate their contents independently of the filename or MIME type, and return a JSON object containing `frameCount`.

## How it works

The parser skips supported metadata, reads MPEG frame headers, and calculates each frame's length from its bitrate, sample rate and padding. It advances through complete frames to determine the count.

An initial Xing/Info information frame is excluded, matching the sample's MediaInfo result. The count stored in that tag is not used.

The streaming implementation uses [strtok3](https://github.com/Borewit/strtok3) for generic byte reading, peeking and skipping. MP3 interpretation and frame counting are implemented in this project.

### Supported metadata

| Format                          | Buffered endpoint | Streaming endpoint |
| ------------------------------- | ----------------- | ------------------ |
| Leading ID3v2                   | Supported         | Supported          |
| ID3v1/ID3v1.1, including `TAG+` | Supported         | Supported          |
| Lyrics3v1 and Lyrics3v2         | Supported         | Supported          |
| Appended ID3v2.4 with footer    | Supported         | Supported          |
| APEv2                           | Header optional   | Header required    |

Trailing tags can be combined. The parsers validate tag boundaries and sizes without extracting metadata values. The streaming parser also checks Lyrics3v2 field lengths.

### Memory usage

The buffered endpoint holds the complete file in memory, so memory usage increases with file size and concurrent uploads.

The streaming endpoint uses bounded buffers and skips payloads by their declared lengths. Metadata lookahead is capped at approximately 1 MB, with additional stream and bookkeeping overhead. No temporary files are created.

## Limitations

- **Free-format MP3s are unsupported** and return `400 Bad Request`. These can still be MPEG-1 Layer III files, but their headers do not provide a bitrate from the standard lookup table.
- Footer-only APEv2 tags require the buffered endpoint.
- Lyrics3v1 text is limited to 5,100 bytes.
- The parsers reject unexpected data and incomplete frames. They do not decode audio or repair corrupt files.

Future free-format support would require inferring frame lengths from compatible subsequent headers and validating their spacing across multiple frames, accounting for padding and false header matches.

## Development

Run all checks before submission:

```bash
npm run check
```

| Command                | Purpose                         |
| ---------------------- | ------------------------------- |
| `npm test`             | Run parser and endpoint tests.  |
| `npm run typecheck`    | Check TypeScript types.         |
| `npm run lint`         | Check lint rules.               |
| `npm run lint:fix`     | Apply available lint fixes.     |
| `npm run format`       | Format project files.           |
| `npm run format:check` | Check formatting.               |
| `npm run build`        | Compile into `dist/`.           |
| `npm start`            | Start the compiled application. |

Stop the development server before running `npm start`; both use port 3000.

### Commit hooks

`npm install` enables Husky's pre-commit hook. Before each commit, lint-staged applies ESLint fixes and Prettier formatting to staged files. Remaining lint errors block the commit, and unstaged edits are preserved.

### Tests

Tests cover the supplied sample, variable bitrate, padding, metadata combinations, chunk boundaries, malformed input and upload errors.

Structural fixtures provide known frame counts using dummy payloads; they are not intended to be playable audio.

## References

- [MPEG frame header layout](https://samples.ffmpeg.org/A-codecs/sf/mpeg_header.html) and [frame length explanation](https://www.datavoyage.com/mpgscript/mpeghdr.htm)
- [ID3v2.4 structure](https://github.com/id3/ID3v2.4/blob/master/id3v2.40-structure.txt) and [ID3v1 TAG+ layout](https://docs.rs/id3/latest/src/id3/v1.rs.html)
- [Lyrics3v1](https://id3.org/Lyrics3) and [Lyrics3v2](https://id3.org/Lyrics3v2)
- [APEv2 header and footer structure](https://taglib.org/api/classTagLib_1_1APE_1_1Footer.html)
- FFmpeg's [frame length calculation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c) and [Xing/Info handling](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mp3dec.c)
