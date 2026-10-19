import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_ROOT } from '../../config/storage.js';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { FILE_STORAGE, type FileStorage } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';
import { S3FileStorage } from './s3-file-storage.js';

// One FileStorage for the whole app, chosen by STORAGE_DRIVER: the local folder (development) or the
// S3 bucket (production must use it). Nothing else in the app knows which one it got.
@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ValidatedEnv, true>): FileStorage => {
        if (config.get('STORAGE_DRIVER', { infer: true }) !== 's3') return new LocalFileStorage(STORAGE_ROOT);
        return S3FileStorage.create({
          bucket: config.get('S3_BUCKET', { infer: true }) as string,
          region: config.get('S3_REGION', { infer: true }) as string,
          endpoint: config.get('S3_ENDPOINT', { infer: true }),
        });
      },
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
