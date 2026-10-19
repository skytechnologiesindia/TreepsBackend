import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { assertSafeStoragePath, type FileStorage } from './file-storage.js';

export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  private locate(path: string): string {
    assertSafeStoragePath(path);
    const full = resolve(this.root, path);
    if (!full.startsWith(resolve(this.root) + sep)) throw new Error('Unsafe storage path');
    return full;
  }

  async save(path: string, data: Buffer): Promise<void> {
    const full = this.locate(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data, { flag: 'wx' }); // never overwrite an existing file
  }

  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(this.locate(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    try {
      await unlink(this.locate(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
