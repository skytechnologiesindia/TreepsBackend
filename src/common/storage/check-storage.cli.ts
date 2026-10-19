import { randomUUID } from 'node:crypto';
import { S3FileStorage } from './s3-file-storage.js';

// `npm run storage:check` - proves the bucket settings work before you rely on them: it saves a tiny
// PNG, reads it back, compares it, and deletes it. It touches only the key healthcheck/<random>.png and
// prints no key or secret. Needs STORAGE_DRIVER=s3, S3_BUCKET, S3_REGION and the AWS keys in .env.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env file: the variables must already be set
  }
  const { S3_BUCKET: bucket, S3_REGION: region, S3_ENDPOINT: endpoint } = process.env;
  if (!bucket || !region) {
    console.error('Set S3_BUCKET and S3_REGION first (see .env.example).');
    process.exit(1);
  }
  const storage = S3FileStorage.create({ bucket, region, endpoint: endpoint || undefined });
  const key = `healthcheck/${randomUUID()}.png`;

  await storage.assertReachable();
  console.log('1/4 bucket reachable');
  await storage.save(key, PNG);
  console.log('2/4 saved a test file');
  const back = await storage.read(key);
  if (back === null || !back.equals(PNG)) throw new Error('read-back did not match');
  console.log('3/4 read it back, identical');
  await storage.delete(key);
  if ((await storage.read(key)) !== null) throw new Error('test file was not deleted');
  console.log('4/4 deleted it. Storage works.');
}

// What an HTTP status from S3 usually means. A bucket check (HEAD) has no body, so AWS often gives no
// error name and the status is the only clue.
const HINTS: Record<number, string> = {
  301: 'the bucket is in a different region than S3_REGION',
  400: 'the request was refused; often S3_REGION does not match the bucket',
  403: 'the keys are wrong, or the key is not allowed to use this bucket',
  404: 'there is no bucket with the name in S3_BUCKET',
};

main().catch((error: unknown) => {
  // The error name, HTTP status and the bucket's real region only; never the full AWS text or a key.
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } };
  const status = e.$metadata?.httpStatusCode;
  const realRegion = e.$response?.headers?.['x-amz-bucket-region'];
  console.error(`Storage check failed: ${e.name ?? 'unknown error'}${status ? ` (HTTP ${status})` : ''}`);
  if (status && HINTS[status]) console.error(`Likely cause: ${HINTS[status]}.`);
  if (realRegion) console.error(`The bucket's region is ${realRegion}.`);
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) console.error('AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is not set.');
  process.exit(1);
});
