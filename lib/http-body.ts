// Reading a request body: bytes for git, text for JSON, and the cap that keeps a hostile body from
// growing the process without bound.

/** What one body read yielded. `error` is set instead of throwing, so a handler answers a 400. */
export interface ReadResult {
  readonly bytes: Buffer;
  readonly text: string;
  readonly error: string | null;
  readonly tooLarge: boolean;
}

/** Read a whole request body up to `limit` bytes. The stream is always drained, so a refused body
 *  never leaves the connection half-read. */
export function readBody(req: NodeJS.ReadableStream, limit: number): Promise<ReadResult> {
  return new Promise<ReadResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const finish = (): void => {
      const bytes = over ? Buffer.alloc(0) : chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
      resolve({ bytes, text: bytes.toString('utf8'), error: over ? `request body is over ${String(limit)} bytes` : null, tooLarge: over });
    };
    req.on('data', (chunk: unknown) => {
      if (over) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
      size += buffer.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', finish);
    req.on('error', () => {
      over = true;
      finish();
    });
  });
}

/** The cap a JSON body gets: 256 KiB, the same bound the model gateway uses. */
export const JSON_BODY_LIMIT = 256 * 1024;

