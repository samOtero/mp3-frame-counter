# MP3 File Analysis API

An API for uploading an MP3 file and retrieving its total audio frame count.
Designed for MPEG Version 1 Audio Layer 3 files.

## Requirements

- Node.js 22 or newer
- npm

## Install and run

```powershell
npm install
npm run dev
```

The development server listens at http://127.0.0.1:3000 and restarts when source
files change.

## Check the health endpoint

```powershell
curl.exe -i http://127.0.0.1:3000/health
```

Expected: HTTP `200`, a JSON content type, and this body:

```json
{ "status": "ok" }
```

## Call the POST endpoint

```powershell
curl.exe -i -X POST http://127.0.0.1:3000/file-upload
```

Expected: HTTP `200`, a JSON content type, and this body:

```json
{ "frameCount": 1234 }
```

## Type-check and build

```powershell
npm run typecheck
npm run build
npm start
```

Stop the development server with Ctrl+C before starting the compiled server,
since both use port 3000. The build outputs JavaScript to `dist/`.

Built with Fastify and TypeScript.
