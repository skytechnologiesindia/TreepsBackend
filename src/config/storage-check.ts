import { S3FileStorage } from '../common/storage/s3-file-storage.js';

// A fixed message. It names the settings and never prints a key, a secret or the AWS error text.
export const STORAGE_CHECK_FAILED =
  'Storage check failed: could not reach the S3 bucket named in S3_BUCKET (it does not exist, the region is wrong, or the keys are missing or not allowed to use it). ' +
  'Check S3_BUCKET, S3_REGION and the AWS keys.';

// The only error this check ever throws: the fixed message, no cause, no AWS text.
export class StorageCheckError extends Error {
  constructor() {
    super(STORAGE_CHECK_FAILED);
    this.name = 'StorageCheckError';
  }
}

// At startup, when the storage is S3: does the bucket answer? The local folder needs no check. Like the
// database check, a deployment with wrong bucket settings refuses to start instead of failing on the
// first driver's upload.
export async function assertStorageReachable(storage: unknown): Promise<void> {
  if (!(storage instanceof S3FileStorage)) return;
  try {
    await storage.assertReachable();
  } catch {
    throw new StorageCheckError();
  }
}
