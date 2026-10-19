import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertSafeStoragePath, type FileStorage } from './file-storage.js';

// The only thing this class needs from the AWS client, so a test can hand in a fake.
export interface S3Sender {
  send(command: unknown): Promise<any>;
}

const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png' };

// The S3 version of the storage class (decision 189). The photo's path is the object's key in the
// bucket, so the database rows are the same as with the local folder. The bucket must be private;
// nothing here makes a public link. Credentials are not read here: the AWS client finds them itself
// (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or the machine's role). In Express terms, the same
// helper as the local one, but it calls the S3 API where the other calls fs.
export class S3FileStorage implements FileStorage {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Sender,
  ) {}

  static create(options: { bucket: string; region: string; endpoint?: string }): S3FileStorage {
    const client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    });
    return new S3FileStorage(options.bucket, client);
  }

  async save(path: string, data: Buffer): Promise<void> {
    assertSafeStoragePath(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: data,
        ContentType: CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
        ServerSideEncryption: 'AES256', // encrypted at rest
        IfNoneMatch: '*', // never overwrite an existing file (same rule as the local folder)
      }),
    );
  }

  async read(path: string): Promise<Buffer | null> {
    assertSafeStoragePath(path);
    try {
      const reply = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
      return Buffer.from(await reply.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  // S3 does not complain when the key is not there, which is the rule we want.
  async delete(path: string): Promise<void> {
    assertSafeStoragePath(path);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
  }

  // Used once at startup and by `npm run storage:check`: does the bucket exist and may we use it?
  async assertReachable(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
