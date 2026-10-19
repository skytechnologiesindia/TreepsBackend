import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3FileStorage, type S3Sender } from './s3-file-storage.js';

// A fake bucket kept in a Map. It answers the way S3 does, including NoSuchKey for a missing file and
// PreconditionFailed when a put must not overwrite (IfNoneMatch "*").
class FakeBucket implements S3Sender {
  objects = new Map<string, Buffer>();
  sent: unknown[] = [];
  failWith: Error | null = null;

  async send(command: unknown): Promise<any> {
    this.sent.push(command);
    if (this.failWith) throw this.failWith;
    if (command instanceof PutObjectCommand) {
      const { Key, Body, IfNoneMatch } = command.input;
      if (IfNoneMatch === '*' && this.objects.has(Key as string)) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      this.objects.set(Key as string, Buffer.from(Body as Buffer));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const found = this.objects.get(command.input.Key as string);
      if (!found) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => new Uint8Array(found) } };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key as string);
      return {};
    }
    if (command instanceof HeadBucketCommand) return {};
    throw new Error('unexpected command');
  }
}

describe('S3FileStorage', () => {
  let bucket: FakeBucket;
  let storage: S3FileStorage;
  beforeEach(() => {
    bucket = new FakeBucket();
    storage = new S3FileStorage('treeps-test', bucket);
  });

  it('saves a file under its path as the key, encrypted, with the right type, never overwriting', async () => {
    await storage.save('drivers/d1/licence-front-abc.png', Buffer.from('bytes'));
    const command = bucket.sent[0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'treeps-test',
      Key: 'drivers/d1/licence-front-abc.png',
      ContentType: 'image/png',
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*',
    });
    expect(bucket.objects.get('drivers/d1/licence-front-abc.png')?.toString()).toBe('bytes');
  });

  it('uses image/jpeg for a jpg', async () => {
    await storage.save('drivers/d1/a.jpg', Buffer.from('x'));
    expect((bucket.sent[0] as PutObjectCommand).input.ContentType).toBe('image/jpeg');
  });

  it('refuses to overwrite a file that exists', async () => {
    await storage.save('drivers/d1/a.jpg', Buffer.from('first'));
    await expect(storage.save('drivers/d1/a.jpg', Buffer.from('second'))).rejects.toMatchObject({ name: 'PreconditionFailed' });
    expect(bucket.objects.get('drivers/d1/a.jpg')?.toString()).toBe('first');
  });

  it('reads back exactly the bytes that were saved', async () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 7]);
    await storage.save('drivers/d1/a.png', original);
    const back = await storage.read('drivers/d1/a.png');
    expect(back?.equals(original)).toBe(true);
  });

  it('read gives null for a file that is not there, and rethrows any other error', async () => {
    expect(await storage.read('drivers/d1/missing.jpg')).toBeNull();
    bucket.failWith = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    await expect(storage.read('drivers/d1/a.jpg')).rejects.toMatchObject({ name: 'AccessDenied' });
  });

  it('delete removes the file, and deleting a missing file is not an error', async () => {
    await storage.save('drivers/d1/a.jpg', Buffer.from('x'));
    await storage.delete('drivers/d1/a.jpg');
    expect(bucket.objects.size).toBe(0);
    await expect(storage.delete('drivers/d1/a.jpg')).resolves.toBeUndefined();
  });

  it('refuses an unsafe path before calling S3', async () => {
    for (const path of ['../secret.png', '/abs/path.png', 'drivers/../x.png', 'drivers/a b.png', 'drivers/é.png', '']) {
      await expect(storage.save(path, Buffer.from('x'))).rejects.toThrow('Unsafe storage path');
      await expect(storage.read(path)).rejects.toThrow('Unsafe storage path');
      await expect(storage.delete(path)).rejects.toThrow('Unsafe storage path');
    }
    expect(bucket.sent).toHaveLength(0);
  });

  it('a failing put reaches the caller (the onboarding service then cleans up)', async () => {
    bucket.failWith = new Error('network down');
    await expect(storage.save('drivers/d1/a.jpg', Buffer.from('x'))).rejects.toThrow('network down');
  });

  it('assertReachable asks S3 about the bucket and reports failure', async () => {
    await storage.assertReachable();
    expect(bucket.sent[0]).toBeInstanceOf(HeadBucketCommand);
    bucket.failWith = Object.assign(new Error('no bucket'), { name: 'NoSuchBucket' });
    await expect(storage.assertReachable()).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });
});
