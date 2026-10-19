import { LocalFileStorage } from '../common/storage/local-file-storage.js';
import { S3FileStorage, type S3Sender } from '../common/storage/s3-file-storage.js';
import { describeStartupFailure } from './startup-failure.js';
import { assertStorageReachable, StorageCheckError, STORAGE_CHECK_FAILED } from './storage-check.js';

describe('assertStorageReachable', () => {
  it('does nothing for the local folder', async () => {
    await expect(assertStorageReachable(new LocalFileStorage('storage'))).resolves.toBeUndefined();
  });

  it('passes when the bucket answers', async () => {
    const client: S3Sender = { send: async () => ({}) };
    await expect(assertStorageReachable(new S3FileStorage('b', client))).resolves.toBeUndefined();
  });

  it('throws only the fixed error when the bucket cannot be used, never the AWS text', async () => {
    const client: S3Sender = { send: async () => { throw new Error('AKIAEXAMPLEKEY secret-detail'); } };
    const error = await assertStorageReachable(new S3FileStorage('b', client)).catch((e) => e);
    expect(error).toBeInstanceOf(StorageCheckError);
    expect(error.message).toBe(STORAGE_CHECK_FAILED);
    expect(error.message).not.toContain('AKIA');
    expect(describeStartupFailure(error)).toBe(STORAGE_CHECK_FAILED);
  });
});
