import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { API_VERSION } from '../api-version.js';

// Test helpers. Call them after `await app.listen(0, '127.0.0.1')`.

// Host and port only. Use it for a path that has no version (a NOT_FOUND check, a neutral route).
export function rawBaseUrl(app: INestApplication): string {
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// Host, port and the default version: what the routes of a controller are served under.
export function versionedBaseUrl(app: INestApplication): string {
  return `${rawBaseUrl(app)}/v${API_VERSION}`;
}
