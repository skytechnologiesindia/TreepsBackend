import { resolve } from 'node:path';

// Where the local file storage keeps the driver photos (decision 186). A folder next to the app,
// not in git (see .gitignore). Production will use S3 behind the same FileStorage class.
export const STORAGE_ROOT = resolve(process.cwd(), 'storage');
