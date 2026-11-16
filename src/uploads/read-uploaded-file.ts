import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from "fastify";

export class UploadError extends Error {
  constructor(
    public readonly statusCode: 400 | 413 | 415,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UploadError";
  }
}

export async function readUploadedFile(
  request: FastifyRequest,
): Promise<Buffer> {
  return processUploadedFile(request, async (stream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  });
}

export async function processUploadedFile<T>(
  request: FastifyRequest,
  consume: (stream: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T> {
  if (!request.isMultipart()) {
    throw new UploadError(
      415,
      'Send a multipart/form-data upload with one file field named "file".',
    );
  }

  let result: { value: T } | undefined;

  // Finish the iterator before returning so extra parts after the file are checked.
  for await (const part of readParts(request)) {
    if (part.type !== "file" || part.fieldname !== "file" || result !== undefined) {
      throw new UploadError(400, 'Upload exactly one file using the field name "file" and no additional fields.');
    }
    // Parser errors from consume() retain their type; only multipart reads below
    // translate transport failures into upload errors.
    result = { value: await consume(readChunks(request, part)) };
  }
  if (result === undefined) throw new UploadError(400, 'A file field named "file" is required.');
  return result.value;
}

async function* readParts(request: FastifyRequest) {
  try {
    yield* request.parts();
  } catch (error) {
    throw multipartError(request, error);
  }
}

async function* readChunks(request: FastifyRequest, part: MultipartFile): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of part.file) yield chunk as Buffer;
    if (part.file.truncated) throw new UploadError(413, "The file exceeds the 10 MiB upload limit.");
  } catch (error) {
    throw multipartError(request, error);
  }
}

function multipartError(request: FastifyRequest, error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  const errors = request.server.multipartErrors;
  if (error instanceof errors.RequestFileTooLargeError) {
    return new UploadError(413, "The file exceeds the 10 MiB upload limit.", { cause: error });
  }
  if (error instanceof errors.FilesLimitError || error instanceof errors.FieldsLimitError || error instanceof errors.PartsLimitError) {
    return new UploadError(400, 'Upload exactly one file using the field name "file" and no additional fields.', { cause: error });
  }
  request.log.warn({ err: error }, "Could not read multipart upload");
  return new UploadError(400, "The multipart upload is malformed or incomplete.", { cause: error });
}
