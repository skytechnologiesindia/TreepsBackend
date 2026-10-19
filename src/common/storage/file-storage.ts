// Where uploaded files are kept. In Express terms, the one helper every route calls instead of
// writing to disk or S3 itself, so the place can change (local folder or S3) in one file.
// A path is made by the server (never taken from a client) and is stored in the database instead
// of a URL.
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface FileStorage {
  save(path: string, data: Buffer): Promise<void>;
  // The file's bytes, or null if the file is not there.
  read(path: string): Promise<Buffer | null>;
  // Deleting a file that is not there is not an error.
  delete(path: string): Promise<void>;
}

// Letters, digits and / _ . - only, no leading slash, no "..". The server builds every path, so this
// is a second lock, not the first. Both storage classes call it before they touch a file.
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9/_.-]+$/;
export function assertSafeStoragePath(path: string): void {
  if (!SAFE_PATH.test(path)) throw new Error('Unsafe storage path');
}
