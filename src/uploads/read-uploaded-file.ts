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
  if (!request.isMultipart()) {
    throw new UploadError(
      415,
      'Send a multipart/form-data upload with one file field named "file".',
    );
  }

  let file: Buffer | undefined;

  try {
    // Loop here to catch any extra parts that may be sent.
    // If more than one is found, we return an error based on the limits set in the register function.
    for await (const part of request.parts()) {
      if (part.type !== "file" || part.fieldname !== "file") {
        throw new UploadError(
          400,
          'Upload exactly one file using the field name "file".',
        );
      }

      // Deliberately buffered for this version; the parser accepts a complete file.
      file = await part.toBuffer();
    }
  } catch (error) {
    if (error instanceof UploadError) {
      throw error;
    }

    const multipartErrors = request.server.multipartErrors;
    if (error instanceof multipartErrors.RequestFileTooLargeError) {
      throw new UploadError(413, "The file exceeds the 10 MiB upload limit.", {
        cause: error,
      });
    }
    if (
      error instanceof multipartErrors.FilesLimitError ||
      error instanceof multipartErrors.FieldsLimitError ||
      error instanceof multipartErrors.PartsLimitError
    ) {
      throw new UploadError(
        400,
        'Upload exactly one file using the field name "file" and no additional fields.',
        { cause: error },
      );
    }

    request.log.warn({ err: error }, "Could not read multipart upload");
    throw new UploadError(
      400,
      "The multipart upload is malformed or incomplete.",
      { cause: error },
    );
  }

  if (file === undefined) {
    throw new UploadError(400, 'A file field named "file" is required.');
  }

  return file;
}
